import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type { ToolResult } from '../tool-types.js';
import { findGraphCandidates } from '../../llm/dead-code.js';
import { getFindingsRanked, getFindingsStats } from '../../db/queries-findings.js';
import { errMsg } from '../../errors.js';
import { getAskModel } from '../../llm/provider.js';
import type Cartograph from '../../index.js';
import type { DeadCodeCandidate } from '../../llm/dead-code.js';
import type { Node } from '../../types.js';
import { isFixturePath, textResult, truncateOutput } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { llmFindDeadCode } from '../../cartograph-llm-service.js';
import {
  renderMarkdownBulletList,
  renderMarkdownCardList,
  type MarkdownBulletListSpec,
  type MarkdownCardListSpec,
} from './_result-spec.js';

/** Classifier axis for `cartograph_dead_code`. */
type ClassifierVia = 'rule' | 'llm' | 'auto';

/** Upper bound on `maxCandidates` — see schema. */
const MAX_CANDIDATES_CAP = 500;

/**
 * Zod schema for `cartograph_dead_code`.
 *
 * `maxCandidates` / `limit` are `.int().min(1).max(500)` — the legacy
 * handler rejected sub-1 values and clamped over-500 with a cap
 * notice. Under the locked reject-out-of-range policy BOTH ends are
 * now REJECTED at the dispatch boundary, so the handler drops the
 * defensive reject-check, the `clamp`, and the cap-notice logic.
 */
