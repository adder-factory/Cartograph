export type MaxAgeDaysParseResult = { ok: true; value: number } | { ok: false; error: string };

export function parseMaxAgeDays(raw: string | undefined, defaultDays: number): MaxAgeDaysParseResult {
  const maxAgeDays = raw === undefined ? defaultDays : Number.parseFloat(raw);
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    return { ok: false, error: `--max-age-days must be a non-negative number. Got '${raw}'.` };
  }
  return { ok: true, value: maxAgeDays };
}
