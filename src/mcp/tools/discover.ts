/**
 * `cartograph_discover` — find every `.cartograph/` directory under a
 * root path. Useful for monorepos where the parent isn't indexed but
 * sub-projects are. Lets the agent enumerate available indices
 * without `find` / `ls` shell calls.
 *
 * Borrowed from CartographContext's `discover_cartograph_contexts`
 * shape — same affordance, scoped to our `.cartograph/` directory
 * convention.
 */
import * as fsMod from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as pathMod from 'node:path';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { errMsg } from '../../errors.js';
import { textResult } from './shared.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { NON_SOURCE_DIR_NAMES } from '../../path-class.js';

// ESM-safe sync require for `bun:sqlite` — bare `require()` throws
// `ReferenceError: require is not defined` in this module since the
// package is `"type": "module"`. Same pattern as src/db/sqlite-adapter.ts:30.
// Pre-bug-#19 fix this loaded `node:sqlite`, which does NOT exist under
// Bun (`No such built-in module: node:sqlite`); every readContextStats
// call silently caught the throw and returned all-null, which rendered
// as em-dashes for every Files/Nodes/Indexed-at column on every project.
const requireCjs = createRequire(import.meta.url);

/** Default scan depth — covers most monorepo shapes (apps/X, packages/X)
 *  without descending into node_modules-deep trees. */
const DEFAULT_MAX_DEPTH = 4;
/** Hard cap on max_depth to prevent unbounded fs scans. */
const MAX_MAX_DEPTH = 10;

interface DiscoveredContext {
  path: string;
  fileCount: number | null;
  nodeCount: number | null;
  indexedAt: string | null;
  /** Populated when the stat read failed. One short line — drives the
   *  per-row em-dash explanation footer (bug #19). */
  failureReason?: string;
}

interface BunSqliteHandle {
  prepare(sql: string): { get(): unknown };
  close(): void;
}

interface BunSqliteCtor {
  new (path: string, opts?: { readonly?: boolean; create?: boolean }): BunSqliteHandle;
}

/**
 * Best-effort minimal stats read. Open read-only via `bun:sqlite` (the
 * runtime's native binding; `node:sqlite` does NOT exist under Bun and
 * was silently failing in every call pre-#19), close immediately so the
 * live MCP's own writer connection isn't blocked. If any step fails
 * (locked file, schema mismatch, truncated db, missing table), populate
 * `failureReason` so the renderer can surface a one-line explanation
 * footer instead of just showing em-dashes with no context.
 */
function readContextStats(
  dbPath: string,
): Pick<DiscoveredContext, 'fileCount' | 'nodeCount' | 'indexedAt' | 'failureReason'> {
  let db: BunSqliteHandle | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Database } = requireCjs('bun:sqlite') as { Database: BunSqliteCtor };
    db = new Database(dbPath, { readonly: true, create: false });
  } catch (e) {
    const raw = errMsg(e);
    // Distinguish the most common cause (the live MCP holds a writer
    // connection) from generic open-failure noise. Without this hint
    // the user reads "open failed: ..." and assumes corruption.
    const lower = raw.toLowerCase();
    const isLockOrBusy =
      lower.includes('locked') || lower.includes('busy') || lower.includes('sqlite_busy') || lower.includes('cantopen');
    const reason = isLockOrBusy
      ? `locked by another process (likely the live MCP's writer connection): ${raw}`
      : `open failed: ${raw}`;
    return { fileCount: null, nodeCount: null, indexedAt: null, failureReason: reason };
  }
  try {
    let fileCount: number | null = null;
    let nodeCount: number | null = null;
    try {
      const fileRow = db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number } | undefined;
      fileCount = fileRow?.c ?? null;
    } catch {
      // `files` table absent on a non-cartograph DB — surface via failureReason
    }
    try {
      const nodeRow = db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number } | undefined;
      nodeCount = nodeRow?.c ?? null;
    } catch {
      // `nodes` table absent — leave nodeCount null
    }
    // Canonical freshness key matches `src/freshness.ts` (`index_timestamp`,
    // stamped as `String(Date.now())` by `eoStampFreshness` on every
    // indexAll/sync). Status reads the same value via `getFreshnessInfo`.
    // Inner try/catch: pre-migration-002 DBs lack `project_metadata`;
    // we still want to surface fileCount/nodeCount from the outer reads.
    let indexedAt: string | null = null;
    try {
      const tsRow = db.prepare(`SELECT value AS v FROM project_metadata WHERE key = 'index_timestamp'`).get() as
        | { v: string }
        | undefined;
      const tsMs = tsRow?.v ? Number(tsRow.v) : Number.NaN;
      if (Number.isFinite(tsMs)) indexedAt = new Date(tsMs).toISOString();
    } catch {
      // project_metadata absent on pre-migration-002 DBs — leave indexedAt null
    }
    return {
      fileCount,
      nodeCount,
      indexedAt,
      // Only emit a reason when something is genuinely missing.
      ...(fileCount === null && nodeCount === null ? { failureReason: 'no cartograph tables found' } : {}),
    };
  } finally {
    try {
      db.close();
    } catch {
      // Best-effort close.
    }
  }
}

