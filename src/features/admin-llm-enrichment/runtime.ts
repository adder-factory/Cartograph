export interface SummarizeOptions {
  quiet?: boolean;
  concurrency?: string;
  limit?: string;
  all?: boolean;
  /** Per-invocation summarizeLlm model override (A/B testing). */
  model?: string;
  /** Per-invocation summarizeLlm endpoint override (implies openai-compat). */
  endpoint?: string;
}

export interface LlmEmbedResult {
  failed?: boolean;
  failureReason?: string;
  generated: number;
  errors: number;
  skipped: number;
  durationMs: number;
}

export interface LlmSummarizeResult {
  candidates: number;
  generated: number;
  errors: number;
  cacheHits: number;
  /** Symbols skipped — prompt exceeds the chat backend's per-slot context
   *  (issue #27). Optional so older callers/tests that omit it still type. */
  skippedTooLarge?: number;
  deferred: number;
  durationMs: number;
  embed?: LlmEmbedResult | null;
}

export interface LlmClassifyResult {
  classified: number;
  candidates: number;
  errors: number;
  durationMs: number;
}

export type NumericParseResult = { ok: true; value: number | undefined } | { ok: false; error: string };

export interface RenderMessage {
  level: 'info' | 'success' | 'warn';
  message: string;
}

export function parseConcurrencyOptionValue(
  raw: string | undefined,
  parseConcurrency: (raw: string | undefined) => number,
): NumericParseResult {
  if (raw === undefined) return { ok: true, value: parseConcurrency(undefined) };
  if (!/^\d+$/.test(raw.trim())) {
    return { ok: false, error: '--concurrency must be a positive integer' };
  }
  return { ok: true, value: parseConcurrency(raw) };
}

export function parseEagerLimitValue(options: SummarizeOptions): NumericParseResult {
  if (options.all) return { ok: true, value: Number.POSITIVE_INFINITY };
  if (options.limit === undefined) return { ok: true, value: undefined };
  const parsed = Number(options.limit);
  if (!Number.isInteger(parsed) || parsed < 0) {
    return {
      ok: false,
      error: '--limit must be a non-negative integer (0 = ad-hoc only; use --all for an uncapped pass)',
    };
  }
  return { ok: true, value: parsed };
}

export function summarizeDetailMessages(
  result: LlmSummarizeResult,
  deps: { formatNumber: (n: number) => string; formatDuration: (ms: number) => string },
): RenderMessage[] {
  const tooLarge = result.skippedTooLarge ?? 0;
  const skipped = result.candidates - result.generated - result.errors - result.cacheHits - result.deferred - tooLarge;
  const messages: RenderMessage[] = [
    {
      level: 'success',
      message: `Summarised ${deps.formatNumber(result.generated)} new symbols in ${deps.formatDuration(result.durationMs)}`,
    },
  ];

  // Explicit "did nothing on purpose" signal so a non-interactive /
  // piped run can't be mistaken for a silent no-op (issue #25): when
  // there were zero eligible candidates the eager pass is already
  // complete, and the remaining sub-100% tail summarises on demand.
  if (result.candidates === 0) {
    messages.push({
      level: 'info',
      message:
        'Nothing to summarise — every eligible symbol already has an up-to-date summary. ' +
        'The eager pass is complete; short / already-documented symbols are handled on demand when referenced.',
    });
  }

  const details: string[] = [];
  if (result.cacheHits > 0) details.push(`Cache hits: ${deps.formatNumber(result.cacheHits)}`);
  if (result.errors > 0) details.push(`Errors: ${deps.formatNumber(result.errors)}`);
  if (skipped > 0) details.push(`Skipped: ${deps.formatNumber(skipped)}`);
  if (details.length > 0) messages.push({ level: 'info', message: details.join(' — ') });
  if (tooLarge > 0) {
    messages.push({
      level: 'warn',
      message:
        `${deps.formatNumber(tooLarge)} symbol(s) skipped — prompt exceeds the chat backend's per-slot context. ` +
        'Raise `-c` or lower `--parallel` (run `cartograph doctor` for the exact per-slot budget), then ' +
        '`cartograph admin summarize --all` to retry them.',
    });
  }
  if (result.deferred > 0) {
    messages.push({
      level: 'info',
      message:
        `Deferred ${deps.formatNumber(result.deferred)} lower-priority symbols — they summarise on demand ` +
        `when \`find mode:intent\` references them. Run \`cartograph admin summarize --all\` for a full pass.`,
    });
  }
  messages.push(...summarizeEmbedDetailMessages(result.embed ?? undefined, deps));
  return messages;
}

export function summarizeEmbedDetailMessages(
  embed: LlmEmbedResult | null | undefined,
  deps: { formatNumber: (n: number) => string; formatDuration: (ms: number) => string },
): RenderMessage[] {
  if (!embed) return [];
  if (embed.failed) {
    return [
      {
        level: 'warn',
        message:
          `Embed phase failed: ${embed.failureReason ?? 'unknown error'}. ` +
          `Summaries are persisted; rerun \`cartograph admin embed\` once the embedding endpoint is back.`,
      },
    ];
  }
  if (embed.generated === 0) return [];
  return [
    {
      level: 'success',
      message: embedSuccessMessage(embed, deps),
    },
  ];
}

export function embedSuccessMessage(
  result: LlmEmbedResult,
  deps: { formatNumber: (n: number) => string; formatDuration: (ms: number) => string },
): string {
  const counters: string[] = [];
  if (result.errors > 0) counters.push(`${deps.formatNumber(result.errors)} errors`);
  if (result.skipped > 0)
    counters.push(`${deps.formatNumber(result.skipped)} skipped — too large for embed server's batch size`);
  return (
    `Embedded ${deps.formatNumber(result.generated)} new vectors in ${deps.formatDuration(result.durationMs)}` +
    (counters.length > 0 ? ` (${counters.join(', ')})` : '')
  );
}

export function classifySuccessMessages(
  result: LlmClassifyResult,
  deps: { formatNumber: (n: number) => string; formatDuration: (ms: number) => string },
): RenderMessage[] {
  const messages: RenderMessage[] = [
    {
      level: 'success',
      message:
        `Classified ${deps.formatNumber(result.classified)} symbols in ${deps.formatDuration(result.durationMs)}` +
        (result.errors > 0 ? ` (${deps.formatNumber(result.errors)} errors)` : ''),
    },
  ];
  if (result.candidates === 0) {
    messages.push({
      level: 'info',
      message:
        'No candidates — every symbol with a description (summary or docstring) already has a role from the active model.',
    });
  }
  return messages;
}

export function printMessages(
  clack: {
    log: { info: (message: string) => void; success: (message: string) => void; warn: (message: string) => void };
  },
  messages: readonly RenderMessage[],
): void {
  for (const message of messages) {
    clack.log[message.level](message.message);
  }
}
