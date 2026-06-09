import { afterEach, describe, expect, it } from 'vitest';
import { PassThrough } from 'node:stream';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  MCPServer,
  formatMcpToolAuditLine,
  parseDebounceEnv,
  shouldAuditMcpToolCalls,
  StdioTransport,
} from '../src/mcp/index.js';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions.js';
import { ErrorCodes, type JsonRpcNotification, type JsonRpcRequest } from '../src/mcp/transport.js';

type RpcMessage = JsonRpcRequest | JsonRpcNotification;
type TransportHandler = (message: RpcMessage) => Promise<void>;

interface CapturedResult {
  id: string | number;
  result: unknown;
}

interface CapturedError {
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

interface ServerHarness {
  request: (message: RpcMessage) => Promise<void>;
  results: CapturedResult[];
  errors: CapturedError[];
  notifications: Array<{ method: string; params?: unknown }>;
}

interface TransportHarness {
  writeLine: (line: string) => Promise<void>;
  chunks: string[];
}

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-server-coverage-'));
  tempRoots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function withCapturedStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = '';
  (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

async function withServerHarness<T>(server: MCPServer, fn: (harness: ServerHarness) => Promise<T>): Promise<T> {
  const results: CapturedResult[] = [];
  const errors: CapturedError[] = [];
  const notifications: Array<{ method: string; params?: unknown }> = [];
  let handler: TransportHandler | undefined;

  const proto = StdioTransport.prototype as unknown as {
    start: StdioTransport['start'];
    sendResult: StdioTransport['sendResult'];
    sendError: StdioTransport['sendError'];
    notify: StdioTransport['notify'];
  };
  const originalStart = proto.start;
  const originalSendResult = proto.sendResult;
  const originalSendError = proto.sendError;
  const originalNotify = proto.notify;
  const originalProcessOn = process.on;
  const originalStdinOn = process.stdin.on;

  proto.start = function start(capturedHandler: TransportHandler): void {
    handler = capturedHandler;
  };
  proto.sendResult = function sendResult(id: string | number, result: unknown): void {
    results.push({ id, result });
  };
  proto.sendError = function sendError(id: string | number | null, error: CapturedError['error']): void {
    errors.push({ id, error });
  };
  proto.notify = function notify(method: string, params?: unknown): void {
    notifications.push(params === undefined ? { method } : { method, params });
  };

  (process as unknown as { on: typeof process.on }).on = function on(): NodeJS.Process {
    return process;
  } as typeof process.on;
  (process.stdin as unknown as { on: typeof process.stdin.on }).on = function on(): NodeJS.ReadStream {
    return process.stdin;
  } as typeof process.stdin.on;

  try {
    await server.start();
  } finally {
    process.on = originalProcessOn;
    process.stdin.on = originalStdinOn;
  }

  if (!handler) throw new Error('MCPServer.start did not install a transport handler');

  try {
    return await fn({
      request: (message) => handler!(message),
      results,
      errors,
      notifications,
    });
  } finally {
    proto.start = originalStart;
    proto.sendResult = originalSendResult;
    proto.sendError = originalSendError;
    proto.notify = originalNotify;
    server.toolHandler.closeAll();
    if (server.st.cg) {
      server.st.cg = null;
    }
  }
}

async function withTransportHarness<T>(
  messageHandler: TransportHandler,
  fn: (harness: TransportHarness) => Promise<T>,
): Promise<T> {
  const fakeStdin = new PassThrough();
  const fakeStdout = new PassThrough();
  const chunks: string[] = [];
  const transport = new StdioTransport({
    input: fakeStdin,
    output: fakeStdout,
    exitOnClose: false,
  });
  const originalExit = process.exit;

  fakeStdout.on('data', (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  });
  (process as unknown as { exit: typeof process.exit }).exit = (() => undefined as never) as typeof process.exit;

  transport.start(messageHandler);

  try {
    return await fn({
      chunks,
      writeLine: async (line: string): Promise<void> => {
        fakeStdin.write(`${line}\n`);
        await settle();
      },
    });
  } finally {
    transport.stop();
    fakeStdin.destroy();
    fakeStdout.destroy();
    process.exit = originalExit;
  }
}

function parseStdout(chunks: string[]): unknown[] {
  return chunks.flatMap((chunk) => chunk.trim().split('\n').filter(Boolean).map(parseJsonLine));
}

function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (err) {
    throw new Error(`Transport wrote invalid JSON: ${line}`, { cause: err });
  }
}

describe('MCPServer JSON-RPC request handling', () => {
  it('initializes from an encoded rootUri and appends the no-project setup warning', async () => {
    const root = path.join(tempDir(), 'workspace with spaces');
    fs.mkdirSync(root, { recursive: true });
    const server = new MCPServer({ disableStartupSync: true });

    await withServerHarness(server, async (harness) => {
      const { stderr } = await withCapturedStderr(() =>
        harness.request({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { rootUri: pathToFileURL(root).href },
        }),
      );

      expect(server.st.projectPath).toBe(path.resolve(root));
      expect(stderr).toContain('server has no default project');
      expect(harness.results).toHaveLength(1);
      const init = harness.results[0]!.result as {
        protocolVersion: string;
        capabilities: {
          tools: Record<string, unknown>;
          resources: Record<string, unknown>;
          prompts: Record<string, unknown>;
        };
        serverInfo: { name: string; version: string };
        instructions: string;
      };
      expect(init.protocolVersion).toBe('2024-11-05');
      expect(init.capabilities).toEqual({ tools: {}, resources: {}, prompts: {} });
      expect(init.serverInfo.name).toBe('cartograph');
      expect(init.instructions.startsWith(SERVER_INSTRUCTIONS)).toBe(true);
      expect(init.instructions).toContain('compact startup guide');
      expect(init.instructions).toContain('cartograph_playbook');
      expect(init.instructions).not.toContain('Which cartograph tool fits this question?');
      expect(init.instructions).toContain('Cartograph setup warning');
      expect(init.instructions).toContain(root);
    });
  });

  it('uses workspaceFolders when rootUri is absent', async () => {
    const root = path.join(tempDir(), 'workspace #1');
    fs.mkdirSync(root, { recursive: true });
    const server = new MCPServer({ disableStartupSync: true });

    await withServerHarness(server, async (harness) => {
      await withCapturedStderr(() =>
        harness.request({
          jsonrpc: '2.0',
          id: 'init-workspace',
          method: 'initialize',
          params: { workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'workspace' }] },
        }),
      );

      expect(server.st.projectPath).toBe(path.resolve(root));
      expect(harness.results[0]!.id).toBe('init-workspace');
    });
  });

