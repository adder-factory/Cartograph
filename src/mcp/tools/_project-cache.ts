/**
 * ProjectCache — owns the LRU + watcher coordination for explicit-
 * project Cartograph instances opened by ToolHandler.execute().
 *
 * Extracted from ToolHandler (split #3) so the handler can focus on
 * dispatch + freshness gating. The cache encapsulates four concerns
 * that previously commingled with handler logic:
 *
 *   1. Aliased path → Cartograph map (multiple input paths can point
 *      at the same resolved root + the same CG instance).
 *   2. FIFO eviction by RESOLVED ROOT once MAX_CACHED_PROJECTS is hit
 *      so a parent-dir launch that ends up querying many subprojects
 *      can't leak everything we ever opened.
 *   3. Watcher lifecycle for cached CGs — start on first open, stop
 *      on eviction, soft-cap at MAX_WATCHED_PROJECTS as a memory /
 *      file-descriptor hygiene ceiling. (Pre-G8 the cap also guarded
 *      against macOS's ~256/process `fs.watch` quota; `@parcel/watcher`
 *      uses FSEvents so that specific quota no longer applies, but the
 *      soft-cap remains a sensible bound on per-server fan-out.)
 *   4. Selective close by resolved root (used by handleUninit before
 *      it deletes `.cartograph/` on disk so nothing holds the SQLite
 *      file open).
 *
 * The single-project case (server with `--default-project`) never
 * touches this cache — the default cg is held directly by ToolHandler.
 */

import { resolve as resolvePath, join as joinPath } from 'node:path';
import { statSync } from 'node:fs';
import Cartograph, { findNearestCartographRoot } from '../../index.js';
import { checkSchemaCompat, formatSchemaMismatch } from '../schema-guard.js';
import { errMsg } from '../../errors.js';

/** Soft-cap on simultaneously-cached explicit-project cartographs. */
const MAX_CACHED_PROJECTS = 16;
/** Soft-cap on simultaneously-watched explicit-project cartographs. */
const MAX_WATCHED_PROJECTS = 16;

/**
 * Fingerprint a project's on-disk SQLite file at open time so a
 * subsequent re-init (which replaces the file with a fresh inode at
 * the same path) is detectable before we hand the cached handle out
 * to a tool. Bug surfaced when ollama was wiped+reinit'd between
 * sessions: the cached handle pointed at the deleted inode and every
 * query failed with "database disk image is malformed".
 *
 * Returns null when the file doesn't exist (also a staleness signal —
 * the project was uninited but the cache wasn't pruned).
 */
function fingerprintProjectDb(resolvedRoot: string): string | null {
  try {
    const dbPath = joinPath(resolvedRoot, '.cartograph', 'cartograph.db');
    const s = statSync(dbPath);
    // inode + size identifies a replaced file even if same path and
    // same mtime second; ino flips on rm-then-recreate.
    return `${s.ino}:${s.size}`;
  } catch {
    return null;
  }
}

export class ProjectCache {
  private readonly st = {
    // May contain multiple alias keys pointing to the same CG (e.g.
    // a subdir-projectPath + the resolved root both map to the same
    // instance).
    cgsByPath: new Map<string, Cartograph>(),
    // Insertion-ordered set of RESOLVED ROOTS — used for FIFO eviction.
    cachedRoots: new Map<string, true>(),
    watchedRoots: new Set<string>(),
    // Per-resolved-root fingerprint of the SQLite file at open time. A
    // mismatch on subsequent lookup means the file was replaced (CLI
    // re-init, manual delete + recreate) and the cached handle is
    // stale — evict and reopen.
    dbFingerprints: new Map<string, string>(),
  };

  /** Read-only view for status's "other projects" listing. */
  get readonlyView(): ReadonlyMap<string, Cartograph> {
    return this.st.cgsByPath;
  }

  /** Snapshot cache bookkeeping for diagnostics and invariant tests. */
  snapshot(): { cachedRoots: readonly string[]; watchedRoots: readonly string[] } {
    return {
      cachedRoots: [...this.st.cachedRoots.keys()],
      watchedRoots: [...this.st.watchedRoots],
    };
  }

