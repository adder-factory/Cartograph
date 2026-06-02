/**
 * Semantic lookalike finder for PR review — dispatched via `cartograph_review({mode: 'neighbors'})`.
 *
 * Given a set of changed files or symbols, returns the top-K symbols whose
 * embeddings are most similar to those changed. The intended workflow:
 *
 *   1. Agent gets a diff / PR — either from `git diff` or a PR API.
 *   2. Pass the changed file paths (or specific qualified symbol names) here.
 *   3. Receive a ranked list of "lookalikes" that may need the same change
 *      (e.g. a sister implementation, a copy-pasted variant, a parallel
 *      handler in another language).
 *
 * Pipeline (each step extracted to its own helper to keep the
 * orchestrator small and the cyclomatic complexity per function low):
 *   1. Resolve changed files → symbols via the nodes table.
 *   2. Detect the active embedding model (config or DB fallback).
 *   3. For each changed symbol: fetch its embedding → KNN → accumulate hits.
 *   4. Rank by max similarity, take top K.
 *   5. Fetch node metadata for the ranked neighbors.
 *   6. Format markdown output.
 */

import { errMsg } from '../../errors.js';
import { getEmbeddingForNode } from '../../db/queries-embeddings.js';
import { findSimilarViaVec } from '../../db/vec-helpers.js';
import { bytesToVector } from '../../llm/embeddings.js';
import { textResult, truncateOutput } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type { ToolCtx } from './types.js';
import type Cartograph from '../../index.js';
import {
  renderMarkdownBulletList,
  renderMarkdownCardList,
  type MarkdownBulletListSpec,
  type MarkdownCardListSpec,
} from './_result-spec.js';

/**
 * Preamble blockquote that introduces the "Top N lookalikes" section.
 * Exported so the wording-lint can pin the load-bearing
 * "semantically similar" phrasing without re-stating it.
 */
export const REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE =
  '> These symbols are semantically similar to the changed set and may need the same kind of change.';

/** Default and maximum number of lookalikes to return. */
const DEFAULT_K = 5;
const MAX_K = 50;

/** Node kinds excluded when resolving files → symbols (structural / non-semantic). */
const EXCLUDED_KINDS = `('file', 'import', 'export')`;

/** Cap on the size of the "Changed symbols" list rendered in output. */
const MAX_CHANGED_DISPLAY = 20;

interface ResolvedNode {
  id: string;
  name: string;
  filePath: string;
  signature: string | null;
}

interface NeighborRow {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string | null;
}

// ---------------------------------------------------------------------------
// Step 1 — resolve files/symbols → changed nodes
// ---------------------------------------------------------------------------

interface ResolveChangedNodesArgs {
  db: ReturnType<Cartograph['db']['getDb']>;
  files: string[];
  symbols: string[];
}

function resolveChangedNodes(args: ResolveChangedNodesArgs): { changedNodes: ResolvedNode[]; changedIds: Set<string> } {
  const { db, files, symbols } = args;
  const changedNodes: ResolvedNode[] = [];
  const changedIds = new Set<string>();

  if (files.length > 0) {
    const placeholders = files.map(() => '?').join(', ');
    const rows = db
      .prepare(
        `SELECT id, name, file_path, signature
           FROM nodes
          WHERE file_path IN (${placeholders})
            AND kind NOT IN ${EXCLUDED_KINDS}`,
      )
      .all(...files) as Array<{ id: string; name: string; file_path: string; signature: string | null }>;
    for (const r of rows) {
      if (changedIds.has(r.id)) continue;
      changedIds.add(r.id);
      changedNodes.push({ id: r.id, name: r.name, filePath: r.file_path, signature: r.signature });
    }
  }

  if (symbols.length > 0) {
    const placeholders = symbols.map(() => '?').join(', ');
    // Match on both qualified_name and bare name; dedup in JS.
    const rows = db
      .prepare(
        `SELECT id, name, file_path, signature
           FROM nodes
          WHERE (qualified_name IN (${placeholders}) OR name IN (${placeholders}))
            AND kind NOT IN ${EXCLUDED_KINDS}`,
      )
      .all(...symbols, ...symbols) as Array<{ id: string; name: string; file_path: string; signature: string | null }>;
    for (const r of rows) {
      if (changedIds.has(r.id)) continue;
      changedIds.add(r.id);
      changedNodes.push({ id: r.id, name: r.name, filePath: r.file_path, signature: r.signature });
    }
  }

  return { changedNodes, changedIds };
}

