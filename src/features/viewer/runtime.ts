export type ViewerPortParseResult = { ok: true; value: number | undefined } | { ok: false; error: string };

export function parseViewerPort(raw: string | undefined): ViewerPortParseResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const port = Number.parseInt(raw, 10);
  if (!Number.isFinite(port)) {
    return { ok: false, error: `Invalid value for --port: "${raw}" is not a number` };
  }
  return { ok: true, value: port };
}