/**
 * Best-effort stats for the ACTIVE project. The MCP server already
 * holds a writer connection to it, so a sibling read-only open from
 * {@link readContextStats} can race the writer (WAL checkpoint window,
 * busy retry budget). Reading off the live `cg.queries` connection
 * sidesteps the lock entirely AND guarantees we never miss the active
 * project's own counts — bug #19 noticed this specifically: the project
 * with 14955 nodes was rendering as an em-dash. Returns null when
 * `activeCg` is not the indexed project (or any step fails).
 */
function readActiveContextStats(
  activeCg: ToolCtx['defaultCg'],
): Pick<DiscoveredContext, 'fileCount' | 'nodeCount' | 'indexedAt'> | null {
  if (!activeCg) return null;
  try {
    const fileRow = activeCg.queries.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number } | undefined;
    const nodeRow = activeCg.queries.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number } | undefined;
    let indexedAt: string | null = null;
    try {
      const tsRow = activeCg.queries.db
        .prepare(`SELECT value AS v FROM project_metadata WHERE key = 'index_timestamp'`)
        .get() as { v: string } | undefined;
      const tsMs = tsRow?.v ? Number(tsRow.v) : Number.NaN;
      if (Number.isFinite(tsMs)) indexedAt = new Date(tsMs).toISOString();
    } catch {
      // pre-migration-002 — leave indexedAt null
    }
    return {
      fileCount: fileRow?.c ?? null,
      nodeCount: nodeRow?.c ?? null,
      indexedAt,
    };
  } catch {
    return null;
  }
}

interface TryRecordCartographDirArgs {
  entry: fsMod.Dirent;
  full: string;
  dir: string;
  out: DiscoveredContext[];
}

/** Returns true if the entry is a `.cartograph` dir with a DB — records it and stops descent. */
function tryRecordCartographDir(args: TryRecordCartographDirArgs): boolean {
  const { entry, full, dir, out } = args;
  if (entry.name !== '.cartograph') return false;
  const dbPath = pathMod.join(full, 'cartograph.db');
  if (fsMod.existsSync(dbPath)) {
    out.push({ path: dir, ...readContextStats(dbPath) });
  }
  return true; // always stop descent into .cartograph
}

/**
 * Directory basenames that hold test fixtures / test code rather than
 * real projects. A `.cartograph/` rooted under one of these is a stale
 * test artifact (e.g. `__tests__/evaluation/fixtures/large`), not a
 * project an agent should be invited to query — skip the descent so it
 * never reaches the discovered-context list. `node_modules`/`dist`/etc.
 * are already covered by {@link NON_SOURCE_DIR_NAMES}; this set is the
 * test-bed analogue.
 */
const FIXTURE_DIR_NAMES: ReadonlySet<string> = new Set([
  '__tests__',
  '__mocks__',
  'fixtures',
  'fixture',
  'test-beds',
  'test-bed',
]);

/** Returns true if this directory entry should be skipped entirely. */
function shouldSkipEntry(entry: fsMod.Dirent, depth: number, maxDepth: number): boolean {
  const isSkippedName = NON_SOURCE_DIR_NAMES.has(entry.name);
  const isFixtureName = FIXTURE_DIR_NAMES.has(entry.name);
  const isHiddenNonCartograph = entry.name.startsWith('.') && entry.name !== '.cartograph';
  const isAtDepthLimit = depth + 1 > maxDepth;
  return isSkippedName || isFixtureName || isHiddenNonCartograph || isAtDepthLimit;
}

function walkForCartographDirs(root: string, maxDepth: number, out: DiscoveredContext[]): void {
  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop()!;
    let entries: fsMod.Dirent[];
    try {
      entries = fsMod.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // permission denied, broken symlink, etc.
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const full = pathMod.join(dir, entry.name);
      if (tryRecordCartographDir({ entry, full, dir, out })) continue;
      if (shouldSkipEntry(entry, depth, maxDepth)) continue;
      stack.push({ dir: full, depth: depth + 1 });
    }
  }
}

