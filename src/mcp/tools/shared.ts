/**
 * Shared MCP-tool helpers.
 *
 * Pure functions extracted from `ToolHandler` so per-tool modules
 * (in `./<name>.ts`) can call them directly rather than through a
 * class-method indirection. Every helper here is stateless — no
 * dependency on `this`, no instance fields — so handlers don't need
 * to receive a `ToolCtx` just to format a result.
 *
 * `ToolHandler` retains a thin `textResult` shim that delegates here.
 * It exists purely so external consumers can keep calling
 * `handler.textResult(...)`; new handler code should import the free
 * function directly. (`errorResult` is no longer a `shared.ts` export
 * — it moved to the dispatch-only `_error-result.ts` in the P6 wave.)
 */

import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Cartograph from '../../index.js';
import { getStaleFiles } from '../../freshness.js';
import { hasUncommittedChanges } from '../../git-utils.js';
import { getFileByPath } from '../../db/queries-files.js';
import { err, type ToolOutcome } from './_outcome.js';
import type { FileRecord, Node } from '../../types.js';
import type { ToolResult } from '../tool-types.js';
import { isTestPath } from '../../utils.js';
import { CallIdCache } from './_call-id-cache.js';

/** Maximum output length to prevent context bloat (characters). */
export const MAX_OUTPUT_LENGTH = 15000;

/** Suffix appended to truncated output. Counts toward the budget. */
const TRUNCATION_SUFFIX = '\n\n... (output truncated)';

/**
 * Cap on stale file paths rendered inline in the freshness footer.
 * Above this, the remainder is summarised as "(and N more)" so a
 * project-wide drift doesn't blow the result size.
 */
const STALE_FILES_INLINE_CAP = 5;

/** Render a stale-file list, truncating beyond {@link STALE_FILES_INLINE_CAP}. */
function renderStaleFileList(stale: string[]): string {
  if (stale.length <= STALE_FILES_INLINE_CAP) return stale.join(', ');
  return `${stale.slice(0, STALE_FILES_INLINE_CAP).join(', ')} (and ${stale.length - STALE_FILES_INLINE_CAP} more)`;
}

/**
 * Wrap plain text in the MCP `ToolResult` envelope. Does NOT
 * truncate — handlers that produce variable-length output call
 * {@link truncateOutput} explicitly before this wrapper. Tools that
 * always return a known-bounded payload (status banner, playbook,
 * error message) skip the truncation.
 */
export function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

/**
 * Validate that a value is a non-empty string of bounded length,
 * returning the validated string or a `ToolOutcome` `err` arm the
 * handler returns directly. (`errorResult` is no longer handler-
 * reachable post-P6, so there is no `ToolResult`-returning sibling —
 * this is the one string validator handlers use.)
 *
 * The default 4 KB cap is well under SQLite's LIKE/GLOB pattern limit
 * (50 KB) but still generous for any real symbol name or FTS phrase.
 * Without it, a multi-100-KB input throws an unhandled "LIKE or GLOB
 * pattern too complex" from `cg.searchNodes` / similar prepared-
 * statement paths. Also rejects non-strings (the `as string` cast is
 * a TS escape hatch that doesn't enforce runtime shape; an object
 * with a `toString` method would otherwise slip through).
 *
 * Whitespace-only input is rejected by default: a value like `"   "`
 * clears the `length === 0` check but is never a legitimate symbol
 * name, FTS phrase, git ref, SQL query, or LLM prompt. Without the
 * trim check a whitespace-only `prompt` / `question` reaches the LLM
 * as a blank turn and a whitespace `symbol` runs a pointless search.
 * The error message keeps the original `non-empty` wording so existing
 * callers' expectations hold.
 *
 * EXCEPTION — `allowWhitespaceOnly: true`: a `by:'content'` regex
 * pattern of pure whitespace (`"  "`, `"\t"`) is a *legitimate* query
 * — it finds lines with that exact indentation. The grep path passes
 * this flag so only genuinely empty (`length === 0`) input is rejected
 * there.
 *
 * Pass a larger `maxLength` for inputs that legitimately exceed
 * 4 KB — primarily `handleReviewContext`, where unified diffs
 * routinely run into hundreds of KB. The length cap is checked
 * against the RAW string (pre-trim) so a large mostly-whitespace
 * payload still trips the size guard.
 */
