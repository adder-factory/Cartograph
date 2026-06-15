import { z } from 'zod';

export function parsePostgresWorkerJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid PostgreSQL worker ${label} JSON: ${message}`);
  }
}

/**
 * Envelope the PostgreSQL worker subprocess returns for every request.
 * `rows`/`value` stay `unknown` — individual rows are validated by the
 * typed-query row schemas downstream; this guards only the envelope
 * shape so a crashed/OOM/hung worker can't smuggle a malformed
 * `ok`/`error` past the adapter via an unchecked cast.
 */
const WorkerResponseSchema = z.object({
  ok: z.boolean(),
  rows: z.array(z.unknown()).optional(),
  changes: z.number().optional(),
  lastInsertRowid: z.union([z.number(), z.bigint()]).optional(),
  value: z.unknown().optional(),
  error: z.string().optional(),
});

export type WorkerResponse = z.infer<typeof WorkerResponseSchema>;

/**
 * Validate a decoded worker response envelope. Throws a clear,
 * labelled error (instead of letting an `as WorkerResponse` cast hide
 * the corruption) when the worker emits a structurally invalid
 * envelope. Call after `decodeValue` so bigint/binary fields are in
 * their decoded form.
 */
export function parseWorkerResponse(decoded: unknown, label: string): WorkerResponse {
  const result = WorkerResponseSchema.safeParse(decoded);
  if (!result.success) {
    throw new Error(`Invalid PostgreSQL worker ${label} envelope: ${z.prettifyError(result.error)}`);
  }
  return result.data;
}
