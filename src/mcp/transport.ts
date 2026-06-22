/**
 * MCP Stdio Transport
 *
 * Handles JSON-RPC 2.0 communication over stdin/stdout for MCP protocol.
 */

import * as readline from 'node:readline';
import type { Socket } from 'node:net';
import { z } from 'zod';
import { errMsg } from '../errors.js';

const jsonRpcIdSchema = z.union([z.string(), z.number()]);

const jsonRpcBaseSchema = z.looseObject({
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.unknown().optional(),
});

const jsonRpcRequestSchema = jsonRpcBaseSchema.extend({ id: jsonRpcIdSchema }).transform((value) => {
  const request: {
    jsonrpc: '2.0';
    id: string | number;
    method: string;
    params?: unknown;
  } = {
    jsonrpc: '2.0',
    id: value.id,
    method: value.method,
  };
  if (value.params !== undefined) request.params = value.params;
  return request;
});

const jsonRpcNotificationSchema = jsonRpcBaseSchema
  .refine((value) => !hasOwn(value, 'id'), {
    path: ['id'],
    message: 'Notifications must not include an id',
  })
  .transform((value) => {
    const notification: {
      jsonrpc: '2.0';
      method: string;
      params?: unknown;
    } = {
      jsonrpc: '2.0',
      method: value.method,
    };
    if (value.params !== undefined) notification.params = value.params;
    return notification;
  });

const jsonRpcInboundMessageSchema = z.union([jsonRpcRequestSchema, jsonRpcNotificationSchema]);

export type JsonRpcRequest = z.infer<typeof jsonRpcRequestSchema>;
export type JsonRpcNotification = z.infer<typeof jsonRpcNotificationSchema>;

export function parseJsonRpcInboundMessage(value: unknown): JsonRpcRequest | JsonRpcNotification | null {
  const parsed = jsonRpcInboundMessageSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * JSON-RPC 2.0 Response
 */
interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

/**
 * JSON-RPC 2.0 Error
 */
interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

// Standard JSON-RPC error codes
export const ErrorCodes = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
} as const;

type MessageHandler = (message: JsonRpcRequest | JsonRpcNotification) => Promise<void>;

export interface StdioTransportOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  exitOnClose?: boolean;
  closeOnStop?: boolean;
  onClose?: () => void;
}

class JsonRpcResponder {
  protected readonly output: NodeJS.WritableStream;

  /**
   * Serialises all stdout writes through a promise chain so that two large
   * responses (each >4096 bytes — macOS PIPE_BUF) never interleave on the
   * pipe. Without this, concurrent admin actions (e.g. `summarize` +
   * `index` running in parallel) could split writes across the OS boundary,
   * causing the MCP client to see garbled JSON, fail to parse it, and close
   * stdin.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(output: NodeJS.WritableStream) {
    this.output = output;
  }

  private enqueueWrite(line: string): void {
    this.writeQueue = this.writeQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            const ok = this.output.write(line);
            if (ok) resolve();
            else this.output.once('drain', resolve);
          }),
      )
      .catch((err) => {
        // A write failure must not poison the queue for subsequent writes.
        // stderr breadcrumb so the operator sees at least one signal
        // before the MCP client disconnects (stdout is unreliable here).
        try {
          process.stderr.write(`StdioTransport: stdout write failed — ${String(err)}\n`);
        } catch {
          /* stderr also broken — nothing left to log to. */
        }
      });
  }

  /** Send a response. */
  send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    this.enqueueWrite(json + '\n');
  }

  /** Send a notification (no id). */
  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.enqueueWrite(JSON.stringify(notification) + '\n');
  }

  /** Send a success response. */
  sendResult(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /** Send an error response. */
  sendError(id: string | number | null, err: { code: number; message: string; data?: unknown }): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: err,
    });
  }
}

/**
 * Stdio Transport for MCP
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout.
 */
export class StdioTransport extends JsonRpcResponder {
  private rl: readline.Interface | null = null;
  private messageHandler: MessageHandler | null = null;
  private readonly input: NodeJS.ReadableStream;
  private readonly exitOnClose: boolean;
  private readonly closeOnStop: boolean;
  private readonly onClose: (() => void) | undefined;
  private closed = false;

  constructor(options: StdioTransportOptions = {}) {
    const output = options.output ?? process.stdout;
    super(output);
    this.input = options.input ?? process.stdin;
    this.exitOnClose = options.exitOnClose ?? true;
    this.closeOnStop = options.closeOnStop ?? false;
    this.onClose = options.onClose;
  }

  /**
   * Start listening for messages on stdin
   */
  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    this.rl = readline.createInterface({
      input: this.input,
      output: this.output,
      terminal: false,
    });

    this.rl.on('line', async (line) => {
      await this.handleLine(line);
    });

    this.rl.on('close', () => this.handleClose());
  }

  /**
   * Stop listening
   */
  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
    if (this.closeOnStop) {
      const stream = this.output as NodeJS.WritableStream & { destroy?: () => void; end?: () => void };
      try {
        stream.end?.();
        stream.destroy?.();
      } catch {
        /* best-effort close */
      }
    }
  }

  /**
   * Handle an incoming line of JSON. Errors thrown by the message
   * handler are reported back via JSON-RPC error response (when the
   * incoming message had an `id`); notifications without an `id`
   * silently swallow the error since there's no channel to reply on.
   */
  private async handleLine(line: string): Promise<void> {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      this.sendError(null, { code: ErrorCodes.ParseError, message: 'Parse error: invalid JSON' });
      return;
    }
    const message = parseJsonRpcInboundMessage(parsed);
    if (!message) {
      this.sendError(null, {
        code: ErrorCodes.InvalidRequest,
        message: 'Invalid Request: not a valid JSON-RPC 2.0 message',
      });
      return;
    }
    if (!this.messageHandler) return;
    try {
      await this.messageHandler(message);
    } catch (err) {
      this.reportHandlerError(message, err);
    }
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    this.onClose?.();
    if (this.exitOnClose) process.exit(0);
  }

  /** JSON-RPC error reply for a thrown messageHandler — only sent when the incoming message had an `id`. */
  private reportHandlerError(message: JsonRpcRequest | JsonRpcNotification, err: unknown): void {
    if (!('id' in message)) return;
    this.sendError(message.id, { code: ErrorCodes.InternalError, message: `Internal error: ${errMsg(err)}` });
  }
}

export class SocketTransport extends StdioTransport {
  constructor(socket: Socket, onClose?: () => void) {
    super({ input: socket, output: socket, exitOnClose: false, closeOnStop: true, ...(onClose ? { onClose } : {}) });
  }
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.hasOwn(value, key);
}