// ---------------------------------------------------------------------------
// Step 2 — detect active embedding model (config first, DB fallback)
// ---------------------------------------------------------------------------

async function detectEmbeddingModel(cg: Cartograph): Promise<string | null> {
  try {
    const resolved = await cg.llm.config.resolveLlmConfig();
    const fromConfig = resolved?.embeddingLlm?.model ?? null;
    if (fromConfig) return fromConfig;
  } catch {
    // LLM config unavailable — try DB fallback.
  }
  try {
    const db = cg.db.getDb();
    const modelRow = db
      .prepare(`SELECT DISTINCT embedding_model FROM symbol_embeddings WHERE grain = 'symbol' LIMIT 1`)
      .get() as { embedding_model?: string } | undefined;
    return modelRow?.embedding_model ?? null;
  } catch {
    // symbol_embeddings table may not exist (pre-migration state).
    return null;
  }
}

// ---------------------------------------------------------------------------
// Step 3 — aggregate KNN hits across the changed set
// ---------------------------------------------------------------------------

interface AggregateNeighborsArgs {
  cg: Cartograph;
  changedNodes: ResolvedNode[];
  changedIds: Set<string>;
  embeddingModel: string;
  k: number;
}

function aggregateNeighbors(args: AggregateNeighborsArgs): { aggregate: Map<string, number>; embeddedCount: number } {
  const { cg, changedNodes, changedIds, embeddingModel, k } = args;
  const aggregate = new Map<string, number>(); // nodeId → max similarity score
  const vecLoaded = cg.db.hasVecExtension();
  const fetchK = k + changedNodes.length;
  let embeddedCount = 0;

  for (const node of changedNodes) {
    const buf = getEmbeddingForNode(cg.queries, node.id, embeddingModel);
    if (!buf) continue;
    embeddedCount++;

    let vec: Float32Array;
    try {
      vec = bytesToVector(buf);
    } catch {
      continue;
    }

    const hits = findSimilarViaVec({
      db: cg.db.getDb(),
      vecLoaded,
      queryVec: vec,
      model: embeddingModel,
      k: fetchK,
    });

    for (const h of hits) {
      if (changedIds.has(h.nodeId)) continue; // exclude changed set
      const sim = 1 - h.distance; // cosine similarity from cosine distance
      const cur = aggregate.get(h.nodeId);
      if (cur === undefined || sim > cur) aggregate.set(h.nodeId, sim);
    }
  }

  return { aggregate, embeddedCount };
}

// ---------------------------------------------------------------------------
// Step 5 — fetch node metadata for the ranked neighbors
// ---------------------------------------------------------------------------

function fetchNeighborMetadata(db: ReturnType<Cartograph['db']['getDb']>, rankedIds: string[]): NeighborRow[] {
  if (rankedIds.length === 0) return [];
  const neighborPlaceholders = rankedIds.map(() => '?').join(', ');
  const rows = db
    .prepare(
      `SELECT id, name, qualified_name, kind, file_path, start_line, signature
         FROM nodes
        WHERE id IN (${neighborPlaceholders})`,
    )
    .all(...rankedIds) as Array<{
    id: string;
    name: string;
    qualified_name: string;
    kind: string;
    file_path: string;
    start_line: number;
    signature: string | null;
  }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    qualifiedName: r.qualified_name,
    kind: r.kind,
    filePath: r.file_path,
    startLine: r.start_line,
    signature: r.signature,
  }));
}

// ---------------------------------------------------------------------------
// Step 5a — trivial-constant filter (friction-23)
// ---------------------------------------------------------------------------

/** Node kinds whose bodies are usually a single literal — filtered when
 *  their body is trivial (see {@link isTrivialConstant}). */
const CONSTANT_LIKE_KINDS: ReadonlySet<string> = new Set(['constant', 'variable']);

