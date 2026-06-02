/**
 * `cartograph_admin({action})` — consolidated admin/lifecycle family.
 * Subsumes the prior tools `cartograph_init` / `cartograph_uninit` /
 * `cartograph_unlock` / `cartograph_sync` / `cartograph_index`.
 *
 * Two arg shapes (intentional — reflects the underlying semantics):
 *   - init / uninit: take `path` (required), since they may target a
 *     directory that has no `.cartograph/` yet.
 *   - everything else: takes optional `projectPath` (defaults to the
 *     server's primary project), since they target an existing
 *     initialized cartograph.
 *
 * All actions bypass the freshness gate (each is part of the fix
 * loop for staleness OR doesn't depend on the index). The family is
 * `isWriteTool: true` because every action mutates state.
 *
 * The action handlers are inlined in this file rather than split into
 * `_admin-<action>.ts` helpers — each body is small and there are no
 * shared helpers between actions, so the indirection would be noise.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { errMsg } from '../../errors.js';
import { formatBytes } from '../../utils.js';
import type { IndexProgress } from '../../extraction/index.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from '../../embeddings/similarity-defaults.js';
import { LLM_CONCURRENCY_BOUNDS, parseConcurrency } from '../../llm/concurrency.js';

async function handleInit(_ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = args['path'];
  if (typeof projectPath !== 'string' || !projectPath) {
    return err('action=init: `path` must be a non-empty absolute project path.');
  }
  try {
    const fsMod = await import('node:fs');
    const ensureErr = ensureProjectDirExists(fsMod, projectPath);
    if (ensureErr) return err(ensureErr);
    // Dynamic import: the static path tools.ts → tools/registry.ts →
    // tools/admin.ts → src/index.ts → src/mcp/index.ts → tools.ts forms a
    // module-load cycle. Loading Cartograph lazily breaks the cycle.
    const { default: Cartograph } = await import('../../index.js');
    const cg = await Cartograph.init(projectPath, { index: false });
    cg.close();
    return ok(
      textResult(
        `## Initialized\n\n- Path: \`${projectPath}\`\n- Created: \`.cartograph/\`\n- Next: pass \`projectPath: "${projectPath}"\` to other tools, or run \`cartograph_admin({action: "index"})\` to populate the index.`,
      ),
    );
  } catch (error_) {
    return err(`Init failed: ${errMsg(error_)}`);
  }
}

/** Create `projectPath` (recursive) when it doesn't exist. Returns
 *  `null` on success or when the dir was already there; returns an
 *  error string when mkdir failed. Pulled out of {@link handleInit}
 *  so the inner try/catch nested inside the outer try doesn't sit
 *  4 levels deep. */
function ensureProjectDirExists(fsMod: typeof import('node:fs'), projectPath: string): string | null {
  if (fsMod.existsSync(projectPath)) return null;
  try {
    fsMod.mkdirSync(projectPath, { recursive: true });
    return null;
  } catch (error_) {
    return `Could not create project directory ${projectPath}: ${errMsg(error_)}`;
  }
}

async function handleUninit(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = args['path'];
  if (typeof projectPath !== 'string' || !projectPath) {
    return err('action=uninit: `path` must be a non-empty absolute project path.');
  }
  if (args['confirm'] !== true) {
    return err(
      'action=uninit: `confirm: true` is required to remove the cartograph index. This deletes ' +
        '`.cartograph/` (nodes, edges, summaries, embeddings, coverage). To preserve ' +
        'config and just rebuild structural data, use action=index with `force: true`.',
    );
  }
  try {
    const { default: pathMod } = await import('node:path');
    const fsp = await import('node:fs/promises');
    const dir = pathMod.join(projectPath, '.cartograph');
    const exists = await fsp
      .access(dir)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return ok(textResult(`## Already uninitialized\n\n- No \`.cartograph/\` at \`${projectPath}\`.`));
    }
    const resolved = pathMod.resolve(projectPath);
    ctx.closeProjectsMatching(resolved);
    await fsp.rm(dir, { recursive: true, force: true });
    return ok(textResult(`## Uninitialized\n\n- Removed: \`${dir}\`\n- All indexed data dropped.`));
  } catch (error_) {
    return err(`Uninit failed: ${errMsg(error_)}`);
  }
}

async function handleUnlock(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = args['projectPath'] as string | undefined;
  let resolvedRoot: string;
  try {
    const cg = ctx.getCartograph(projectPath);
    resolvedRoot = cg.projectRoot;
  } catch (error_) {
    return err(`Unlock failed: ${errMsg(error_)}`);
  }
  try {
    const { default: pathMod } = await import('node:path');
    const fsp = await import('node:fs/promises');
    const lockPath = pathMod.join(resolvedRoot, '.cartograph', 'cartograph.lock');
    const exists = await fsp
      .access(lockPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return ok(textResult('## No lock file\n\n- Nothing to do; index is not locked.'));
    }
    await fsp.unlink(lockPath);
    const relPath = pathMod.relative(resolvedRoot, lockPath);
    return ok(textResult(`## Lock cleared\n\n- Removed: \`${relPath}\``));
  } catch (error_) {
    return err(`Unlock failed: ${errMsg(error_)}`);
  }
}

/** Render the per-file progress label streamed back to the MCP client. */
function formatProgressMsg(p: IndexProgress): string {
  if (p.currentFile) return `${p.phase}: ${p.currentFile}`;
  return p.phase;
}

async function handleSync(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  try {
    // B13: forward IndexProgress to MCP notifications/progress when
    // the client requested it. Sync on a real project can take 10s+
    // on first-touch; per-phase visibility lets the agent show life.
    const progressOpts = buildIndexProgressOpts(ctx);
    const result = await cg.sync({ summarize: false, ...progressOpts });
    if (result.lockContention) {
      // No `notifications/progress` events fired in this branch — the
      // contention check is immediate (no work done before the early
      // return). A client showing a progress bar will see it stay
      // empty for the brief contention window. Acceptable: contention
      // is rare and resolves in milliseconds; not worth a synthetic
      // "0/0" event just to update the UI.
      return ok(
        textResult(
          '## Sync skipped\n\n' +
            'Another indexing process currently holds the index file-lock. ' +
            'The index may still be stale — retry action=sync in a moment.',
        ),
      );
    }
    return ok(textResult(formatSyncResult(result)));
  } catch (error_) {
    return err(`Sync failed: ${errMsg(error_)}`);
  }
}

