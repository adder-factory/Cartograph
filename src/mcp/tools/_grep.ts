/**
 * @internal — by='content' handler for the consolidated `cartograph_find`
 * family tool (formerly the top-level `cartograph_grep` tool). Dispatched
 * from `find.ts` when `by === 'content'`. No registered ToolModule export —
 * the registry only knows FIND_TOOL.
 *
 * Preserves the pre-merge `cartograph_grep` API verbatim: regex content
 * search with enclosing-symbol attribution, path / language filters,
 * per-file round-robin interleave, delta-mode `since:` cursor.
 */
import type Cartograph from '../../index.js';
import { getAllFiles } from '../../db/queries-files.js';
import type { NodeKind } from '../../types.js';
import type { ToolResult } from '../tool-types.js';
import { clamp, numArg, validatePathWithinRootReal } from '../../utils.js';
import { errMsg } from '../../errors.js';
import { applyDeltaSince, mintCallId, pathFilterStripHint, textResult, validateStringOutcome } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import { splitCallIdFooter } from './_call-id-footer.js';
import { compileSafeRegex } from '../../regex.js';
import type { RE2 } from 're2-wasm';
import type { ToolCtx } from './types.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/** Default cap on returned hits when caller doesn't pass `limit`. */
const DEFAULT_LIMIT = 50;
/** Hard ceiling on caller-supplied `limit` to bound output length. */
const MAX_LIMIT = 500;
/** Snippet length cap — trims long lines so the output stays readable. */
const MAX_SNIPPET_CHARS = 200;
/**
 * Skip files larger than this threshold — typically minified bundles,
 * generated code, vendored deps that leaked into the index. Reading
 * and line-walking a 10 MB minified file blocks the worker for
 * seconds and the hits are almost always noise.
 */
const MAX_FILE_BYTES = 1_000_000; // 1 MiB
/** Only attribute hits to nodes in these kinds — narrowing avoids assigning hits to variable/import nodes whose span doesn't really represent a "scope". */
const ENCLOSING_KINDS: ReadonlySet<NodeKind> = new Set(['function', 'method', 'class', 'interface']);
/**
 * Soft ceiling above which a regex pattern is considered "very broad" — the
 * agent gets a guidance hint in the response asking it to scope further before
 * relying on these results. Picked at 5000 to fire on `query: '.'` /
 * `query: '\\w'` (six-figure hit counts) but stay quiet on legit dense queries
 * like `import ` over a large monorepo. WARN, never reject — false-positives on
 * the reject path would break real queries against monorepos where 8k matches
 * for `return null` is the actual answer.
 */
const BROAD_PATTERN_HIT_THRESHOLD = 5000;

/**
 * Strip pattern anchors / common quantifiers to estimate the "effective" pattern
 * width — used by {@link isPatternTriviallyBroad}. Removes `^`, `$`, `\b`
 * (anchor-equivalents) and any single trailing `*` / `+` / `?` quantifier.
 *
 * Returns the stripped string. NOT a full regex parse — best-effort heuristic
 * for the cheapest triviality check.
 */
function stripAnchorsAndQuantifiers(pattern: string): string {
  return pattern
    .replaceAll(/\^|\$|\\b/g, '')
    .replaceAll(/[*+?]/g, '')
    .trim();
}

/**
 * Heuristic: is this pattern so broad that almost every line will match? Returns
 * a hint string when it is, null otherwise. The check is purely string-level —
 * cheap, runs before any disk I/O.
 *
 * Triggers on: `.`, `.*`, `.+`, `\w`, `\s`, `\d`, single-char or empty patterns
 * after stripping anchors / quantifiers, and the standalone single-char
 * meta-classes. Misses some adversarial broad patterns like `[a-z]` — that's
 * fine; the post-search hit-count guard ({@link BROAD_PATTERN_HIT_THRESHOLD})
 * is the second line of defence.
 */
