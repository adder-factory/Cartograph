/**
 * `cartograph_trace_to_culprits(trace)` — paste a stack trace, get a
 * ranked list of likely fix-site candidates (#11). Replaces the
 * "stitch together cartograph_callers + cartograph_history + biomarker
 * lookups manually" pattern an agent runs through every time a bug
 * report arrives with a stack.
 *
 * Pipeline:
 *  1. Parse the trace text for `file:line` references across the
 *     common formats (V8/Node, Python, Java, Go, Rust). Frames are
 *     ordered top-of-stack first (most recent).
 *  2. Map each frame to an indexed file via path-suffix match (stack
 *     paths are often absolute; the index stores project-relative).
 *  3. For each mapped file, find the enclosing symbol via the line
 *     number using `findEnclosingNode`.
 *  4. Score each enclosing symbol by:
 *       - Frame position (top of stack = closer to the error site).
 *       - Recent churn (recently-modified code is a likely regression).
 *       - Biomarker overlap (god_class / complex_method = riskier).
 *  5. Render top-N candidates with the per-symbol "why suspected"
 *     reasons so the agent can decide where to read first.
 *
 * Returns markdown grouped into a candidates table + a "frames not
 * mapped" footer for transparency. The footer matters: it tells the
 * agent which lines couldn't be attributed to indexed code (likely
 * `node_modules/`, generated files, or paths the index doesn't cover).
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type Cartograph from '../../index.js';
import type { Node, NodeKind } from '../../types.js';
import { getAllFiles, getFileByPath } from '../../db/queries-files.js';
import type { FileRecord } from '../../types.js';
import { getFindingsForNode } from '../../db/queries-findings.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import {
  renderMarkdownBulletList,
  renderMarkdownCardList,
  type MarkdownBulletListSpec,
  type MarkdownCardListSpec,
} from './_result-spec.js';

/**
 * Empty-state message for `formatReport` when zero stack frames mapped
 * to indexed symbols. Hoisted so the wording-lint can pin the
 * load-bearing "`node_modules/` or generated files; or the index is
 * out of date" guidance — refactor that loses the diagnostic hints
 * silently degrades the agent's ability to triage the empty result.
 */
export const TRACE_CULPRITS_EMPTY_NOTE =
  '_No frames mapped to indexed symbols. Stack paths may all be in `node_modules/` or generated files; or the index is out of date._';

/** Default maximum candidates rendered. Higher loses focus; lower
 *  loses recall on a deep stack. */
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Frame parsing cap — refuse to parse more than this many lines so a
 *  pathological log doesn't pin the worker. */
const MAX_FRAMES = 200;

/** Days back from "now" considered "recent churn" for scoring. */
const RECENT_CHURN_DAYS = 30;
/** Convert ms→seconds and seconds→ms — `last_touched_ts` is unix SECONDS in this DB. */
const MS_PER_SECOND = 1000;
const SECONDS_PER_DAY = 86_400;
/** Score boost when the culprit's symbol carries any risky biomarker (god_class, complex_method, etc). */
const SCORE_BOOST_RISK_BIOMARKER = 0.3;
/** Score boost when the culprit's file was touched inside {@link RECENT_CHURN_DAYS}. */
const SCORE_BOOST_RECENT_CHURN = 0.2;

/** Node kinds we'll attribute frames to — narrows out import / file
 *  nodes that span huge ranges and don't really represent a frame. */
const FRAME_ATTRIBUTABLE_KINDS: ReadonlySet<NodeKind> = new Set([
  'function',
  'method',
  'class',
  'interface',
  'struct',
  'trait',
]);

interface ParsedFrame {
  /** Original trace line (rendered back as-is in the "not mapped" footer). */
  raw: string;
  /** File path as it appeared in the trace (may be absolute or relative). */
  file: string;
  /** 1-based line number. */
  line: number;
  /** 0-based position in the trace (0 = top of stack). */
  rank: number;
}

interface Culprit {
  node: Node;
  /** Best (lowest) frame rank from any matching frame — top-of-stack wins. */
  topRank: number;
  /** Composite score 0..1+; higher = more likely culprit. */
  score: number;
  /** Per-reason bullets the renderer surfaces under each candidate. */
  reasons: string[];
}

/**
 * Multi-format trace parser. Extracts `{ file, line }` triples from
 * V8/Node, Python, Java, Go, Rust, and the generic `path:line` shape
 * (which covers many editor / linter outputs too). Each format gets
 * one anchored regex; we run all of them on every line and dedupe by
 * (file, line) at the end so a line that matches two patterns
 * doesn't produce two frames.
 */