  it('normalizes malformed file URIs through the initialize fallback path', async () => {
    const originalCwd = process.cwd();
    const isolatedCwd = tempDir();
    const server = new MCPServer({ disableStartupSync: true });

    try {
      process.chdir(isolatedCwd);
      await withServerHarness(server, async (harness) => {
        await withCapturedStderr(() =>
          harness.request({
            jsonrpc: '2.0',
            id: 'bad-uri',
            method: 'initialize',
            params: { rootUri: 'file:///tmp/%E0%A4%A' },
          }),
        );

        expect(server.st.projectPath).toBe(path.resolve('tmp/%E0%A4%A'));
        expect(harness.results[0]!.id).toBe('bad-uri');
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  it('lists tools and handles successful, missing-name, and unknown tool calls', async () => {
    const server = new MCPServer({ disableStartupSync: true });

    await withServerHarness(server, async (harness) => {
      await harness.request({ jsonrpc: '2.0', id: 'list', method: 'tools/list' });
      const listed = harness.results[0]!.result as { tools: Array<{ name: string }> };
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toContain('cartograph_playbook');
      expect(names).toContain('cartograph_find');

      await harness.request({
        jsonrpc: '2.0',
        id: 'playbook',
        method: 'tools/call',
        params: { name: 'cartograph_playbook', arguments: {}, _meta: { progressToken: 'p1' } },
      });
      const playbook = harness.results.find((entry) => entry.id === 'playbook')!.result as {
        content: Array<{ type: string; text: string }>;
      };
      expect(playbook.content[0]!.type).toBe('text');
      expect(playbook.content[0]!.text).toContain('Which cartograph tool fits this question?');
      expect(harness.notifications).toEqual([]);

      await harness.request({ jsonrpc: '2.0', id: 'missing', method: 'tools/call', params: {} });
      await harness.request({
        jsonrpc: '2.0',
        id: 'unknown-tool',
        method: 'tools/call',
        params: { name: 'cartograph_nope' },
      });

      expect(harness.errors).toEqual([
        { id: 'missing', error: { code: ErrorCodes.InvalidParams, message: 'Missing tool name' } },
        {
          id: 'unknown-tool',
          error: { code: ErrorCodes.InvalidParams, message: 'Unknown tool: cartograph_nope' },
        },
      ]);
    });
  });

  it('emits opt-in tool-call audit lines without logging arguments', async () => {
    const previousAudit = process.env['CARTOGRAPH_MCP_AUDIT_LOG'];
    process.env['CARTOGRAPH_MCP_AUDIT_LOG'] = '1';
    const server = new MCPServer({ disableStartupSync: true });

    try {
      await withServerHarness(server, async (harness) => {
        const { stderr } = await withCapturedStderr(() =>
          harness.request({
            jsonrpc: '2.0',
            id: 'audited-call',
            method: 'tools/call',
            params: {
              name: 'cartograph_playbook',
              arguments: { token: 'must-not-be-logged' },
            },
          }),
        );

        expect(stderr).toContain('Cartograph MCP audit');
        expect(stderr).toContain('tool=cartograph_playbook');
        expect(stderr).not.toContain('must-not-be-logged');
        expect(stderr).not.toContain('arguments');
      });
    } finally {
      if (previousAudit === undefined) delete process.env['CARTOGRAPH_MCP_AUDIT_LOG'];
      else process.env['CARTOGRAPH_MCP_AUDIT_LOG'] = previousAudit;
    }
  });

  it('returns empty resource and prompt lists for MCP clients that ask', async () => {
    const server = new MCPServer({ disableStartupSync: true });

    await withServerHarness(server, async (harness) => {
      await harness.request({ jsonrpc: '2.0', id: 'resources', method: 'resources/list' });
      await harness.request({ jsonrpc: '2.0', id: 'templates', method: 'resources/templates/list' });
      await harness.request({ jsonrpc: '2.0', id: 'prompts', method: 'prompts/list' });

      expect(harness.results).toEqual([
        { id: 'resources', result: { resources: [] } },
        { id: 'templates', result: { resourceTemplates: [] } },
        { id: 'prompts', result: { prompts: [] } },
      ]);
    });
  });

  it('responds to ping and returns MethodNotFound only for unknown requests', async () => {
    const server = new MCPServer({ disableStartupSync: true });

    await withServerHarness(server, async (harness) => {
      await harness.request({ jsonrpc: '2.0', id: 7, method: 'ping' });
      await harness.request({ jsonrpc: '2.0', id: 8, method: 'unknown/request' });
      await harness.request({ jsonrpc: '2.0', method: 'unknown/notification' });

      expect(harness.results).toEqual([{ id: 7, result: {} }]);
      expect(harness.errors).toEqual([
        { id: 8, error: { code: ErrorCodes.MethodNotFound, message: 'Method not found: unknown/request' } },
      ]);
    });
  });
});

describe('StdioTransport parsing through the public start API', () => {
  it('delivers valid request and notification lines while ignoring blank lines', async () => {
    const seen: RpcMessage[] = [];

    await withTransportHarness(
      async (message) => {
        seen.push(message);
      },
      async (harness) => {
        await harness.writeLine('');
        await harness.writeLine('   ');
        await harness.writeLine(JSON.stringify({ jsonrpc: '2.0', id: 'req', method: 'tools/list' }));
        await harness.writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

        expect(seen).toEqual([
          { jsonrpc: '2.0', id: 'req', method: 'tools/list' },
          { jsonrpc: '2.0', method: 'notifications/initialized' },
        ]);
        expect(harness.chunks).toEqual([]);
      },
    );
  });

  it('writes JSON-RPC parse and invalid-request errors for malformed lines', async () => {
    const seen: RpcMessage[] = [];

    await withTransportHarness(
      async (message) => {
        seen.push(message);
      },
      async (harness) => {
        await harness.writeLine('{');
        await harness.writeLine(JSON.stringify({ jsonrpc: '2.0', method: 42 }));
        await harness.writeLine(JSON.stringify({ jsonrpc: '1.0', method: 'tools/list' }));

        expect(seen).toEqual([]);
        const responses = parseStdout(harness.chunks) as Array<{
          id: null;
          error: { code: number; message: string };
        }>;
        expect(responses.map((response) => response.id)).toEqual([null, null, null]);
        expect(responses.map((response) => response.error.code)).toEqual([
          ErrorCodes.ParseError,
          ErrorCodes.InvalidRequest,
          ErrorCodes.InvalidRequest,
        ]);
        expect(responses[0]!.error.message).toContain('invalid JSON');
        expect(responses[1]!.error.message).toContain('not a valid JSON-RPC 2.0 message');
      },
    );
  });

  it('reports thrown handler errors for requests but not notifications', async () => {
    await withTransportHarness(
      async () => {
        throw new Error('handler exploded');
      },
      async (harness) => {
        await harness.writeLine(JSON.stringify({ jsonrpc: '2.0', id: 'boom', method: 'tools/list' }));
        await harness.writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

        const responses = parseStdout(harness.chunks) as Array<{
          id: string;
          error: { code: number; message: string };
        }>;
        expect(responses).toHaveLength(1);
        expect(responses[0]!.id).toBe('boom');
        expect(responses[0]!.error.code).toBe(ErrorCodes.InternalError);
        expect(responses[0]!.error.message).toContain('handler exploded');
      },
    );
  });
});

describe('parseDebounceEnv edge cases', () => {
  it('accepts trimmed integer-like values at the lower boundary', () => {
    expect(parseDebounceEnv('\n100\t')).toBe(100);
    expect(parseDebounceEnv('1e2')).toBe(100);
  });

  it('rejects non-integer numeric values even when they are in range', () => {
    expect(parseDebounceEnv('100.5')).toBeUndefined();
    expect(parseDebounceEnv('59999.5')).toBeUndefined();
  });
});

describe('MCP tool-call audit helpers', () => {
  it('accepts explicit truthy env values and ignores unset or false-like values', () => {
    expect(shouldAuditMcpToolCalls({ CARTOGRAPH_MCP_AUDIT_LOG: '1' })).toBe(true);
    expect(shouldAuditMcpToolCalls({ CARTOGRAPH_MCP_AUDIT_LOG: ' true ' })).toBe(true);
    expect(shouldAuditMcpToolCalls({ CARTOGRAPH_MCP_AUDIT_LOG: 'yes' })).toBe(true);
    expect(shouldAuditMcpToolCalls({ CARTOGRAPH_MCP_AUDIT_LOG: 'on' })).toBe(true);
    expect(shouldAuditMcpToolCalls({ CARTOGRAPH_MCP_AUDIT_LOG: '0' })).toBe(false);
    expect(shouldAuditMcpToolCalls({ CARTOGRAPH_MCP_AUDIT_LOG: 'false' })).toBe(false);
    expect(shouldAuditMcpToolCalls({})).toBe(false);
  });

  it('formats one compact line with only timestamp, pid, and tool name', () => {
    expect(formatMcpToolAuditLine('cartograph_status', new Date('2026-06-09T00:00:00.000Z'), 42)).toBe(
      '[Cartograph MCP audit] 2026-06-09T00:00:00.000Z pid=42 tool=cartograph_status\n',
    );
  });
});
