/**
 * Parse Worker
 *
 * Runs tree-sitter parsing in a separate thread so the main thread
 * stays unblocked and the UI animation renders smoothly.
 */

import { parentPort } from 'node:worker_threads';
import { extractFromSource } from './tree-sitter.js';
import { detectLanguage, loadGrammarsForLanguages, resetParser } from './grammars.js';
import type { ExtractionResult } from './types.js';
import { errMsg } from '../errors.js';
import { snapshotProfileDelta } from './profile.js';
import {
  parseParseWorkerCommand,
  parseWorkerRawId,
  parseWorkerRawType,
  type ParseWorkerReply,
} from './parse-worker-contract.js';
import type { Language } from '../types.js';

// Emscripten prints `Aborted()` (and a follow-up RuntimeError diag
// line) directly to stderr when WASM aborts — before the JS catch
// runs. Worker stderr is inherited by the parent, so each crash leaks
// a noise line to the user's terminal even though the JS layer
// already handles the failure cleanly. Filter these specific lines
// out at the source. Real diagnostic output (anything we log
// ourselves) goes through console.* / parentPort and is unaffected.
//
// Caveats deliberately accepted:
//   - Per-call match: each `write()` call is matched in isolation.
//     If Emscripten ever splits `Aborted(` across two write()s (it
//     doesn't today — synchronous abort prints the whole line at
//     once via libc puts) the first fragment would leak. Buffering
//     across calls would add complexity for a hypothetical case.
//   - Substring exactness: the prefix `Aborted(` is the literal
//     Emscripten signature. Any user code that legitimately writes
//     a stderr line starting with that prefix would also be filtered;
//     in practice no real diagnostic does.
{
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean => {
    const s = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    if (s.startsWith('Aborted(') || s.includes('Build with -sASSERTIONS for more info')) {
      // Honour the Writable stream contract: callbacks must always
      // fire even when the write is suppressed, or upstream code
      // waiting on the drain signal would hang. Both overload forms
      // are handled (`(chunk, cb)` and `(chunk, encoding, cb)`).
      if (typeof encoding === 'function') encoding();
      else if (cb) cb();
      return true;
    }
    if (typeof encoding === 'function') return realWrite(chunk, encoding);
    return realWrite(chunk, encoding, cb);
  };
}

const PARSER_RESET_INTERVAL = 5000;
const parseCounts = new Map<Language, number>();

function emptyParseResultError(message: string, filePath: string | undefined, code: string): ExtractionResult {
  return {
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [
      {
        message,
        ...(filePath !== undefined && { filePath }),
        severity: 'error',
        code,
      },
    ],
    durationMs: 0,
  };
}

function postProtocolError(raw: unknown, error: Error): void {
  const type = parseWorkerRawType(raw);
  if (type === 'load-grammars') {
    parentPort!.postMessage({ type: 'grammars-load-failed', error: error.message } satisfies ParseWorkerReply);
    return;
  }
  const id = parseWorkerRawId(raw);
  if (id !== null) {
    parentPort!.postMessage({
      type: 'parse-result',
      id,
      result: emptyParseResultError(error.message, undefined, 'worker_protocol_error'),
    } satisfies ParseWorkerReply);
  }
}

parentPort!.on('message', async (raw: unknown) => {
  let msg: ReturnType<typeof parseParseWorkerCommand>;
  try {
    msg = parseParseWorkerCommand(raw);
  } catch (err) {
    postProtocolError(raw, err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (msg.type === 'load-grammars') {
    try {
      await loadGrammarsForLanguages(msg.languages);
      parentPort!.postMessage({ type: 'grammars-loaded' } satisfies ParseWorkerReply);
    } catch (err) {
      parentPort!.postMessage({ type: 'grammars-load-failed', error: errMsg(err) } satisfies ParseWorkerReply);
    }
  } else if (msg.type === 'parse') {
    const { id, filePath, content } = msg;
    try {
      const language = detectLanguage(filePath, content);
      const result: ExtractionResult = extractFromSource(filePath, content, language);

      // Periodic parser reset to reclaim WASM heap memory
      const count = (parseCounts.get(language) ?? 0) + 1;
      parseCounts.set(language, count);
      if (count % PARSER_RESET_INTERVAL === 0) {
        resetParser(language);
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result,
        profileDelta: snapshotProfileDelta(),
      } satisfies ParseWorkerReply);
    } catch (err) {
      const message = errMsg(err);

      // WASM memory errors leave the module in a corrupted state — all
      // subsequent parses would also fail (cascading failures). Crash the
      // worker so the main thread spawns a fresh one with a clean heap.
      if (message.includes('memory access out of bounds') || message.includes('out of memory')) {
        process.exit(1);
      }

      parentPort!.postMessage({
        type: 'parse-result',
        id,
        result: emptyParseResultError(`Parse worker error: ${message}`, filePath, 'parse_error'),
        // Mirror the success path's delta so partial timings from
        // the (possibly long-running) extract attempt aren't dropped
        // and `lastSent` stays consistent across parse failures.
        profileDelta: snapshotProfileDelta(),
      } satisfies ParseWorkerReply);
    }
  } else if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdown-ack' } satisfies ParseWorkerReply);
  }
});