export function parseTrace(trace: string): ParsedFrame[] {
  // Patterns (in declaration order — first match per line wins). Each
  // capture group exposes (file, line) so the consumer is uniform.
  const PATTERNS: ReadonlyArray<RegExp> = [
    // V8 / Node: `at fn (path/to/file.ts:42:13)` or `at path/to/file.ts:42:13`
    /\(([^()\s][^()]*?):(\d+)(?::\d+)?\)/,
    /\bat\s+(?:.*?\s+\()?([^\s(]+\.[a-z]+):(\d+)(?::\d+)?\)?/i,
    // Python: `File "path/to/file.py", line 42, in fn`
    /File\s+"([^"]+)",\s+line\s+(\d+)/,
    // Java: `at com.foo.Bar.baz(Bar.java:42)`
    /\(([^()\s]+\.(?:java|kt|scala)):(\d+)\)/,
    // Go: `\tpath/to/file.go:42 +0x1a` or `path/to/file.go:42`
    /([^\s:]+\.(?:go|rs)):(\d+)(?::\d+)?\b/,
    // Generic suffix: any `path/to/file.ext:line` not already caught.
    /(\b[\w./\\-]+\.[a-zA-Z]{1,5}):(\d+)(?::\d+)?\b/,
  ];

  const frames: ParsedFrame[] = [];
  const seen = new Set<string>();
  const lines = trace.split('\n');
  for (let i = 0; i < lines.length && frames.length < MAX_FRAMES; i++) {
    const text = lines[i]!;
    for (const re of PATTERNS) {
      const m = re.exec(text);
      if (!m) continue;
      const file = m[1]!.replaceAll(/\\/g, '/'); // normalise Windows separators
      const line = Number(m[2]);
      if (!Number.isFinite(line) || line <= 0) break;
      const key = `${file}:${line}`;
      if (seen.has(key)) break;
      seen.add(key);
      frames.push({ raw: text.trim(), file, line, rank: frames.length });
      break; // first matching pattern per line wins
    }
  }
  return frames;
}

/**
 * Match a trace path (often absolute / OS-dependent) to an indexed
 * file path (always project-relative, forward-slashed). Strategy:
 * find the indexed file whose path is a SUFFIX of the trace path,
 * preferring the longest suffix match (`a/b/c.ts` beats `c.ts` when
 * both indexed paths exist).
 *
 * Returns null when no indexed file is a tail of the trace path.
 */
function resolveTraceFile(allFiles: readonly FileRecord[], tracePath: string): string | null {
  const norm = tracePath.replaceAll(/\\/g, '/');
  let best: string | null = null;
  let bestLen = 0;
  for (const f of allFiles) {
    if (!isPathBoundarySuffix(norm, f.path)) continue;
    if (f.path.length <= bestLen) continue;
    best = f.path;
    bestLen = f.path.length;
  }
  return best;
}

/** True when `indexed` is a `/`-aligned suffix of `norm`. The
 *  leading char of the suffix must be at start-of-string or right
 *  after a `/` so `foo/bar.ts` matches `.../foo/bar.ts` but NOT
 *  `.../sub-foo/bar.ts`. Pulled out of {@link resolveTraceFile} so
 *  the for-of body sits at depth 1 instead of nesting `if endsWith
 *  / if path-boundary / if longer` four levels deep. */
function isPathBoundarySuffix(norm: string, indexed: string): boolean {
  if (!norm.endsWith(indexed)) return false;
  const idx = norm.length - indexed.length;
  return idx === 0 || norm[idx - 1] === '/';
}

/**
 * For each parsed frame, find the enclosing symbol in the indexed
 * graph and aggregate per-symbol scores. Multiple frames may map to
 * the same symbol (loop with internal helper called twice) — the
 * topRank wins and reasons accumulate.
 */
