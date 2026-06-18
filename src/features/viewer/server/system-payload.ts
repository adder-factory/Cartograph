import * as fs from 'node:fs';
import { resolveAssetPath } from '../../../assets.js';
import { getCoverageStats } from '../../../db/queries-coverage.js';
import { getAllDirectorySummaries } from '../../../db/queries-directory-summaries.js';
import { getEmbeddingsTotal } from '../../../db/queries-embeddings.js';
import { getMetadata } from '../../../db/queries-metadata.js';
import { getRoleCounts } from '../../../db/queries-roles.js';
import {
  countPendingSummarizable,
  getSummaryBreakdown,
  getSummaryCoverage,
  getWeightedSummaryCoverage,
} from '../../../db/queries-summaries.js';
import { getUnresolvedReferencesCount } from '../../../db/queries-unresolved-refs.js';
import { safeCall } from '../../../errors.js';
import { getCurrentHeadSha } from '../../../git-utils.js';
import type Cartograph from '../../../index.js';
import type { LlmEndpointConfig } from '../../../llm/client.js';
import { getAskModel, getChatModel, getEmbeddingModel } from '../../../llm/provider.js';
import { readOnDiskPackageVersion } from '../../../package-version.js';
import { DEFAULT_DOC_CHAR_THRESHOLD, resolveBodyLineFloor, SUMMARIZABLE_KINDS } from '../../../llm/summarizer.js';
import { ensureCartograph, type RequestContext } from './context.js';

/** A configured LLM tier mapped for the viewer's overview page. Each
 *  tier carries its model + provider, plus the openai-compat endpoint
 *  and a `reachable` probe result (null when the tier is not an
 *  HTTP/openai-compat backend, so it can't be probed). */
export interface SystemLlmTier {
  tier: string;
  model: string | null;
  provider: string | null;
  endpoint: string | null;
  reachable: boolean | null;
}

export interface SystemReadinessSummaries {
  done: number;
  total: number;
  pct: number;
  weightedPct: number | null;
  pending: number;
  reuseCached: number;
  breakdown: {
    structural: number;
    neighborProp: number;
    llm: number;
    skippedByFloor: number;
  };
}

export interface SystemReadiness {
  summaries: SystemReadinessSummaries | null;
  embeddings: { rows: number; reuseCached: number } | null;
  coverage: { symbols: number; sources: string[] } | null;
  roles: { classified: number } | null;
  directorySummaries: { count: number } | null;
  unresolvedRefs: { count: number } | null;
}

/** Structured payload for `GET /api/system` — the viewer's
 *  Status/Overview page. Mirrors what `cartograph status` reports, as
 *  numbers rather than markdown. Every key is always present; a section
 *  degrades to `null` when its source query throws. */
export interface SystemPayload {
  version: string;
  dbSizeBytes: number | null;
  backend: string | null;
  moduleFormat: string | null;
  indexedAt: number | null;
  head: string | null;
  inSync: boolean | null;
  readiness: SystemReadiness;
  llm: { configured: boolean; tiers: SystemLlmTier[] } | null;
}

/** ~1.5s reachability probe budget, matching `renderReachabilitySection`. */
const REACHABILITY_TIMEOUT_MS = 1500;

/** A fully-shaped payload with every readiness section nulled — the
 *  fallback when `systemPayload` itself throws (e.g. the project can't
 *  be opened), so the client always parses a valid `SystemPayload`. */
export function emptySystemPayload(): SystemPayload {
  return {
    version: readVersion(),
    dbSizeBytes: null,
    backend: null,
    moduleFormat: readModuleFormat(),
    indexedAt: null,
    head: null,
    inSync: null,
    readiness: {
      summaries: null,
      embeddings: null,
      coverage: null,
      roles: null,
      directorySummaries: null,
      unresolvedRefs: null,
    },
    llm: null,
  };
}