/**
 * Matches a "trivial" constant body — an assignment to a single literal
 * token: a number (`= 1`, `= 3.5`, `= 0xff`), a boolean, `null`/
 * `undefined`, or a short string/char literal (at most 16 characters).
 * Tiny-bodied constants
 * like these all embed to near-identical vectors, so a global KNN over
 * the changed set trivially fills with every `= <int>` in the repo
 * (friction-23) — they are noise for "what may need the same change".
 *
 * Deliberately conservative: a constant with a *structured* initializer
 * (object / array / call / template literal — e.g. `= { a: 1 }`,
 * `= computeDefault()`, `` = `tpl ${x}` ``) is NOT trivial and stays in
 * the pool, since it carries real structure a reviewer would want a
 * lookalike for. Backtick literals are deliberately NOT in the trivial
 * set — a template literal can carry an interpolation.
 */
const DECIMAL_LITERAL_RE = /^-?\d[\d_]*(?:\.\d+)?(?:e-?\d+)?$/i;
const BASE_LITERAL_RE = /^0[xob][0-9a-f_]+$/i;
const TRIVIAL_KEYWORD_LITERALS: ReadonlySet<string> = new Set(['true', 'false', 'null', 'undefined']);

function isTrivialConstantBody(signature: string): boolean {
  const trimmed = signature.trim();
  if (!trimmed.startsWith('=')) return false;
  let value = trimmed.slice(1).trim();
  if (value.endsWith(';')) value = value.slice(0, -1).trim();
  if (TRIVIAL_KEYWORD_LITERALS.has(value.toLowerCase())) return true;
  if (DECIMAL_LITERAL_RE.test(value)) return true;
  if (BASE_LITERAL_RE.test(value)) return true;
  return isShortStringLiteral(value, "'") || isShortStringLiteral(value, '"');
}

function isShortStringLiteral(value: string, quote: "'" | '"'): boolean {
  if (!value.startsWith(quote) || !value.endsWith(quote)) return false;
  const body = value.slice(1, -1);
  return body.length <= 16 && !body.includes(quote);
}

/**
 * True when `kind`/`signature` describe a constant/variable bound to a
 * single trivial literal. Used to drop such symbols from the neighbor
 * candidate pool — they crowd out structurally-meaningful peers.
 */
export function isTrivialConstant(kind: string, signature: string | null): boolean {
  if (!CONSTANT_LIKE_KINDS.has(kind)) return false;
  // No signature recorded → can't prove it's structured; treat a
  // bare constant as trivial (the common one-liner case).
  if (signature == null || signature.trim() === '') return true;
  return isTrivialConstantBody(signature);
}

// ---------------------------------------------------------------------------
// Step 5b — name-based dedupe (friction-30)
// ---------------------------------------------------------------------------

/**
 * Drop duplicate-name neighbors from a ranked `[id, score]` list. When a
 * pattern like `requireCjs = createRequire(import.meta.url)` appears in
 * N files, the embedding for each clone is near-identical, so the global
 * top-K trivially fills with `requireCjs × N`. After dedupe, only the
 * highest-scoring instance of each name survives — domain-relevant
 * peers stop being crowded out.
 *
 * The first occurrence wins because the input is sorted by score
 * descending. Order is otherwise preserved (so downstream `.slice(0, k)`
 * picks the top-K by score). Rows whose `id` is missing from `byId`
 * (metadata fetch returned a smaller set than expected) are kept as-is
 * — we can't dedupe a row we can't name.
 */