/** Arguments for {@link validateStringOutcome}. */
export interface ValidateStringOutcomeArgs {
  /** The value to validate. */
  readonly value: unknown;
  /** Field name used in the error message. */
  readonly name: string;
  /** Maximum allowed length; defaults to 4096 when omitted. */
  readonly maxLength?: number;
  /**
   * When true, only genuinely empty (`length === 0`) input is rejected
   * — whitespace-only input passes. Defaults to false.
   */
  readonly allowWhitespaceOnly?: boolean;
}

export function validateStringOutcome(args: ValidateStringOutcomeArgs): string | ToolOutcome {
  const { value, name, maxLength = 4096, allowWhitespaceOnly = false } = args;
  const r = checkString({ value, name, maxLength, allowWhitespaceOnly });
  return typeof r === 'string' ? r : err(r.error);
}

/** Arguments for {@link checkString}. */
interface CheckStringArgs {
  /** The value to validate. */
  readonly value: unknown;
  /** Field name used in the error message. */
  readonly name: string;
  /** Maximum allowed length. */
  readonly maxLength: number;
  /** When true, only genuinely empty (`length === 0`) input is rejected. */
  readonly allowWhitespaceOnly: boolean;
}

/**
 * Core string check behind {@link validateStringOutcome}. Returns the
 * validated string, or `{ error }` carrying the message — kept a
 * separate helper so the "non-empty, ≤ maxLength" rule stays one
 * function regardless of how the caller wants the failure shaped.
 */
function checkString(args: CheckStringArgs): string | { error: string } {
  const { value, name, maxLength, allowWhitespaceOnly } = args;
  const empty = allowWhitespaceOnly ? value === '' : typeof value === 'string' && value.trim().length === 0;
  if (typeof value !== 'string' || empty) {
    return { error: `${name} must be a non-empty string` };
  }
  if (value.length > maxLength) {
    return { error: `${name} must be at most ${maxLength} characters` };
  }
  return value;
}

/**
 * Render a model identifier for a user-/agent-facing trailer.
 *
 * A local GGUF backend reports its model as the absolute file path it
 * was loaded from (`/Users/me/.cartograph/models/Qwen3-7B-Q4_K_M.gguf`).
 * Echoing that verbatim in an `_ask: model … _` / `_local-chat: model …_`
 * trailer leaks the operator's home directory and bloats the line with
 * a path the agent can't act on. This collapses any value that looks
 * like a filesystem path down to its basename; API model ids
 * (`claude-…`, `gpt-…`, `qwen2.5-coder:7b`) contain no slash and pass
 * through untouched.
 */
export function displayModelName(model: string): string {
  if (!model.includes('/') && !model.includes('\\')) return model;
  // path.basename handles both separators on the host platform; the
  // explicit backslash split covers a Windows path seen on a POSIX host.
  const base = path.basename(model.replaceAll('\\', '/'));
  return base.length > 0 ? base : model;
}

/**
 * Append a "more results may exist" tail to `rendered` when the
 * caller signals a capped result set. Lets the agent know when
 * re-fetching with a higher `limit` could surface more results, AND
 * — by the absence of the hint — confirms when they've seen
 * everything (so a redundant re-fetch is pointless).
 *
 * `hasMore` is the caller's own ground truth. Two common shapes:
 *   - Tools that LIMIT in SQL get `rows.length === requestedLimit`
 *     as a heuristic (false positive when the count exactly equals
 *     the cap; cheap re-fetch confirms).
 *   - Tools that fetch the full set and slice in JS get the exact
 *     `rawCount > shownCount`.
 *
 * The hint names the exact arg the agent should bump (`limit`,
 * `maxCandidates`, etc.) so they don't have to guess.
 */