/** Render the sync summary card: header + per-bucket added/modified/removed deltas. */
function formatSyncResult(result: {
  filesChecked: number;
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
}): string {
  // Header verb is `Scanned`, not `Synced`: `filesChecked` is the count
  // of files the watcher walked — most are unchanged. The
  // added/modified/removed line below names the actual delta vs the
  // previous sync (which is the count an "I just edited N files"
  // session-cumulative reader was expecting). Reduces the confusing
  // "Synced 7 files / ~1 modified" friction where the two numbers
  // sound contradictory.
  const lines: string[] = [
    `## Scanned ${result.filesChecked} file${result.filesChecked === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s`,
  ];
  const segs: string[] = [];
  if (result.filesAdded > 0) segs.push(`+${result.filesAdded} added`);
  if (result.filesModified > 0) segs.push(`~${result.filesModified} modified`);
  if (result.filesRemoved > 0) segs.push(`-${result.filesRemoved} removed`);
  if (segs.length === 0) {
    lines.push('- No content changes since the previous sync; index already in sync.');
  } else {
    lines.push(
      `- Delta since last sync: ${segs.join(', ')}; ${result.nodesUpdated} node${result.nodesUpdated === 1 ? '' : 's'} updated.`,
    );
  }
  return lines.join('\n');
}

/**
 * F#29 — footer rendered after a successful index against a project
 * whose `config.llm` has no `summarizeLlm`. Best-effort port-scan for
 * OpenAI-compat backends on the standard ports; when ≥1 is reachable,
 * lists them so the user sees what's already running without having to
 * call `llm-plan` separately. Scan failure / no detection falls back to
 * the bare "No LLM configured" message — same behaviour as before F#29.
 *
 * The scan is bounded by `PROBE_TIMEOUT_MS` (1s per port) and runs
 * after the index has already done its work, so the added latency is
 * trivial relative to a multi-second index.
 *
 * Takes an optional scanner injection so tests can drive both the
 * empty-detection and the detected-backend paths without spinning up
 * real HTTP listeners.
 */
interface NoLlmFooterBackend {
  readonly kind: string;
  readonly endpoint: string;
}
export async function buildNoLlmFooter(scan?: () => Promise<readonly NoLlmFooterBackend[]>): Promise<string> {
  const bare =
    'Base graph is queryable now. (No LLM configured — `find mode:intent` / `ask` need `cartograph admin llm-apply`.)';
  const runScan =
    scan ??
    (async () => {
      const { scanForLlmBackends } = await import('../../installer/scan-backends.js');
      return scanForLlmBackends();
    });
  try {
    const detected = await runScan();
    if (detected.length === 0) return bare;
    const list = detected.map((d) => `${d.kind} ${d.endpoint}`).join(', ');
    const noun = detected.length === 1 ? 'backend' : 'backends';
    return `Base graph is queryable now. ${detected.length} OpenAI-compat ${noun} detected on standard ports: ${list}. Run \`cartograph_admin({action: 'llm-plan'})\` to see setup presets, then \`llm-apply\` to enroll one for this project.`;
  } catch {
    return bare;
  }
}

async function handleIndex(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const force = args['force'] === true;
  const clearParseCacheLangRaw = args['clearParseCacheLanguage'];
  const clearParseCacheLang =
    typeof clearParseCacheLangRaw === 'string' && clearParseCacheLangRaw.length > 0
      ? clearParseCacheLangRaw
      : undefined;
  const clearParseCacheArg = args['clearParseCache'] === true || clearParseCacheLang !== undefined;
  try {
    if (clearParseCacheArg) {
      const { clearParseCache } = await import('../../db/queries-parse-cache.js');
      clearParseCache(cg.queries, clearParseCacheLang);
    }
    const progressOpts = buildIndexProgressOpts(ctx);
    // Agentic equivalent of the CLI's detached summarizer: the MCP
    // server is long-lived, so the LLM summary tail runs as an
    // in-process background pass (`bgCtrl`, fired by `indexAll` when
    // `summarize !== false`). The agent gets the base graph back NOW
    // and polls `cartograph_status` for summary coverage. Skipped only
    // when the operator set `summarizeEagerLimit: 0` (ad-hoc only).
    const adhocOnly = cg.config.llm?.summarizeEagerLimit === 0;
    // `force` clear is threaded INTO indexAll so it runs under the file lock —
    // a contended force-reindex (another indexer holds the lock) then leaves
    // the existing index intact instead of wiping it with no rebuild.
    const result = await cg.indexAll({ summarize: !adhocOnly, clearStructural: force, ...progressOpts });
    const base = formatIndexResult({
      result,
      force,
      parseCacheCleared: clearParseCacheArg,
      parseCacheClearedLang: clearParseCacheLang,
    });
    let tail = '';
    if (result.success && result.filesIndexed > 0) {
      const noLlm = !cg.config.llm?.summarizeLlm;
      if (noLlm) {
        tail = `\n\n${await buildNoLlmFooter()}`;
      } else if (adhocOnly) {
        tail =
          '\n\nSummaries: ad-hoc only (summarizeEagerLimit = 0) — generated on demand as `find mode:intent` references symbols.';
      } else {
        tail =
          '\n\nBase graph is queryable now. Symbol summaries are generating in the background — call `cartograph_status` for coverage; `find mode:intent` / `ask` answers improve as they land.';
      }
    }
    return ok(textResult(base + tail));
  } catch (error_) {
    return err(`Reindex failed: ${errMsg(error_)}`);
  }
}

/**
 * Stage 4 #9 — fast-lane index that skips reference resolution and
 * every postHook (centrality, biomarkers, churn, etc.), then runs
 * the embed pass synchronously. Useful for operators who only want
 * semantic search and don't need biomarker / hotspot / call-graph data.
 */
async function handleEmbedOnly(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  try {
    const progressOpts = buildIndexProgressOpts(ctx);
    const result = await cg.indexAll({ summarize: false, embedOnly: true, ...progressOpts });
    if (!result.success) {
      return err(`Embed-only index failed (${result.errors[0]?.message ?? 'unknown error'}).`);
    }
    let embedSummary = '';
    try {
      const r = await cg.llm.embed.embedAll({});
      embedSummary = `\nEmbedded ${r.generated}/${r.candidates} symbols (${r.errors} errors, ${r.durationMs}ms)`;
    } catch (error_) {
      embedSummary = `\nEmbed pass skipped: ${errMsg(error_)}`;
    }
    return ok(textResult(formatIndexResult({ result, force: false, parseCacheCleared: false }) + embedSummary));
  } catch (error_) {
    return err(`Embed-only index failed: ${errMsg(error_)}`);
  }
}

/**
 * B13: forward IndexProgress to MCP notifications/progress so the agent
 * sees life during a multi-minute full re-index.
 */
