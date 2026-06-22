import type * as http from 'node:http';
import { parseStrictDecimalInteger } from '../../shared/cli-args.js';
import type { IntBound } from './constants.js';

export function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Write one Server-Sent Events frame to an already-open `text/event-stream`
 *  response (headers must already be written). Shared by the live feed and
 *  the config-editor re-index progress stream. No-ops once the response has
 *  ended or the socket is gone, so a write after a client disconnect can't
 *  throw `ERR_STREAM_WRITE_AFTER_END`. */
export function writeSseEvent(res: http.ServerResponse, event: string, data: unknown): void {
  if (res.writableEnded || res.destroyed) return;
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function clampInt(v: string | null, bound: IntBound): number {
  if (!v) return bound.default;
  const n = parseStrictDecimalInteger(v);
  if (n === null) return bound.default;
  return Math.max(bound.min, Math.min(bound.max, n));
}

/** Parse stored JSON (e.g. trace args), falling back to the raw string. */
export function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export type JsonObjectParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'invalid-json' | 'not-object' };

export function parseJsonObject(body: string): JsonObjectParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'not-object' };
  }

  const ownOnly: Record<string, unknown> = Object.create(null);
  for (const [key, value] of Object.entries(parsed)) {
    ownOnly[key] = value;
  }
  return { ok: true, value: ownOnly };
}

export function clampString(v: unknown, max: number, opts: { trim?: boolean } = {}): string {
  if (typeof v !== 'string') return '';
  const trimmed = opts.trim === false ? v : v.trim();
  if (trimmed.length > max) return trimmed.slice(0, max);
  return trimmed;
}

export function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    req.on('data', (c: Buffer) => {
      if (rejected) return;
      size += c.length;
      if (size > maxBytes) {
        rejected = true;
        chunks.length = 0;
        reject(new Error('body too large'));
        req.resume();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!rejected) resolve(Buffer.concat(chunks).toString('utf-8'));
    });
    req.on('error', (err) => {
      if (!rejected) reject(err);
    });
  });
}