export function appendMoreHint(rendered: string, hasMore: boolean, argName = 'limit'): string {
  if (!hasMore) return rendered;
  return `${rendered}\n\n` + `> Result capped — pass a higher \`${argName}\` to see more.`;
}

/**
 * Truncate output if it exceeds the maximum length. Cuts at the
 * last newline before the budget when one exists past 80% of the
 * budget, so the truncated payload ends on a clean line boundary;
 * otherwise falls back to a raw character cut.
 *
 * The budget reserves room for {@link TRUNCATION_SUFFIX} so the
 * returned string never exceeds the cap — earlier versions overshot
 * by the suffix length when the line-boundary fallback fired.
 *
 * `maxLen` defaults to {@link MAX_OUTPUT_LENGTH}; callers serving
 * deliberately larger payloads (e.g. `cartograph_local_chat`'s bulk
 * prose) pass a higher cap so they get the same line-boundary cut.
 */
export function truncateOutput(text: string, maxLen: number = MAX_OUTPUT_LENGTH): string {
  if (text.length <= maxLen) return text;
  const budget = maxLen - TRUNCATION_SUFFIX.length;
  const truncated = text.slice(0, budget);
  const cutPoint = pickTruncationCut(truncated, budget);
  return truncated.slice(0, cutPoint) + TRUNCATION_SUFFIX;
}

/** Choose where to cut a truncated string — prefer the last newline
 *  when it's inside the trailing 20%, else cut at the byte budget. */
function pickTruncationCut(truncated: string, budget: number): number {
  const lastNewline = truncated.lastIndexOf('\n');
  const newlineThreshold = budget * 0.8;
  if (lastNewline > newlineThreshold) return lastNewline;
  return budget;
}

/**
 * Delta-mode helpers (#16). Tools that opt in (`cartograph_search` /
 * `cartograph_grep` / `cartograph_explore`) compute a row-key list per
 * result, then call:
 *
 *   - {@link applyDeltaSince} to filter rows against a prior cached set
 *     when the agent passes `since=<call-id>`. Falls back to "no
 *     filtering" + a warning marker when the prior id is unknown.
 *   - {@link mintCallId} to bind the rendered set to a fresh `c_xxxx`
 *     UID that the agent can pass on the next call.
 *   - {@link appendCallIdFooter} to surface the UID + delta summary
 *     line on the result.
 */

interface DeltaResult<T> {
  /** The (possibly filtered) row list to render. */
  rows: T[];
  /** Total before filtering — for the delta summary line. */
  totalBefore: number;
  /** The UID the caller passed (or null when no `since`). */
  sinceUid: string | null;
  /** True when `since` was set but the prior call wasn't in cache. */
  sinceMissing: boolean;
  /**
   * Prior row-key set resolved from cache, or null when there was no
   * `since` arg or the UID didn't resolve. Callers union this with
   * the current full key set when minting the new call id so that a
   * subsequent `since=<this-id>` correctly excludes everything the
   * agent has seen across the chain — not just the latest delta.
   */
  priorKeys: ReadonlySet<string> | null;
}

interface ApplyDeltaSinceArgs<T> {
  callIds: CallIdCache;
  sinceArg: unknown;
  rows: T[];
  rowKey: (row: T) => string;
}

