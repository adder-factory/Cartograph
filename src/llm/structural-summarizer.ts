/**
 * Structural Summariser
 *
 * Deterministic synthetic-summary pipeline that runs BEFORE the LLM
 * phase. Writes one-line descriptions for symbols whose bodies are too
 * thin for the LLM to add value (1-3 lines) plus every route node,
 * using only the existing graph edges and AST patterns — zero LLM calls.
 *
 * Summaries land in `symbol_summaries` with `model='structural:v1'`
 * so the `getSymbolDescriptions` cascade (summary > docstring) picks
 * them up transparently — consumers don't need to know the summary was
 * generated structurally.
 *
 * LLM/agent summaries always win: if a non-structural summary already
 * exists for a node, the node is counted as `preserved` and left alone.
 *
 * Content-hash cache: reuses `contentHashFor` from `summarizer.ts` so
 * a body change invalidates the structural summary on the next pass —
 * the same cache-invalidation logic the LLM pass uses.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Node } from '../types.js';
import { type QueryBuilder, type NodeRow, rowToNode } from '../db/queries.js';
import { getSymbolSummary, upsertSymbolSummary } from '../db/queries-summaries.js';
import { withSqliteBusyRetry } from '../utils-concurrency.js';
import { getOutgoingEdges } from '../db/queries-edges.js';
import { SUMMARIZABLE_KINDS, contentHashFor, MIN_BODY_LINES } from './summarizer.js';
import { validatePathWithinRootReal } from '../utils.js';
import { logDebug, logWarn } from '../errors.js';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

interface StructuralSummariserOptions {
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface StructuralSummariserResult {
  /** Nodes evaluated (candidate set). */
  candidates: number;
  /** Synthetic summaries written this run. */
  generated: number;
  /** No structural pattern matched; left for the LLM phase. */
  skipped: number;
  /** Existing non-structural summary kept (LLM/agent wins). */
  preserved: number;
  /** Total wall-clock duration in ms. */
  durationMs: number;
}

/** Model label written into `symbol_summaries.model`. */
const STRUCTURAL_MODEL = 'structural:v1';

/** Max chars in produced summaries (matches LLM summarizer cap). */
const MAX_SUMMARY_CHARS = 200;

/** Max body-line count eligible for structural summarisation. Sourced
 *  from the LLM pass's MIN_BODY_LINES so the two stay in lock-step:
 *  symbols below MIN_BODY_LINES are skipped by the LLM pass (the LLM
 *  adds nothing to a 1-line forwarder), and this pass picks up exactly
 *  that gap. Routes are included regardless of body length —
 *  MIN_BODY_LINES_BY_KIND['route']=1 already lets short routes through
 *  to the LLM, but the structural pass also synthesises route summaries
 *  so intent-search works without a summarize backend. */
const STRUCTURAL_MAX_BODY_LINES = MIN_BODY_LINES - 1;

// ---------------------------------------------------------------------------
// Candidate enumeration
// ---------------------------------------------------------------------------

/**
 * Fetch nodes eligible for structural summarisation:
 *   - All route nodes (regardless of body length).
 *   - All non-route nodes in SUMMARIZABLE_KINDS whose body is ≤
 *     STRUCTURAL_MAX_BODY_LINES lines (the gap below the LLM threshold).
 *   - `type_alias` nodes with no body (0 lines) — often declaration-only.
 *
 * Ordered by `updated_at DESC` (freshly-edited first, same priority as
 * the LLM pass) then by file_path/start_line for file-cache warmth.
 *
 * The SQL is inlined here (not in queries-summaries.ts) per the task
 * scope constraint: DO NOT touch existing source files.
 */
function getStructuralCandidates(qb: QueryBuilder): Node[] {
  const kinds = [...SUMMARIZABLE_KINDS, 'route'];
  // Deduplicate: SUMMARIZABLE_KINDS already includes 'route', but the
  // Set guarantees we don't produce a duplicate placeholder.
  const uniqueKinds = [...new Set(kinds)];
  if (uniqueKinds.length === 0) return [];

  const placeholders = uniqueKinds.map(() => '?').join(',');

  // Route nodes: always included (body-line check waived).
  // Non-route nodes in SUMMARIZABLE_KINDS: body ≤ STRUCTURAL_MAX_BODY_LINES.
  // The CASE expression avoids two separate queries.
  const sql = `
    SELECT * FROM nodes
    WHERE kind IN (${placeholders})
      AND (
        kind = 'route'
        OR (end_line - start_line) <= ?
      )
    ORDER BY updated_at DESC, file_path, start_line
  `;
  const rows = qb.db.prepare(sql).all(...uniqueKinds, STRUCTURAL_MAX_BODY_LINES) as NodeRow[];
  return rows.map(rowToNode);
}

