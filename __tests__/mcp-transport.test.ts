/**
 * StdioTransport write-queue regression (F#19).
 *
 * The real bug: under concurrent admin actions producing large
 * responses (>4096-byte PIPE_BUF), the OS pipe could interleave
 * bytes from two `process.stdout.write` calls, the MCP client
 * received garbled JSON and disconnected, and the server's
 * `readline` close handler called `process.exit(0)`.
 *
 * Testing the OS kernel race directly from userland is not
 * possible (JavaScript runs single-threaded — calls are
 * sequential at the JS level; interleaving happens beneath the
 * `write` syscall). What we CAN exercise from userland is the
 * SERIALIZATION INVARIANT the fix establishes: only one
 * in-flight `process.stdout.write` at a time, with backpressure
 * properly awaited via `'drain'`. If a future refactor reverts
 * to direct unqueued writes, the backpressure-aware tests below
 * fail because the second send no longer waits for the first
 * one's `drain` to resolve.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ErrorCodes, StdioTransport, type JsonRpcNotification, type JsonRpcRequest } from '../src/mcp/transport.js';

const byNumber = (a: number, b: number): number => a - b;

/** Drain pending microtasks + setTimeout(0) ticks. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

interface MockStdout extends EventEmitter {
  write: (chunk: string | Uint8Array, encodingOrCb?: unknown, cb?: unknown) => boolean;
}

type RpcMessage = JsonRpcRequest | JsonRpcNotification;
type TransportHandler = (message: RpcMessage) => Promise<void>;

interface LineTransportHarness {
  chunks: string[];
  writeLine: (line: string) => Promise<void>;
}

async function withLineTransport<T>(
  handler: TransportHandler,
  fn: (harness: LineTransportHarness) => Promise<T>,
): Promise<T> {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: string[] = [];
  const transport = new StdioTransport({
    input,
    output,
    exitOnClose: false,
  });
  output.on('data', (chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
  });
  transport.start(handler);
  try {
    return await fn({
      chunks,
      writeLine: async (line: string): Promise<void> => {
        input.write(`${line}\n`);
        await settle();
      },
    });
  } finally {
    transport.stop();
    input.destroy();
    output.destroy();
  }
}

function parseTransportChunks(chunks: string[]): unknown[] {
  return chunks.flatMap((chunk) => chunk.trim().split('\n').filter(Boolean).map(parseTransportJsonLine));
}

function parseTransportJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch (err) {
    throw new Error(`Transport wrote invalid JSON: ${line}`, { cause: err });
  }
}

describe('StdioTransport write queue (F#19)', () => {
  let originalWrite: typeof process.stdout.write;
  let originalOnce: typeof process.stdout.once;
  let originalListenerCount: typeof process.stdout.listenerCount;
  let originalEmit: typeof process.stdout.emit;
  let mock: MockStdout;
  let chunks: string[];
  let writeCalls: number;
  /** When > 0, the Nth write returns `false` (backpressure) and only
   *  resolves after a subsequent `emitDrain` call. */
  let backpressureFirstN: number;
  let emitDrain: () => void;

  beforeEach(() => {
    chunks = [];
    writeCalls = 0;
    backpressureFirstN = 0;
    originalWrite = process.stdout.write.bind(process.stdout);
    originalOnce = process.stdout.once.bind(process.stdout);
    originalListenerCount = process.stdout.listenerCount.bind(process.stdout);
    originalEmit = process.stdout.emit.bind(process.stdout);

    mock = new EventEmitter() as MockStdout;
    mock.write = (chunk, encodingOrCb, cb) => {
      writeCalls++;
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (typeof callback === 'function') callback();
      // Return false on the first N writes to simulate backpressure.
      return writeCalls > backpressureFirstN;
    };
    emitDrain = (): void => {
      mock.emit('drain');
    };
    (process.stdout as unknown as { write: unknown }).write = mock.write.bind(mock);
    (process.stdout as unknown as { once: unknown }).once = mock.once.bind(mock);
    (process.stdout as unknown as { listenerCount: unknown }).listenerCount = mock.listenerCount.bind(mock);
    (process.stdout as unknown as { emit: unknown }).emit = mock.emit.bind(mock);
  });

  afterEach(() => {
    (process.stdout as unknown as { write: unknown }).write = originalWrite;
    (process.stdout as unknown as { once: unknown }).once = originalOnce;
    (process.stdout as unknown as { listenerCount: unknown }).listenerCount = originalListenerCount;
    (process.stdout as unknown as { emit: unknown }).emit = originalEmit;
  });

  it('serialises sends under backpressure — second send waits for first drain', async () => {
    backpressureFirstN = 1; // First write returns false → queue awaits drain.
    const transport = new StdioTransport();

    transport.sendResult(1, { data: 'x'.repeat(6000) });
    transport.sendResult(2, { data: 'y'.repeat(6000) });

    // After one tick: queue fired write1 (returned false, awaiting drain).
    // write2 must NOT have happened yet — that's the invariant the queue
    // enforces. Without the queue, both sendResult calls would call
    // process.stdout.write synchronously and `writeCalls` would be 2.
    await settle();
    expect(writeCalls).toBe(1);
    expect(chunks).toHaveLength(1);

    // Fire the drain event → write1's promise resolves → queue advances.
    emitDrain();
    await settle();

    // Now write2 has run.
    expect(writeCalls).toBe(2);
    expect(chunks).toHaveLength(2);

    // Sanity: each line is well-formed JSON-RPC.
    for (const chunk of chunks) {
      expect(chunk.endsWith('\n')).toBe(true);
      const parsed = JSON.parse(chunk.trim()) as { jsonrpc: string; id: number };
      expect(parsed.jsonrpc).toBe('2.0');
    }
    const ids = chunks.map((c) => (JSON.parse(c.trim()) as { id: number }).id).sort(byNumber);
    expect(ids).toEqual([1, 2]);
  });

  it('notify() is also serialised through the queue', async () => {
    backpressureFirstN = 1;
    const transport = new StdioTransport();

    transport.notify('tools/progress', { value: 'n'.repeat(5500) });
    transport.notify('tools/progress', { value: 'n'.repeat(5500) });

    await settle();
    expect(writeCalls).toBe(1); // queued behind drain

    emitDrain();
    await settle();
    expect(writeCalls).toBe(2);

    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      const parsed = JSON.parse(chunk.trim()) as { method: string };
      expect(parsed.method).toBe('tools/progress');
    }
  });

  it('three concurrent sends each wait for the prior drain', async () => {
    // Every write returns false until enough drains have fired.
    backpressureFirstN = 3;
    const transport = new StdioTransport();

    transport.sendResult(1, { ok: true });
    transport.sendResult(2, { ok: true });
    transport.sendResult(3, { ok: true });

    await settle();
    expect(writeCalls).toBe(1);

    emitDrain();
    await settle();
    expect(writeCalls).toBe(2);

    emitDrain();
    await settle();
    expect(writeCalls).toBe(3);
  });

  it('a synchronous write throw does not poison the queue', async () => {
    const transport = new StdioTransport();
    let callCount = 0;
    mock.write = (chunk, encodingOrCb, cb) => {
      callCount++;
      if (callCount === 1) throw new Error('simulated stdout error');
      chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
      const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
      if (typeof callback === 'function') callback();
      return true;
    };
    (process.stdout as unknown as { write: unknown }).write = mock.write.bind(mock);

    expect(() => transport.sendResult(1, { ok: true })).not.toThrow();
    transport.sendResult(2, { ok: true });

    await settle();
    await settle();

    // The second send arrived even though the first threw.
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks.some((c) => (JSON.parse(c.trim()) as { id: number }).id === 2)).toBe(true);
  });
});

describe('StdioTransport inbound JSON-RPC validation', () => {
  it('rejects non-string/non-number request ids before dispatching to the handler', async () => {
    let calls = 0;

    await withLineTransport(
      async () => {
        calls++;
      },
      async ({ chunks, writeLine }) => {
        await writeLine(JSON.stringify({ jsonrpc: '2.0', id: { nested: 1 }, method: 'tools/list' }));

        expect(calls).toBe(0);
        expect(parseTransportChunks(chunks)).toEqual([
          {
            jsonrpc: '2.0',
            id: null,
            error: {
              code: ErrorCodes.InvalidRequest,
              message: 'Invalid Request: not a valid JSON-RPC 2.0 message',
            },
          },
        ]);
      },
    );
  });
});
