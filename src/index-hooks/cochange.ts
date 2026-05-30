/**
 * Co-change index hook — mines git history for file pairs that
 * change together. Persists pair counts + per-file commit counts.
 * Incremental on sync via `last_mined_cochange_head` metadata; full
 * rescan with force-push recovery on indexAll.
 */

import type { IndexHook, IndexHookContext } from './registry.js';
import { mineCoChanges, LAST_MINED_HEAD_KEY } from '../cochange/index.js';
import { logDebug, errMsg } from '../errors.js';
import { getAllFiles } from '../db/queries-files.js';
import { applyCoChangeDeltas, clearCoChanges } from '../db/queries-history.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { classifyCommitMessage } from '../llm/commit-intent.js';
import { recordCommitIntents, clearCommitIntents } from '../db/queries-commit-intents.js';
import { gitCommitCount } from '../git-utils.js';

async function applyResults(
  ctx: IndexHookContext,
  result: { pairs: Map<string, number>; fileCommits: Map<string, number>; subjects?: Map<string, string> },
): Promise<void> {
  const pairDeltas: Array<[string, string, number]> = [];
  for (const [key, count] of result.pairs) {
    const [a, b] = key.split('\0');
    if (a && b) pairDeltas.push([a, b, count]);
  }
  // `result.fileCommits` is intentionally NOT written here — the churn
  // miner is the sole writer of `files.commit_count`. The cochange
  // miner's per-file count stays available for in-memory diagnostics
  // and tests but never reaches the DB.
  applyCoChangeDeltas(ctx.queries, pairDeltas);

  // Stage 7 #2 — classify newly-mined commit subjects and persist
  // intents alongside the co-change deltas. Hook runs the heuristic
  // path only (synchronous, no model load) so sync stays fast. Callers
  // that want richer coverage can run classifyCommitMessageWithFallback
  // with the configured openai-compat chat client.
  if (result.subjects && result.subjects.size > 0) {
    const intentRows: Array<{
      sha: string;
      intent: ReturnType<typeof classifyCommitMessage>['intent'];
      score: number;
    }> = [];
    for (const [sha, subject] of result.subjects) {
      const c = classifyCommitMessage(subject);
      intentRows.push({ sha, intent: c.intent, score: c.score });
    }
    recordCommitIntents(ctx.queries, intentRows);
  }
}

/** Handle full rescan path when cochange mining detected a rebase/branch switch. */
async function applyFullRescan(ctx: IndexHookContext, indexedFiles: Set<string>): Promise<void> {
  clearCoChanges(ctx.queries);
  // Drop stale intents alongside co-changes so a force-pushed branch
  // doesn't carry old SHAs that no longer reach.
  clearCommitIntents(ctx.queries);
  const fresh = await mineCoChanges(ctx.projectRoot, indexedFiles, null);
  if (fresh.pairs.size > 0 || fresh.fileCommits.size > 0) {
    await applyResults(ctx, fresh);
  }
  if (fresh.currentHead) setMetadata(ctx.queries, LAST_MINED_HEAD_KEY, fresh.currentHead);
}

/** Handle incremental update path when mining succeeded and no rescan needed. */
async function applyIncremental(
  ctx: IndexHookContext,
  result: Awaited<ReturnType<typeof mineCoChanges>>,
  clearFirst: boolean,
): Promise<void> {
  if (clearFirst) clearCoChanges(ctx.queries);
  if (result.pairs.size > 0 || result.fileCommits.size > 0) {
    await applyResults(ctx, result);
  }
  if (result.currentHead) setMetadata(ctx.queries, LAST_MINED_HEAD_KEY, result.currentHead);
}

async function refresh(ctx: IndexHookContext, options: { fullRescan: boolean }): Promise<void> {
  if (ctx.config.enableCoChange === false) return;
  try {
    // B23 (2026-05-24) — shallow-clone short-circuit. With < 2
    // commits in history there are zero possible co-change pairs.
    // Skip the miner entirely instead of doing the full git-log
    // subprocess + parse pass for no useful output. The
    // `null` (not-a-git-repo) case falls through to the miner,
    // which has its own no-git-repo guard.
    const commitCount = gitCommitCount(ctx.projectRoot);
    if (commitCount !== null && commitCount < 2) return;
    const indexedFiles = new Set(getAllFiles(ctx.queries).map((f) => f.path));
    if (indexedFiles.size === 0) return;
    const sinceSha = options.fullRescan ? null : getMetadata(ctx.queries, LAST_MINED_HEAD_KEY);
    const result = await mineCoChanges(ctx.projectRoot, indexedFiles, sinceSha);
    if (!result.currentHead) return;

    if (result.needsFullRescan) {
      await applyFullRescan(ctx, indexedFiles);
      return;
    }

    await applyIncremental(ctx, result, options.fullRescan);
  } catch (err) {
    logDebug(`cochange hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'cochange',
  async afterIndexAll(ctx) {
    await refresh(ctx, { fullRescan: true });
  },
  async afterSync(ctx) {
    await refresh(ctx, { fullRescan: false });
  },
};