function isPatternTriviallyBroad(pattern: string): boolean {
  const stripped = stripAnchorsAndQuantifiers(pattern);
  // After stripping, the pattern is shorter than 2 visible chars.
  if (stripped.length < 2) return true;
  // Single meta-class shorthand that matches almost any line.
  if (/^\\[wsd]$/i.test(stripped)) return true;
  // `.X` or `X.` where the only real char is one wildcard pair.
  if (/^\.[*+?]?$/.test(pattern.trim())) return true;
  return false;
}

interface GrepHit {
  file: string;
  line: number;
  text: string;
  enclosing: string | null;
}

/** Type alias for the scope-array shape used by the enclosing-node helpers. */
type ScopeSpans = Array<{ id: string; start: number; end: number }>;

/** Per-call grep environment — bundles the cartograph handle, fs module, scope cache, and the dynamically-imported enclosing helpers so the searcher signature stays narrow. */
interface GrepEnvironment {
  cg: Cartograph;
  fsMod: typeof import('node:fs');
  enclosingCache: Map<string, ScopeSpans>;
  findEnclosingNode: (scopes: ScopeSpans, line: number) => string | null;
  sortScopesBySpan: (scopes: ScopeSpans) => ScopeSpans;
}

/** Per-file scan task — file, its already-validated absolute path, the compiled regex, and the remaining hit budget. */
interface GrepTask {
  file: { path: string };
  absPath: string;
  regex: RE2;
  remainingBudget: number;
}

interface FileSearchResult {
  /** New hits produced by this file (capped to `limit - existing.length`). */
  hits: GrepHit[];
  /** Total regex matches in this file (may exceed `hits.length` when truncated by limit). */
  matched: number;
  /** True when the file was skipped because its size exceeded `MAX_FILE_BYTES`. */
  skippedLarge: boolean;
  /** True when the budget was filled mid-file — caller should stop iterating. */
  reachedBudget: boolean;
}

/**
 * Scan one file's contents for regex matches, attribute each match
 * to its enclosing function/method/class/interface, and return up to
 * `remainingBudget` hits plus the total match count for the file.
 */
/** Trim a line to {@link MAX_SNIPPET_CHARS} for grep output. */
function clipSnippet(line: string): string {
  if (line.length <= MAX_SNIPPET_CHARS) return line;
  return line.slice(0, MAX_SNIPPET_CHARS) + ' …';
}

function searchFileForRegex(env: GrepEnvironment, task: GrepTask): FileSearchResult {
  const { cg, fsMod, enclosingCache, findEnclosingNode, sortScopesBySpan } = env;
  const { file, absPath, regex, remainingBudget } = task;
  let src: string;
  try {
    const stat = fsMod.statSync(absPath);
    if (stat.size > MAX_FILE_BYTES) return { hits: [], matched: 0, skippedLarge: true, reachedBudget: false };
    src = fsMod.readFileSync(absPath, 'utf8');
  } catch {
    return { hits: [], matched: 0, skippedLarge: false, reachedBudget: false }; // file deleted or unreadable
  }

  let scopes = enclosingCache.get(file.path);
  if (!scopes) {
    scopes = sortScopesBySpan(
      cg.queries
        .getNodesByFile(file.path)
        .filter((n) => ENCLOSING_KINDS.has(n.kind))
        .map((n) => ({ id: n.id, start: n.startLine, end: n.endLine })),
    );
    enclosingCache.set(file.path, scopes);
  }

  const lines = src.split('\n');
  // Mirrors the pre-refactor `break outer` semantics: once the budget
  // is filled, stop scanning the file too — `totalMatched` should
  // reflect "matches we counted before hitting the cap", not the full
  // project-wide count.
  return scanLinesForMatches({
    lines,
    file,
    regex,
    remainingBudget,
    scopes,
    findEnclosingNode,
    getNodeById: (id) => cg.queries.getNodeById(id) ?? null,
  });
}

interface ScanLinesArgs {
  lines: string[];
  file: { path: string };
  regex: RE2;
  remainingBudget: number;
  scopes: Array<{ id: string; start: number; end: number }>;
  findEnclosingNode: GrepEnvironment['findEnclosingNode'];
  getNodeById: (id: string) => { name: string } | null;
}

