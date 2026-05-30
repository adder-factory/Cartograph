/**
 * Miner-refs index-hook factory. `build-context-refs.ts` and
 * `config-refs.ts` are structural twins — {@link makeRefsIndexHook} is
 * their one public entry point: given the per-miner specifics it
 * assembles a complete `IndexHook` (full rescan on indexAll, incremental
 * + algo-version self-heal on sync). Everything else in this module is
 * the internal machinery the factory wires together.
 */

import type { IndexHookContext } from './types.js';
import type { IndexHook } from './registry.js';
import type { SyncResult } from '../extraction/index.js';
import { getAllFiles, getFileByPath } from '../db/queries-files.js';
import { getMetadata, setMetadata, type MetadataKey } from '../db/queries-metadata.js';
import { findEnclosingNode, sortScopesBySpan, type ScopeNode } from './enclosing.js';
import { logDebug, errMsg } from '../errors.js';
import type { QueryBuilder } from '../db/queries.js';

/** Scope passed to a miner-refs hook's refresh — whole project or a file set. */
type RefreshScope = { scope: 'all' } | { scope: 'files'; files: string[] };

interface RefTarget {
  path: string;
  language: string;
}

interface ResolveRefTargetsArgs {
  ctx: IndexHookContext;
  options: { scope: 'all' } | { scope: 'files'; files: string[] };
  /** Called when scope is 'all' — truncates the entire table. */
  clearAll: (qb: QueryBuilder) => void;
  /** Called when scope is 'files' — removes rows for orphaned file paths. */
  pruneOrphaned: (qb: QueryBuilder) => void;
  /** Called when scope is 'files' and the target list is non-empty —
   *  deletes rows for the specific paths about to be re-mined. */
  deleteForPaths: (qb: QueryBuilder, paths: string[]) => void;
}

/**
 * Resolve the target file list + clear/prune the destination table
 * for a miner-refs hook based on scope. Shared by `build-context-refs`
 * and `config-refs` which differ only in which table-mutation functions
 * they pass.
 */
function resolveRefTargets(args: ResolveRefTargetsArgs): RefTarget[] {
  const { ctx, options, clearAll, pruneOrphaned, deleteForPaths } = args;
  if (options.scope === 'all') {
    clearAll(ctx.queries);
    return getAllFiles(ctx.queries).map((f) => ({ path: f.path, language: f.language }));
  }
  const records = options.files
    .map((p) => getFileByPath(ctx.queries, p))
    .filter((f): f is NonNullable<typeof f> => f != null);
  const targets = records.map((f) => ({ path: f.path, language: f.language }));
  pruneOrphaned(ctx.queries);
  if (targets.length > 0) {
    deleteForPaths(
      ctx.queries,
      targets.map((t) => t.path),
    );
  }
  return targets;
}

/** Resolves the enclosing symbol node ID for a given file+line. */
type EnclosingResolver = (filePath: string, line: number) => string | null;

interface RefreshRefsHookArgs {
  ctx: IndexHookContext;
  options: { scope: 'all' } | { scope: 'files'; files: string[] };
  /** When false the hook is a no-op (mirrors `ctx.config.enable*` flags). */
  enabled: boolean;
  hookName: string;
  /** Resolve target files + clear/prune the table. */
  resolveTargets: (
    ctx: IndexHookContext,
    options: { scope: 'all' } | { scope: 'files'; files: string[] },
  ) => RefTarget[];
  /**
   * Extract refs from `targets` using `resolveEnclosing` and persist
   * them. This callback owns the extract + apply pair so it can use the
   * correct concrete row shape without generics-threading.
   */
  extractAndApply: (
    projectRoot: string,
    targets: RefTarget[],
    resolveEnclosing: EnclosingResolver,
    queries: QueryBuilder,
  ) => void;
  algoVersionKey: MetadataKey;
  algoVersion: string;
}

/**
 * Shared `refresh` implementation for the miner-refs index hooks
 * (`build-context-refs`, `config-refs`). Both hooks build the same
 * enclosing-scope resolver, call `resolveTargets`, then delegate
 * extract+apply to a caller-supplied callback. Errors are swallowed and
 * logged so a parse failure in one file never aborts the whole hook.
 */