function formatDiscovered(root: string, contexts: DiscoveredContext[], maxDepth: number): string {
  if (contexts.length === 0) {
    return `## No cartograph contexts found under \`${root}\` (depth ≤ ${maxDepth})\n\n_Try \`cartograph admin init\` in a project directory to create one, or raise \`maxDepth\` if your monorepo is deeper._`;
  }
  const failed = contexts.filter((c) => c.failureReason);
  // Bug #19 — when one or more sibling stat reads failed, surface a
  // single-line per-row explanation footer instead of leaving em-dashes
  // unexplained. The active project's stats are populated via
  // {@link readActiveContextStats}, so a remaining em-dash row means the
  // sibling DB couldn't be opened read-only (likely locked by another
  // process, schema-incompatible, or truncated).
  const failureFooter =
    failed.length > 0
      ? [
          `_Stat read failed for ${failed.length} index${failed.length === 1 ? '' : 'es'} — em-dashes above mean the DB couldn't be opened read-only (the live MCP holding a writer connection, schema mismatch, or truncated file). Per-row reasons:_`,
          ...failed.map((c) => `- \`${c.path}\` — ${c.failureReason}`),
        ]
      : [];
  return renderMarkdownTable(buildDiscoverContextsSpec(contexts, root, failureFooter));
}

/**
 * One row of the discover-contexts table — one resolved `.cartograph/`
 * directory found under the search root. Exported alongside
 * {@link buildDiscoverContextsSpec} so the wording-lint test in
 * `__tests__/result-spec.test.ts` can construct an instance without
 * walking a real filesystem.
 */
export interface DiscoverContextsTableRow {
  path: string;
  fileCount: number | null;
  nodeCount: number | null;
  indexedAt: string | null;
}

/**
 * Build the typed `ResultSpec` for the `cartograph_discover` results
 * table. Pure — call sites pass the already-walked + stat-enriched
 * contexts plus the search root (folded into the title) and the
 * optional failure footer (live data — built by the caller from
 * `contexts.filter(c => c.failureReason)`). The wording-alignment
 * lint pins title + column headers + the "pass projectPath" hint to
 * the discover vocabulary.
 *
 * Null `fileCount` / `nodeCount` / `indexedAt` render as `'—'`
 * (matching the existing convention from the pre-migration handler).
 *
 * **Why `failureFooter` is INSIDE the spec** (vs the role.ts
 * `unclassifiedFooter` precedent that bypasses the spec): the
 * failure-block header text is user-visible prose that the wording
 * lint should walk via `specStrings(spec)`. Role distribution's
 * footers carry a single numeric value the lint doesn't need to
 * see; discover's failure header explains a real error mode and
 * benefits from lint coverage. The per-row reasons inside the
 * failure footer are dynamic (paths + error messages from the live
 * filesystem) and will appear in `specStrings` output — that's fine
 * for the lint since the test constructs a static fixture.
 *
 * **`emptyState` is unreachable in production**: `formatDiscovered`
 * guards `contexts.length === 0` and returns a hand-built message
 * (with `maxDepth` in it) before ever calling this builder. The
 * `emptyState` field exists to satisfy the `MarkdownTableSpec<T>`
 * interface and to give the wording lint a target for the
 * "no contexts found" copy; the actual user-visible empty message
 * is rendered by the caller's guard.
 */
export function buildDiscoverContextsSpec(
  contexts: ReadonlyArray<DiscoverContextsTableRow>,
  root: string,
  failureFooter: ReadonlyArray<string>,
): MarkdownTableSpec<DiscoverContextsTableRow> {
  const title = `${contexts.length} cartograph context${contexts.length === 1 ? '' : 's'} found under \`${root}\``;
  const passHint = '_Pass any of the listed paths as `projectPath` on subsequent calls to query that index._';
  return {
    title,
    emptyState: `No cartograph contexts found under \`${root}\`. Try \`cartograph admin init\` in a project directory.`,
    columns: [
      // Use the absolute path so it is directly usable as `projectPath`
      // on subsequent calls — the tool's trailing instruction says
      // "pass any of the listed paths as `projectPath`", which expects
      // an absolute path. `c.path` is already absolute (the traversal
      // roots at `pathMod.resolve(pathArg)`).
      { header: 'Path', cell: (r) => `\`${r.path}\`` },
      { header: 'Files', align: 'right', cell: (r) => (r.fileCount != null ? String(r.fileCount) : '—') },
      { header: 'Nodes', align: 'right', cell: (r) => (r.nodeCount != null ? String(r.nodeCount) : '—') },
      { header: 'Indexed at', cell: (r) => r.indexedAt ?? '—' },
    ],
    rows: contexts,
    footers: failureFooter.length > 0 ? [passHint, '', ...failureFooter] : [passHint],
  };
}