/** Inner-loop scanner. Pulled out of {@link searchFileForRegex} so its
 *  per-line ternaries don't roll up into the outer function's
 *  conditional-complexity tally. */
function scanLinesForMatches(args: ScanLinesArgs): FileSearchResult {
  const { lines, file, regex, remainingBudget, scopes, findEnclosingNode, getNodeById } = args;
  const hits: GrepHit[] = [];
  let matched = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    regex.lastIndex = 0;
    if (!regex.test(line)) continue;
    matched++;
    if (hits.length >= remainingBudget) {
      return { hits, matched, skippedLarge: false, reachedBudget: true };
    }
    const lineNo = i + 1;
    const enclosingId = findEnclosingNode(scopes, lineNo);
    const enclosingName = enclosingId ? (getNodeById(enclosingId)?.name ?? null) : null;
    const snippet = clipSnippet(line);
    hits.push({ file: file.path, line: lineNo, text: snippet, enclosing: enclosingName });
  }
  return { hits, matched, skippedLarge: false, reachedBudget: false };
}

/** Group hits by file so the output renders one section per file. */
function groupHitsByFile(hits: ReadonlyArray<GrepHit>): Map<string, GrepHit[]> {
  const byFile = new Map<string, GrepHit[]>();
  for (const h of hits) {
    if (!byFile.has(h.file)) byFile.set(h.file, []);
    byFile.get(h.file)!.push(h);
  }
  return byFile;
}

interface FormatGrepOutputArgs {
  pattern: string;
  hits: ReadonlyArray<GrepHit>;
  totalMatched: number;
  limit: number;
  skippedLargeFiles: number;
}

/**
 * Build the per-file H3 bullet-list spec for one grep file-group.
 * Title interpolates the file path + hit count; formatRow renders the
 * canonical `- L${line} — in \`${enclosing}\`: \`${snippet}\`` bullet
 * (enclosing prefix omitted when no enclosing function/method/class
 * spans the line).
 *
 * Caller (`formatGrepOutput`) only emits non-empty groups
 * (groupHitsByFile drops files with zero hits), so `emptyState` is
 * the never-rendered empty string.
 */
export function buildGrepFileSpec(args: {
  file: string;
  hits: ReadonlyArray<GrepHit>;
}): MarkdownBulletListSpec<GrepHit> {
  const { file, hits } = args;
  return {
    title: `${file} (${hits.length})`,
    headingLevel: 3,
    rows: hits,
    formatRow: (h) => {
      const inSym = h.enclosing ? ` — in \`${h.enclosing}\`` : '';
      return `- L${h.line}${inSym}: \`${h.text.trim()}\``;
    },
    emptyState: '',
  };
}

/** Render the grep result body — header, per-file sections, truncation/skip notes.
 *
 *  The composite top (H2 title + optional broad-pattern hint) and the
 *  trailing truncation / skipped-large blockquote notes stay hand-built
 *  — composite report shape with conditional sections, outside the
 *  bullet-list spec's scope. Per-file groups go through
 *  {@link buildGrepFileSpec}. */
function formatGrepOutput(args: FormatGrepOutputArgs): string {
  const { pattern, hits, totalMatched, limit, skippedLargeFiles } = args;
  const hitCountText = totalMatched > limit ? `${hits.length} of ${totalMatched}+` : String(hits.length);
  const lines: string[] = [
    `## Grep results for \`${pattern}\` (${hitCountText} hits)`,
    '',
  ];
  const broadHint = computeBroadPatternHint(pattern, totalMatched);
  if (broadHint !== null) {
    lines.push(broadHint, '');
  }
  const byFile = groupHitsByFile(hits);
  for (const [file, group] of byFile) {
    lines.push(renderMarkdownBulletList(buildGrepFileSpec({ file, hits: group })));
  }
  if (totalMatched > limit) {
    lines.push(
      `> _Truncated at \`limit=${limit}\` — at least ${totalMatched} total matches. Tighten \`pattern\` / add \`pathFilter\` / raise \`limit\` for more._`,
    );
  }
  if (skippedLargeFiles > 0) {
    lines.push(
      `> _Skipped ${skippedLargeFiles} file(s) larger than ${MAX_FILE_BYTES.toLocaleString()} bytes — typically minified bundles or generated code._`,
    );
  }
  return lines.join('\n');
}

