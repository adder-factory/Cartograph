export function parsePostgresWorkerJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid PostgreSQL worker ${label} JSON: ${message}`);
  }
}
