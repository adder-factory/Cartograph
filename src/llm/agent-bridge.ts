/**
 * Agent-as-LLM bridge.
 *
 * When no local LLM is available, the agent currently in the user's
 * session (Claude via Claude Code, or any MCP-speaking agent) can
 * fill the summary cache directly. The `cartograph_summaries` MCP
 * tool provides the contract via two actions:
 *
 *   1. action: 'pending'  → returns a batch of un-summarised symbols
 *      with bodies + content_hash for the agent to summarise.
 *
 *   2. action: 'save'     → takes the agent's results and persists
 *      them with the same content_hash invalidation as the local-LLM
 *      path.
 *
 * No HTTP, no embedding model required, no install friction. The
 * agent's tokens replace the local model. Quality is typically
 * higher (Claude vs. a 32B local model) at the cost of agent budget.
 *
 * Same SUMMARIZABLE_KINDS / MIN_BODY_LINES filters as the local pass
 * so both paths produce comparable cache entries.
 */

import * as crypto from 'crypto';
import type { Node } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getSummarizableNodes, getSymbolSummary, upsertSymbolSummary } from '../db/queries-summaries.js';
import { stripReasoningTokens } from '../utils.js';
import { readBodySafe } from './read-body-safe.js';
import { SUMMARIZABLE_KINDS, MIN_BODY_LINES_BY_KIND, DEFAULT_DOC_CHAR_THRESHOLD } from './summarizer.js';

/** Body-line floor for the agent-bridge candidate set: 3 lines
 *  (the local pass uses a stricter MIN_BODY_LINES_BY_KIND map that
 *  averages to 4). The agent typically produces higher-quality
 *  summaries from less context, so a 3-line body still benefits
 *  from a Claude summary when no local model is available. */
const MIN_BODY_LINES = 3;
const MAX_BODY_CHARS = 4000;

/**
 * Hard cap on agent-summary batch size. A single MCP round-trip ships
 * bodies inline, so 200 keeps payloads under common transport limits.
 */
const PENDING_BATCH_MAX_LIMIT = 200;

/** Default agent-summary batch size when caller doesn't specify. */
const PENDING_BATCH_DEFAULT_LIMIT = 20;

/**
 * Existing-docstring char threshold for "needs summarising." Anything
 * shorter is treated as not-yet-documented; longer docstrings are left
 * alone so we don't overwrite the author's prose with a model summary.
 *
 * Sourced from the local pass so the two stay aligned; kept as a local
 * constant so the agent path can deviate later without forcing the
 * local pass to follow.
 */
const SUMMARY_DOCSTRING_CHAR_THRESHOLD = DEFAULT_DOC_CHAR_THRESHOLD;

interface PendingSummaryItem {
  nodeId: string;
  name: string;
  kind: string;
  language: string;
  filePath: string;
  startLine: number;
  endLine: number;
  signature: string | null;
  body: string;
  contentHash: string;
}

interface PendingBatch {
  items: PendingSummaryItem[];
  /** How many additional candidates remain after this batch. */
  remaining: number;
  /** Total summarisable candidates (stable per index state). */
  total: number;
  /**
   * Subset of `total`: candidates whose symbol DOES have a cached
   * summary row but whose current content_hash no longer matches it
   * (drift). Matches `cartograph_status`'s "out-of-date summaries" count
   * — the agent should consider these the priority work.
   */
  staleCount: number;
  /**
   * Subset of `total`: candidates whose symbol has NO cached summary at
   * all (the long tail — symbols that were never summarised by either
   * the local pass or a prior agent-bridge round).
   */
  neverSummarisedCount: number;
  /** Echo back to MCP callers so they know what label to save under. */
  modelHint: string;
}

interface SaveSummaryItem {
  nodeId: string;
  contentHash: string;
  summary: string;
}

interface SaveResult {
  saved: number;
  skipped: number;
  errors: string[];
}

/** Compute the same content_hash the local summariser uses, so the
 *  cache key is interchangeable between paths. */
function contentHashFor(sym: Pick<Node, 'signature'>, body: string): string {
  const h = crypto.createHash('sha256');
  h.update(sym.signature ?? '');
  h.update('\0');
  h.update(body);
  return h.digest('hex').slice(0, 32);
}

/**
 * Pull the next batch of un-summarised symbols. Returns bodies inline
 * so the agent has everything it needs in one MCP round-trip.
 *
 * `modelHint` defaults to "agent-mcp" — callers can override (e.g. the
 * actual model id of the calling agent) to keep cache provenance
 * accurate.
 */
/** Argument bundle for `tryBuildPendingItem`. */
interface PendingItemCtx {
  projectRoot: string;
  queries: QueryBuilder;
  modelHint: string;
}

/**
 * Build a `PendingSummaryItem` for one candidate node, returning null
 * when the file can't be read or when an existing summary from the
 * same model already matches the current content_hash (cache hit).
 */
function tryBuildPendingItem(
  node: ReturnType<typeof getSummarizableNodes>[number],
  ctx: PendingItemCtx,
): PendingSummaryItem | null {
  const body = readBodySafe(ctx.projectRoot, node, MAX_BODY_CHARS);
  if (!body) return null;
  const hash = contentHashFor(node, body);

  // Don't ship a candidate whose content_hash already matches a
  // cached summary from THIS model (effectively a cache hit) —
  // that would waste agent tokens.
  const existing = getSymbolSummary(ctx.queries, node.id);
  if (existing && existing.contentHash === hash && existing.model === ctx.modelHint) return null;

  return {
    nodeId: node.id,
    name: node.name,
    kind: node.kind,
    language: node.language,
    filePath: node.filePath,
    startLine: node.startLine,
    endLine: node.endLine,
    signature: node.signature ?? null,
    body,
    contentHash: hash,
  };
}