/**
 * Compute the "your pattern is very broad" hint, or null if neither the
 * pattern-shape heuristic nor the hit-count threshold fired. The hint is a
 * blockquote line the renderer drops near the top of the output so the agent
 * sees it before scanning the (likely-noisy) hit list.
 *
 * Two triggers:
 *   1. Pattern is trivially broad ({@link isPatternTriviallyBroad}) — fires
 *      even on zero hits, because the agent's intent was almost certainly
 *      mis-formed (e.g. `query: '.'`).
 *   2. totalMatched exceeds {@link BROAD_PATTERN_HIT_THRESHOLD} — fires when
 *      the regex compiled cleanly but produced a flood of hits the agent
 *      probably didn't want.
 */
function computeBroadPatternHint(pattern: string, totalMatched: number): string | null {
  if (isPatternTriviallyBroad(pattern)) {
    return `> _Pattern \`${pattern}\` is very broad — it matches almost any line. Add context (e.g. \`function \`, \`import \`, \`return \\\`) or scope with \`pathFilter\` for a useful slice._`;
  }
  if (totalMatched > BROAD_PATTERN_HIT_THRESHOLD) {
    return `> _Pattern matched ${totalMatched}+ lines — likely too broad. Consider adding context (\`function \`, \`import \`, a specific identifier) or \`pathFilter\` to scope the search._`;
  }
  return null;
}

export async function handleFindByContent(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const pattern = validateStringOutcome({ value: args['pattern'], name: 'pattern' });
  if (typeof pattern !== 'string') return pattern;
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const caseSensitive = args['caseSensitive'] === true;
  const pathFilter = args['pathFilter'] as string | undefined;
  const langFilter = (args['language'] as string | undefined)?.toLowerCase();
  const limit = clamp(numArg(args['limit'], DEFAULT_LIMIT), 1, MAX_LIMIT);

  const compiled = compileGrepRegex(pattern, caseSensitive);
  if (!compiled.ok) return err(compiled.error);

  const env = await buildGrepEnvironment(cg);
  const files = filterIndexedFilesForGrep(cg, pathFilter, langFilter);

  if (files.length === 0) {
    const stripHint = pathFilterStripHint({
      pathFilter,
      projectRoot: cg.projectRoot,
      // Probe: would the stripped prefix have matched any files under
      // the SAME langFilter? Cheap — `filterIndexedFilesForGrep`
      // short-circuits on the first miss for the langFilter and the
      // full pass over `files` is the same one we'd run on the real
      // query. Bounded by indexed-files count.
      probe: (stripped) => filterIndexedFilesForGrep(cg, stripped, langFilter).length > 0,
    });
    return ok(
      textResult(
        `No indexed files match the filters (pathFilter=${pathFilter ?? '*'}, language=${langFilter ?? '*'}).${stripHint}`,
      ),
    );
  }

  const swept = sweepFilesForRegex({
    env,
    files,
    regex: compiled.regex,
    projectRoot: cg.projectRoot,
    limit,
  });
  if (swept.hits.length === 0) {
    // P5 chokepoint: the empty-result branch owns the freshness hint —
    // the message is everything BEFORE the hint; `{ cg }` resolves to
    // `freshnessHintForEmptyResult`, appended last in the one correct
    // order (regex echo → interp hint → freshness).
    return ok(
      renderToolResponse({
        body: '',
        empty: {
          message: buildGrepEmptyResultMessage({
            pattern,
            fileCount: files.length,
            regex: compiled.regex,
          }),
          freshness: { cg },
        },
      }),
    );
  }
  return ok(renderGrepResponse({ ctx, args, pattern, swept, limit }));
}