function dedupeRankedByName(ranked: Array<[string, number]>, byId: Map<string, NeighborRow>): Array<[string, number]> {
  const seenNames = new Set<string>();
  const out: Array<[string, number]> = [];
  for (const entry of ranked) {
    const row = byId.get(entry[0]);
    if (!row) {
      out.push(entry);
      continue;
    }
    if (seenNames.has(row.name)) continue;
    seenNames.add(row.name);
    out.push(entry);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Step 6 — format output
// ---------------------------------------------------------------------------

interface FormatOutputArgs {
  embeddingModel: string;
  changedNodes: ResolvedNode[];
  embeddedCount: number;
  ranked: Array<[string, number]>;
  byId: Map<string, NeighborRow>;
  /** Count of trivial-constant candidates dropped before ranking
   *  (friction-23). 0 when none were dropped or the filter no-op'd. */
  trivialFiltered: number;
}

/**
 * Build the "Changed symbols" H2 bullet-list spec. Title interpolates
 * the total count; rows are pre-rendered bullets (`- **name** \`file\`
 * — \`sig\``) plus an optional `- _(and N more)_` overflow row when
 * `changedNodes.length > MAX_CHANGED_DISPLAY`. Identity-passthrough
 * formatRow matches the established pattern (changed-since per-bucket
 * / imports per-kind / grep per-file / callees+callers per-source).
 *
 * Caller (`formatReviewNeighborsOutput`) is reached only when at
 * least one changed node was resolved upstream — `emptyState` is the
 * never-rendered empty string.
 */
export function buildReviewNeighborsChangedSymbolsSpec(args: {
  changedNodes: ReadonlyArray<{ name: string; filePath: string; signature: string | null }>;
}): MarkdownBulletListSpec<string> {
  const { changedNodes } = args;
  const shown = changedNodes.slice(0, MAX_CHANGED_DISPLAY);
  const bullets = shown.map((c) => {
    const sig = c.signature ? ` — \`${c.signature}\`` : '';
    return `- **${c.name}** \`${c.filePath}\`${sig}`;
  });
  const overflow = changedNodes.length - shown.length;
  const rows = overflow > 0 ? [...bullets, `- _(and ${overflow} more)_`] : bullets;
  return {
    title: `Changed symbols (${changedNodes.length})`,
    rows,
    formatRow: (s) => s,
    emptyState: '',
  };
}

/** One ranked lookalike row consumed by {@link buildReviewNeighborsLookalikesSpec}.
 *  Pre-resolved from `ranked` + `byId` so the spec's rowHeading/rowBody
 *  work on a typed shape rather than walking a Map. */
export interface ReviewNeighborsRankedRow {
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  signature: string | null;
  score: number;
}

/** Resolve `ranked` (Array<[id, score]>) + `byId` lookup into typed
 *  rows for the card-list spec, skipping any id with no matching row
 *  (mirrors the pre-migration `if (!r) continue` guard).
 *
 *  Side effect of upstream-filtering: the lookalikes section title
 *  now interpolates the RESOLVED row count (post-skip), not the raw
 *  `ranked.length`. When a ranked id has no matching `byId` entry
 *  (transient DB miss or stale aggregate row), pre-migration would
 *  print `## Top 5 lookalikes` but render only 3 cards; post-migration
 *  prints `## Top 3 lookalikes` matching what the user sees. The
 *  rare case where this matters is a transient miss; the new shape
 *  is the accurate one. */
function resolveLookalikeRows(
  ranked: ReadonlyArray<[string, number]>,
  byId: Map<string, NeighborRow>,
): ReviewNeighborsRankedRow[] {
  const out: ReviewNeighborsRankedRow[] = [];
  for (const [id, score] of ranked) {
    const r = byId.get(id);
    if (!r) continue;
    out.push({
      name: r.name,
      kind: r.kind,
      filePath: r.filePath,
      startLine: r.startLine,
      signature: r.signature,
      score,
    });
  }
  return out;
}

/**
 * Build the "Top N lookalikes" H2 card-list spec. Mirror of the
 * `_search-semantic` concept branch shape:
 *  - title interpolates `${ranked.length} lookalike(s)` (singular/plural)
 *  - preamble carries `REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE` plus an
 *    optional `> _Filtered N trivial constants…_` blockquote when
 *    upstream's trivial-constant filter dropped any rows (friction-23)
 *  - per-card heading `${name} (${kind}) — score X.XXX` (raw-decimal
 *    toFixed(3), no `*100` — same no-percent invariant as the search
 *    family)
 *  - rowBody `[\`${file}${:line?}\`, optional \`${signature}\`]`
 *
 * Empty ranked → spec renders `emptyState` verbatim. In practice the
 * caller is only reached when ranked has at least one resolved row;
 * keeping `emptyState: ''` documents that the empty path is
 * unreachable through normal flow.
 */
export function buildReviewNeighborsLookalikesSpec(args: {
  ranked: ReadonlyArray<ReviewNeighborsRankedRow>;
  trivialFiltered: number;
}): MarkdownCardListSpec<ReviewNeighborsRankedRow> {
  const { ranked, trivialFiltered } = args;
  const preamble: string[] = [REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE];
  if (trivialFiltered > 0) {
    preamble.push(
      '>',
      `> _Filtered ${trivialFiltered} trivial constant${trivialFiltered === 1 ? '' : 's'} (single-literal \`= <int>\`-style bindings) — they embed near-identically and crowd out structural peers._`,
    );
  }
  return {
    title: `Top ${ranked.length} lookalike${ranked.length === 1 ? '' : 's'}`,
    preamble,
    rows: ranked,
    rowHeading: (r) => `${r.name} (${r.kind}) — score ${r.score.toFixed(3)}`,
    rowBody: (r) => {
      const loc = r.startLine ? `:${r.startLine}` : '';
      const body: string[] = [`\`${r.filePath}${loc}\``];
      if (r.signature) body.push(`\`${r.signature}\``);
      return body;
    },
    emptyState: '',
  };
}

function formatReviewNeighborsOutput(args: FormatOutputArgs): string {
  const { embeddingModel, changedNodes, embeddedCount, ranked, byId, trivialFiltered } = args;
  const lines: string[] = [];
  lines.push(
    '# Review neighbors — semantic lookalikes for changed symbols',
    '',
    `Embedding model: \`${embeddingModel}\``,
    `Changed symbols with embeddings: ${embeddedCount} / ${changedNodes.length}`,
    '',
  );

  const rankedRows = resolveLookalikeRows(ranked, byId);
  lines.push(
    renderMarkdownBulletList(buildReviewNeighborsChangedSymbolsSpec({ changedNodes })),
    renderMarkdownCardList(buildReviewNeighborsLookalikesSpec({ ranked: rankedRows, trivialFiltered })),
  );

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Step — rank the aggregated neighbor pool down to the final top-K
// ---------------------------------------------------------------------------

interface RankNeighborPoolArgs {
  db: ReturnType<Cartograph['db']['getDb']>;
  aggregate: Map<string, number>;
  k: number;
  dedupeByName: boolean;
}

interface RankedNeighborPool {
  ranked: [string, number][];
  byId: Map<string, NeighborRow>;
  trivialFiltered: number;
}

/**
 * Turn the raw similarity aggregate into the final ranked top-K.
 *
 * Ranks globally first; the dedupe pass needs node NAMES to drop
 * duplicates, so metadata is fetched BEFORE slicing to k. To avoid an
 * unbounded fetch when the aggregate is huge, a generous prefix
 * (k * 10, capped at 200) is taken — enough room to drop duplicates
 * and still surface k unique-named peers in the common case.
 *
 * Returns the metadata-fetch error as a `ToolOutcome` (caller returns
 * it verbatim) so the orchestrator's early-out contract is preserved.
 */
function rankNeighborPool(args: RankNeighborPoolArgs): RankedNeighborPool | ToolOutcome {
  const { db, aggregate, k, dedupeByName } = args;
  const fullyRanked = [...aggregate.entries()].sort((a, b) => b[1] - a[1]);
  const prefetchCap = Math.min(Math.max(k * 10, k), 200);
  const candidateRanked = fullyRanked.slice(0, prefetchCap);
  const candidateIds = candidateRanked.map(([id]) => id);
  let neighborRows: NeighborRow[];
  try {
    neighborRows = fetchNeighborMetadata(db, candidateIds);
  } catch (e) {
    return err(`Failed to fetch neighbor metadata: ${errMsg(e)}`);
  }
  const byId = new Map(neighborRows.map((r) => [r.id, r]));

  // Friction-23: drop trivial integer/literal constants from the
  // candidate pool. Tiny-bodied constants all embed to near-identical
  // vectors, so a global KNN trivially fills the top-K with every
  // `= <int>` in the repo — useless for "what may need the same
  // change". A row with no metadata is kept (can't prove triviality).
  const meaningfulRanked = candidateRanked.filter(([id]) => {
    const row = byId.get(id);
    return !row || !isTrivialConstant(row.kind, row.signature);
  });
  // If filtering emptied the pool entirely (all neighbors were trivial
  // constants), fall back to the unfiltered set so the agent still
  // gets a — clearly weaker — answer rather than a bare "no neighbors".
  const filteredRanked = meaningfulRanked.length > 0 ? meaningfulRanked : candidateRanked;
  const rawTrivialFiltered = candidateRanked.length - meaningfulRanked.length;

  const ranked = dedupeByName ? dedupeRankedByName(filteredRanked, byId).slice(0, k) : filteredRanked.slice(0, k);

  return {
    ranked,
    byId,
    trivialFiltered: meaningfulRanked.length > 0 ? rawTrivialFiltered : 0,
  };
}

// ---------------------------------------------------------------------------
// Orchestrator — thin wrapper that chains the helpers above and returns
// early-out messages at well-defined boundaries
// ---------------------------------------------------------------------------

export async function handleReviewNeighbors(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const files = Array.isArray(args['files']) ? (args['files'] as string[]).filter((f) => typeof f === 'string') : [];
  const symbols = Array.isArray(args['symbols'])
    ? (args['symbols'] as string[]).filter((s) => typeof s === 'string')
    : [];
  const requestedK = Number(args['k'] ?? DEFAULT_K);
  const k = Math.max(1, Math.min(MAX_K, requestedK));
  // Surface a silent down-clamp so an over-large `k` doesn't read as
  // "only this many lookalikes exist".
  const kCapNotice =
    Number.isFinite(requestedK) && requestedK > MAX_K ? `\n\n> _Requested k ${requestedK}, capped at ${MAX_K}._` : '';
  // Friction-30: boilerplate-constant clones (e.g. `requireCjs =
  // createRequire(import.meta.url)`) appear identically in N files and
  // dominate the top-K when ranked globally. With `dedupeByName: true`
  // (default), only the highest-scoring instance of each neighbor NAME
  // survives — domain-relevant peers stop being crowded out by
  // duplicate-name clones. Pass `dedupeByName: false` to recover the
  // legacy behaviour (every clone surfaces individually).
  const dedupeByName = args['dedupeByName'] !== false;

  if (files.length === 0 && symbols.length === 0) {
    return err(
      'Pass at least one of `files: string[]` (changed file paths) or `symbols: string[]` (changed symbol names).',
    );
  }

  const db = cg.db.getDb();

  let changedNodes: ResolvedNode[];
  let changedIds: Set<string>;
  try {
    ({ changedNodes, changedIds } = resolveChangedNodes({ db, files, symbols }));
  } catch (e) {
    return err(`Failed to resolve symbols: ${errMsg(e)}`);
  }

  if (changedNodes.length === 0) {
    return ok(
      textResult(
        'No symbols resolved from the inputs. ' +
          'Verify file paths are relative to the project root and match the index, ' +
          'or that symbol names (qualified or simple) are indexed.',
      ),
    );
  }

  const embeddingModel = await detectEmbeddingModel(cg);
  if (!embeddingModel) {
    return ok(
      textResult(
        `Found ${changedNodes.length} changed symbol(s) but no embedding model is configured or no embeddings exist. ` +
          'Run `cartograph_admin({action: "index"})` followed by `cartograph_admin({action: "embed"})` (or `{action: "summarize"}`) to generate embeddings.',
      ),
    );
  }

  const { aggregate, embeddedCount } = aggregateNeighbors({ cg, changedNodes, changedIds, embeddingModel, k });
  if (embeddedCount === 0) {
    return ok(
      textResult(
        `Found ${changedNodes.length} changed symbol(s) but none have embeddings for model \`${embeddingModel}\`. ` +
          'Run `cartograph_admin({action: "embed"})` (or `{action: "summarize"}`) to populate embeddings.',
      ),
    );
  }
  if (aggregate.size === 0) {
    return ok(
      textResult(
        `Found ${changedNodes.length} changed symbol(s) with embeddings, but no semantic neighbors above threshold. ` +
          'The changed symbols may be unique in this codebase or embeddings have not been run on the full corpus.',
      ),
    );
  }

  const pool = rankNeighborPool({ db, aggregate, k, dedupeByName });
  if ('ok' in pool) return pool;
  const { ranked, byId, trivialFiltered } = pool;

  return ok(
    textResult(
      truncateOutput(
        formatReviewNeighborsOutput({
          embeddingModel,
          changedNodes,
          embeddedCount,
          ranked,
          byId,
          trivialFiltered,
        }) + kCapNotice,
      ),
    ),
  );
}
