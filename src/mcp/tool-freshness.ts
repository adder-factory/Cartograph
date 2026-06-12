import type Cartograph from '../index.js';
import {
  contentDriftCount,
  describeFreshnessRisk,
  freshnessRecommendedAction,
  freshnessSyncCandidateCount,
  hasFreshnessRisk,
  isHeavyFreshnessRisk,
  type FreshnessInfo,
} from '../freshness.js';
import { borrowedWorktreeBanner, detectBorrowedWorktreeIndex } from '../git-utils.js';
import type { PendingFile } from '../sync/index.js';
import type { ToolResult } from './tool-types.js';
import { errorResult } from './tools/_error-result.js';
import type { ToolModule } from './tools/types.js';

interface WorktreeBannerCacheHost {
  readonly worktreeBannerCache: Map<string, string | null>;
}

/**
 * Outcome of `runFreshnessGate` — either a hard block (returned to the
 * caller as the final ToolResult) or a banner + metadata pair to attach
 * to the downstream tool's result.
 */
export interface FreshnessGateOutcome {
  blockResult: ToolResult | null;
  banner: string | null;
  freshnessMeta: import('./tool-types.js').FreshnessMetadata | null;
}

/**
 * Shared singleton for the "no gate applies" case. Frozen so a future
 * caller can't accidentally mutate the shared reference and corrupt
 * other concurrent execute() calls.
 */
const PASS_THROUGH: FreshnessGateOutcome = Object.freeze({
  blockResult: null,
  banner: null,
  freshnessMeta: null,
});

/**
 * F#60 — Compute the per-file staleness banner from the watcher's
 * pending list intersected with the file paths referenced in the tool
 * result's first text block. Returns null when there's nothing pending
 * AND nothing for the response to flag — the common case.
 *
 * Cost on the happy path (no pending files): one `getPendingFiles()`
 * call returning `[]` and an immediate return — no string scanning.
 *
 * Path-match semantics (this is the bug class upstream's port had):
 * `text.includes("foo.ts")` false-matches `foo.ts.snap`. We require
 * the char following the matched path to be a non-pathchar (or
 * end-of-string), giving a `\b`-style boundary without paying for a
 * regex per file.
 */
export function computeStalenessBanner(cg: Cartograph | null, result: ToolResult): string | null {
  if (result.isError || !cg) return null;
  const pending = cg.watcher.getPendingFiles();
  if (pending.length === 0) return null;

  const first = result.content[0];
  if (first?.type !== 'text') return null;
  const text = first.text;

  const referenced: PendingFile[] = [];
  const elsewhere: PendingFile[] = [];
  for (const p of pending) {
    if (textMentionsPath(text, p.path)) referenced.push(p);
    else elsewhere.push(p);
  }
  if (referenced.length === 0 && elsewhere.length === 0) return null;

  const parts: string[] = [];
  if (referenced.length > 0) parts.push(formatStaleBanner(referenced));
  if (elsewhere.length > 0) parts.push(formatStaleFooter(elsewhere));
  return parts.join('\n\n');
}

/** Chars that count as part of a path token; a match isn't a real
 *  "mention" when the next char is one of these (it's a longer path). */
const PATH_CHAR_RE = /[A-Za-z0-9._/\\-]/;

/** A path "is mentioned" when its exact string appears in `text` AND
 *  the char immediately after the match isn't another path char. This
 *  closes the substring-false-match class — `foo.ts` would otherwise
 *  match `foo.ts.snap`, `src/a` would match `src/abc`, etc. */
function textMentionsPath(text: string, p: string): boolean {
  let idx = text.indexOf(p);
  while (idx >= 0) {
    const end = idx + p.length;
    if (end >= text.length) return true;
    // Non-path char immediately after ⇒ word boundary ⇒ a real mention.
    // Backslash is a path char for parity with Windows-native path text in
    // tool responses; pending-file paths are POSIX-normalized at watcher
    // capture time, so `indexOf` only matches when the response uses the
    // same form — the boundary check then rejects a trailing `\foo` that
    // extends the match (e.g. `foo.ts` inside `foo.ts.snap`; F#60 info).
    if (!PATH_CHAR_RE.test(text[end]!)) return true;
    idx = text.indexOf(p, end);
  }
  return false;
}

