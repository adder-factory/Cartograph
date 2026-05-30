/**
 * The `concurrency` knob for the LLM-driven admin passes
 * (`summarize` / `embed` / `classify`).
 *
 * Shared by the `cartograph admin …` CLI and the `cartograph_admin` MCP
 * tool so the inclusive [1, 16] clamp and the default of 2 can't drift
 * between the two surfaces (backlog M3 — the formula was open-coded six
 * times, three per surface).
 */

/** Inclusive bounds + default for the LLM-pass `concurrency` knob. */
export const LLM_CONCURRENCY_BOUNDS = { min: 1, max: 16, default: 2 } as const;

/**
 * Parse + clamp a caller-supplied concurrency value to
 * `[LLM_CONCURRENCY_BOUNDS.min, LLM_CONCURRENCY_BOUNDS.max]`. Accepts a
 * number (MCP arg), a string (CLI option), or `undefined` (absent);
 * non-numeric / absent input falls back to `LLM_CONCURRENCY_BOUNDS.default`.
 */
export function parseConcurrency(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(n)) return LLM_CONCURRENCY_BOUNDS.default;
  return Math.min(LLM_CONCURRENCY_BOUNDS.max, Math.max(LLM_CONCURRENCY_BOUNDS.min, Math.floor(n)));
}