// ---------------------------------------------------------------------------
// File-content helpers
// ---------------------------------------------------------------------------

/**
 * Read a project file's lines, constrained to `projectRoot` (symlink-
 * resistant). Returns null on any read error.
 */
function loadFileLinesSafely(projectRoot: string, filePath: string): string[] | null {
  const safePath = validatePathWithinRootReal(projectRoot, filePath);
  if (!safePath) return null;
  try {
    return fs.readFileSync(safePath, 'utf-8').split('\n');
  } catch {
    return null;
  }
}

/** Extract the body text for a node from a pre-loaded lines array. */
function extractBody(lines: string[], sym: Node): string {
  return lines.slice(Math.max(0, sym.startLine - 1), sym.endLine).join('\n');
}

// ---------------------------------------------------------------------------
// Pattern helpers
// ---------------------------------------------------------------------------

/** Truncate a produced summary to the global cap. */
function cap(s: string): string {
  return s.length > MAX_SUMMARY_CHARS ? s.slice(0, MAX_SUMMARY_CHARS - 1) + '…' : s;
}

/**
 * Resolve a target node by its ID, returning a brief description
 * (summary or docstring) if one exists — used to enrich synthetic
 * forwarder/route summaries.
 *
 * Returns null when the target doesn't exist or has no description.
 */
function resolveTargetDescription(qb: QueryBuilder, targetId: string): string | null {
  const row = qb.db
    .prepare(
      `SELECT n.name, n.docstring,
              NULLIF(ss.summary, '') AS summary
         FROM nodes n
         LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
        WHERE n.id = ?`,
    )
    .get(targetId) as { name: string; docstring: string | null; summary: string | null } | undefined;
  if (!row) return null;
  return row.summary ?? row.docstring ?? null;
}

/**
 * Resolve the name of a target node. Returns null when not found.
 */
function resolveTargetName(qb: QueryBuilder, targetId: string): string | null {
  const row = qb.db.prepare('SELECT name FROM nodes WHERE id = ?').get(targetId) as { name: string } | undefined;
  return row?.name ?? null;
}

/**
 * Resolve the `file_path` of a target node. Returns null when not found.
 */
function resolveTargetFilePath(qb: QueryBuilder, targetId: string): string | null {
  const row = qb.db.prepare('SELECT file_path FROM nodes WHERE id = ?').get(targetId) as
    | { file_path: string }
    | undefined;
  return row?.file_path ?? null;
}

// ---------------------------------------------------------------------------
// Pattern detectors (first match wins in applyPattern)
// ---------------------------------------------------------------------------

/**
 * Pattern 1 — Route node.
 *
 * Route names are conventionally `"METHOD /path"` (e.g. `"GET /users"`),
 * set by every framework extractor. We normalise that into
 * `"HTTP GET /users"` and optionally append the handler summary.
 */
function patternRoute(qb: QueryBuilder, sym: Node): string | null {
  if (sym.kind !== 'route') return null;

  // name is "METHOD /path" — parse out the components.
  // Some extractors omit the space; fall back gracefully.
  const name = sym.name.trim();
  let httpLine: string;
  if (/^[A-Z]+\s+\//.test(name)) {
    // "GET /users" → already the right shape
    httpLine = `HTTP ${name}`;
  } else if (/^[A-Z]+:\//.test(name)) {
    // "GET:/users" format (less common)
    httpLine = `HTTP ${name.replace(':', ' ')}`;
  } else {
    // Fallback: use the raw name
    httpLine = `HTTP ${name}`;
  }

  // Try to find the handler via a `calls` edge
  const callsEdges = getOutgoingEdges(qb, sym.id, ['calls']);
  if (callsEdges.length > 0) {
    const edge = callsEdges[0]!;
    const desc = resolveTargetDescription(qb, edge.target);
    if (desc) {
      const shortDesc = desc.slice(0, 80);
      return cap(`${httpLine} → ${shortDesc}`);
    }
    // Handler exists but no description yet
    const handlerName = resolveTargetName(qb, edge.target);
    if (handlerName) {
      return cap(`${httpLine} (handler: ${handlerName})`);
    }
  }

  return cap(httpLine);
}