const deadCodeSchema = z.object({
  via: z
    .enum(['rule', 'llm', 'auto'])
    .optional()
    .describe(
      'Classifier axis. ' +
        '`rule` — graph-orphan structural pass, no LLM. ' +
        '`llm` — LLM verdicts (framework hooks / dynamic dispatch); requires an ask provider. ' +
        "`auto` (default) — LLM judge; errors when no LLM configured (use `via: 'rule'` for an LLM-free list).",
    ),
  mode: z
    .enum(['static', 'judge'])
    .optional()
    .describe('Deprecated alias for `via`: `static`→`rule`, `judge`→`llm`. Prefer `via`.'),
  maxCandidates: z
    .number()
    .int()
    .min(1)
    .max(MAX_CANDIDATES_CAP)
    .optional()
    .describe(
      'Cap on candidates returned (default 50, integer in [1, 500]). For via=llm also the LLM call budget. `limit` is an alias.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_CANDIDATES_CAP)
    .optional()
    .describe('Alias for `maxCandidates` (integer in [1, 500]).'),
  verdict: z
    .enum(['dead', 'live', 'uncertain', 'all'])
    .optional()
    .describe('Filter results by verdict (via=llm only; ignored in via=rule).'),
  excludeFixtures: z
    .boolean()
    .default(true)
    .describe(
      'Filter out candidates in fixture directories (default true). When false, fixtures are included. Honored by both via=rule and via=llm.',
    ),
  includeTests: z
    .boolean()
    .default(false)
    .describe(
      'Include symbols in test/script/benchmark paths (default false, since those paths expectedly carry uncalled symbols). Set true to also surface their orphans. Honored by both modes.',
    ),
  projectPath: projectPathField,
});

type DeadCodeArgs = z.infer<typeof deadCodeSchema>;

/**
 * Resolve the classifier axis for `cartograph_dead_code`.
 *
 * Accepts the canonical `via:` parameter and the legacy `mode:` alias
 * (deprecated; still wired so existing callers don't break):
 *   - `mode: 'static'` → `via: 'rule'`  (graph-orphan structural pass)
 *   - `mode: 'judge'`  → `via: 'llm'`   (LLM-mediated verdicts)
 * The default is `via: 'auto'` which preserves the historical default
 * (try LLM judge when configured, fall back to the rule path otherwise).
 */
function resolveVia(args: DeadCodeArgs): ClassifierVia {
  if (args.via) return args.via;
  if (args.mode === 'static') return 'rule';
  if (args.mode === 'judge') return 'llm';
  return 'auto';
}

// P6: returns a `ToolOutcome`. Two error paths — "no LLM configured"
// and a caught LLM-call failure — are now the typed `err(...)` arm;
// success paths route through `ok(...)`. The `formatStaticDeadCode`
// helper is a pure success path so it returns the `ToolResult`
// directly and the caller wraps it in `ok(...)`.
async function handleDeadCode(ctx: ToolCtx, args: DeadCodeArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const via = resolveVia(args);
  // `limit` accepted as an alias for the user-natural name; `maxCandidates`
  // is canonical (also doubles as the LLM call budget in via=llm). Both are
  // already integers in [1, 500] — Zod rejected anything else at the
  // dispatch boundary, so no clamp / sub-1 reject / cap notice is needed.
  // Precedence mirrors the legacy `maxCandidates ?? limit ?? 50` order.
  const maxCandidates = args.maxCandidates ?? args.limit ?? 50;
  const excludeFixtures = args.excludeFixtures;
  // Default false: test/script/benchmark paths are expected to carry
  // uncalled symbols, so they're exempt from dead-code suspicion
  // unless the caller explicitly opts in.
  const includeTests = args.includeTests;

  if (via === 'rule') return ok(formatStaticDeadCode({ cg, maxCandidates, excludeFixtures, includeTests }));

  // LLM / AUTO: judge mode runs through the ask path (useAskModel: true),
  // so check getAskModel — covers split-provider configs where chat is
  // e.g. a small local model and askChat is Sonnet. `auto` matches the
  // pre-`via` default (today's `judge`): error when no LLM is
  // configured, so the absence of a backing-mechanism becomes visible
  // rather than silently downgrading.
  const llmConfig = await cg.llm.getEffectiveLlmConfig();
  if (!getAskModel(llmConfig)) {
    return err(
      'No LLM available for dead-code judge. Configure config.llm.summarizeLlm (with optional askModel field) or config.llm.askLlm for a separate ask provider; legacy config.llm.chat / config.llm.askChat / flat config.llm.chatModel also work. Or call this tool with `via: "rule"` for the LLM-free graph-only candidate list.',
    );
  }
  const verdictFilter = args.verdict ?? 'all';

  try {
    const result = await llmFindDeadCode(cg.llm, { maxCandidates, excludeFixtures, includeTests });
    // #64: judge mode previously bypassed isFixturePath, surfacing
    // every test-bed fixture's orphan in the agent-facing list. Static
    // mode excludes fixtures inside findGraphCandidates (the `isExempt`
    // arg); mirror that on the judged output here so the same
    // `excludeFixtures: true` default applies in both modes.
    const filteredResults = excludeFixtures
      ? result.results.filter((r) => !isFixturePath(r.node.filePath))
      : result.results;
    const rows = verdictFilter === 'all' ? filteredResults : filteredResults.filter((r) => r.verdict === verdictFilter);

    if (rows.length === 0) return ok(textResult(formatJudgeEmpty(cg, result, verdictFilter)));
    const judgeBody = formatJudgeRows(rows, result.candidates);
    return ok(textResult(truncateOutput(judgeBody)));
  } catch (caught) {
    return err(errMsg(caught));
  }
}

/** Bundled arguments for {@link formatStaticDeadCode}. */
interface FormatStaticDeadCodeArgs {
  /** The open Cartograph instance to query. */
  readonly cg: Cartograph;
  /** Maximum number of real candidates to surface. */
  readonly maxCandidates: number;
  /** When true, fixture-path orphans are dropped inside the graph scan. */
  readonly excludeFixtures: boolean;
  /** When true, test/script/benchmark-path orphans are kept as candidates. */
  readonly includeTests: boolean;
}

/**
 * Build the static-dead-code H2 bullet-list spec — graph-only orphan
 * candidates rendered as `- \`name\` (kind) — file:line`. Title
 * interpolates `candidates.length`; preamble explains the rule-tier
 * coverage AND the path-class footprint via `includeTests`. The spec
 * OWNS all four user-facing wording surfaces (title + preamble +
 * formatRow + emptyState) so a `bulletListSpecStrings` walk pins them
 * for the wording-lint.
 *
 * Caller (`formatStaticDeadCode`) routes the empty-candidates path
 * through `renderToolResponse({body: '', empty: {...}})` — a different
 * surface (envelope-level empty signal) than this spec's emptyState,
 * so the spec's `emptyState: ''` is never rendered.
 */
export function buildDeadCodeStaticSpec(args: {
  candidates: ReadonlyArray<Node>;
  includeTests: boolean;
}): MarkdownBulletListSpec<Node> {
  const { candidates, includeTests } = args;
  const pathNote = includeTests
    ? 'no incoming calls, not exported; test/script paths INCLUDED'
    : 'no incoming calls, not exported, not in test/script paths';
  return {
    title: `Static dead-code candidates (${candidates.length}, no LLM judge)`,
    preamble: [
      `_These are graph-only orphans (${pathNote}). Framework hooks, dynamic dispatch, and reflective callers are NOT filtered out — for that, run \`via: 'llm'\`._`,
    ],
    rows: candidates,
    formatRow: (c) => `- \`${c.name}\` (${c.kind}) — ${c.filePath}:${c.startLine}`,
    emptyState: '',
  };
}

/**
 * Static mode: graph-only orphan candidates, no LLM. Cheap and always
 * available. The agent sees raw orphans without filtering for
 * framework hooks / dynamic dispatch / public API; `via: 'llm'` is the
 * right call when those distinctions matter.
 */
function formatStaticDeadCode(args: FormatStaticDeadCodeArgs): ToolResult {
  const { cg, maxCandidates, excludeFixtures, includeTests } = args;
  // Pass `isFixturePath` so fixture orphans are dropped INSIDE
  // findGraphCandidates — they sort ahead of `src/`, so an
  // over-fetch-then-filter approach could leave the result under-filled
  // on a fixture-dense repo. With inline exemption `maxCandidates`
  // means exactly that many real candidates.
  const candidates = findGraphCandidates({
    queries: cg.queries,
    max: maxCandidates,
    isExempt: excludeFixtures ? isFixturePath : undefined,
    includeTests,
  });

  if (candidates.length === 0) {
    const exemptNote = includeTests
      ? 'every indexed symbol has incoming edges or is exported'
      : 'every indexed symbol has incoming edges, is exported, or lives in a test/script path';
    return renderToolResponse({
      body: '',
      empty: { message: `No static dead-code candidates — ${exemptNote}.` },
    });
  }
  return renderToolResponse({ body: renderMarkdownBulletList(buildDeadCodeStaticSpec({ candidates, includeTests })) });
}

/**
 * Empty-judge-results path — empty signal is the worst signal, the
 * agent learns nothing and has no next step. When the user asked for
 * "dead" and the judge returned none, surface the most-suspicious
 * uncertain candidates by descending confidence so the agent has
 * somewhere to look. Also cross-link `unused_export` count so the
 * agent can compare a different (graph-only) signal.
 */
function formatJudgeEmpty(
  cg: Cartograph,
  result: { judged: number; candidates: number; results: DeadCodeCandidate[] },
  verdictFilter: string,
): string {
  const lines: string[] = [
    `Judged ${result.judged}/${result.candidates} candidates; no entries matched filter "${verdictFilter}".`,
  ];
  if (verdictFilter === 'dead') {
    appendUncertainTop(lines, result.results);
    appendUnusedExportCrossLink(lines, cg);
  }
  return lines.join('\n');
}

/**
 * Build the "Top uncertain candidates" H3 bullet-list spec for the
 * `formatJudgeEmpty` consolation path. Multi-line formatRow returns
 * `[bullet, '  > reason']` so the optional reason blockquote stays
 * indented under its parent bullet.
 *
 * Caller (`appendUncertainTop`) guards on `uncertainTop.length === 0`
 * before calling the renderer, so `emptyState` is the never-rendered
 * empty string.
 */
export function buildDeadCodeUncertainTopSpec(
  uncertainTop: ReadonlyArray<DeadCodeCandidate>,
): MarkdownBulletListSpec<DeadCodeCandidate> {
  return {
    title: 'Top uncertain candidates (closest to "dead", verify manually)',
    headingLevel: 3,
    rows: uncertainTop,
    formatRow: (c) => {
      const loc = c.node.startLine ? `:${c.node.startLine}` : '';
      const conf = `${(c.confidence * 100).toFixed(0)}%`;
      const bullet = `- [${conf} confidence uncertain] ${c.node.name} (${c.node.kind}) — ${c.node.filePath}${loc}`;
      return c.reason ? [bullet, `  > ${c.reason}`] : bullet;
    },
    emptyState: '',
  };
}

/** Append the top-5 uncertain candidates (descending confidence) when any exist. */
function appendUncertainTop(lines: string[], results: DeadCodeCandidate[]): void {
  const uncertainTop = results
    .filter((r) => r.verdict === 'uncertain')
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, 5);
  if (uncertainTop.length === 0) return;
  // Leading blank preserves the pre-migration `lines.push('')` gap
  // between the prior "Judged X/Y candidates" line and the H3 section.
  lines.push('');
  lines.push(renderMarkdownBulletList(buildDeadCodeUncertainTopSpec(uncertainTop)));
}