export function pendingSummariesBatch(
  projectRoot: string,
  queries: QueryBuilder,
  options: { limit?: number; kinds?: ReadonlySet<string> | undefined; modelHint?: string } = {},
): PendingBatch {
  const limit = Math.max(1, Math.min(PENDING_BATCH_MAX_LIMIT, options.limit ?? PENDING_BATCH_DEFAULT_LIMIT));
  const kinds = options.kinds ?? SUMMARIZABLE_KINDS;
  const modelHint = options.modelHint ?? 'agent-mcp';

  // Reuse the same docstring threshold the local pass uses for parity.
  const candidates = getSummarizableNodes(queries, kinds, {
    minBodyLinesByKind: MIN_BODY_LINES_BY_KIND,
    defaultMinBodyLines: MIN_BODY_LINES,
    docCharThreshold: SUMMARY_DOCSTRING_CHAR_THRESHOLD,
  });
  const total = candidates.length;
  const items: PendingSummaryItem[] = [];
  const ctx: PendingItemCtx = { projectRoot, queries, modelHint };

  // Bucket the FULL candidate set into stale vs never-summarised so the
  // response can split the misleading single `total` number into two
  // honest buckets (bug #16). The previous `total: 1669` masked the
  // fact that only ~3 were drift-stale; the rest were the long tail of
  // symbols that were never processed by any path.
  //
  // `staleCount` mirrors `getStaleArtifactsCount(qb).summaries` —
  // `symbol_summaries.content_hash != nodes.body_hash` AND `body_hash`
  // non-empty (pre-migration-048 rows are "tracking pending", not
  // stale). Cache-hit candidates (existing row matching the current
  // body_hash) fall into the third implicit bucket — accounted for
  // by `total - staleCount - neverSummarisedCount`, never returned as
  // pending work. Pure DB lookups — no file I/O for the count pass.
  let staleCount = 0;
  let neverSummarisedCount = 0;
  for (const node of candidates) {
    const existing = getSymbolSummary(queries, node.id);
    if (!existing) {
      neverSummarisedCount++;
    } else if (node.bodyHash && node.bodyHash.length > 0 && existing.contentHash !== node.bodyHash) {
      staleCount++;
    }
    // else: cache hit (existing summary matches current body_hash, or
    // body_hash empty = pre-migration row not yet re-extracted). Neither
    // bucket — `tryBuildPendingItem` will also skip these.
  }

  for (const node of candidates) {
    if (items.length >= limit) break;
    const item = tryBuildPendingItem(node, ctx);
    if (item) items.push(item);
  }

  return {
    items,
    remaining: Math.max(0, total - items.length),
    total,
    staleCount,
    neverSummarisedCount,
    modelHint,
  };
}

/**
 * Persist a batch of agent-generated summaries. Idempotent: a stale
 * content_hash is silently skipped (with a logged reason in `errors`)
 * because by the time the agent answered, the symbol body may have
 * changed under it.
 */
/** Bundle for `saveOneAgentSummary` so the helper stays under 4 args. */
interface SaveAgentSummaryCtx {
  projectRoot: string;
  queries: QueryBuilder;
  modelLabel: string;
}

/**
 * Per-item save: validates the agent's summary against current disk
 * state and either upserts the row or returns a skip reason.
 */
function saveOneAgentSummary(
  ctx: SaveAgentSummaryCtx,
  item: SaveSummaryItem,
): { ok: true } | { ok: false; reason: string } {
  const { projectRoot, queries, modelLabel } = ctx;
  const node = queries.getNodeById(item.nodeId);
  if (!node) return { ok: false, reason: `${item.nodeId}: node no longer exists` };
  // Re-derive the hash from current disk content; if it doesn't
  // match what the agent saw, the body changed under them.
  const body = readBodySafe(projectRoot, node, MAX_BODY_CHARS);
  if (!body) return { ok: false, reason: `${item.nodeId}: body unreadable` };
  const currentHash = contentHashFor(node, body);
  if (currentHash !== item.contentHash) {
    return { ok: false, reason: `${item.nodeId}: content_hash drifted (${item.contentHash} → ${currentHash})` };
  }
  const trimmed = stripReasoningTokens(item.summary).trim().split('\n')[0]?.trim() ?? '';
  if (!trimmed) return { ok: false, reason: `${item.nodeId}: empty summary` };
  if (
    upsertSymbolSummary({
      qb: queries,
      nodeId: item.nodeId,
      contentHash: currentHash,
      summary: trimmed.slice(0, 200),
      model: modelLabel,
    })
  ) {
    return { ok: true };
  }
  // The pre-flight getNodeById passed but a concurrent sync deleted
  // the node between then and the upsert (cross-process race; same
  // shape as the FK fix in queries-summaries.ts). Report as a skip
  // rather than overcounting `saved`.
  return { ok: false, reason: `${item.nodeId}: node disappeared mid-write` };
}

interface SaveAgentSummariesArgs {
  projectRoot: string;
  queries: QueryBuilder;
  items: ReadonlyArray<SaveSummaryItem>;
  modelLabel: string;
}

export function saveAgentSummaries(args: SaveAgentSummariesArgs): SaveResult {
  const { projectRoot, queries, items, modelLabel } = args;
  let saved = 0;
  let skipped = 0;
  const errors: string[] = [];
  const ctx: SaveAgentSummaryCtx = { projectRoot, queries, modelLabel };
  for (const item of items) {
    const res = saveOneAgentSummary(ctx, item);
    if (res.ok) {
      saved++;
    } else {
      skipped++;
      errors.push(res.reason);
    }
  }
  return { saved, skipped, errors };
}