/**
 * Compose the empty-result message for by='content' grep. Echoes the
 * compiled regex (source + flags) in a fenced code block BEFORE the
 * freshness hint so the agent can spot transport-mangled patterns
 * (e.g. HTML-escaped `&lt;` becoming a literal that matches nothing)
 * before trusting the "true negative" claim that
 * {@link freshnessHintForEmptyResult} emits on an in-sync index.
 *
 * Friction F-R: without the echo, an escape bug at the transport
 * layer is indistinguishable from a real zero-match query.
 */
interface BuildGrepEmptyResultMessageArgs {
  pattern: string;
  fileCount: number;
  regex: RE2;
}

/**
 * The empty-result MESSAGE — everything up to (but not including) the
 * freshness hint. The P5 chokepoint's `empty` branch appends the
 * freshness hint after this, preserving the documented order: regex
 * echo → template-interpolation hint → freshness.
 */
function buildGrepEmptyResultMessage(args: BuildGrepEmptyResultMessageArgs): string {
  const { pattern, fileCount, regex } = args;
  const fileWord = fileCount === 1 ? 'file' : 'files';
  const interpHint = templateInterpolationHint(pattern);
  return (
    `No matches for \`${pattern}\` across ${fileCount} indexed ${fileWord}.\n\n` +
    '```\n' +
    `pattern: /${regex.source}/${regex.flags}\n` +
    '```\n' +
    '> _If the pattern above looks transport-mangled (HTML-escaped ' +
    '`&lt;` / `&amp;`, doubled backslashes, etc.) the regex compiled to a ' +
    'literal that matches zero rows — fix the call site before trusting ' +
    'the freshness hint below._' +
    interpHint
  );
}

/**
 * Detect numeric character classes (`\d`, `\d+`, `\d*`, `\d?`,
 * `\d{n,m}`) in the user's raw query. JS regex syntax — a literal
 * backslash-d in the source means a numeric-digit class at runtime.
 *
 * We only fire when the agent expected to match digits, because the
 * common interpolation footgun is `\(\+\d+ more` against source like
 * `` `(+${cappedExtra} more)` `` — the literal digit run never appears
 * because it was synthesised into the string at runtime.
 *
 * Keep narrow: trigger ONLY on `\d` (digit), not `\w` / `\s` — those
 * are too broad and would spam unrelated patterns. Negated `\D` skipped
 * for the same reason.
 */
function patternExpectsNumericInterpolation(pattern: string): boolean {
  return /\\d/.test(pattern);
}

/**
 * "Template-literal interpolation may have split your match" hint —
 * appended to the empty-result message when the user's regex contains
 * a `\d` class. Returns the empty string when the heuristic doesn't fire,
 * so callers can concatenate unconditionally.
 *
 * Friction: a regex like `\(\+\d+ more` looks for a literal char run,
 * but the source is built via `` `(+${var} more)` ``. The literal
 * `(+\d+` never appears as one continuous char range, yet the
 * freshness footer claims "true negative" — misleading.
 */
function templateInterpolationHint(pattern: string): string {
  if (!patternExpectsNumericInterpolation(pattern)) return '';
  return (
    '\n\n> _Note: template-literal interpolations split the source — ' +
    "a regex like `\\(\\+\\d+ more` won't match `` `(+${var} more)` ``. " +
    'Try matching one side of the interpolation (e.g. a nearby static ' +
    'string) or use `cartograph_find by:name` to locate the variable._'
  );
}

interface CompiledRegexOk {
  ok: true;
  regex: RE2;
}
interface CompiledRegexErr {
  ok: false;
  error: string;
}

/** Compile the user-supplied pattern with explicit success/error
 *  outcomes — keeps handleGrep a flat orchestrator, no try/catch.
 *  Uses RE2 (linear-time) instead of JS RegExp: no catastrophic
 *  backtracking, no ReDoS — even a hostile `(a+)+` pattern against
 *  a 1MB file resolves in milliseconds. Trade-off: lookahead /
 *  lookbehind / backreferences throw at construction. */