function formatStaleBanner(referenced: PendingFile[]): string {
  const now = Date.now();
  const lines = referenced.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    const label = p.indexing ? 'indexing in progress' : 'pending sync';
    return `  - ${p.path} (edited ${ageMs}ms ago, ${label})`;
  });
  return (
    '⚠️ Some files referenced below were edited since the last index sync — ' +
    'their cartograph entries may be stale:\n' +
    lines.join('\n') +
    '\nFor accurate content of those specific files, Read them directly. ' +
    'The rest of this response is fresh.'
  );
}

/** Cap to keep the footer compact. F#60 design: agent gets a project-wide
 *  freshness picture without bloating the banner. */
const STALE_FOOTER_CAP = 5;

function formatStaleFooter(elsewhere: PendingFile[]): string {
  const now = Date.now();
  const shown = elsewhere.slice(0, STALE_FOOTER_CAP);
  const lines = shown.map((p) => {
    const ageMs = Math.max(0, now - p.lastSeenMs);
    return `  - ${p.path} (edited ${ageMs}ms ago)`;
  });
  const more = elsewhere.length > STALE_FOOTER_CAP ? `\n  - …and ${elsewhere.length - STALE_FOOTER_CAP} more` : '';
  return (
    `(Note: ${elsewhere.length} file(s) elsewhere in this project are pending index ` +
    `sync but were not referenced above:\n${lines.join('\n')}${more})`
  );
}

/**
 * Compute the borrowed-worktree banner (or null) for a tool call,
 * using the handler's per-(startPath, indexRoot) cache. `startPath`
 * is the request's effective working directory — the explicit
 * `projectPath` arg if any, else `process.cwd()`. The two-key cache
 * means a `cartograph admin init` mid-session that creates a local
 * `.cartograph/` (changing `indexRoot`) misses the cache cleanly and
 * recomputes — the next tool call's banner reflects the fix.
 */
export function computeWorktreeBanner(
  host: WorktreeBannerCacheHost,
  cg: Cartograph | null,
  args: Record<string, unknown>,
): string | null {
  if (!cg) return null;
  const startPath = (args['projectPath'] as string | undefined) ?? process.cwd();
  const indexRoot = cg.projectRoot;
  if (!indexRoot) return null;
  // NUL-separated key — neither path component can contain NUL on any
  // POSIX or Windows filesystem, so the (startPath, indexRoot) pair
  // round-trips unambiguously even when paths contain literal spaces.
  // Space-delimited keys had a theoretical collision the reviewer
  // flagged (`/Users/John Doe` + `/proj` ambiguous with `/Users/John`
  // + `Doe /proj`).
  const cacheKey = `${startPath}\0${indexRoot}`;
  const cached = host.worktreeBannerCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const mismatch = detectBorrowedWorktreeIndex(startPath, indexRoot);
  const banner = mismatch ? borrowedWorktreeBanner(mismatch) : null;
  host.worktreeBannerCache.set(cacheKey, banner);
  return banner;
}

/**
 * Race a `cg.sync({ summarize: false })` against a wall-clock timeout
 * so a worst-case sync doesn't block a tool call for too long.
 */
async function toolHandlerAttemptAutoSync(
  cg: Cartograph,
  f: FreshnessInfo,
): Promise<{ banner: string | null; freshnessMeta: import('./tool-types.js').FreshnessMetadata | null }> {
  try {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error('auto-sync timeout')), AUTO_SYNC_TIMEOUT_MS);
    });
    let syncResult: import('../extraction/index.js').SyncResult;
    try {
      syncResult = await Promise.race([cg.sync({ summarize: false }), timeout]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (syncResult.lockContention) {
      // The sync was SKIPPED — another process holds the index lock, so
      // nothing was synced and the index is still stale. Don't emit a
      // "✓ Auto-synced" banner; fall through to the stale-fallback path.
      return autoSyncStaleFallback(f, 'lock');
    }
    const f2 = cg.stats.getFreshness();
    // Report the count of files the sync ACTUALLY touched, not the
    // pre-sync candidate estimate (which over- or under-counts).
    const syncedCount = syncResult.filesAdded + syncResult.filesModified + syncResult.filesRemoved;
    return {
      banner: `> ✓ Auto-synced ${syncedCount} file(s) before query.`,
      freshnessMeta: f2 ? toFreshnessMetadata(f2, { autoSynced: true }) : null,
    };
  } catch {
    return autoSyncStaleFallback(f, 'timeout');
  }
}