function buildIndexProgressOpts(ctx: ToolCtx): { onProgress?: (p: IndexProgress) => void } {
  if (!ctx.reportProgress) return {};
  return {
    onProgress: (p: IndexProgress): void => {
      const msg = formatProgressMsg(p);
      ctx.reportProgress!(p.current, p.total, msg);
    },
  };
}

interface FormatIndexResultArgs {
  result: {
    filesIndexed: number;
    durationMs: number;
    nodesCreated: number;
    edgesCreated: number;
    filesSkipped: number;
    filesErrored: number;
    success: boolean;
  };
  force: boolean;
  parseCacheCleared: boolean;
  parseCacheClearedLang?: string | undefined;
}

/** Build the `(force, parse-cache cleared)` tag string for the re-index header. */
function buildIndexTagStr(force: boolean, parseCacheCleared: boolean, parseCacheClearedLang?: string): string {
  const tags: string[] = [];
  if (force) tags.push('force');
  if (parseCacheCleared)
    tags.push(parseCacheClearedLang ? `parse-cache cleared (${parseCacheClearedLang})` : 'parse-cache cleared');
  return tags.length > 0 ? ` (${tags.join(', ')})` : '';
}

/** Render the indexAll summary card (counts + duration + tags + error tail). */
function formatIndexResult({ result, force, parseCacheCleared, parseCacheClearedLang }: FormatIndexResultArgs): string {
  const tagStr = buildIndexTagStr(force, parseCacheCleared, parseCacheClearedLang);
  const lines: string[] = [
    `## Re-indexed ${result.filesIndexed} file${result.filesIndexed === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s${tagStr}`,
    `- ${result.nodesCreated} node${result.nodesCreated === 1 ? '' : 's'}, ${result.edgesCreated} edge${result.edgesCreated === 1 ? '' : 's'}`,
  ];
  if (result.filesSkipped > 0) lines.push(`- Skipped: ${result.filesSkipped}`);
  if (result.filesErrored > 0) lines.push(`- Errored: ${result.filesErrored}`);
  if (!result.success) lines.push('\n⚠ Some files failed to index — see `.cartograph/errors.log`.');
  return lines.join('\n');
}

/**
 * Apply forward schema migrations on the project DB without
 * re-indexing. Used as the cheap recovery path after a
 * `Database schema vN is behind` error — opens with
 * `autoMigrate: true` (which runs migrations once on open) and
 * returns immediately.
 *
 * `ctx.getCartograph` opens with `autoMigrate: true` on the MCP-
 * server path (project-cache), so by the time the handler runs,
 * any pending migrations have already been applied — possibly on
 * an earlier call this session, possibly at server boot. We can't
 * tell from inside the handler whether THIS call ran migrations
 * or whether the DB was already current. The response therefore
 * states the resulting version neutrally and points the agent at
 * `cartograph admin migrate` (CLI) for the rare case where pre /
 * post detection matters (the CLI does a two-phase open to tell
 * the difference).
 */
async function handleMigrate(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const { CURRENT_SCHEMA_VERSION } = await import('../../db/migrations.js');
  const v = cg.db.getSchemaVersion();
  const at = v?.version ?? 0;
  const lines: string[] = [`## Schema at v${at} (binary supports v${CURRENT_SCHEMA_VERSION})`];
  if (v?.description) lines.push(`- ${v.description}`);
  if (at >= CURRENT_SCHEMA_VERSION) {
    lines.push('- Already current. Any migrations needed at server boot or earlier in this session have completed.');
  } else {
    // Should be unreachable when ctx.getCartograph used autoMigrate: true;
    // included for the freak case where the cache short-circuited to a
    // pre-existing stale handle.
    lines.push(
      `- Behind by ${CURRENT_SCHEMA_VERSION - at} migration${CURRENT_SCHEMA_VERSION - at === 1 ? '' : 's'} — restart the MCP server to apply.`,
    );
  }
  return ok(textResult(lines.join('\n')));
}

async function handleBuildSimilarityEdges(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : undefined;
    const cg = ctx.getCartograph(projectPath);
    // `k` (positive integer) and `minScore` ([0, 1]) are range-enforced
    // by the Zod schema at the dispatch boundary — out-of-range input is
    // rejected there, not clamped. Both carry a schema default, so the
    // parsed args always supply a valid value.
    const k = typeof args['k'] === 'number' ? args['k'] : DEFAULT_SIMILAR_K;
    const minScore = typeof args['minScore'] === 'number' ? args['minScore'] : DEFAULT_SIMILAR_MIN_SCORE;

    const { buildSimilarToEdges } = await import('../../embeddings/similar-edges.js');
    const result = await buildSimilarToEdges(cg, { k, minScore });

    const lines: string[] = ['## Built similarity edges'];
    lines.push(`- Written: ${result.written}`, `- Nodes processed: ${result.processed}`);
    if (result.reason) {
      lines.push(`- Note: ${result.reason}`);
    }
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Build similarity edges failed: ${errMsg(error_)}`);
  }
}

async function handlePruneStore(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : undefined;
    const cg = ctx.getCartograph(projectPath);
    const { pruneOrphanStoreRows, MS_PER_DAY, PRUNE_STORE_DEFAULT_DAYS } = await import(
      '../../db/queries-summaries.js'
    );
    // `maxAgeDays` (non-negative) is range-enforced by the Zod schema at
    // the dispatch boundary — a present-but-negative value is rejected
    // there, not silently coerced. The field carries a schema default,
    // so the parsed args always supply a valid value.
    const maxAgeDaysRaw = args['maxAgeDays'];
    const maxAgeDays =
      typeof maxAgeDaysRaw === 'number' && maxAgeDaysRaw >= 0 ? maxAgeDaysRaw : PRUNE_STORE_DEFAULT_DAYS;

    const { dbReclaimAfterBulkDelete } = await import('../../db/index.js');
    const sizeBefore = cg.db.getSize();
    const result = pruneOrphanStoreRows(cg.queries, {
      maxAgeMs: maxAgeDays * MS_PER_DAY,
    });
    const totalPruned = result.summariesPruned + result.embeddingsPruned;
    // Deleting rows only moves pages to the freelist — the file still
    // occupies the same disk. Reclaim the freelist AND truncate the WAL
    // so the prune actually shrinks the DB. Skipped when nothing was
    // deleted (no freelist to reclaim).
    if (totalPruned > 0) {
      dbReclaimAfterBulkDelete(cg.db);
    }
    const sizeAfter = cg.db.getSize();

    const lines: string[] = ['## Pruned cold orphan store rows'];
    lines.push(
      `- Threshold: ${maxAgeDays} day(s) (cutoff = ${new Date(result.cutoffMs).toISOString()})`,
      `- summary_store rows pruned: ${result.summariesPruned}`,
      `- embedding_store rows pruned: ${result.embeddingsPruned}`,
    );
    if (result.summariesPruned === 0 && result.embeddingsPruned === 0) {
      lines.push(
        '',
        'No cold orphans matched. Either every store row has a live ref, or every orphan was bumped within the threshold (revert/rename reuse pool).',
      );
    } else {
      const reclaimed = Math.max(0, sizeBefore - sizeAfter);
      lines.push(
        `- Database: ${formatBytes(sizeBefore)} → ${formatBytes(sizeAfter)} ` + `(reclaimed ${formatBytes(reclaimed)})`,
      );
    }
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Prune store failed: ${errMsg(error_)}`);
  }
}