/**
 * Pattern 2 — One-call forwarder.
 *
 * Body 1-3 lines, exactly one outgoing `calls` edge.
 */
function patternOneCallForwarder(qb: QueryBuilder, sym: Node): string | null {
  if (sym.kind === 'route') return null;
  const bodyLines = sym.endLine - sym.startLine;
  if (bodyLines > STRUCTURAL_MAX_BODY_LINES) return null;

  const callsEdges = getOutgoingEdges(qb, sym.id, ['calls']);
  if (callsEdges.length !== 1) return null;

  const edge = callsEdges[0]!;
  const targetName = resolveTargetName(qb, edge.target);
  if (!targetName) return null;

  const desc = resolveTargetDescription(qb, edge.target);
  if (desc) {
    const shortDesc = desc.slice(0, 80);
    return cap(`Delegates to ${targetName} (${shortDesc})`);
  }
  return cap(`Delegates to ${targetName}`);
}

/**
 * Pattern 3 — One-instantiation factory.
 *
 * Body 1-3 lines, exactly one outgoing `instantiates` edge.
 */
function patternOneInstantiationFactory(qb: QueryBuilder, sym: Node): string | null {
  if (sym.kind === 'route') return null;
  const bodyLines = sym.endLine - sym.startLine;
  if (bodyLines > STRUCTURAL_MAX_BODY_LINES) return null;

  const instantiatesEdges = getOutgoingEdges(qb, sym.id, ['instantiates']);
  if (instantiatesEdges.length !== 1) return null;

  const edge = instantiatesEdges[0]!;
  const targetName = resolveTargetName(qb, edge.target);
  if (!targetName) return null;

  return cap(`Factory for ${targetName}`);
}

/**
 * Pattern 4 — Single field accessor.
 *
 * Body 1-3 lines, exactly one outgoing `field_access` edge, no `calls`.
 * Distinguish getter/setter from the signature.
 */
function patternSingleFieldAccessor(qb: QueryBuilder, sym: Node): string | null {
  if (sym.kind === 'route') return null;
  const bodyLines = sym.endLine - sym.startLine;
  if (bodyLines > STRUCTURAL_MAX_BODY_LINES) return null;

  const fieldEdges = getOutgoingEdges(qb, sym.id, ['field_access']);
  if (fieldEdges.length !== 1) return null;

  // Must have no calls (otherwise it's more than just a field accessor)
  const callsEdges = getOutgoingEdges(qb, sym.id, ['calls']);
  if (callsEdges.length > 0) return null;

  const edge = fieldEdges[0]!;
  const metadataFieldName = edge.metadata?.['fieldName'];
  const fieldName =
    resolveTargetName(qb, edge.target) ?? (typeof metadataFieldName === 'string' ? metadataFieldName : 'field');

  const sig = sym.signature ?? '';
  let verb: string;
  if (/\bget\s+\w/.test(sig)) {
    verb = 'Gets';
  } else if (/\bset\s+\w/.test(sig)) {
    verb = 'Sets';
  } else {
    verb = 'Accesses';
  }

  return cap(`${verb} ${fieldName}`);
}

/**
 * Pattern 5 — Re-export.
 *
 * kind in {function, type_alias, interface, class, method} with body
 * 1-2 lines and an outgoing `references` edge to a node in another file.
 */
function patternReExport(qb: QueryBuilder, sym: Node): string | null {
  const reExportKinds = new Set(['function', 'type_alias', 'interface', 'class', 'method']);
  if (!reExportKinds.has(sym.kind)) return null;

  const bodyLines = sym.endLine - sym.startLine;
  // Re-exports typically occupy 1-2 lines
  if (bodyLines > 2) return null;

  const refEdges = getOutgoingEdges(qb, sym.id, ['references']);
  if (refEdges.length === 0) return null;

  // Pick the first cross-file reference
  const crossFileEdge = refEdges.find((e) => {
    const targetFile = resolveTargetFilePath(qb, e.target);
    return targetFile && targetFile !== sym.filePath;
  });
  if (!crossFileEdge) return null;

  const targetName = resolveTargetName(qb, crossFileEdge.target);
  if (!targetName) return null;

  const targetFile = resolveTargetFilePath(qb, crossFileEdge.target);
  if (!targetFile) return null;

  // Compute relative path from project root (use the stored path, which
  // is already relative to the project root in cartograph's convention).
  const relPath = path.relative(path.dirname(sym.filePath), targetFile) || targetFile;

  return cap(`Re-exports ${targetName} from ${relPath}`);
}

