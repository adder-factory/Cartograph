/**
 * Issue-history index hook — mines `Fixes/Closes/Resolves #N`
 * commits and attributes them to symbols touched by each commit's
 * hunks. Incremental via `last_mined_issues_head` in
 * project_metadata; only walks new commits since that SHA on both
 * `afterIndexAll` and `afterSync`. See `src/issue-history/` for the
 * miner.
 *
 * Pre-2026-05-01 the `afterIndexAll` path always did a full rescan
 * of every commit in `git log`. Profile against the cartograph repo
 * showed this was 16% of postHooks (167ms/1066ms) on a real-history
 * workload. Now both phases use the incremental path; a full
 * rescan only happens when we have NO prior head OR when the
 * attributions table is empty (orphan-metadata after
 * `clearStructural`).
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import { mineIssueHistory, LAST_MINED_ISSUES_HEAD_KEY } from '../issue-history/index.js';
import { logDebug, errMsg } from '../errors.js';
import { applyIssueAttributions, clearIssueAttributions, getSymbolIssuesCount } from '../db/queries-history.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';

/** Build a `(filePath, name) → nodeId | null` lookup closed over a
 *  per-pass file-level cache. Without the cache, every lookup would
 *  re-fetch all nodes for the file. Pulled out of {@link refresh} so
 *  the caller doesn't carry the closure's `for/if/set` walker as
 *  4-deep nesting. */
function makeFileNameResolver(ctx: IndexHookContext): (filePath: string, name: string) => string | null {
  const fileNodesCache = new Map<string, Map<string, string>>();
  return (filePath, name) => {
    let nameToId = fileNodesCache.get(filePath);
    if (nameToId) return nameToId.get(name) ?? null;
    nameToId = new Map();
    for (const n of ctx.queries.getNodesByFile(filePath)) {
      if (!nameToId.has(n.name)) nameToId.set(n.name, n.id);
    }
    fileNodesCache.set(filePath, nameToId);
    return nameToId.get(name) ?? null;
  };
}

async function refresh(ctx: IndexHookContext): Promise<void> {
  if (ctx.config.enableIssueHistory === false) return;
  try {
    const resolveSymbol = makeFileNameResolver(ctx);

    // Decide incremental vs. full rescan. Incremental requires:
    //   1. A prior `last_mined_issues_head` SHA (we know where we
    //      stopped last time).
    //   2. A non-empty `symbol_issues` table — `clearStructural`
    //      wipes attributions but may leave the metadata key,
    //      producing an "orphan head" that would silently skip a
    //      legitimate full rescan.
    const storedHead = getMetadata(ctx.queries, LAST_MINED_ISSUES_HEAD_KEY);
    const haveAttributions = getSymbolIssuesCount(ctx.queries) > 0;
    const sinceSha = storedHead && haveAttributions ? storedHead : null;

    const mined = await mineIssueHistory(ctx.projectRoot, resolveSymbol, sinceSha);
    if (mined.currentHead === null) return; // not in a git repo

    if (mined.needsFullRescan) {
      // Miner detected the head moved sideways (rebase / branch
      // switch); walk from scratch.
      clearIssueAttributions(ctx.queries);
      const remined = await mineIssueHistory(ctx.projectRoot, resolveSymbol, null);
      applyIssueAttributions(ctx.queries, remined.attributions);
      setMetadata(ctx.queries, LAST_MINED_ISSUES_HEAD_KEY, remined.currentHead ?? '');
    } else if (sinceSha) {
      // Incremental — append attributions for new commits only.
      applyIssueAttributions(ctx.queries, mined.attributions);
      setMetadata(ctx.queries, LAST_MINED_ISSUES_HEAD_KEY, mined.currentHead);
    } else {
      // First run on this index, OR attributions table is empty.
      // Either way the slate is clean; just apply.
      applyIssueAttributions(ctx.queries, mined.attributions);
      setMetadata(ctx.queries, LAST_MINED_ISSUES_HEAD_KEY, mined.currentHead);
    }
  } catch (err) {
    logDebug(`issue-history hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'issue-history',
  async afterIndexAll(ctx) {
    await refresh(ctx);
  },
  async afterSync(ctx) {
    await refresh(ctx);
  },
};