export async function systemPayload(ctx: RequestContext): Promise<SystemPayload> {
  const cg = await ensureCartograph(ctx);
  const indexedAtRaw = safeCall(() => getMetadata(cg.queries, 'index_timestamp')) ?? null;
  const head = safeCall(() => getMetadata(cg.queries, 'index_head_sha')) ?? null;
  return {
    version: readVersion(),
    dbSizeBytes: readDbSize(cg),
    backend: readBackend(cg),
    moduleFormat: readModuleFormat(),
    indexedAt: indexedAtRaw ? Number(indexedAtRaw) : null,
    head,
    inSync: computeInSync(cg.projectRoot, head),
    readiness: buildReadiness(cg),
    llm: await buildLlm(cg),
  };
}

/** The cartograph package version, read fresh from disk (so an
 *  in-place upgrade is reflected) — same source as `cartograph status`'s
 *  `cartographVersion`. NOT `cg.config.version`, which is the DB schema
 *  migration number. */
function readVersion(): string {
  return readOnDiskPackageVersion() ?? '0.0.0';
}

/** Module system + TS build target, for the overview header. The module
 *  system is gated on cartograph's own `package.json` `type` being
 *  readable (so this returns `null` in a sandboxed env where the asset
 *  is missing, honoring the `string | null` contract); the `NodeNext`
 *  resolution and `ES2022` target are fixed build constants
 *  (`tsconfig.json`). */
function readModuleFormat(): string | null {
  return packageIsEsm() ? 'ESM (NodeNext, ES2022)' : null;
}

/** Whether cartograph's on-disk `package.json` declares `type: module`;
 *  null/false when the asset is unreadable or not an ES module. The value
 *  is static for the process lifetime, so cache it — `/api/system` must
 *  not stat + parse package.json on every request. */
let cachedIsEsm: boolean | undefined;
function packageIsEsm(): boolean {
  if (cachedIsEsm !== undefined) return cachedIsEsm;
  try {
    const raw = fs.readFileSync(resolveAssetPath('package.json'), 'utf-8');
    cachedIsEsm = (JSON.parse(raw) as { type?: unknown }).type === 'module';
  } catch {
    cachedIsEsm = false;
  }
  return cachedIsEsm;
}

function readDbSize(cg: Cartograph): number | null {
  return safeCall(() => cg.db.getSize()) ?? null;
}

function readBackend(cg: Cartograph): string | null {
  return (
    safeCall(() => {
      const backend = cg.db.getBackend();
      if (backend === 'postgres') {
        return cg.db.hasVecExtension() ? 'postgres + pgvector' : 'postgres';
      }
      return cg.db.hasVecExtension() ? `${backend} + sqlite-vec` : backend;
    }) ?? null
  );
}

/** True when the indexed HEAD matches the current git HEAD; null when
 *  either is undeterminable (no recorded head, or git unavailable). */
function computeInSync(projectRoot: string, indexedHead: string | null): boolean | null {
  if (!indexedHead) return null;
  const current = safeCall(() => getCurrentHeadSha(projectRoot));
  if (!current) return null;
  return current === indexedHead;
}

function buildReadiness(cg: Cartograph): SystemReadiness {
  return {
    summaries: buildSummaries(cg),
    embeddings: buildEmbeddings(cg),
    coverage: buildCoverage(cg),
    roles: buildRoles(cg),
    directorySummaries: buildDirectorySummaries(cg),
    unresolvedRefs: buildUnresolvedRefs(cg),
  };
}

