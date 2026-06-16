/**
 * Classify a config edit by HOW it takes effect.
 *
 * The viewer's config editor (and any other "save config, then what?"
 * caller) needs to tell the user the right next step after a save,
 * because a `CartographConfig` change does not take effect uniformly:
 *
 *  - `restart` — the database connection binds once at process start
 *    (`DatabaseConnection.open`), so a `database.*` change is only
 *    honored after the server is restarted.
 *  - `reindex` — fields that change WHAT gets indexed (scope globs,
 *    languages, file-size cutoff) or WHICH derived passes run
 *    (biomarkers / co-change / docstrings) only take effect on the next
 *    `indexAll`/`sync`, which re-reads the file via `cgRefreshConfigFromDisk`.
 *  - `hot` — fields re-read on the next consuming call with no re-index
 *    (the `llm.*` block is re-read per LLM call via an mtime check).
 *  - `none` — no classified field changed.
 *
 * `maxFileSize` is `reindex`, not `hot`: although it is read per index
 * call, a persisted change only pulls in (or drops) files on the next
 * index — "applied instantly" would be misleading.
 *
 * Returned by priority: a single save touching several classes reports
 * the most disruptive one (`restart` > `reindex` > `hot` > `none`).
 */
import type { CartographConfig } from '../types.js';

export type ConfigApplyClass = 'restart' | 'reindex' | 'hot' | 'none';

/** DB connection binds at startup — a change here needs a restart. This
 *  classifier is general-purpose: the viewer's editor intentionally keeps
 *  `database` out of its curated, writable surface, so in that flow the
 *  `restart` class is a safety net rather than a reachable result; other
 *  callers that do edit `database` still get the correct classification. */
const RESTART_FIELDS: ReadonlyArray<keyof CartographConfig> = ['database'];

/** Changes what gets indexed / which derived passes run — needs a re-index. */
const REINDEX_FIELDS: ReadonlyArray<keyof CartographConfig> = [
  'include',
  'exclude',
  'languages',
  'frameworks',
  'maxFileSize',
  'enableBiomarkers',
  'enableCoChange',
];

/** Re-read on the next consuming call (e.g. `llm.*` per LLM call) — no re-index. */
const HOT_FIELDS: ReadonlyArray<keyof CartographConfig> = ['llm'];

/**
 * Structural inequality via canonical JSON. Adequate here because both
 * sides originate from `loadConfig` (stable key order) overlaid with the
 * editor's curated fields, so a false positive only ever means showing a
 * safe "re-index" prompt — never silently skipping a real change.
 */
function differs(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

export function classifyConfigChange(prev: CartographConfig, next: CartographConfig): ConfigApplyClass {
  const anyChanged = (fields: ReadonlyArray<keyof CartographConfig>): boolean =>
    fields.some((field) => differs(prev[field], next[field]));
  if (anyChanged(RESTART_FIELDS)) return 'restart';
  if (anyChanged(REINDEX_FIELDS)) return 'reindex';
  if (anyChanged(HOT_FIELDS)) return 'hot';
  return 'none';
}
