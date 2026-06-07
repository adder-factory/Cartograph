import type * as http from 'node:http';
import type { IntBound } from './constants.js';

export function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function clampInt(v: string | null, bound: IntBound): number {
  if (!v) return bound.default;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return bound.default;
  return Math.max(bound.min, Math.min(bound.max, n));
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