function buildSummaries(cg: Cartograph): SystemReadinessSummaries | null {
  const coverage = safeCall(() => getSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS));
  if (!coverage || coverage.total === 0) return null;
  const floor = resolveBodyLineFloor(cg.config?.llm);
  const filter = {
    minBodyLinesByKind: floor.minBodyLinesByKind,
    defaultMinBodyLines: floor.defaultMinBodyLines,
    docCharThreshold: DEFAULT_DOC_CHAR_THRESHOLD,
  };
  const weighted = safeCall(() => getWeightedSummaryCoverage(cg.queries, SUMMARIZABLE_KINDS));
  const pending = safeCall(() => countPendingSummarizable(cg.queries, SUMMARIZABLE_KINDS, filter)) ?? 0;
  const breakdown = safeCall(() => getSummaryBreakdown(cg.queries, SUMMARIZABLE_KINDS, filter)) ?? {
    structural: 0,
    neighborProp: 0,
    llm: 0,
    skippedByFloor: 0,
  };
  const weightedPct = weighted && weighted.weightedRatio !== null ? Math.round(weighted.weightedRatio * 100) : null;
  return {
    done: coverage.summarised,
    total: coverage.total,
    pct: Math.round((coverage.summarised / coverage.total) * 100),
    weightedPct,
    pending,
    reuseCached: countSummaryReuseCachedRows(cg),
    breakdown: {
      structural: breakdown.structural,
      neighborProp: breakdown.neighborProp,
      llm: breakdown.llm,
      skippedByFloor: breakdown.skippedByFloor,
    },
  };
}

function buildEmbeddings(cg: Cartograph): { rows: number; reuseCached: number } | null {
  const rows = safeCall(() => getEmbeddingsTotal(cg.queries));
  if (rows === undefined) return null;
  return { rows, reuseCached: countEmbeddingReuseCachedRows(cg) };
}

function buildCoverage(cg: Cartograph): { symbols: number; sources: string[] } | null {
  const stats = safeCall(() => getCoverageStats(cg.queries));
  if (stats === undefined) return null;
  return { symbols: stats.symbolsWithCoverage, sources: stats.sources };
}

function buildRoles(cg: Cartograph): { classified: number } | null {
  const counts = safeCall(() => getRoleCounts(cg.queries));
  if (counts === undefined) return null;
  let classified = 0;
  for (const count of counts.values()) classified += count;
  return { classified };
}

function buildDirectorySummaries(cg: Cartograph): { count: number } | null {
  const count = safeCall(() => getAllDirectorySummaries(cg.queries).length);
  if (count === undefined) return null;
  return { count };
}

function buildUnresolvedRefs(cg: Cartograph): { count: number } | null {
  const count = safeCall(() => getUnresolvedReferencesCount(cg.queries));
  if (count === undefined) return null;
  return { count };
}

/** Replicates `rollups.ts`'s private `countSummaryReuseCachedRows`:
 *  content-addressed summaries whose body-hash is no longer referenced
 *  by any current node (reusable on the next index). */