async function handleScipExport(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : undefined;
    const cg = ctx.getCartograph(projectPath);
    const root = cg.projectRoot;
    const { writeScipExport } = await import('../../scip/index.js');
    const path = await import('node:path');
    const out = typeof args['out'] === 'string' && args['out'] ? args['out'] : path.join(root, 'index.scip');
    const result = writeScipExport(cg.queries, root, out);
    const lines: string[] = ['## Exported SCIP index'];
    lines.push(
      `- File: \`${result.outPath}\``,
      `- Documents: ${result.stats.documents}`,
      `- Symbols: ${result.stats.symbols}`,
      `- Occurrences: ${result.stats.occurrences}`,
      `- Size: ${result.stats.bytes} bytes`,
    );
    if (result.stats.disambiguated > 0) {
      lines.push(`- Disambiguated: ${result.stats.disambiguated} symbol(s) had name collisions`);
    }
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`scip-export failed: ${errMsg(error_)}`);
  }
}

async function handleScipImport(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  try {
    const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : undefined;
    const cg = ctx.getCartograph(projectPath);
    const root = cg.projectRoot;
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const inPath = typeof args['in'] === 'string' && args['in'] ? args['in'] : path.join(root, 'index.scip');
    const exists = await fsp
      .access(inPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return err(`scip-import: SCIP file not found: ${inPath}`);
    }
    const { writeScipImport } = await import('../../scip/index.js');
    const result = writeScipImport(cg.queries, root, await fsp.readFile(inPath));
    const lines: string[] = ['## Imported SCIP index'];
    lines.push(
      `- Source: \`${inPath}\``,
      `- Documents: ${result.stats.documents}`,
      `- Files replaced: ${result.stats.files}`,
      `- Nodes: ${result.stats.nodes}`,
      `- Edges: ${result.stats.edges}`,
    );
    if (result.stats.skippedDocuments > 0) {
      lines.push(`- Skipped: ${result.stats.skippedDocuments} document(s) with an unsafe path`);
    }
    if (result.stats.unresolvedEdges > 0) {
      lines.push(`- Dropped: ${result.stats.unresolvedEdges} edge(s) — target symbol had no definition`);
    }
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`scip-import failed: ${errMsg(error_)}`);
  }
}

/** EmbedPhase trailer line for the summarize action's report. */
interface EmbedPhaseSummary {
  candidates: number;
  generated: number;
  errors: number;
  durationMs: number;
  failed?: boolean;
  failureReason?: string;
}

function formatEmbedPhaseLine(embed?: EmbedPhaseSummary | null): string | null {
  if (!embed) return null;
  if (embed.failed) {
    return (
      `\n⚠ **Embed phase failed:** ${embed.failureReason ?? 'unknown error'}. ` +
      `Summaries are persisted; rerun \`cartograph_admin({action: 'embed'})\` once the embedding endpoint is back.`
    );
  }
  if (embed.generated <= 0) return null;
  const errs = embed.errors > 0 ? ` (${embed.errors} errors)` : '';
  return (
    `\n**Embedded** ${embed.generated} new vector${embed.generated === 1 ? '' : 's'} ` +
    `in ${(embed.durationMs / 1000).toFixed(1)}s${errs}`
  );
}