export function applyDeltaSince<T>(args: ApplyDeltaSinceArgs<T>): DeltaResult<T> {
  const { callIds, sinceArg, rows, rowKey } = args;
  if (typeof sinceArg !== 'string' || !sinceArg) {
    return { rows, totalBefore: rows.length, sinceUid: null, sinceMissing: false, priorKeys: null };
  }
  if (!CallIdCache.isUid(sinceArg)) {
    // Don't echo the raw value back into the footer — a malformed
    // `since` value would otherwise land in a markdown blockquote
    // unescaped. The footer renders a generic warning instead.
    return { rows, totalBefore: rows.length, sinceUid: '<malformed>', sinceMissing: true, priorKeys: null };
  }
  const prior = callIds.resolve(sinceArg);
  if (!prior) {
    return { rows, totalBefore: rows.length, sinceUid: sinceArg, sinceMissing: true, priorKeys: null };
  }
  const filtered = rows.filter((r) => !prior.has(rowKey(r)));
  return { rows: filtered, totalBefore: rows.length, sinceUid: sinceArg, sinceMissing: false, priorKeys: prior };
}

/**
 * Mint a UID for the call. When a prior set is supplied, the union
 * (prior ∪ current) is what gets cached so a future `since=<this-id>`
 * filters everything the agent has seen across the chain.
 */
interface MintCallIdArgs {
  callIds: CallIdCache;
  toolName: string;
  currentKeys: ReadonlyArray<string>;
  priorKeys?: ReadonlySet<string> | null;
}

export function mintCallId(args: MintCallIdArgs): string {
  const { callIds, toolName, currentKeys, priorKeys = null } = args;
  if (!priorKeys || priorKeys.size === 0) return callIds.mint(toolName, currentKeys);
  const merged = new Set<string>(priorKeys);
  for (const k of currentKeys) merged.add(k);
  return callIds.mint(toolName, [...merged]);
}

/**
 * Append the call-id marker + (optional) delta summary footer. Format:
 *
 *   > _call: c_xxxxxxxx_  •  pass as `since` for delta-only follow-ups.
 *
 * In delta mode (when `delta` is provided), prepends a one-line
 * summary above the marker. When the prior `since` UID was unknown,
 * adds a soft warning instead of dropping silently to full results.
 */
/**
 * Delta-summary payload for {@link appendCallIdFooter}. Exported as the
 * canonical type — `_call-id-footer.ts`'s `splitCallIdFooter` and the
 * delta-aware tool handlers all type their `since` metadata against it.
 */
export interface DeltaSummary {
  newCount: number;
  totalBefore: number;
  sinceUid: string | null;
  sinceMissing: boolean;
}

export function appendCallIdFooter(rendered: string, newCallId: string, delta?: DeltaSummary): string {
  const parts: string[] = [];
  if (delta?.sinceMissing && delta.sinceUid) {
    parts.push(
      `> ⚠ Delta requested vs \`${delta.sinceUid}\` but that call id is no longer cached ` +
        `(MCP server restart or eviction). Returning full results below.`,
    );
  } else if (delta && delta.sinceUid) {
    const noun = delta.newCount === 1 ? 'new row' : 'new rows';
    parts.push(`> **Delta vs \`${delta.sinceUid}\`** — ${delta.newCount} ${noun} of ${delta.totalBefore} total.`);
  }
  const marker = `> _call: \`${newCallId}\`_  •  pass as \`since\` for delta-only follow-ups.`;
  const header = parts.length > 0 ? parts.join('\n') + '\n\n' : '';
  return `${header}${rendered}\n\n${marker}`;
}

/**
 * Shape every "ref site" carries in this codebase: a path + 1-indexed
 * line + optional enclosing-symbol attribution. SQL/env/secret refs all
 * conform; future ref-domain handlers should follow the same shape so
 * the partition + format helpers below stay reusable.
 */
interface RefSite {
  filePath: string;
  line: number;
  sourceName?: string | null;
  sourceKind?: string | null;
}

/** Stage 6 #6.3 field-projection: allowed compact-row fields. The
 *  `role` entry is opt-in — only renders when the caller passes a
 *  `roles` map to {@link formatNodeList}; otherwise the column is
 *  silently dropped. Adding the field name here lets callers ask
 *  for `fields: ['name', 'role']` without an enum-mismatch error. */