/**
 * Stale-banner fallback for an auto-sync that did NOT refresh the index —
 * either it timed out / threw (`'timeout'`) or it was skipped because
 * another process holds the index lock (`'lock'`). Replaces the CLI
 * "run `cartograph sync`" hint (wrong for an agent reading from MCP)
 * with the matching MCP-side remediation, and reports the metadata as
 * still-stale rather than auto-synced.
 */
function autoSyncStaleFallback(
  f: FreshnessInfo,
  reason: 'timeout' | 'lock',
): { banner: string | null; freshnessMeta: import('./tool-types.js').FreshnessMetadata | null } {
  const cliHint = /run `cartograph sync`\.?$/;
  const baseBanner = f.banner ? f.banner.replace(cliHint, '').trimEnd() : freshnessRiskBannerForMcp(f);
  const suffix =
    reason === 'lock'
      ? " Auto-sync skipped — another process holds the index lock; call `cartograph_admin({action: 'sync'})` once it frees."
      : ` Auto-sync exceeded ${AUTO_SYNC_TIMEOUT_MS}ms — call \`cartograph_admin({action: 'sync'})\` to refresh manually.`;
  const augmented = baseBanner ? baseBanner + suffix : null;
  return { banner: augmented, freshnessMeta: toFreshnessMetadata(f) };
}

/**
 * Pre-flight freshness handling. Tools with `bypassFreshnessGate` skip
 * the gate entirely so it doesn't deadlock the only way out of a
 * heavily-stale state.
 */
interface FreshnessGateInput {
  readonly cg: Cartograph | null;
  readonly mod: ToolModule | undefined;
  readonly allowStale: boolean;
  readonly args: Record<string, unknown>;
}

export async function runFreshnessGate(input: FreshnessGateInput): Promise<FreshnessGateOutcome> {
  const { cg, mod, allowStale, args } = input;
  if (!cg || toolBypassesFreshnessGate(mod, args)) return PASS_THROUGH;
  const f = cg.stats.getFreshness();
  if (!f) return PASS_THROUGH;

  if (!allowStale && hasFreshnessRisk(f) && toolRequiresFreshIndex(mod, args)) {
    if (shouldAutoSync(f)) {
      const synced = await toolHandlerAttemptAutoSync(cg, f);
      if (!metadataHasFreshnessRisk(synced.freshnessMeta)) {
        return { blockResult: null, ...synced };
      }
    }
    return {
      blockResult: {
        ...errorResult(
          `This tool requires a fresh index because stale graph data can produce misleading results — ${describeFreshnessRisk(f)}. ` +
            `Call \`cartograph_admin({action: 'sync'})\` first, or pass \`allowStale: true\` if you intentionally want the cached view.`,
        ),
        metadata: { freshness: toFreshnessMetadata(f, { blocked: true }) },
      },
      banner: null,
      freshnessMeta: null,
    };
  }

  if (!allowStale && hasFreshnessRisk(f) && shouldBlockOnHeavyDrift(f)) {
    return {
      blockResult: {
        ...errorResult(
          `Index too stale to safely query — ${describeFreshnessRisk(f)}. ` +
            `Refusing to serve potentially-wrong results. Call ` +
            `\`cartograph_admin({action: 'sync'})\` first (or run \`cartograph admin sync\` ` +
            `from the shell), or pass \`allowStale: true\` to query the cached view anyway.`,
        ),
        metadata: { freshness: toFreshnessMetadata(f, { blocked: true }) },
      },
      banner: null,
      freshnessMeta: null,
    };
  }

  if (!allowStale && hasFreshnessRisk(f) && shouldAutoSync(f)) {
    const synced = await toolHandlerAttemptAutoSync(cg, f);
    return { blockResult: null, ...synced };
  }

  // Auto-sync skipped (filesChanged outside the auto-sync band, or
  // unknown). The stale banner from freshness.ts ends with "run
  // `cartograph sync`" (CLI). Rewrite to MCP-side guidance so an agent
  // reading the banner from the MCP transport gets the right call.
  return { blockResult: null, banner: freshnessRiskBannerForMcp(f), freshnessMeta: toFreshnessMetadata(f) };
}