async function handleSummarizePhase(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const concurrency = parseConcurrency(args['concurrency']);
  // Lever C — `summarizeLimit` caps eager generations this pass.
  // Omitted → service falls back to config.llm.summarizeEagerLimit;
  // `0` → uncapped full pass (mirrors the CLI `--all`).
  const summarizeLimit = typeof args['summarizeLimit'] === 'number' ? args['summarizeLimit'] : undefined;
  try {
    const progressOpts = ctx.reportProgress
      ? {
          onProgress: (done: number, total: number) =>
            ctx.reportProgress!(done, total, `summarising symbol ${done}/${total}`),
        }
      : {};
    const result = await cg.llm.summarizeAll({
      concurrency,
      // Conditional spread — `exactOptionalPropertyTypes` rejects an
      // explicit `eagerLimit: undefined`.
      ...(summarizeLimit === undefined ? {} : { eagerLimit: summarizeLimit }),
      ...progressOpts,
    });
    const lines: string[] = [
      `## Summarised ${result.generated} new symbol${result.generated === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s`,
    ];
    const details: string[] = [];
    if (result.cacheHits > 0) details.push(`Cache hits: ${result.cacheHits}`);
    if (result.errors > 0) details.push(`Errors: ${result.errors}`);
    const skipped = result.candidates - result.generated - result.errors - result.cacheHits - result.deferred;
    if (skipped > 0) details.push(`Skipped: ${skipped}`);
    if (details.length > 0) lines.push(`- ${details.join(' — ')}`);
    // Lever C — surface the deferred tail so the caller knows the pass
    // was capped (not failed); it drains on demand via intent-search.
    if (result.deferred > 0) {
      lines.push(
        `- Deferred ${result.deferred} lower-priority symbols — they summarise on demand when ` +
          `\`find mode:intent\` references them. Pass \`summarizeLimit: -1\` for a full pass.`,
      );
    }
    const embedLine = formatEmbedPhaseLine(result.embed);
    if (embedLine) lines.push(embedLine);
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Summarize failed: ${errMsg(error_)}`);
  }
}

async function handleEmbedPhase(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const concurrency = parseConcurrency(args['concurrency']);
  try {
    const progressOpts = ctx.reportProgress
      ? {
          onProgress: (done: number, total: number) =>
            ctx.reportProgress!(done, total, `embedding symbol ${done}/${total}`),
        }
      : {};
    const result = await cg.llm.embed.embedAll({ concurrency, ...progressOpts });
    const lines: string[] = [
      `## Embedded ${result.generated} new vector${result.generated === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s`,
    ];
    const details: string[] = [];
    if (result.candidates !== result.generated) {
      const cached = result.candidates - result.generated - result.errors - result.skipped;
      if (cached > 0) details.push(`Cache hits: ${cached}`);
    }
    if (result.errors > 0) details.push(`Errors: ${result.errors}`);
    if (result.skipped > 0) {
      details.push(
        `Skipped: ${result.skipped} (inputs too large for the embed server's batch size — increase --batch-size on the server to cover these)`,
      );
    }
    if (details.length > 0) lines.push(`- ${details.join(' — ')}`);
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Embed failed: ${errMsg(error_)}`);
  }
}

async function handleClassifyPhase(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const concurrency = parseConcurrency(args['concurrency']);
  try {
    const progressOpts = ctx.reportProgress
      ? {
          onProgress: (done: number, total: number) =>
            ctx.reportProgress!(done, total, `classifying role ${done}/${total}`),
        }
      : {};
    const result = await cg.llm.classifyAll({ concurrency, ...progressOpts });
    const lines: string[] = [
      `## Classified ${result.classified} symbol${result.classified === 1 ? '' : 's'} in ${(result.durationMs / 1000).toFixed(1)}s`,
    ];
    const details: string[] = [];
    if (result.candidates === 0) {
      details.push(
        'No candidates — every symbol with a description (summary or docstring) already has a role from the active model',
      );
    } else {
      const skipped = result.candidates - result.classified - result.errors;
      if (skipped > 0) details.push(`Skipped: ${skipped}`);
      if (result.errors > 0) details.push(`Errors: ${result.errors}`);
    }
    if (details.length > 0) lines.push(`- ${details.join(' — ')}`);
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Classify failed: ${errMsg(error_)}`);
  }
}

async function handleInstallModels(_ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const dir = typeof args['dir'] === 'string' ? args['dir'] : undefined;
  const minimal = args['minimal'] === true;
  const { installRecommendedModels } = await import('../../installer/install-models.js');
  const { RECOMMENDED_MODELS, MINIMAL_MODELS } = await import('../../llm/recommended-models.js');
  try {
    const result = await installRecommendedModels({
      ...(dir ? { dir } : {}),
      models: minimal ? MINIMAL_MODELS : RECOMMENDED_MODELS,
    });
    const lines: string[] = [
      `## Installed ${result.downloaded.length} model${result.downloaded.length === 1 ? '' : 's'}`,
    ];
    if (result.downloaded.length > 0) {
      lines.push('', '**Downloaded:**');
      for (const m of result.downloaded) {
        lines.push(`- ${m.filename} (~${m.sizeMb} MB) — ${m.description}`);
      }
    }
    if (result.skipped.length > 0) {
      lines.push('', '**Already present (skipped):**');
      for (const m of result.skipped) lines.push(`- ${m.filename}`);
    }
    lines.push(
      '',
      'Set `llm.summarizeLlm`, `llm.askLlm`, `llm.embeddingLlm`, `llm.rerankerLlm` in `.cartograph/config.json` to point at the GGUF paths above, or call this from the installer with `--write-config`.',
    );
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`install-models failed: ${errMsg(error_)}`);
  }
}

async function handleDoctor(_ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : undefined;
  const skipProjectChecks = args['skipProjectChecks'] === true;
  const fix = args['fix'] === true;
  const { runDoctor, formatDoctorReport } = await import('../../installer/doctor.js');
  try {
    const result = await runDoctor({
      ...(projectPath ? { projectPath } : {}),
      skipProjectChecks,
      fix,
    });
    return ok(textResult(formatDoctorReport(result)));
  } catch (error_) {
    return err(`doctor failed: ${errMsg(error_)}`);
  }
}

// The `install-shim` action was removed 2026-05-24c when the
// in-process LLM pathway (libcgshim + mini-nllc) was deleted in step
// 4c of the migration. Embed / chat / rerank all run via HTTP
// against an OpenAI-compat backend now — see CLAUDE.md "Native
// dependencies + runtime architecture" + `cartograph doctor` for
// setup guidance.

/**
 * `cartograph_admin({action: 'llm-plan'})` — agent-friendly LLM setup
 * planner. Returns a JSON-shaped plan listing detected backends + the
 * setup presets the agent can offer the user. The user picks one, the
 * agent re-calls with `action: 'llm-apply', preset: <id>`. Designed
 * so an AI agent walking a user through cartograph install doesn't
 * need to drive the interactive @clack wizard.
 */
async function handleLlmPlan(_ctx: ToolCtx, _args: Record<string, unknown>): Promise<ToolOutcome> {
  const { planLlmSetup } = await import('../../installer/llm-setup-plan.js');
  try {
    const plan = await planLlmSetup();
    const lines: string[] = ['## LLM setup plan', ''];
    appendDetectedBackends(lines, plan);
    appendCloudChatAvailability(lines, plan.cloudChatAvailable);
    lines.push('', `**Recommended preset:** \`${plan.recommendedPresetId}\``, '', '**Available presets:**');
    for (const p of plan.presets) {
      lines.push(`- \`${p.id}\` — **${p.label}**`, `  - ${p.description}`, `  - Summary: ${p.summary}`);
      if (p.nextSteps.length > 0) {
        lines.push('  - Next steps:');
        for (const step of p.nextSteps) lines.push(`    - \`${step}\``);
      }
    }
    lines.push(
      '',
      'To apply a preset: `cartograph_admin({action: "llm-apply", preset: "<id>"})`. The agent can show this list to the user, take their pick, and call back.',
    );
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`llm-plan failed: ${errMsg(error_)}`);
  }
}

function appendDetectedBackends(lines: string[], plan: Awaited<ReturnType<typeof import('../../installer/llm-setup-plan.js')['planLlmSetup']>>): void {
  if (plan.detectedBackends.length === 0) {
    lines.push('**No backends detected.** Wizard recommends installing one (see presets below).', '');
    return;
  }
  lines.push('**Detected backends:**');
  for (const b of plan.detectedBackends) {
    const modelHint = b.models.length > 0 ? `${b.models.length} models loaded` : 'no models loaded';
    lines.push(`- ${b.label} at \`${b.endpoint}\` (${modelHint})`);
  }
  lines.push('');
}

function appendCloudChatAvailability(
  lines: string[],
  cloudChatAvailable: { claudeBin: string | null; anthropicApiKey: boolean },
): void {
  if (cloudChatAvailable.claudeBin) {
    lines.push(`**Cloud chat available:** \`claude\` CLI at \`${cloudChatAvailable.claudeBin}\``);
  }
  if (cloudChatAvailable.anthropicApiKey) {
    lines.push('**Cloud chat available:** ANTHROPIC_API_KEY set');
  }
}

