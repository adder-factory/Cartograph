import { parseStrictDecimalInteger } from '../shared/cli-args.js';

export type ViewerPortParseResult = { ok: true; value: number | undefined } | { ok: false; error: string };

export function parseViewerPort(raw: string | undefined): ViewerPortParseResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const port = parseStrictDecimalInteger(raw);
  if (port === null) {
    return { ok: false, error: `Invalid value for --port: "${raw}" is not a number` };
  }
  return { ok: true, value: port };
}