/**
 * Append a cross-link to the structural `unused_export` biomarker —
 * different signal (no cross-file references in graph), different
 * failure mode, agent can compare. Silently swallows errors because
 * biomarker tables may be absent on a freshly-indexed project.
 */
function appendUnusedExportCrossLink(lines: string[], cg: Cartograph): void {
  try {
    const findings = getFindingsRanked(cg.queries, { biomarker: 'unused_export', limit: 1 });
    if (findings.length === 0) return;
    const total = getFindingsStats(cg.queries).byBiomarker['unused_export'] ?? 0;
    if (total === 0) return;
    lines.push(
      '',
      `> **Cross-check:** \`cartograph_biomarkers biomarker=unused_export\` reports **${total}** ranked finding${total === 1 ? '' : 's'} on this project — different signal (no cross-file references in graph). Always grep before deletion.`,
    );
  } catch {
    /* biomarker tables may be absent — keep the rest */
  }
}

/**
 * Confidence threshold below which a definite `DEAD`/`LIVE` verdict is
 * flagged as self-contradictory. A `[DEAD 0%]` heading reads as a clean
 * signal but the model itself is unsure — the hedge stops the agent
 * from acting on it.
 */
const LOW_CONFIDENCE_HEDGE_THRESHOLD = 0.25;