async function buildCulprits(
  cg: Cartograph,
  frames: readonly ParsedFrame[],
): Promise<{ culprits: Culprit[]; unmappedFrames: ParsedFrame[]; gapFrames: ParsedFrame[] }> {
  const { findEnclosingNode, sortScopesBySpan } = await import('../../index-hooks/enclosing.js');
  const enclosingCache = new Map<string, Array<{ id: string; start: number; end: number }>>();
  const culpritsByNodeId = new Map<string, Culprit>();
  /** Frames whose file path was NOT matched to any indexed file. */
  const unmappedFrames: ParsedFrame[] = [];
  /** Frames whose file IS indexed but whose line falls between symbol bodies (e.g. a JSDoc comment). */
  const gapFrames: ParsedFrame[] = [];
  // Hoist the file list so the per-frame suffix-match doesn't pay an
  // SQL round-trip per frame (B5-style perf hygiene; reviewer-flagged).
  const allFiles = getAllFiles(cg.queries);

  for (const frame of frames) {
    const indexedPath = resolveTraceFile(allFiles, frame.file);
    if (!indexedPath) {
      unmappedFrames.push(frame);
      continue;
    }

    let scopes = enclosingCache.get(indexedPath);
    if (!scopes) {
      scopes = sortScopesBySpan(
        cg.queries
          .getNodesByFile(indexedPath)
          .filter((n) => FRAME_ATTRIBUTABLE_KINDS.has(n.kind))
          .map((n) => ({ id: n.id, start: n.startLine, end: n.endLine })),
      );
      enclosingCache.set(indexedPath, scopes);
    }
    const enclosingId = findEnclosingNode(scopes, frame.line);
    // File is indexed but line falls in a gap (e.g. JSDoc / blank lines between
    // symbol bodies) — distinct from a completely unindexed file path.
    if (!enclosingId) {
      gapFrames.push(frame);
      continue;
    }

    const node = cg.queries.getNodeById(enclosingId);
    if (!node) {
      unmappedFrames.push(frame);
      continue;
    }

    const existing = culpritsByNodeId.get(node.id);
    if (existing) {
      if (frame.rank < existing.topRank) existing.topRank = frame.rank;
      continue;
    }
    culpritsByNodeId.set(node.id, { node, topRank: frame.rank, score: 0, reasons: [] });
  }

  // Score pass — done after the symbol set is known so we don't pay
  // the per-symbol queries (churn, biomarkers) for every frame.
  const culprits = [...culpritsByNodeId.values()];
  scoreCulprits(cg, culprits);
  culprits.sort((a, b) => b.score - a.score);
  return { culprits, unmappedFrames, gapFrames };
}

/**
 * Composite score per culprit. Frame position is the spine — top-of-
 * stack symbols are where errors usually originate. Recent churn and
 * biomarker overlap are multipliers that nudge "if you only have
 * time to read 3 of these, read these 3" picks.
 */
function scoreCulprits(cg: Cartograph, culprits: Culprit[]): void {
  // `last_touched_ts` is unix SECONDS (see `queries-history.ts` and
  // schema.sql). Earlier draft compared seconds-on-disk against a
  // ms-based cutoff — silently dead churn signal on every project.
  const nowSec = Math.floor(Date.now() / MS_PER_SECOND);
  const recentCutoffSec = nowSec - RECENT_CHURN_DAYS * SECONDS_PER_DAY;
  for (const c of culprits) {
    let score = 1 / (c.topRank + 1); // 1.0 at top, 0.5 at rank 1, 0.33 at rank 2…
    const why: string[] = [];
    if (c.topRank === 0) why.push('top of stack');
    else why.push(`stack frame ${c.topRank + 1}`);

    // Biomarker overlap — risky-shaped code is more likely to hide a bug.
    const findings = getFindingsForNode(cg.queries, c.node.id);
    const RISKY_BIOMARKERS = new Set(['god_class', 'complex_method', 'large_method', 'nested_complexity']);
    const riskyFindings = findings.filter((f) => RISKY_BIOMARKERS.has(f.biomarker));
    if (riskyFindings.length > 0) {
      score += SCORE_BOOST_RISK_BIOMARKER;
      const names = [...new Set(riskyFindings.map((f) => f.biomarker))].join(', ');
      why.push(`risk biomarker(s): ${names}`);
    }

    // Recent churn — `last_touched_ts` on the FILE as a cheap proxy
    // (per-symbol churn is a separate backlog item). Goes through the
    // domain helper rather than inline SQL so the prepared statement
    // is cached and the call respects the per-domain query-file
    // convention. The reason text says "file last touched" — NOT
    // "symbol touched" — because this signal is file-granular: the
    // enclosing file changed recently, the specific symbol may not
    // have. Conflating the two (audit #25) misleads the agent into
    // thinking the culprit symbol itself was just edited.
    const file = getFileByPath(cg.queries, c.node.filePath);
    if (file?.lastTouchedTs && file.lastTouchedTs >= recentCutoffSec) {
      score += SCORE_BOOST_RECENT_CHURN;
      const days = Math.floor((nowSec - file.lastTouchedTs) / SECONDS_PER_DAY);
      const ago = days <= 0 ? 'today' : `${days}d ago`;
      const commits = (file.commitCount ?? 0) > 1 ? `, ${file.commitCount} file commits` : '';
      why.push(
        `recent churn (file \`${c.node.filePath}\` last touched ${ago}${commits} — file-level signal, not symbol-level)`,
      );
    }

    c.score = score;
    c.reasons = why;
  }
}

