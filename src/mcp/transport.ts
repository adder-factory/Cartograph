/**
 * MCP Stdio Transport
 *
 * Handles JSON-RPC 2.0 communication over stdin/stdout for MCP protocol.
 */

import * as readline from 'node:readline';
import { errMsg } from '../errors.js';

/**
 * JSON-RPC 2.0 Request
 */
export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
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

/**
 * JSON-RPC 2.0 Notification (no id, no response expected)
 */
export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
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

/**
 * Stdio Transport for MCP
 *
 * Reads JSON-RPC messages from stdin and writes responses to stdout.
 */
export class StdioTransport {
  private rl: readline.Interface | null = null;
  private messageHandler: MessageHandler | null = null;

  /**
   * Serialises all stdout writes through a promise chain so that two large
   * responses (each >4096 bytes — macOS PIPE_BUF) never interleave on the
   * pipe. Without this, concurrent admin actions (e.g. `summarize` +
   * `index` running in parallel) could split writes across the OS boundary,
   * causing the MCP client to see garbled JSON, fail to parse it, and close
   * stdin — which triggered `readline.on('close')` → `process.exit(0)`,
   * killing the server irrecoverably mid-session.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  /**
   * Start listening for messages on stdin
   */
  start(handler: MessageHandler): void {
    this.messageHandler = handler;

    this.rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    this.rl.on('line', async (line) => {
      await this.handleLine(line);
    });

    this.rl.on('close', () => {
      process.exit(0);
    });
  }

  /**
   * Stop listening
   */
  stop(): void {
    if (this.rl) {
      this.rl.close();
      this.rl = null;
    }
  }

  private enqueueWrite(line: string): void {
    this.writeQueue = this.writeQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
            const ok = process.stdout.write(line);
            if (ok) resolve();
            else process.stdout.once('drain', resolve);
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

  /**
   * Send a response
   */
  send(response: JsonRpcResponse): void {
    const json = JSON.stringify(response);
    this.enqueueWrite(json + '\n');
  }

  /**
   * Send a notification (no id)
   */
  notify(method: string, params?: unknown): void {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.enqueueWrite(JSON.stringify(notification) + '\n');
  }

  /**
   * Send a success response
   */
  sendResult(id: string | number, result: unknown): void {
    this.send({
      jsonrpc: '2.0',
      id,
      result,
    });
  }

  /**
   * Send an error response
   */
  sendError(id: string | number | null, err: { code: number; message: string; data?: unknown }): void {
    this.send({
      jsonrpc: '2.0',
      id,
      error: err,
    });
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
    if (!this.isValidMessage(parsed)) {
      this.sendError(null, {
        code: ErrorCodes.InvalidRequest,
        message: 'Invalid Request: not a valid JSON-RPC 2.0 message',
      });
      return;
    }
    if (!this.messageHandler) return;
    try {
      await this.messageHandler(parsed as JsonRpcRequest | JsonRpcNotification);
    } catch (err) {
      this.reportHandlerError(parsed as JsonRpcRequest, err);
    }
  }

  /** JSON-RPC error reply for a thrown messageHandler — only sent when the incoming message had an `id`. */
  private reportHandlerError(message: JsonRpcRequest, err: unknown): void {
    if (!('id' in message)) return;
    this.sendError(message.id, { code: ErrorCodes.InternalError, message: `Internal error: ${errMsg(err)}` });
  }

  /**
   * Check if message is a valid JSON-RPC 2.0 message
   */
  private isValidMessage(msg: unknown): boolean {
    if (typeof msg !== 'object' || msg === null) return false;
    const obj = msg as Record<string, unknown>;
    if (obj['jsonrpc'] !== '2.0') return false;
    if (typeof obj['method'] !== 'string') return false;
    return true;
  }
}