  /**
   * Get or open a Cartograph for `projectPath`, walking up parent
   * directories to find the nearest `.cartograph/`. Caches by both the
   * input path AND the resolved root so subsequent calls with either
   * form hit the same instance. Auto-starts the file watcher on first
   * open so subsequent queries see edits without a manual sync.
   */
  getOrOpen(projectPath: string): Cartograph {
    const cached = this.st.cgsByPath.get(projectPath);
    if (cached && this.isCachedHandleFresh(cached)) return cached;
    if (cached) {
      // Stale handle (DB file inode/size changed since open). Evict the
      // resolved-root entry and every alias that pointed at the same CG,
      // then fall through to re-open.
      this.evictByRoot(resolvePath(cached.projectRoot));
    }

    const resolvedRoot = findNearestCartographRoot(projectPath);
    if (!resolvedRoot) {
      throw new Error(
        `No .cartograph/ found at or above ${projectPath}. ` +
          `Run \`cartograph init\` in that project first, or pass a different projectPath.`,
      );
    }

    // Same resolved root reached via a different alias → reuse + alias
    // (after the same freshness check).
    const cachedByRoot = this.st.cgsByPath.get(resolvedRoot);
    if (cachedByRoot && this.isCachedHandleFresh(cachedByRoot)) {
      this.st.cgsByPath.set(projectPath, cachedByRoot);
      return cachedByRoot;
    }
    if (cachedByRoot) this.evictByRoot(resolvedRoot);

    this.evictOldestIfFull();
    // The MCP server is the long-lived writer for cross-project queries;
    // opt in to auto-migration here too (the schema-guard B4 catches
    // the opposite case where the DB is ahead of this binary).
    const cg = Cartograph.openSync(resolvedRoot, { autoMigrate: true });
    this.st.cgsByPath.set(resolvedRoot, cg);
    if (projectPath !== resolvedRoot) this.st.cgsByPath.set(projectPath, cg);
    this.st.cachedRoots.set(resolvedRoot, true);
    const fingerprint = fingerprintProjectDb(resolvedRoot);
    if (fingerprint !== null) this.st.dbFingerprints.set(resolvedRoot, fingerprint);
    this.tryStartWatcher(cg);
    return cg;
  }

  /**
   * True when a cached CG's on-disk SQLite file still matches the
   * fingerprint we recorded at open time. Returns true when no
   * fingerprint was stored (defensive — never demote on a missing
   * baseline) AND when the file is unchanged. False ONLY when the
   * file is gone or its inode/size differs — both signal a wipe-and-
   * recreate cycle that would surface as "database disk image is
   * malformed" on the next query.
   */
  private isCachedHandleFresh(cg: Cartograph): boolean {
    let root: string;
    try {
      root = resolvePath(cg.projectRoot);
    } catch {
      return false;
    }
    const recorded = this.st.dbFingerprints.get(root);
    if (recorded === undefined) return true; // never demote without a baseline
    const current = fingerprintProjectDb(root);
    if (current === null) return false; // file gone
    return current === recorded;
  }

  /**
   * Close every cached project whose root resolves to `resolvedRoot`,
   * dropping every alias key that mapped to it. Used by handleUninit
   * before deleting `.cartograph/`. Also drops the resolved root from
   * the sibling registries (cachedRoots / watchedRoots / dbFingerprints)
   * so a follow-up reinit reopens cleanly with a fresh fingerprint.
   */
  closeProjectsMatching(resolvedRoot: string): void {
    for (const [key, cached] of this.st.cgsByPath.entries()) {
      if (this.shouldEvictCachedProject(cached, resolvedRoot)) {
        this.st.cgsByPath.delete(key);
      }
    }
    this.st.cachedRoots.delete(resolvedRoot);
    this.st.watchedRoots.delete(resolvedRoot);
    this.st.dbFingerprints.delete(resolvedRoot);
  }

  /** Close every cached project. Idempotent — duplicate alias keys close the underlying CG once. */
  closeAll(): void {
    const closed = new Set<Cartograph>();
    for (const cg of this.st.cgsByPath.values()) {
      if (closed.has(cg)) continue;
      closed.add(cg);
      try {
        cg.watcher.stop?.();
      } catch {
        /* idempotent */
      }
      try {
        cg.close();
      } catch {
        /* idempotent */
      }
    }
    this.st.cgsByPath.clear();
    this.st.cachedRoots.clear();
    this.st.watchedRoots.clear();
    this.st.dbFingerprints.clear();
  }