interface FormatTraceCulpritsReportArgs {
  candidates: readonly Culprit[];
  unmapped: readonly ParsedFrame[];
  /** Frames whose file IS indexed but whose line falls between symbol bodies. */
  gap: readonly ParsedFrame[];
  totalParsed: number;
  limit: number;
}

/** Sample cap for the H3 frame-sub-sections — 5 entries is enough
 *  for the agent to see the kind of paths missing without a deep
 *  node_modules stack drowning the candidates section. */
const TRACE_FRAMES_SAMPLE = 5;

/**
 * Build the top-level "## Trace analysis" card-list spec. One card
 * per candidate (heading + per-reason bullet body).
 *
 * Title interpolates the frames parsed (`N frame(s) parsed`) and
 * mapped (`M mapped to indexed symbols`) counts. Truncation footer
 * fires only when `candidates.length > limit`.
 *
 * Empty `candidates` → renderer emits `emptyState` verbatim. To
 * preserve the diagnostic value of the parsed/mapped counts on the
 * empty path (pre-migration emitted them BEFORE the empty note),
 * `emptyState` here pre-renders `## ${title}\n\n${TRACE_CULPRITS_EMPTY_NOTE}`
 * so the H2 title survives the empty short-circuit. Verified by an
 * end-to-end assertion in `__tests__/mcp-trace-to-culprits.test.ts`
 * on the all-frames-unmapped path.
 *
 * rowHeading shape preserves the TWO-space gap before `_(score X.XX)_`
 * — byte-parity with the pre-migration template literal. rowBody maps
 * each `reasons[]` entry to a `- ${reason}` bullet line.
 */
export function buildTraceCulpritsSpec(args: {
  candidates: ReadonlyArray<Culprit>;
  totalParsed: number;
  limit: number;
}): MarkdownCardListSpec<Culprit> {
  const { candidates, totalParsed, limit } = args;
  const title = `Trace analysis — ${totalParsed} frame${totalParsed === 1 ? '' : 's'} parsed, ${candidates.length} mapped to indexed symbols`;
  const shown = candidates.slice(0, limit);
  const truncated = candidates.length > limit;
  return {
    title,
    rows: shown,
    rowHeading: (c) => {
      const loc = c.node.startLine ? `:${c.node.startLine}` : '';
      return `${c.node.name} (${c.node.kind}) — \`${c.node.filePath}${loc}\`  _(score ${c.score.toFixed(2)})_`;
    },
    rowBody: (c) => c.reasons.map((reason) => `- ${reason}`),
    emptyState: `## ${title}\n\n${TRACE_CULPRITS_EMPTY_NOTE}`,
    ...(truncated
      ? {
          footers: [
            `> _Showing top ${limit} of ${candidates.length} candidates. Pass a higher \`limit\` to see more._`,
          ],
        }
      : {}),
  };
}

/** Build the "Frames not mapped to indexed code" H3 bullet-list spec.
 *  Rows are pre-rendered bullets + optional `- … and N more (likely
 *  \`node_modules/\` / generated / unindexed)` overflow row. Identity
 *  formatRow.
 *
 *  Caller (`formatReport`) guards on `unmapped.length > 0` before
 *  invoking the renderer, so `emptyState` is the never-rendered empty
 *  string. */
export function buildTraceUnmappedFramesSpec(unmapped: ReadonlyArray<ParsedFrame>): MarkdownBulletListSpec<string> {
  const shown = unmapped.slice(0, TRACE_FRAMES_SAMPLE);
  const overflow = unmapped.length - shown.length;
  const bullets = shown.map((f) => `- \`${f.file}:${f.line}\``);
  const rows =
    overflow > 0
      ? [...bullets, `- … and ${overflow} more (likely \`node_modules/\` / generated / unindexed)`]
      : bullets;
  return {
    title: `Frames not mapped to indexed code (${unmapped.length})`,
    headingLevel: 3,
    rows,
    formatRow: (s) => s,
    emptyState: '',
  };
}