function compileGrepRegex(pattern: string, caseSensitive: boolean): CompiledRegexOk | CompiledRegexErr {
  try {
    return { ok: true, regex: compileSafeRegex(pattern, caseSensitive ? 'g' : 'gi') };
  } catch (err) {
    return {
      ok: false,
      error: `Invalid regex \`${pattern}\`: ${errMsg(err)}. cartograph_find by:'content' treats the query as a RE2 regex — escape metacharacters (e.g. \`\\(\`, \`\\[\`) to match them literally. Note: lookahead (\`(?=...)\`), lookbehind (\`(?<=...)\`), and backreferences (\`\\1\`) are not supported by RE2's linear-time engine.`,
    };
  }
}

/** Lazy-import the runtime helpers grep needs and bundle them into a
 *  reusable {@link GrepEnvironment}. Defensive default: a fresh
 *  enclosingCache per invocation so cross-call state can't leak. */
async function buildGrepEnvironment(cg: import('../../index.js').default): Promise<GrepEnvironment> {
  const fsMod = await import('node:fs');
  const { findEnclosingNode, sortScopesBySpan } = await import('../../index-hooks/enclosing.js');
  return {
    cg,
    fsMod,
    enclosingCache: new Map(),
    findEnclosingNode,
    sortScopesBySpan,
  };
}

/** Pre-filter indexed files by `pathFilter` (literal prefix) and
 *  `langFilter` (case-insensitive language match). */
function filterIndexedFilesForGrep(
  cg: import('../../index.js').default,
  pathFilter: string | undefined,
  langFilter: string | undefined,
): ReturnType<typeof getAllFiles> {
  return getAllFiles(cg.queries).filter((f) => {
    if (pathFilter && !f.path.startsWith(pathFilter)) return false;
    if (langFilter && f.language.toLowerCase() !== langFilter) return false;
    return true;
  });
}

interface SweepResult {
  hits: GrepHit[];
  totalMatched: number;
  skippedLargeFiles: number;
}

interface SweepOpts {
  env: GrepEnvironment;
  files: ReturnType<typeof getAllFiles>;
  regex: RE2;
  projectRoot: string;
  limit: number;
}

/**
 * Walk filtered indexed files, delegating per-file regex work to
 * {@link searchFileForRegex}. Stops as soon as the user-facing limit
 * is met OR a file reports the per-file budget was hit mid-file —
 * `totalMatched` then reports the count from VISITED files only,
 * matching the existing "X of Y+" message contract.
 *
 * Each path is validated to stay inside `projectRoot` (symlink-aware)
 * before being opened — defence-in-depth against an out-of-date or
 * malicious index that might point at `../` or a symlink target.
 */
function sweepFilesForRegex(opts: SweepOpts): SweepResult {
  const { env, files, regex, projectRoot, limit } = opts;
  // Phase 1: scan each file independently, collecting up to `limit`
  // hits per file (cap is per-file memory bound, NOT overall budget).
  // Earlier behaviour was budget-greedy: a single file with many
  // matches consumed the budget and pushed canonical low-occurrence
  // files (type defs, schema.sql) past the cap. Now every file gets
  // a chance to surface in the truncated output.
  const perFile: Array<{ hits: GrepHit[] }> = [];
  let totalMatched = 0;
  let skippedLargeFiles = 0;
  for (const f of files) {
    const absPath = validatePathWithinRootReal(projectRoot, f.path);
    if (absPath === null) continue;
    const result = searchFileForRegex(env, { file: f, absPath, regex, remainingBudget: limit });
    totalMatched += result.matched;
    if (result.skippedLarge) skippedLargeFiles++;
    if (result.hits.length > 0) perFile.push({ hits: result.hits });
  }

  // Phase 2: round-robin interleave across files until `limit` is
  // hit. Each file contributes its 1st hit before any file gets a
  // 2nd, then its 2nd before any gets a 3rd, etc. — preserves
  // breadth across files at the cost of depth in any single file.
  // Renderer regroups by file downstream, so input order doesn't
  // affect the final layout.
  const hits = roundRobinInterleave(perFile, limit);
  return { hits, totalMatched, skippedLargeFiles };
}