/**
 * `cartograph_admin({action: 'llm-apply', preset: <id>})` — apply a
 * setup preset returned by `action: 'llm-plan'`. Writes
 * `.cartograph/config.json` (atomic + .bak.<ts> if a prior file
 * existed) and returns the next-step commands the user must run for
 * the configured endpoints to actually serve traffic.
 */
async function handleLlmApply(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : null;
  const preset = typeof args['preset'] === 'string' ? args['preset'] : '';
  if (!projectPath) {
    return err(
      "llm-apply requires `projectPath: <absolute-path>` — the wizard writes `<projectPath>/.cartograph/config.json` and silently falling back to the MCP server's cwd would land the config in the wrong project. Pass the project root explicitly.",
    );
  }
  if (!preset) {
    return err('llm-apply requires `preset: <id>`. Call `action: "llm-plan"` first to see available presets.');
  }
  const { applyLlmSetupChoice } = await import('../../installer/llm-setup-plan.js');
  try {
    const result = await applyLlmSetupChoice({
      projectRoot: projectPath,
      preset: preset as Parameters<typeof applyLlmSetupChoice>[0]['preset'],
    });
    if (result.applied) {
      // config.json was written to disk; the cached Cartograph for this project
      // holds a stale in-memory config copy that won't see the new LLM preset
      // until evicted. Force eviction so the next tool call (e.g. summarize)
      // re-opens the instance and loads the fresh config from disk.
      ctx.evictCachedProject(projectPath);
    }
    const lines: string[] = [
      `## Applied preset \`${result.preset}\``,
      '',
      formatAppliedPresetLine(result),
    ];
    if (result.notes.length > 0) {
      lines.push('', '**Notes:**');
      for (const n of result.notes) lines.push(`- ${n}`);
    }
    if (result.nextSteps.length > 0) {
      lines.push('', '**Next steps (run these to bring the configured endpoints up):**');
      for (const step of result.nextSteps) lines.push(`- \`${step}\``);
    }
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`llm-apply failed: ${errMsg(error_)}`);
  }
}

function formatAppliedPresetLine(result: {
  readonly applied: boolean;
  readonly configPath: string | null;
  readonly backupPath: string | null;
}): string {
  if (!result.applied) return 'No config written.';
  const backupSuffix = result.backupPath ? ` (backup at \`${result.backupPath}\`)` : '';
  return `Wrote \`${result.configPath}\`${backupSuffix}.`;
}

/**
 * `cartograph_admin({action: 'llm-tune'})` — agent-friendly tuning
 * inspector + writer. Two modes:
 *
 *   Read mode (no `tier` arg) — returns detected hardware + the
 *     recommended per-tier `{llamaServerParallel, cartographConcurrency}`
 *     + the user's current per-tier overrides from config (if any).
 *     Agent renders this in chat so the user can compare what's
 *     auto-tuned vs what they've manually pinned.
 *
 *   Write mode (`tier: '<embed|chat|ask|reranker>', concurrency: N`)
 *     — applies a user override to the corresponding *Llm.concurrency
 *     field in `.cartograph/config.json` (atomic + `.bak.<ts>` backup
 *     if a prior file existed). Cartograph reads the override next
 *     time it embeds/summarizes/etc.
 */
type LlmTier = 'embed' | 'chat' | 'ask' | 'reranker';
type LlmTierConfigKey = 'embeddingLlm' | 'summarizeLlm' | 'askLlm' | 'rerankerLlm';

const LLM_TIERS: ReadonlySet<LlmTier> = new Set(['embed', 'chat', 'ask', 'reranker']);
const LLM_TIER_TO_CONFIG_KEY: Record<LlmTier, LlmTierConfigKey> = {
  embed: 'embeddingLlm',
  chat: 'summarizeLlm',
  ask: 'askLlm',
  reranker: 'rerankerLlm',
};

async function handleLlmTune(_ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : process.cwd();
  const tier = typeof args['tier'] === 'string' ? args['tier'] : null;
  const concurrency = typeof args['concurrency'] === 'number' ? args['concurrency'] : null;
  const { describeHardware, recommendedTuning } = await import('../../installer/hardware-tuning.js');
  const tuning = recommendedTuning();
  if (tier !== null) {
    return writeLlmTuneOverride({ projectPath, tier, concurrency });
  }
  return renderLlmTuneReport({ projectPath, hw: describeHardware(), tuning });
}

interface WriteLlmTuneOverrideArgs {
  readonly projectPath: string;
  readonly tier: string;
  readonly concurrency: number | null;
}

/** Write mode — apply a per-tier concurrency override to .cartograph/config.json. */
async function writeLlmTuneOverride(args: WriteLlmTuneOverrideArgs): Promise<ToolOutcome> {
  const { projectPath, tier, concurrency } = args;
  if (!LLM_TIERS.has(tier as LlmTier)) {
    return err(`llm-tune: \`tier\` must be one of 'embed' / 'chat' / 'ask' / 'reranker' (got '${tier}').`);
  }
  if (concurrency === null || !Number.isInteger(concurrency) || concurrency < 1) {
    return err('llm-tune: write mode requires `concurrency: <positive int>`.');
  }
  const configKey = LLM_TIER_TO_CONFIG_KEY[tier as LlmTier];
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const configPath = path.join(projectPath, '.cartograph', 'config.json');
    const exists = await fsp
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return err(
        `llm-tune: no config.json at ${configPath}. Run \`cartograph_admin({action: 'llm-apply', preset: 'install-ollama', projectPath: '${projectPath}'})\` first.`,
      );
    }
    const parsed = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    const llm = (parsed['llm'] as Record<string, unknown> | undefined) ?? {};
    const tierBlock = (llm[configKey] as Record<string, unknown> | null | undefined) ?? null;
    if (!tierBlock) {
      return err(
        `llm-tune: no \`llm.${configKey}\` block in ${configPath}. Configure it first via \`llm-apply\` or hand-edit.`,
      );
    }
    const previous = (tierBlock['concurrency'] as number | undefined) ?? null;
    tierBlock['concurrency'] = concurrency;
    llm[configKey] = tierBlock;
    parsed['llm'] = llm;
    const backupPath = `${configPath}.bak.${Date.now()}`;
    await fsp.copyFile(configPath, backupPath);
    const tmp = `${configPath}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(parsed, null, 2), 'utf-8');
    await fsp.rename(tmp, configPath);
    return ok(
      textResult(buildOverrideAppliedReport({ tier, configKey, previous, concurrency, configPath, backupPath })),
    );
  } catch (error_) {
    return err(`llm-tune write failed: ${errMsg(error_)}`);
  }
}

interface OverrideAppliedReportArgs {
  readonly tier: string;
  readonly configKey: LlmTierConfigKey;
  readonly previous: number | null;
  readonly concurrency: number;
  readonly configPath: string;
  readonly backupPath: string;
}

function buildOverrideAppliedReport(args: OverrideAppliedReportArgs): string {
  return [
    '## Applied tuning override',
    '',
    `**Tier:** \`${args.tier}\` (config key \`llm.${args.configKey}\`)`,
    `**Concurrency:** ${args.previous ?? '(unset)'} → **${args.concurrency}**`,
    `**Config:** \`${args.configPath}\``,
    `**Backup:** \`${args.backupPath}\``,
    '',
    `Takes effect on the next embed / summarize / rerank pass. ` +
      `To match this on the backend side, restart the corresponding llama-server with \`--parallel ${args.concurrency}\`.`,
  ].join('\n');
}