/** Build the "Frames in module-level / unenclosed lines" H3
 *  bullet-list spec — file IS indexed but the line falls between
 *  symbol bodies. Per-row hint reminds the agent the gap usually
 *  means module-level top-level code.
 *
 *  Caller guards on `gap.length > 0` before invoking the renderer. */
export function buildTraceGapFramesSpec(gap: ReadonlyArray<ParsedFrame>): MarkdownBulletListSpec<string> {
  const shown = gap.slice(0, TRACE_FRAMES_SAMPLE);
  const overflow = gap.length - shown.length;
  const bullets = shown.map(
    (f) =>
      `- \`${f.file}:${f.line}\` (file is indexed; line is in module-level top-level code, no enclosing symbol — try a wider hunk or check the file directly)`,
  );
  const rows = overflow > 0 ? [...bullets, `- … and ${overflow} more`] : bullets;
  return {
    title: `Frames in module-level / unenclosed lines (${gap.length})`,
    headingLevel: 3,
    rows,
    formatRow: (s) => s,
    emptyState: '',
  };
}

function formatReport(args: FormatTraceCulpritsReportArgs): string {
  const { candidates, unmapped, gap, totalParsed, limit } = args;
  const sections: string[] = [renderMarkdownCardList(buildTraceCulpritsSpec({ candidates, totalParsed, limit }))];
  if (unmapped.length > 0) {
    sections.push(renderMarkdownBulletList(buildTraceUnmappedFramesSpec(unmapped)));
  }
  if (gap.length > 0) {
    sections.push(renderMarkdownBulletList(buildTraceGapFramesSpec(gap)));
  }
  return sections.join('\n');
}

/**
 * Zod schema for `cartograph_trace_to_culprits`.
 *
 * `limit` is `.int().min(1).max(50)` — a sub-1 or over-cap value is
 * REJECTED at the dispatch boundary (locked reject-out-of-range
 * decision), so the handler's old `clamp` + `Requested limit…capped`
 * notice are gone. `trace` is bounded at 200 KB — a generous ceiling
 * for a multi-thousand-line log pasted whole that still blocks
 * accidental megabyte payloads.
 */
const traceToCulpritsSchema = z.object({
  trace: z.string().min(1).max(200_000).describe('Stack trace text. Multi-line, multiple formats. Up to 200 KB.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe('Max culprit candidates returned (default 10, max 50).'),
  projectPath: projectPathField,
});

type TraceToCulpritsArgs = z.infer<typeof traceToCulpritsSchema>;

async function handleTraceToCulprits(ctx: ToolCtx, args: TraceToCulpritsArgs): Promise<ToolOutcome> {
  const trace = args.trace;
  const cg = ctx.getCartograph(args.projectPath);
  // `limit` is already an integer in [1, 50] — Zod's `.int().min().max()`
  // rejected anything else at the dispatch boundary. No clamp needed.
  const limit = args.limit;

  const frames = parseTrace(trace);
  if (frames.length === 0) {
    return ok(
      textResult(
        'No `file:line` references found in the trace. Supported formats: V8/Node `at fn (file:line:col)`, Python `File "file", line N`, Java `(File:N)`, Go `file.go:N`. If your trace is non-standard, reformat any one frame so the file path and line number are adjacent (`path/to/file.ext:42`).',
      ),
    );
  }
  const { culprits, unmappedFrames, gapFrames } = await buildCulprits(cg, frames);
  return ok(
    renderToolResponse({
      body: formatReport({
        candidates: culprits,
        unmapped: unmappedFrames,
        gap: gapFrames,
        totalParsed: frames.length,
        limit,
      }),
    }),
  );
}

export const TRACE_TO_CULPRITS_TOOL = defineTool({
  name: 'cartograph_trace_to_culprits',
  description:
    'Stack trace → ranked fix sites. Parses frames, maps to symbols, ranks by culprit likelihood. ' +
    'Scoring: frame position + file churn + biomarker overlap. ' +
    'Supports V8/Node, Python, Java/Kotlin/Scala, Go, Rust, and any `path/to/file:line`. ' +
    'Empty when no frames map (often a stale index).',
  schema: traceToCulpritsSchema,
  handle: handleTraceToCulprits,
});