/** Pull from each non-empty bucket in turn until `cap` items collected or all empty. */
function roundRobinInterleave(perFile: Array<{ hits: GrepHit[] }>, cap: number): GrepHit[] {
  const out: GrepHit[] = [];
  if (perFile.length === 0) return out;
  while (out.length < cap) {
    let progress = false;
    for (const bucket of perFile) {
      if (out.length >= cap) break;
      const next = bucket.hits.shift();
      if (next !== undefined) {
        out.push(next);
        progress = true;
      }
    }
    if (!progress) break; // every bucket empty
  }
  return out;
}

interface RenderOpts {
  ctx: ToolCtx;
  args: Record<string, unknown>;
  pattern: string;
  swept: SweepResult;
  limit: number;
}

/**
 * Apply delta-mode filtering, render the body, mint a new call-id,
 * and stamp the call-id footer. Split out so handleGrep stays a thin
 * orchestrator and the response-building flow has one home.
 *
 * Delta-mode (#16) row key: `${file}:${line}` — same line on a
 * different file, or different line in the same file, is a different
 * hit. When every hit was already surfaced by a prior call, render
 * the empty-rows banner via {@link formatAllAlreadySeenGrepBody}
 * instead of the per-hit table.
 */
function renderGrepResponse(opts: RenderOpts): ToolResult {
  const { ctx, args, pattern, swept, limit } = opts;
  const { hits, totalMatched, skippedLargeFiles } = swept;
  const rowKey = (h: GrepHit) => `${h.file}:${h.line}`;
  const delta = applyDeltaSince({ callIds: ctx.callIds, sinceArg: args['since'], rows: hits, rowKey });
  const rendered =
    delta.rows.length === 0
      ? formatAllAlreadySeenGrepBody(pattern, delta.totalBefore)
      : formatGrepOutput({ pattern, hits: delta.rows, totalMatched, limit, skippedLargeFiles });
  // Per-axis call-id scope: distinct from `cartograph_find:name` so
  // grep delta UIDs can't collide with search delta UIDs.
  const newCallId = mintCallId({
    callIds: ctx.callIds,
    toolName: 'cartograph_find:content',
    currentKeys: hits.map(rowKey),
    priorKeys: delta.priorKeys,
  });
  const sinceMeta = buildGrepSinceMeta(delta);
  // P5 chokepoint: the delta-summary header describes the rows that
  // follow, so it stays in the BODY; the call-id marker is a FOOTER
  // the chokepoint places after truncation.
  const { header, marker } = splitCallIdFooter(newCallId, sinceMeta);
  const body = header + rendered;
  return renderToolResponse({ body, footers: [marker] });
}

/** Build the optional `since` metadata footer for grep, returning
 *  undefined when no `since` cursor was passed. */
function buildGrepSinceMeta(delta: ReturnType<typeof applyDeltaSince<GrepHit>>):
  | {
      newCount: number;
      totalBefore: number;
      sinceUid: string;
      sinceMissing: boolean;
    }
  | undefined {
  if (delta.sinceUid === null) return undefined;
  return {
    newCount: delta.rows.length,
    totalBefore: delta.totalBefore,
    sinceUid: delta.sinceUid,
    sinceMissing: delta.sinceMissing,
  };
}

/** Empty-rows banner for delta-mode grep where every hit was already
 *  surfaced in a prior call. Split out for the same reason as the
 *  search-tool's {@link formatAllAlreadySeenBody}. */
function formatAllAlreadySeenGrepBody(pattern: string, totalBefore: number): string {
  const plural = totalBefore === 1 ? '' : 's';
  return `## Grep results for \`${pattern}\` (0 new)\n\n_All ${totalBefore} hit${plural} were already returned in the prior call._`;
}

// GREP_TOOL removed — registration now lives in `find.ts` (FIND_TOOL).
// The handler is exported as `handleFindByContent` and reachable only
// through the family dispatcher when `by === 'content'`.