interface RenderLlmTuneReportArgs {
  readonly projectPath: string;
  readonly hw: string;
  readonly tuning: Awaited<ReturnType<typeof import('../../installer/hardware-tuning.js')['recommendedTuning']>>;
}

/** Read mode — describe hardware + recommendation + current overrides. */
async function renderLlmTuneReport(args: RenderLlmTuneReportArgs): Promise<ToolOutcome> {
  const currentOverrides = await readCurrentOverrides(args.projectPath);
  const lines: string[] = [
    '## LLM tuning',
    '',
    `**Detected hardware:** ${args.hw}`,
    '',
    '**Per-tier recommendation:** (auto-applied unless overridden)',
    '',
    '| Tier | Recommended `llama-server --parallel N` | Recommended cartograph concurrency | Your override |',
    '|---|---|---|---|',
    `| embed (jina, :8080)                | ${args.tuning.embed.llamaServerParallel} | ${args.tuning.embed.cartographConcurrency} | ${currentOverrides['embed'] ?? '(none)'} |`,
    `| chat (Qwen 3B, :8081)              | ${args.tuning.chat.llamaServerParallel} | ${args.tuning.chat.cartographConcurrency} | ${currentOverrides['chat'] ?? '(none)'} |`,
    `| ask (Qwen 7B, :8082)               | ${args.tuning.ask.llamaServerParallel} | ${args.tuning.ask.cartographConcurrency} | ${currentOverrides['ask'] ?? '(none)'} |`,
    `| reranker (bge, :8083 --reranking)  | ${args.tuning.reranker.llamaServerParallel} | ${args.tuning.reranker.cartographConcurrency} | ${currentOverrides['reranker'] ?? '(none)'} |`,
    '',
    '**To apply a manual override:** call `cartograph_admin({action: "llm-tune", projectPath: "<abs>", tier: "<embed|chat|ask|reranker>", concurrency: N})`. ',
    'To match on the backend side, restart the corresponding llama-server with `--parallel N`.',
  ];
  return ok(textResult(lines.join('\n')));
}

async function readCurrentOverrides(projectPath: string): Promise<Record<string, number | null>> {
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const configPath = path.join(projectPath, '.cartograph', 'config.json');
    const exists = await fsp
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return {};
    const parsed = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    const llm = (parsed['llm'] as Record<string, unknown> | undefined) ?? {};
    const readConc = (k: string): number | null => {
      const block = llm[k] as Record<string, unknown> | null | undefined;
      return typeof block?.['concurrency'] === 'number' ? block['concurrency'] : null;
    };
    return {
      embed: readConc('embeddingLlm'),
      chat: readConc('summarizeLlm'),
      ask: readConc('askLlm'),
      reranker: readConc('rerankerLlm'),
    };
  } catch {
    return {};
  }
}

type AdminAction = (ctx: ToolCtx, args: Record<string, unknown>) => Promise<ToolOutcome>;

const ADMIN_ACTIONS: Record<string, AdminAction> = {
  init: handleInit,
  uninit: handleUninit,
  unlock: handleUnlock,
  sync: handleSync,
  index: handleIndex,
  'embed-only': handleEmbedOnly,
  migrate: handleMigrate,
  'build-similarity-edges': handleBuildSimilarityEdges,
  'prune-store': handlePruneStore,
  'scip-export': handleScipExport,
  'scip-import': handleScipImport,
  summarize: handleSummarizePhase,
  embed: handleEmbedPhase,
  classify: handleClassifyPhase,
  'install-models': handleInstallModels,
  doctor: handleDoctor,
  'llm-plan': handleLlmPlan,
  'llm-apply': handleLlmApply,
  'llm-tune': handleLlmTune,
};

const ADMIN_ACTION_NAMES = Object.keys(ADMIN_ACTIONS);

/**
 * Zod schema for `cartograph_admin` — a flat `action`-discriminated
 * family. Every per-action field is `.optional()` (or carries a
 * `.default()`), matching the legacy hand-written JSON `inputSchema`,
 * which never enforced per-action required fields either; cross-field
 * checks (e.g. `path` required for init/uninit, `confirm: true` for
 * uninit) stay in the action handlers.
 *
 * `action` is `z.enum([...ADMIN_ACTION_NAMES])` so the schema and the
 * dispatch table stay in lock-step. `k` / `minScore` / `maxAgeDays` /
 * `concurrency` carry their documented bounds — out-of-range input is
 * REJECTED at the dispatch boundary (locked decision), never clamped.
 */