/**
 * Pattern 6 — Type-only alias.
 *
 * kind='type_alias', no edges, signature contains `=`.
 */
function patternTypeOnlyAlias(qb: QueryBuilder, sym: Node): string | null {
  if (sym.kind !== 'type_alias') return null;

  const sig = sym.signature ?? '';
  if (!sig.includes('=')) return null;

  // Require no edges (truly structural alias, not a re-export)
  const allEdges = getOutgoingEdges(qb, sym.id);
  if (allEdges.length > 0) return null;

  // Extract the RHS of the type alias: everything after the first `=`
  const eqIdx = sig.indexOf('=');
  const rhs = sig
    .slice(eqIdx + 1)
    .trim()
    .replace(/;$/, '')
    .trim();
  if (!rhs) return null;

  return cap(`Type alias for ${rhs.slice(0, 80)}`);
}

/**
 * Pattern 7 — Empty / abstract / declaration-only.
 *
 * 0 lines body OR signature ends with `;` (declaration only, no body).
 */
function patternEmptyOrAbstract(_qb: QueryBuilder, sym: Node): string | null {
  const bodyLines = sym.endLine - sym.startLine;
  const sig = sym.signature ?? '';
  const isDeclOnly = sig.trimEnd().endsWith(';') && bodyLines <= 1;
  const isEmpty = bodyLines === 0;

  if (!isEmpty && !isDeclOnly) return null;

  return cap(`Abstract ${sym.kind}: ${sym.name}`);
}

// ---------------------------------------------------------------------------
// Main pattern dispatcher
// ---------------------------------------------------------------------------

/**
 * Try all patterns in priority order. Returns the first match or null
 * if no pattern applies (node is left for the LLM phase).
 */