export type CompactFieldName = 'name' | 'kind' | 'path' | 'line' | 'id' | 'role';

const COMPACT_FIELD_SET: ReadonlySet<string> = new Set(['name', 'kind', 'path', 'line', 'id', 'role']);

/**
 * Parse + validate the `fields: string[]` arg used by callers /
 * callees / future walk integrations. Returns null when the arg is
 * absent / empty / has no valid entries — caller falls back to the
 * full-fields default. Drops invalid field names silently rather
 * than erroring.
 */
export function parseFieldsArg(arg: unknown): ReadonlyArray<CompactFieldName> | null {
  if (!Array.isArray(arg) || arg.length === 0) return null;
  const out: CompactFieldName[] = [];
  for (const v of arg) {
    if (typeof v === 'string' && COMPACT_FIELD_SET.has(v)) out.push(v as CompactFieldName);
  }
  return out.length > 0 ? out : null;
}

/** Field enum for `cartograph_search` compact rows. `signature` is the
 *  search-specific addition (rows carry it; callers/callees rows don't).
 *  `id` is the per-node UID for chained calls. */
export type SearchFieldName = 'name' | 'kind' | 'path' | 'line' | 'signature' | 'id';

const SEARCH_FIELD_SET: ReadonlySet<string> = new Set(['name', 'kind', 'path', 'line', 'signature', 'id']);

/** Parse the `fields` arg for `cartograph_search`. Same null-on-empty
 *  semantics as {@link parseFieldsArg}. Silently drops invalid names. */
export function parseSearchFieldsArg(arg: unknown): ReadonlyArray<SearchFieldName> | null {
  if (!Array.isArray(arg) || arg.length === 0) return null;
  const out: SearchFieldName[] = [];
  for (const v of arg) {
    if (typeof v === 'string' && SEARCH_FIELD_SET.has(v)) out.push(v as SearchFieldName);
  }
  return out.length > 0 ? out : null;
}

/** Field enum for `cartograph_at_range` compact rows. `endLine` is the
 *  at-range-specific addition (range queries return both endpoints);
 *  `signature` matches the bullet/table output. */
export type AtRangeFieldName = 'name' | 'kind' | 'path' | 'line' | 'endLine' | 'signature';

const AT_RANGE_FIELD_SET: ReadonlySet<string> = new Set(['name', 'kind', 'path', 'line', 'endLine', 'signature']);

/** Parse the `fields` arg for `cartograph_at_range`. Same null-on-empty
 *  semantics as {@link parseFieldsArg}. Silently drops invalid names. */
export function parseAtRangeFieldsArg(arg: unknown): ReadonlyArray<AtRangeFieldName> | null {
  if (!Array.isArray(arg) || arg.length === 0) return null;
  const out: AtRangeFieldName[] = [];
  for (const v of arg) {
    if (typeof v === 'string' && AT_RANGE_FIELD_SET.has(v)) out.push(v as AtRangeFieldName);
  }
  return out.length > 0 ? out : null;
}

/**
 * Count items by prod/test classification without allocating partitioned arrays.
 *
 * `isTest` defaults to `isTestPath` (back-compat); callers that also want
 * fixture directories counted as non-prod pass a widened predicate
 * (e.g. env-refs: `p => isTestPath(p) || isFixturePath(p)`).
 */
export function countByTestPath(
  items: ReadonlyArray<{ filePath: string }>,
  isTest: (filePath: string) => boolean = isTestPath,
): { prod: number; test: number } {
  let prod = 0;
  let test = 0;
  for (const item of items) {
    if (isTest(item.filePath)) test++;
    else prod++;
  }
  return { prod, test };
}

/**
 * Render one ref site as a markdown bullet:
 *
 *   - [test] [op] `path:line` — kind `name`
 *   - [prod] `path:line` — top-level
 *
 * `formatExtra` injects an optional inline tag between the test/prod
 * marker and the location (sql-refs uses it for the `[op]` segment;
 * env-refs omits it).
 */
