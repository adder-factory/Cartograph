/**
 * Churn index hook — mines git history for per-file commit counts,
 * first/last touched timestamps, and refreshes on-disk LOC.
 * Incremental on sync via `last_mined_churn_head` in
 * project_metadata; full re-mine on indexAll. See `src/churn/`
 * for the miner.
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import type { SyncResult } from '../extraction/index.js';
import {
  mineChurn,
  readFileLoc,
  LAST_MINED_CHURN_HEAD_KEY,
  CHURN_ALGO_VERSION,
  LAST_MINED_CHURN_ALGO_VERSION_KEY,
} from '../churn/index.js';
import { logDebug, errMsg } from '../errors.js';
import { applyLocUpdates, getAllFilePaths } from '../db/queries-files.js';
import { applyChurnDeltas, clearChurn } from '../db/queries-history.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';

/**
 * Apply the mined churn deltas to the DB, handling the side-ways
 * head case (full re-mine) and stamping the new head SHA.
 */
interface ApplyChurnMinedArgs {
  ctx: IndexHookContext;
  indexedFiles: Set<string>;
  mined: Awaited<ReturnType<typeof mineChurn>>;
  fullRescan: boolean;
}

async function applyChurnMined(args: ApplyChurnMinedArgs): Promise<void> {
  const { ctx, indexedFiles, mined, fullRescan } = args;
  if (mined.needsFullRescan) {
    clearChurn(ctx.queries);
    const remined = await mineChurn(ctx.projectRoot, indexedFiles, null);
    applyChurnDeltas(ctx.queries, remined.deltas.values());
    setMetadata(ctx.queries, LAST_MINED_CHURN_HEAD_KEY, remined.currentHead ?? '');
  } else {
    if (fullRescan) clearChurn(ctx.queries);
    applyChurnDeltas(ctx.queries, mined.deltas.values());
    setMetadata(ctx.queries, LAST_MINED_CHURN_HEAD_KEY, mined.currentHead!);
  }
}

async function refresh(
  ctx: IndexHookContext,
  options: { fullRescan: boolean; changedFiles: string[] | null },
): Promise<void> {
  if (ctx.config.enableChurn === false) return;
  try {
    const indexedFiles = new Set(getAllFilePaths(ctx.queries));
    if (indexedFiles.size === 0) return;
    // Self-heal when the persisted algorithm version doesn't match.
    // Forces a one-shot full rescan so users who pull a bugfix don't
    // have to run `cartograph index` manually — incremental sync alone
    // would just keep adding to the wrong historical totals.
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_CHURN_ALGO_VERSION_KEY);
    const fullRescan = options.fullRescan || storedAlgo !== CHURN_ALGO_VERSION;

    const sinceSha = fullRescan ? null : getMetadata(ctx.queries, LAST_MINED_CHURN_HEAD_KEY);
    const mined = await mineChurn(ctx.projectRoot, indexedFiles, sinceSha);
    if (mined.currentHead === null) return; // not in a git repo

    await applyChurnMined({ ctx, indexedFiles, mined, fullRescan });

    // Stamp the version regardless of branch so the next sync stays incremental.
    setMetadata(ctx.queries, LAST_MINED_CHURN_ALGO_VERSION_KEY, CHURN_ALGO_VERSION);
    // LOC refresh intentionally scopes to the sync's changedFiles even
    // on a version-mismatch self-heal: `clearChurn` doesn't touch the
    // `loc` column, and refreshing every file's LOC just because the
    // algo version bumped would do disk reads on the entire project
    // for no real signal. Genuine `options.fullRescan` still refreshes all.
    const targets = options.fullRescan
      ? [...indexedFiles]
      : (options.changedFiles ?? []).filter((p) => indexedFiles.has(p));
    if (targets.length > 0) {
      applyLocUpdates(
        ctx.queries,
        targets.map((p) => ({ path: p, loc: readFileLoc(ctx.projectRoot, p) })),
      );
    }
  } catch (err) {
    logDebug(`churn hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'churn',
  async afterIndexAll(ctx) {
    await refresh(ctx, { fullRescan: true, changedFiles: null });
  },
  async afterSync(ctx, result: SyncResult) {
    await refresh(ctx, { fullRescan: false, changedFiles: result.changedFilePaths ?? null });
  },
};