/**
 * Build the populated-judge card-list spec. Card per candidate:
 * heading is `[VERDICT CONF%] name (kind)${hedge}`; body is
 * `file:line` + optional `> reason` blockquote.
 *
 * The `hedge` suffix fires when a definite verdict (DEAD/LIVE) pairs
 * with very low confidence — `[DEAD 0%]` looks like a clean signal
 * but the model itself is unsure, so the heading appends
 * `(low confidence — treat as uncertain)` to stop the agent acting
 * on a false-clean heading. The threshold is
 * {@link LOW_CONFIDENCE_HEDGE_THRESHOLD}.
 *
 * Caller (`formatJudgeRows`) is only invoked when `rows.length > 0`
 * (handleDeadCode short-circuits via formatJudgeEmpty otherwise), so
 * `emptyState` is the never-rendered empty string.
 */
export function buildDeadCodeJudgeSpec(
  rows: ReadonlyArray<DeadCodeCandidate>,
  totalCandidates: number,
): MarkdownCardListSpec<DeadCodeCandidate> {
  return {
    title: `Dead-code candidates (${rows.length} of ${totalCandidates} judged)`,
    preamble: ['_Combines graph signal (no callers + not exported) with LLM verdict._'],
    rows,
    rowHeading: (c) => {
      const conf = `${(c.confidence * 100).toFixed(0)}%`;
      const contradicts =
        (c.verdict === 'dead' || c.verdict === 'live') && c.confidence < LOW_CONFIDENCE_HEDGE_THRESHOLD;
      const hedge = contradicts ? ' (low confidence — treat as uncertain)' : '';
      return `[${c.verdict.toUpperCase()} ${conf}] ${c.node.name} (${c.node.kind})${hedge}`;
    },
    rowBody: (c) => {
      const loc = c.node.startLine ? `:${c.node.startLine}` : '';
      const body: string[] = [`${c.node.filePath}${loc}`];
      if (c.reason) body.push(`> ${c.reason}`);
      return body;
    },
    emptyState: '',
  };
}

/** Render the populated judge result list as a markdown report. */
function formatJudgeRows(rows: DeadCodeCandidate[], totalCandidates: number): string {
  return renderMarkdownCardList(buildDeadCodeJudgeSpec(rows, totalCandidates));
}

export const DEAD_CODE_TOOL = defineTool({
  name: 'cartograph_dead_code',
  description:
    'Potentially-dead symbols — a confidence-ranked candidate list, NOT a delete list.\n\n' +
    "`via: 'rule'` graph orphan-finder (no LLM) | `'llm'` adds an LLM filter for framework hooks/dynamic dispatch | `'auto'` (default) is the LLM judge, erroring when no LLM is configured. " +
    'JSX usage counts as a use-edge, so React components used only via JSX in their own file are not false-flagged as orphans. ' +
    'Always verify candidates against callers + tests before deleting.',
  schema: deadCodeSchema,
  handle: handleDeadCode,
});