  /**
   * FIFO eviction: drop the OLDEST cached explicit-project entry when
   * adding a new one would push the cache past MAX_CACHED_PROJECTS.
   * Closes the cg + stops its watcher + drops all alias keys.
   * (Picked FIFO over LRU because in practice the agent either stays
   * on one project — `--default-project` — or rotates through a few;
   * LRU bumping adds complexity without meaningful win in either case.)
   */
  private evictOldestIfFull(): void {
    while (this.st.cachedRoots.size >= MAX_CACHED_PROJECTS) {
      const oldest = this.st.cachedRoots.keys().next().value;
      // Explicit `=== undefined` (not truthy): a falsy-but-defined key
      // (e.g. empty-string path) must still evict, else this loop
      // returns early on a non-empty map → cache stuck oversized.
      if (oldest === undefined) return;
      this.evictByRoot(oldest);
    }
  }

  /**
   * Evict a cached project by its resolved root — public surface for
   * callers that need to bust a stale in-memory Cartograph after writing
   * config.json (e.g. llm-apply). Safe no-op when the root was never
   * cached. Delegates to the shared private implementation.
   */
  evictProject(root: string): void {
    this.evictByRoot(root);
  }

  /** Evict one cached project: drop the LRU entry, clear the db
   *  fingerprint entry, remove every alias-path that pointed at it,
   *  stop its watcher (if running), and close the Cartograph instance.
   *  Errors at watcher-stop and close-time are idempotent — best-effort
   *  cleanup, never throw. */
  private evictByRoot(root: string): void {
    this.st.cachedRoots.delete(root);
    this.st.dbFingerprints.delete(root);
    const cg = this.st.cgsByPath.get(root);
    for (const [key, value] of this.st.cgsByPath.entries()) {
      if (value === cg) this.st.cgsByPath.delete(key);
    }
    if (this.st.watchedRoots.has(root)) {
      try {
        cg?.watcher.stop?.();
      } catch {
        /* idempotent */
      }
      this.st.watchedRoots.delete(root);
    }
    try {
      cg?.close();
    } catch {
      /* idempotent */
    }
  }

  /**
   * Start the file watcher on a freshly-opened cached project.
   * Idempotent (deduped by `cg.projectRoot`); soft-caps so a sandboxed
   * agent querying many projects doesn't fan out unbounded watchers.
   * Failures are best-effort: logged to stderr and otherwise silent.
   * B4 schema-compat guard: refuse to start when on-disk schema is
   * newer than what this server's loaded code understands.
   */
  private tryStartWatcher(cg: Cartograph): void {
    let root: string;
    try {
      root = cg.projectRoot;
    } catch {
      return;
    }
    if (this.st.watchedRoots.has(root)) return;
    if (this.st.watchedRoots.size >= MAX_WATCHED_PROJECTS) return;
    const compat = checkSchemaCompat(cg);
    if (!compat.ok) {
      process.stderr.write(`[Cartograph MCP] ${formatSchemaMismatch(compat)} Watcher NOT started for ${root}.\n`);
      return;
    }
    try {
      const started = cg.watcher.start({
        onSyncComplete: (result) => {
          if (result.filesChanged > 0) {
            process.stderr.write(
              `[Cartograph MCP] Auto-synced ${result.filesChanged} file(s) in ${result.durationMs}ms (${root})\n`,
            );
          }
        },
        onSyncError: (err) => {
          process.stderr.write(`[Cartograph MCP] Auto-sync error (${root}): ${err.message}\n`);
        },
      });
      if (started) this.st.watchedRoots.add(root);
    } catch (err) {
      // Watcher startup must never fail the tool call.
      process.stderr.write(`[Cartograph MCP] Failed to start watcher for ${root}: ${errMsg(err)}\n`);
    }
  }

  /**
   * Decide whether to evict a cached Cartograph entry for closeProjectsMatching.
   * Returns true when the entry's projectRoot can't be read (half-closed
   * connection) OR when its root resolves to `resolvedRoot` — both cases
   * mean the caller should `delete` the cache slot. The close attempt is
   * best-effort (idempotent close errors are swallowed).
   */
  private shouldEvictCachedProject(cached: Cartograph, resolvedRoot: string): boolean {
    let cgRoot: string;
    try {
      cgRoot = cached.projectRoot;
    } catch {
      return true;
    }
    if (resolvePath(cgRoot) !== resolvedRoot) return false;
    try {
      cached.close();
    } catch {
      /* idempotent */
    }
    return true;
  }
}