function refreshRefsHook(args: RefreshRefsHookArgs): void {
  const { ctx, options, enabled, hookName, resolveTargets, extractAndApply, algoVersionKey, algoVersion } = args;
  if (!enabled) return;
  try {
    const fileNodes = new Map<string, ScopeNode[]>();
    const resolveEnclosing: EnclosingResolver = (filePath, line) => {
      let nodes = fileNodes.get(filePath);
      if (!nodes) {
        nodes = sortScopesBySpan(
          ctx.queries
            .getNodesByFile(filePath)
            .filter((n) => n.kind === 'function' || n.kind === 'method' || n.kind === 'class' || n.kind === 'interface')
            .map((n) => ({ id: n.id, start: n.startLine, end: n.endLine })),
        );
        fileNodes.set(filePath, nodes);
      }
      return findEnclosingNode(nodes, line);
    };

    const targets = resolveTargets(ctx, options);
    extractAndApply(ctx.projectRoot, targets, resolveEnclosing, ctx.queries);
    setMetadata(ctx.queries, algoVersionKey, algoVersion);
  } catch (err) {
    logDebug(`${hookName} hook failed: ${errMsg(err)}`);
  }
}

interface SyncRefsHookArgs {
  ctx: IndexHookContext;
  result: { changedFilePaths?: string[] | null; filesRemoved: number };
  algoVersionKey: MetadataKey;
  algoVersion: string;
  refresh: (ctx: IndexHookContext, options: { scope: 'all' } | { scope: 'files'; files: string[] }) => void;
}

/**
 * Shared `afterSync` algo-version self-heal for miner-refs hooks.
 * When the stored algo version differs from the current one, forces a
 * full re-mine; otherwise runs an incremental pass when files changed.
 */
function syncRefsHook(args: SyncRefsHookArgs): void {
  const { ctx, result, algoVersionKey, algoVersion, refresh } = args;
  const storedAlgo = getMetadata(ctx.queries, algoVersionKey);
  if (storedAlgo !== algoVersion) {
    refresh(ctx, { scope: 'all' });
    return;
  }
  if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
    refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
  }
}

/**
 * Per-miner specifics for {@link makeRefsIndexHook}. Everything that
 * differs between the `config-refs` and `build-context-refs` hooks —
 * the table-mutation functions, the extractor + apply pair, the
 * algo-version metadata, the enable flag and the hook name.
 */
interface RefsIndexHookConfig<TRef> {
  hookName: string;
  /** Read the per-hook enable flag off the resolved config (default on). */
  isEnabled: (config: IndexHookContext['config']) => boolean;
  algoVersionKey: MetadataKey;
  algoVersion: string;
  clearAll: (qb: QueryBuilder) => void;
  pruneOrphaned: (qb: QueryBuilder) => void;
  deleteForPaths: (qb: QueryBuilder, paths: string[]) => void;
  extract: (projectRoot: string, targets: RefTarget[], resolveEnclosing: EnclosingResolver) => TRef[];
  apply: (queries: QueryBuilder, refs: TRef[]) => void;
}

/**
 * Assemble a complete miner-refs {@link IndexHook} from its per-miner
 * specifics. `config-refs.ts` and `build-context-refs.ts` are structural
 * twins — this factory owns the one shared `refresh` / `afterIndexAll` /
 * `afterSync` wiring so neither file duplicates it.
 */
export function makeRefsIndexHook<TRef>(config: RefsIndexHookConfig<TRef>): IndexHook {
  const refresh = (ctx: IndexHookContext, options: RefreshScope): void => {
    refreshRefsHook({
      ctx,
      options,
      enabled: config.isEnabled(ctx.config),
      hookName: config.hookName,
      resolveTargets: (c, o) =>
        resolveRefTargets({
          ctx: c,
          options: o,
          clearAll: config.clearAll,
          pruneOrphaned: config.pruneOrphaned,
          deleteForPaths: config.deleteForPaths,
        }),
      extractAndApply: (projectRoot, targets, resolveEnclosing, queries) => {
        config.apply(queries, config.extract(projectRoot, targets, resolveEnclosing));
      },
      algoVersionKey: config.algoVersionKey,
      algoVersion: config.algoVersion,
    });
  };
  return {
    name: config.hookName,
    afterIndexAll(ctx) {
      refresh(ctx, { scope: 'all' });
    },
    afterSync(ctx, result: SyncResult) {
      syncRefsHook({ ctx, result, algoVersionKey: config.algoVersionKey, algoVersion: config.algoVersion, refresh });
    },
  };
}