function toolBypassesFreshnessGate(mod: ToolModule | undefined, args: Record<string, unknown>): boolean {
  const flag = mod?.bypassFreshnessGate;
  if (typeof flag === 'function') return flag(args);
  return flag === true;
}

function toolRequiresFreshIndex(mod: ToolModule | undefined, args: Record<string, unknown>): boolean {
  const flag = mod?.requiresFreshIndex;
  if (typeof flag === 'function') return flag(args);
  return flag === true;
}

/** Rewrite the freshness.ts CLI hint suffix to point at the MCP tool
 *  the agent should actually call. Idempotent — leaves banners that
 *  don't end with the CLI hint untouched. */
function rewriteStaleBannerForMcp(banner: string | null): string | null {
  if (!banner) return banner;
  const cliHint = /run `cartograph sync`\.?$/;
  if (!cliHint.test(banner)) return banner;
  return banner.replace(cliHint, "call `cartograph_admin({action: 'sync'})`.");
}

/** Auto-sync threshold: bumped from 5 → 50 to absorb a session's worth
 *  of edits when the file watcher missed them (e.g. watcher debounce
 *  edge case, an early-session window before the watcher subscribed,
 *  or a non-watcher-managed write like a rebase). Still bounded by
 *  AUTO_SYNC_TIMEOUT_MS so a worst-case sync can't turn a tool call
 *  into a multi-second hang. */
const AUTO_SYNC_MAX_FILES = 50;
/** Wall-clock budget for the inline auto-sync. Beyond this we abort the
 *  attempt and fall through to the banner so a slow sync doesn't turn a
 *  tool call into a multi-second hang on large monorepos. Bumped from
 *  3s to 10s 2026-05-10: a structural-only sync on a 580-file repo
 *  with 15 changed files runs in ~1s, but the bundled post-hooks
 *  (centrality, biomarkers, hnsw rebuild) can push the wall clock past
 *  3s mid-session. The 10s ceiling (10_000) matches `cg.sync({summarize: false})`'s
 *  observed worst case on this codebase while keeping the failure mode
 *  bounded for monorepo callers. */
const AUTO_SYNC_TIMEOUT_MS = 10_000;
/** Block-on-heavy thresholds: too many files OR too many commits behind. */
const BLOCK_MAX_FILES = 100;
const BLOCK_MAX_COMMITS = 20;

function metadataHasFreshnessRisk(meta: import('./tool-types.js').FreshnessMetadata | null): boolean {
  return meta?.recommendedAction === 'sync' || meta?.recommendedAction === 'sync_required';
}

function shouldAutoSync(f: FreshnessInfo): boolean {
  const candidates = freshnessSyncCandidateCount(f);
  if (candidates == null) return false;
  return candidates <= AUTO_SYNC_MAX_FILES;
}

function shouldBlockOnHeavyDrift(f: FreshnessInfo): boolean {
  return isHeavyFreshnessRisk(f, { maxFiles: BLOCK_MAX_FILES, maxCommits: BLOCK_MAX_COMMITS });
}

function freshnessRiskBannerForMcp(f: FreshnessInfo): string | null {
  const rewritten = rewriteStaleBannerForMcp(f.banner);
  if (rewritten) return rewritten;
  const drifted = contentDriftCount(f);
  if (drifted <= 0) return null;
  return (
    `> ⚠ Index content drift — ${drifted} file${drifted === 1 ? '' : 's'} content-drifted on disk vs indexed ` +
    "`content_hash`; call `cartograph_changed_since` to inspect paths, then `cartograph_admin({action: 'sync'})`."
  );
}

function toFreshnessMetadata(
  f: FreshnessInfo,
  extra?: { autoSynced?: boolean; blocked?: boolean },
): import('./tool-types.js').FreshnessMetadata {
  const metadata: import('./tool-types.js').FreshnessMetadata = {
    isStale: f.isStale,
    severity: f.severity,
    indexedSha: f.indexedSha,
    currentSha: f.currentSha,
    filesChanged: f.filesChanged,
    contentDriftedFiles: f.contentDriftedFiles,
    commitsAhead: f.commitsAhead,
    breakdown: f.breakdown,
    recommendedAction: freshnessRecommendedAction(f, extra),
  };
  if (extra) Object.assign(metadata, extra);
  return metadata;
}