const adminSchema = z.object({
  action: z
    // ADMIN_ACTION_NAMES is `string[]`; assert the non-empty tuple
    // shape `z.enum` requires. The dispatch table is the sole source.
    .enum(ADMIN_ACTION_NAMES as [string, ...string[]])
    .describe(
      "Action to perform. Diagnostic: `doctor` (check install state + print next steps per gap). LLM setup: `llm-plan` (scan for backends + list setup presets) | `llm-apply` with `preset: '<id>'` (writes config.json + next-step commands) | `llm-tune` (inspect/override per-tier concurrency). Refresh: `sync` (incremental, everyday default) | `index` (full; `force=true` if extractor changed). Setup: `init` | `uninit` | `install-models` (download the curated GGUF set). Pipeline phases (idempotent): `summarize` | `embed` | `classify`. Fix-loops: `embed-only` (semantic-only fast lane) | `migrate` (after schema error) | `unlock` (stale lock) | `build-similarity-edges` | `prune-store` (cold-orphan GC, bounded by `maxAgeDays`). Interop: `scip-export` (write a Sourcegraph-compatible SCIP protobuf index; path via `out`) | `scip-import` (per-file replace of nodes+edges from a SCIP protobuf; path via `in`).",
    ),
  path: z.string().optional().describe('(action=init / action=uninit) Absolute path to the project directory.'),
  confirm: z
    .boolean()
    .optional()
    .describe('(action=uninit) Must be `true` to actually delete the directory. Guard against accidental destruction.'),
  force: z
    .boolean()
    .default(false)
    .describe(
      '(action=index) Clear structural data (nodes, edges, refs) before re-indexing; LLM caches survive via content-hash fallback. Default false.',
    ),
  clearParseCache: z
    .boolean()
    .default(false)
    .describe(
      '(action=index) Wipe the entire per-file parse cache before reindexing. `force` alone preserves it; use this when an extractor changed but its version envelope was not bumped. For one language prefer `clearParseCacheLanguage`. Default false.',
    ),
  clearParseCacheLanguage: z
    .string()
    .optional()
    .describe(
      '(action=index) Drop parse-cache entries for only this language (e.g. "typescript", "python") before reindexing — leaves other grammars\' caches intact. Use when one extractor changed.',
    ),
  k: z
    .number()
    .int()
    .min(1)
    .default(DEFAULT_SIMILAR_K)
    .describe(
      `(action=build-similarity-edges) Nearest neighbors to find per node. Positive integer; default ${DEFAULT_SIMILAR_K}.`,
    ),
  minScore: z
    .number()
    .min(0)
    .max(1)
    .default(DEFAULT_SIMILAR_MIN_SCORE)
    .describe(
      `(action=build-similarity-edges) Minimum similarity score (0..1) to create an edge. Default ${DEFAULT_SIMILAR_MIN_SCORE}.`,
    ),
  maxAgeDays: z
    .number()
    .min(0)
    .default(30)
    .describe(
      '(action=prune-store) Evict orphan summary_store / embedding_store rows whose `last_ref_at` is older than this many days. Default 30. Active rows (≥1 ref) are never evicted. Pass 0 to evict every orphan immediately (defeats revert/rename reuse).',
    ),
  concurrency: z
    .number()
    .int()
    .min(LLM_CONCURRENCY_BOUNDS.min)
    .max(LLM_CONCURRENCY_BOUNDS.max)
    .default(LLM_CONCURRENCY_BOUNDS.default)
    .describe(
      `(action=summarize / embed / classify) Concurrent LLM / embedding requests for this single pass. Default ${LLM_CONCURRENCY_BOUNDS.default}, integer in [${LLM_CONCURRENCY_BOUNDS.min}, ${LLM_CONCURRENCY_BOUNDS.max}]. (action=llm-tune, write mode) Per-tier in-flight requests for the chosen \`tier\`; persists to config.json. Match to your \`llama-server --parallel N\` for that tier.`,
    ),
  summarizeLimit: z
    .number()
    .optional()
    .describe(
      '(action=summarize) Cap on eager summary generations this pass; symbols are ordered by importance and the tail summarises on demand. Omit → config.llm.summarizeEagerLimit (default ~600). `0` → ad-hoc only. `-1` → uncapped full pass.',
    ),
  out: z
    .string()
    .optional()
    .describe('(action=scip-export) Output path for the `.scip` protobuf file. Default: `<projectRoot>/index.scip`.'),
  in: z
    .string()
    .optional()
    .describe('(action=scip-import) Path to the input `.scip` protobuf file. Default: `<projectRoot>/index.scip`.'),
  minimal: z
    .boolean()
    .optional()
    .describe(
      '(action=install-models) Install only the smallest viable subset (embed + 3B chat, ~2.1 GB) instead of the full ~7 GB set. Default false.',
    ),
  skipProjectChecks: z
    .boolean()
    .optional()
    .describe(
      '(action=doctor) Skip the project-init + config checks. Useful for fresh-install verification before any init has run.',
    ),
  fix: z
    .boolean()
    .optional()
    .describe(
      '(action=doctor) Auto-apply remediations for fixable gaps: create `.cartograph/` if missing, download the recommended GGUF set if absent, apply the recommended LLM preset (writes config.json), then re-run the checks. Backend-not-running gaps stay manual. Default false.',
    ),
  preset: z
    .string()
    .optional()
    .describe(
      "(action=llm-apply) Setup preset id to apply; call `action: 'llm-plan'` first for the available ids. Common values: 'install-ollama', 'install-llama-cpp', 'install-mlx', 'cloud-openai', 'cloud-openai-compat', 'hybrid-claude-bridge', 'use-detected-<kind>-<endpoint>'.",
    ),
  tier: z
    .enum(['embed', 'chat', 'ask', 'reranker'])
    .optional()
    .describe(
      "(action=llm-tune, write mode) Tier to override: 'embed' / 'chat' / 'ask' / 'reranker' (maps to embeddingLlm / summarizeLlm / askLlm / rerankerLlm concurrency). Omit (read mode) to see the recommendation.",
    ),
  projectPath: projectPathField,
});

type AdminArgs = z.infer<typeof adminSchema>;

async function handleAdmin(ctx: ToolCtx, args: AdminArgs): Promise<ToolOutcome> {
  // `action` is enum-validated by Zod, so the handler is always
  // present — the lookup result is asserted, not guarded.
  const handler = ADMIN_ACTIONS[args.action]!;
  // The per-action handlers read individual keys off a
  // `Record<string, unknown>` view; the parsed args are structurally a
  // superset, so the cast is safe.
  return handler(ctx, args as Record<string, unknown>);
}

export const ADMIN_TOOL = defineTool({
  name: 'cartograph_admin',
  description:
    'Index lifecycle + LLM-pipeline ops, dispatched by `action` (all bypass the freshness gate). ' +
    'Refresh: `sync` / `index`. Setup: `init` / `uninit`. Phases: `summarize` / `embed` / `classify` / `embed-only`. ' +
    'Fix-loops: `migrate` / `unlock` / `build-similarity-edges` / `prune-store`. Interop: `scip-export` / `scip-import`. ' +
    'See the `action` field for per-action detail.',
  schema: adminSchema,
  handle: handleAdmin,
  bypassFreshnessGate: true,
  isWriteTool: true,
});

export const __adminToolInternals = {
  ensureProjectDirExists,
  formatProgressMsg,
  formatSyncResult,
  buildIndexProgressOpts,
  buildIndexTagStr,
  formatIndexResult,
  formatEmbedPhaseLine,
  appendDetectedBackends,
  appendCloudChatAvailability,
  formatAppliedPresetLine,
  buildOverrideAppliedReport,
};