export function formatRefSiteLine<T extends RefSite>(
  site: T,
  formatExtra?: (site: T) => string,
  isTest: (filePath: string) => boolean = isTestPath,
): string {
  const tag = isTest(site.filePath) ? '[test] ' : '[prod] ';
  const extra = formatExtra ? `${formatExtra(site)} ` : '';
  const enclosing = site.sourceName ? ` — ${site.sourceKind ?? 'symbol'} \`${site.sourceName}\`` : ' — top-level';
  return `- ${tag}${extra}\`${site.filePath}:${site.line}\`${enclosing}`;
}

/**
 * Annotate a tool's empty-result message with freshness signal so
 * the agent can disambiguate "doesn't exist" from "index is lagging".
 *
 * Returns:
 *   - empty string when no signal can be derived (no git, no metadata).
 *   - "Index in sync" line when the index matches HEAD — the empty
 *     result is a true negative; don't waste a sync round-trip.
 *   - "Index lagging" warning when the index is behind by enough that
 *     the empty result might be a freshness gap; agent can rerun after
 *     `cartograph_admin({action: 'sync'})`.
 *
 * Cheap — `getFreshness()` is the same accessor `appendStaleFilesNote`
 * already calls. Keep messages compact: agents read these on every
 * miss, so verbosity compounds.
 */
export function freshnessHintForEmptyResult(cg: Cartograph): string {
  const f = cg.stats.getFreshness();
  if (!f) return '';
  if (f.isStale) {
    const filesNote =
      f.filesChanged !== null && f.filesChanged > 0
        ? ` (${f.filesChanged} file${f.filesChanged === 1 ? '' : 's'} changed since last index)`
        : '';
    return `\n\n> ⚠ Index lagging${filesNote} — this empty result may be a freshness gap. Run \`cartograph_admin({action: 'sync'})\` and retry if you expected matches.`;
  }
  // `getFreshness()` compares only the indexed-vs-current HEAD SHA — it
  // does NOT see working-tree drift. A just-created or just-edited file
  // (or one the file watcher has not synced yet) is invisible to
  // `isStale`, so only claim a true negative when the working tree is
  // also clean; otherwise the symbol may simply not be indexed yet.
  if (hasUncommittedChanges(cg.projectRoot)) {
    return "\n\n> ⚠ Uncommitted changes on disk — a file you just created or edited may not be indexed yet. Run `cartograph_admin({action: 'sync'})` and retry if you expected a match.";
  }
  // In-sync AND a clean working tree: the negative is real — don't sync.
  return '\n\n> _Index in sync — empty result is a true negative, not a freshness gap._';
}

/**
 * Append a footer listing files whose on-disk content has drifted
 * from the indexed version. Used by symbol-level handlers (notably
 * `cartograph_explore`) so per-result locations carry a freshness
 * signal even when the project HEAD matches.
 *
 * Skipped when the project-level banner already says the index is
 * stale — that warning covers the same ground and avoids redundant
 * statSync/sha256 I/O on every result file for queries against a
 * known-stale index.
 *
 * Bug #20: the warning USED to read "file modified since last index",
 * which agents reliably read as "the user just edited this file" —
 * misleading when the caller never touched the file (the index lagged
 * behind disk for other reasons: a watcher debounce window, a sync
 * still in flight, an `EXTRACTION_LOGIC_VERSION` bump pending re-mine,
 * or simply a file the user-edit-tracker doesn't see). The phrasing
 * now distinguishes "user edited this file" from "index lags disk for
 * some other reason" by consulting `hasUncommittedChanges` on the
 * specific files — `git status --porcelain` knows which files the user
 * actually touched. A file whose content_hash drifted but isn't in the
 * porcelain output is index-lag, not a user edit.
 */