function countSummaryReuseCachedRows(cg: Cartograph): number {
  try {
    const row = cg.db
      .getDb()
      .prepare('SELECT COUNT(*) AS c FROM summary_store WHERE body_hash NOT IN (SELECT body_hash FROM summary_refs)')
      .get() as { c?: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

/** Replicates `rollups.ts`'s private `countEmbeddingReuseCachedRows`. */
function countEmbeddingReuseCachedRows(cg: Cartograph): number {
  try {
    const row = cg.db
      .getDb()
      .prepare(
        'SELECT COUNT(*) AS c FROM embedding_store WHERE body_hash NOT IN (SELECT body_hash FROM embedding_refs)',
      )
      .get() as { c?: number } | undefined;
    return row?.c ?? 0;
  } catch {
    return 0;
  }
}

async function buildLlm(cg: Cartograph): Promise<{ configured: boolean; tiers: SystemLlmTier[] } | null> {
  let llmCfg: LlmEndpointConfig | null;
  try {
    llmCfg = await cg.llm.config.getEffectiveLlmConfig();
  } catch {
    return null;
  }
  if (!llmCfg) return { configured: false, tiers: [] };

  const reachMap = await probeReachability(llmCfg);
  // `ask` falls back to the summarize backend when `askLlm` is omitted
  // (getAskModel mirrors that), so build the row from the effective block —
  // otherwise the row shows a model with a null provider/endpoint/reach.
  const tiers: SystemLlmTier[] = [
    buildTier({ tier: 'chat', block: llmCfg.summarizeLlm, model: getChatModel(llmCfg), reachMap }),
    buildTier({ tier: 'ask', block: llmCfg.askLlm ?? llmCfg.summarizeLlm, model: getAskModel(llmCfg), reachMap }),
    buildTier({ tier: 'embed', block: llmCfg.embeddingLlm, model: getEmbeddingModel(llmCfg), reachMap }),
  ];
  // A configured reranker is already probed by collectOpenAiCompatEndpoints,
  // so it must appear as a tier — otherwise a down reranker is invisible and
  // the summary still reads "all reachable".
  if (llmCfg.rerankerLlm) {
    tiers.push(buildTier({ tier: 'reranker', block: llmCfg.rerankerLlm, model: llmCfg.rerankerLlm.model, reachMap }));
  }
  return { configured: true, tiers };
}

interface TierBlock {
  provider?: string;
  endpoint?: string;
}

interface BuildTierArgs {
  tier: string;
  block: TierBlock | null | undefined;
  model: string | undefined;
  reachMap: Map<string, boolean>;
}

function buildTier(args: BuildTierArgs): SystemLlmTier {
  const { tier, block, model, reachMap } = args;
  const provider = block?.provider ?? null;
  const endpoint =
    provider === 'openai-compat' && typeof block?.endpoint === 'string' && block.endpoint.length > 0
      ? block.endpoint
      : null;
  return {
    tier,
    model: model ?? null,
    provider,
    endpoint,
    // Only openai-compat HTTP endpoints can be probed; other backends
    // (claude-bridge / anthropic-api) report null rather than a
    // misleading "unreachable".
    reachable: endpoint === null ? null : (reachMap.get(endpoint) ?? false),
  };
}

/** Probe each distinct openai-compat endpoint at `<base>/v1/models`
 *  with a short timeout, mirroring `status-llm.ts`. The result is cached
 *  for a short TTL so opening the Overview repeatedly does not block on
 *  (or spam) the backends — each probe can cost up to the full timeout. */
let cachedReach: { key: string; map: Map<string, boolean>; atMs: number } | undefined;
const REACHABILITY_CACHE_TTL_MS = 15_000;
async function probeReachability(llmCfg: LlmEndpointConfig): Promise<Map<string, boolean>> {
  const endpoints = collectOpenAiCompatEndpoints(llmCfg);
  if (endpoints.length === 0) return new Map();
  // Key the cache by the exact endpoint set so a config change (or a
  // different project served by the same process) re-probes immediately
  // instead of returning a stale map; the TTL only bounds same-set reuse.
  // Sort a copy: the spread keeps the mutating `.sort()` off the array we
  // iterate below (Sonar S4043) and the comparator is deterministic (S2871).
  const key = [...endpoints].sort((a, b) => a.localeCompare(b)).join('\n');
  const now = Date.now();
  if (cachedReach?.key === key && now - cachedReach.atMs < REACHABILITY_CACHE_TTL_MS) {
    return cachedReach.map;
  }
  const probes = await Promise.all(
    endpoints.map(async (url) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
      try {
        const probeUrl = `${url.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`;
        const res = await fetch(probeUrl, { signal: controller.signal });
        return [url, res.ok] as const;
      } catch {
        return [url, false] as const;
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  cachedReach = { key, map: new Map(probes), atMs: now };
  return cachedReach.map;
}

function collectOpenAiCompatEndpoints(llmCfg: LlmEndpointConfig): string[] {
  const endpoints = new Set<string>();
  const collect = (block: TierBlock | null | undefined): void => {
    if (block?.provider === 'openai-compat' && typeof block.endpoint === 'string' && block.endpoint.length > 0) {
      endpoints.add(block.endpoint);
    }
  };
  collect(llmCfg.summarizeLlm);
  collect(llmCfg.askLlm);
  collect(llmCfg.embeddingLlm);
  collect(llmCfg.rerankerLlm);
  return [...endpoints];
}