function applyPattern(qb: QueryBuilder, sym: Node): string | null {
  return (
    patternRoute(qb, sym) ??
    patternOneCallForwarder(qb, sym) ??
    patternOneInstantiationFactory(qb, sym) ??
    patternSingleFieldAccessor(qb, sym) ??
    patternReExport(qb, sym) ??
    patternTypeOnlyAlias(qb, sym) ??
    patternEmptyOrAbstract(qb, sym)
  );
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Inputs bundle for {@link runStructuralSummariser}. */
interface RunStructuralSummariserArgs {
  projectRoot: string;
  queries: QueryBuilder;
  options?: StructuralSummariserOptions;
}

// ---------------------------------------------------------------------------
// Per-symbol processing helpers (used by the main loop)
// ---------------------------------------------------------------------------

/**
 * Tally enum tracked across the loop; passed by reference so helpers can
 * mutate it without returning multiple values.
 */
interface ProcessTally {
  generated: number;
  skipped: number;
  preserved: number;
  done: number;
}

/** Shared bag for the per-candidate phase helpers. The orchestrator
 *  builds one and threads it through Phase A → B → C; the helpers
 *  mutate `tally` and fire `onProgress` so the main loop stays a
 *  linear sequence of guard checks. */
interface PhaseCtx {
  queries: QueryBuilder;
  tally: ProcessTally;
  total: number;
  onProgress: ((done: number, total: number) => void) | undefined;
}

/**
 * Phase A — Guard: return true when the existing summary is from a
 * non-structural model (LLM/agent wins).  Side-effect: increments
 * `preserved` + `done` and fires `onProgress`.
 */
function isPreservedByNonStructural(ctx: PhaseCtx, symId: string): boolean {
  const { queries, tally, total, onProgress } = ctx;
  const existing = getSymbolSummary(queries, symId);
  if (existing && !existing.model.startsWith('structural:')) {
    tally.preserved++;
    tally.done++;
    onProgress?.(tally.done, total);
    return true;
  }
  return false;
}

/**
 * Phase B — Cache check: return true when a structural summary with the
 * same content hash already exists (no rewrite needed).  Side-effect:
 * increments `skipped` + `done` and fires `onProgress`.
 */
function isStructuralCacheHit(ctx: PhaseCtx, symId: string, hash: string): boolean {
  const { queries, tally, total, onProgress } = ctx;
  const existing = getSymbolSummary(queries, symId);
  if (existing?.model.startsWith('structural:') && existing.contentHash === hash) {
    tally.skipped++;
    tally.done++;
    onProgress?.(tally.done, total);
    return true;
  }
  return false;
}

/**
 * Phase C — Pattern + write: try all patterns; if one matches, upsert the
 * summary.  Side-effect: increments `generated` or `skipped` + `done` and
 * fires `onProgress`.
 */
function applyPatternAndWrite(ctx: PhaseCtx, sym: Node, hash: string): void {
  const { queries, tally, total, onProgress } = ctx;
  const summary = applyPattern(queries, sym);

  if (!summary) {
    logDebug('StructuralSummariser: no pattern matched', { id: sym.id, kind: sym.kind, name: sym.name });
    tally.skipped++;
    tally.done++;
    onProgress?.(tally.done, total);
    return;
  }

  let wrote = false;
  try {
    wrote = withSqliteBusyRetry(() =>
      upsertSymbolSummary({ qb: queries, nodeId: sym.id, contentHash: hash, summary, model: STRUCTURAL_MODEL }),
    );
  } catch (err) {
    // D (issues #15/#16): a transient lock is non-fatal here — leave `wrote`
    // false so it's counted as skipped and re-summarised on the next pass. Warn
    // (not debug) so persistent contention is visible amid no-match skips.
    logWarn('StructuralSummariser: persist failed under DB contention, deferring', {
      id: sym.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (wrote) {
    tally.generated++;
  } else {
    // Stale-handle race OR a transient lock: not an error semantically — count
    // as `skipped` (candidates = generated + skipped + preserved holds;
    // re-summarised next pass).
    tally.skipped++;
  }

  tally.done++;
  onProgress?.(tally.done, total);
}

/**
 * Run a full structural-summarisation pass.
 *
 * For each candidate:
 *   1. If a non-structural summary already exists → preserve it (LLM wins).
 *   2. Compute content hash from the symbol's body.
 *   3. If an existing structural summary has the same hash → cache hit, skip.
 *   4. Try each pattern in order; first match produces the synthetic summary.
 *   5. If no pattern matches → count as `skipped` (left for the LLM phase).
 *
 * Always synchronous internally (no LLM calls), but returns a Promise
 * for API parity with the LLM pass siblings.
 */
export async function runStructuralSummariser(args: RunStructuralSummariserArgs): Promise<StructuralSummariserResult> {
  const { projectRoot, queries, options = {} } = args;
  const { signal, onProgress } = options;

  const t0 = Date.now();
  const candidates = getStructuralCandidates(queries);
  const total = candidates.length;

  const tally: ProcessTally = { generated: 0, skipped: 0, preserved: 0, done: 0 };
  const phaseCtx: PhaseCtx = { queries, tally, total, onProgress };

  // Per-file line cache to amortise repeated readFileSync on the same file
  const fileContentCache = new Map<string, string[] | null>();

  for (const sym of candidates) {
    if (signal?.aborted) break;

    // Phase A: LLM/agent summary already exists — preserve it.
    if (isPreservedByNonStructural(phaseCtx, sym.id)) continue;

    // Phase B: Load body text (needed for content-hash cache check).
    let lines = fileContentCache.get(sym.filePath);
    if (lines === undefined) {
      lines = loadFileLinesSafely(projectRoot, sym.filePath);
      fileContentCache.set(sym.filePath, lines);
    }
    // Body text — empty string when file is unreadable (routes often have
    // single-line bodies in framework extractors, so even an empty body
    // is fine for the route pattern which uses node.name, not body text).
    const body = lines ? extractBody(lines, sym) : '';
    const hash = contentHashFor(sym, body);

    // Phase C: Same structural summary still valid — skip rewrite.
    if (isStructuralCacheHit(phaseCtx, sym.id, hash)) continue;

    // Phase D: Apply pattern and write.
    applyPatternAndWrite(phaseCtx, sym, hash);
  }

  return {
    candidates: total,
    generated: tally.generated,
    skipped: tally.skipped,
    preserved: tally.preserved,
    durationMs: Date.now() - t0,
  };
}