export function appendStaleFilesNote(cg: Cartograph, formatted: string, nodes: Node[]): string {
  if (nodes.length === 0) return formatted;
  if (cg.stats.getFreshness()?.isStale) return formatted;
  const seen = new Set<string>();
  const records: FileRecord[] = [];
  for (const node of nodes) {
    if (seen.has(node.filePath)) continue;
    seen.add(node.filePath);
    const rec = getFileByPath(cg.queries, node.filePath);
    if (rec) records.push(rec);
  }
  if (records.length === 0) return formatted;
  const stale = getStaleFiles(cg.projectRoot, records);
  if (stale.length === 0) return formatted;
  // Partition into "the user edited this file (per git status)" vs
  // "index lags disk for some other reason" so the agent isn't told the
  // file was modified when in fact only the index is behind. Best-
  // effort: a non-git repo (or a git error) collapses to "index lags"
  // — the safe direction, since the alternative wording wrongly
  // implies a user edit.
  const userEditedSet = getUserEditedPathsSet(cg.projectRoot);
  const userEdited: string[] = [];
  const indexLagged: string[] = [];
  for (const path of stale) {
    if (userEditedSet?.has(path)) userEdited.push(path);
    else indexLagged.push(path);
  }
  const segments: string[] = [];
  if (userEdited.length > 0) {
    segments.push(
      `file${userEdited.length === 1 ? '' : 's'} modified since last index (user edit): ${renderStaleFileList(userEdited)}`,
    );
  }
  if (indexLagged.length > 0) {
    segments.push(
      `index lags disk for ${indexLagged.length === 1 ? 'file' : 'files'} (content_hash drift, no user edit detected — see \`cartograph_changed_since\`): ${renderStaleFileList(indexLagged)}`,
    );
  }
  return `${formatted}\n\n> ⚠ Stale results — ${segments.join('; ')}`;
}

/** Wall-clock budget (ms) for the `git status --porcelain` shell-out;
 *  bounds a hung git invocation so a stale lock can't stall the tool. */
const GIT_STATUS_TIMEOUT_MS = 5000;

/**
 * Minimum porcelain v1 line length worth parsing: a 2-char status code
 * (`XY`) + a space + at least one path character. Shorter lines (e.g. a
 * trailing empty split element) carry no path.
 */
const PORCELAIN_MIN_LINE_LENGTH = 4;

/** Index where the path begins in a porcelain v1 line — past the 2-char
 *  status code and its single separating space (`XY <path>`). */
const PORCELAIN_PATH_OFFSET = 3;

/**
 * Set of project-relative paths the user has edited per `git status
 * --porcelain` (staged, unstaged, untracked). Returns null when git is
 * unavailable / not a repo / errors — callers should treat null as
 * "can't disambiguate user edits from index lag" and fall back to
 * showing all drift as index lag (the conservative wording).
 *
 * Each call shells out fresh — `appendStaleFilesNote` is called once
 * per tool response, so deduplication within a single MCP request is
 * not needed today. If a future tool calls it in a loop, a TTL-keyed
 * cache by `rootDir` would be the right addition.
 */
function getUserEditedPathsSet(rootDir: string): ReadonlySet<string> | null {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      encoding: 'utf-8',
      cwd: rootDir,
      timeout: GIT_STATUS_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const set = new Set<string>();
    for (const line of out.split('\n')) {
      if (line.length < PORCELAIN_MIN_LINE_LENGTH) continue;
      // Porcelain v1: `XY <path>` or `XY <old> -> <new>` for renames.
      const path = line.includes(' -> ') ? line.split(' -> ')[1]!.trim() : line.slice(PORCELAIN_PATH_OFFSET).trim();
      if (path) set.add(path);
    }
    return set;
  } catch {
    return null;
  }
}

/**
 * Whether a project-relative file path is under a known fixture
 * directory. Re-exported from `path-class.ts` (the unified path
 * classifier) so the existing tool-file imports from `./shared.js`
 * keep working; new code should import from `path-class.js` directly.
 */