/**
 * Zod schema for `cartograph_discover` — the structural-campaign-P3
 * proof-of-concept for the `defineTool` infrastructure. One schema is
 * the single source for the JSON `inputSchema`, the handler's arg
 * types, and (P8) the CLI `--max-depth` option.
 *
 * `maxDepth` is `.int().min(1).max(10)` — so a depth of `0`, a
 * negative, an over-cap value (`999`), or a non-integer float is
 * REJECTED at the dispatch boundary by `safeParse` (the locked
 * reject-out-of-range decision), never silently clamped. The handler
 * therefore receives a value already in `[1, 10]` and drops the old
 * `Math.min(Math.floor(...))` clamp entirely.
 */
const discoverSchema = z.object({
  path: z
    .string()
    .optional()
    .describe('Root directory to scan from. Defaults to the current project root when omitted.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(MAX_MAX_DEPTH)
    .default(DEFAULT_MAX_DEPTH)
    .describe('Max directory depth to scan; integer in [1, 10] (default 4, covers typical monorepo shapes).'),
});

type DiscoverArgs = z.infer<typeof discoverSchema>;

async function handleDiscover(ctx: ToolCtx, args: DiscoverArgs): Promise<ToolOutcome> {
  const hasExplicitPath = typeof args.path === 'string' && args.path.length > 0;
  // Default: use the project root when the server has a default project
  // (matches CLI behaviour — CLI scans the cwd / project root, not the
  // parent). Falling back to process.cwd() keeps the no-default-project
  // path intact.
  const defaultRoot = (() => {
    try {
      return ctx.defaultCg?.projectRoot ?? undefined;
    } catch {
      return undefined;
    }
  })();
  const root = hasExplicitPath
    ? // `hasExplicitPath` is a stored boolean, not an inline guard, so
      // TS does not narrow `args.path` (string | undefined) here.
      pathMod.resolve(args.path as string)
    : (defaultRoot ?? process.cwd());
  const rootExists = await fsp
    .access(root)
    .then(() => true)
    .catch(() => false);
  if (!rootExists) {
    return err(`path does not exist: ${root}`);
  }
  // `maxDepth` is already an integer in [1, 10] — Zod's `.int().min().max()`
  // rejected anything else at the dispatch boundary. No clamp needed.
  const maxDepth = args.maxDepth;
  try {
    const contexts: DiscoveredContext[] = [];
    walkForCartographDirs(root, maxDepth, contexts);
    backfillActiveContextStats(ctx, defaultRoot, contexts);
    return ok(textResult(formatDiscovered(root, contexts, maxDepth)));
  } catch (e) {
    return err(`discover failed: ${errMsg(e)}`);
  }
}

/**
 * Bug #19 — backfill the active project's stats from the live
 * `cg.queries` connection. A sibling read-only open against the
 * active DB races the MCP server's own writer (WAL checkpoint, busy
 * budget) and was the most visible symptom — the user's OWN
 * 14,955-node project rendered as `—`. Reading off the live handle
 * sidesteps the lock and guarantees a populated row.
 */
function backfillActiveContextStats(
  ctx: ToolCtx,
  defaultRoot: string | undefined,
  contexts: DiscoveredContext[],
): void {
  if (!defaultRoot) return;
  const activeRoot = pathMod.resolve(defaultRoot);
  const activeStats = readActiveContextStats(ctx.defaultCg);
  if (!activeStats) return;
  for (const c of contexts) {
    if (pathMod.resolve(c.path) !== activeRoot) continue;
    c.fileCount = activeStats.fileCount;
    c.nodeCount = activeStats.nodeCount;
    c.indexedAt = activeStats.indexedAt;
    delete c.failureReason;
    return;
  }
}

export const DISCOVER_TOOL = defineTool({
  name: 'cartograph_discover',
  description:
    'Monorepo discovery — find every `.cartograph/` under a parent path. ' +
    'Returns `(path, file count, node count, indexed-at)` (stats best-effort). ' +
    'Skips build/dependency dirs, dot-dirs, and test-fixture dirs. ' +
    'Pass any returned path as `projectPath` on subsequent calls.',
  schema: discoverSchema,
  handle: handleDiscover,
  // Project-agnostic: doesn't use ctx.getCartograph, no index to gate.
  bypassFreshnessGate: true,
});