export { isFixturePath } from '../../path-class.js';

/**
 * Resolve a file's `file`-kind node id. Used for incoming-edge walks
 * where the import targets a file rather than a specific symbol inside
 * it (e.g. `import './foo'` lands an `imports` edge on the `file` node,
 * not on any individual export).
 */
export function fileNodeIdFor(cg: Cartograph, filePath: string): string | null {
  for (const n of cg.queries.getNodesByFile(filePath)) {
    if (n.kind === 'file') return n.id;
  }
  return null;
}

/**
 * Node kinds that hold type-usage incoming edges (rather than call
 * edges). Class / interface / type_alias / etc. are reached via
 * `instantiates` / `type_of` / `returns` / `extends` / `implements`
 * — not via the regular `calls` edge that `traverser.getCallers`
 * walks. Both `cartograph_callers` and `cartograph_node {includeCallers}`
 * consult this so a class's construction sites are surfaced under
 * "Callers" instead of being hidden behind file-level imports.
 */
export const TYPE_LIKE_KINDS: ReadonlySet<import('../../types.js').NodeKind> = new Set<
  import('../../types.js').NodeKind
>(['interface', 'class', 'struct', 'type_alias', 'enum', 'trait', 'protocol', 'component', 'module']);

/**
 * Edge kinds that represent type-usage of a type-like node. Typed
 * array so callers can hand it straight to `getIncomingEdges` — the
 * filter pushes into SQL rather than scanning structural edges in JS.
 *
 * Treat as logically immutable — exported for read-only consumption.
 */
export const TYPE_USAGE_EDGE_KINDS: import('../../types.js').Edge['kind'][] = [
  'instantiates',
  'type_of',
  'returns',
  'extends',
  'implements',
];

/**
 * Args for {@link pathFilterStripHint}. The probe callback returns
 * true when the stripped prefix WOULD have matched at least one file
 * — keeps the caller in control of how "matched" is measured (regex
 * sweep, in-memory filter, etc.) so this helper never has to know
 * about the per-tool plumbing.
 */
export interface PathFilterStripHintArgs {
  pathFilter: string | undefined;
  projectRoot: string;
  probe: (stripped: string) => boolean;
}

/**
 * "Did you mean to drop the prefix?" hint for `pathFilter`. Returns a
 * non-empty hint string when the supplied prefix matched zero files
 * BUT stripping a leading project-root-basename segment would have
 * matched. Returns the empty string otherwise.
 *
 * Friction: agents (and humans) routinely paste host-relative paths
 * like `cartograph/src/mcp/` into `pathFilter`, but the index stores
 * project-relative paths (`src/mcp/`). The bare "no files match"
 * message is correct but silent — the agent has no nudge toward the
 * fix. Six sub-agents in the 2026-05-14 session hit this in parallel.
 *
 * Cheap by design: only triggers when (1) the prefix contains a `/`,
 * (2) the leading segment equals the project-root basename, AND (3)
 * the supplied probe says the stripped form would have matched. The
 * probe is invoked at most once per call.
 */
export function pathFilterStripHint(args: PathFilterStripHintArgs): string {
  const { pathFilter, projectRoot, probe } = args;
  if (!pathFilter) return '';
  const slash = pathFilter.indexOf('/');
  if (slash <= 0) return '';
  const head = pathFilter.slice(0, slash);
  const rootBasename = path.basename(projectRoot);
  if (!rootBasename || head !== rootBasename) return '';
  const stripped = pathFilter.slice(slash + 1);
  if (stripped.length === 0) return '';
  if (!probe(stripped)) return '';
  return (
    `\n\n> _\`pathFilter\` "${pathFilter}" matched 0 files. ` +
    `Did you mean "${stripped}"? Path filters are index-relative ` +
    `(project root is "${rootBasename}")._`
  );
}
