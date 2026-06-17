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
 *   2. LRU eviction by RESOLVED ROOT once MAX_CACHED_PROJECTS is hit
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
    // Insertion-ordered set of RESOLVED ROOTS — used for LRU eviction.
    cachedRoots: new Map<string, true>(),
    watchedRoots: new Set<string>(),
    // Per-resolved-root fingerprint of the SQLite file at open time. A
    // mismatch on subsequent lookup means the file was replaced (CLI
    // re-init, manual delete + recreate) and the cached handle is
    // stale — evict and reopen.
    dbFingerprints: new Map<string, string>(),
    // Per-resolved-root refcount of in-flight tool calls currently holding
    // this CG. LRU-cap eviction skips a borrowed root so a concurrent burst
    // of new projects can't close a handle another call is still using
    // (tool calls dispatch concurrently — readline doesn't await handlers).
    borrows: new Map<string, number>(),
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
    if (cached && this.isCachedHandleFresh(cached)) {
      try {
        this.touchRoot(resolvePath(cached.projectRoot));
      } catch {
        /* stale/half-closed cached handle; freshness check handles reopening */
      }
      return cached;
    }
    if (cached) {
      // Stale handle (DB file inode/size changed since open). Evict the
      // resolved-root entry and every alias that pointed at the same CG,
      // then fall through to re-open.
      this.evictProject(resolvePath(cached.projectRoot));
    }

    const resolvedRoot = findNearestCartographRoot(projectPath);
    if (!resolvedRoot) {
      throw new Error(
        `No .cartograph/ found at or above ${projectPath}. ` +
          `Run \`cartograph index\` in that project first, or pass a different projectPath.`,
      );
    }

    // Same resolved root reached via a different alias → reuse + alias
    // (after the same freshness check).
    const cachedByRoot = this.st.cgsByPath.get(resolvedRoot);
    if (cachedByRoot && this.isCachedHandleFresh(cachedByRoot)) {
      this.st.cgsByPath.set(projectPath, cachedByRoot);
      this.touchRoot(resolvedRoot);
      return cachedByRoot;
    }
    if (cachedByRoot) this.evictProject(resolvedRoot);

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
    // NB: `st.borrows` is intentionally NOT cleared here — see the {@link borrow}
    // lifecycle note. An in-flight call drains its own root-keyed count via
    // release(); clearing it would under-count a concurrent borrow on a re-opened
    // root and reopen the use-after-close window.
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
    this.st.borrows.clear();
  }

  /**
   * LRU eviction: drop the least-recently-used cached explicit-project entry when
   * adding a new one would push the cache past MAX_CACHED_PROJECTS.
   * Closes the cg + stops its watcher + drops all alias keys.
   *
   * Skips roots an in-flight tool call is still borrowing (refcount > 0): closing
   * a live handle mid-call is a use-after-close. If every cached root is borrowed
   * (a pathological concurrent fan-out), it leaves the cache temporarily over the
   * cap rather than close a handle in use — the next open with a freed slot trims
   * it back down.
   */
  private evictOldestIfFull(): void {
    while (this.st.cachedRoots.size >= MAX_CACHED_PROJECTS) {
      // The oldest (LRU) root with no in-flight borrow. Iterating insertion
      // order (oldest first) gives true LRU; skipping borrowed roots avoids
      // closing a handle a concurrent tool call is still using. If every cached
      // root is borrowed, leave the cache temporarily over the cap rather than
      // close a live one — the next open with a freed slot trims it back.
      let evictable: string | undefined;
      for (const root of this.st.cachedRoots.keys()) {
        if ((this.st.borrows.get(root) ?? 0) === 0) {
          evictable = root;
          break;
        }
      }
      if (evictable === undefined) return;
      this.evictProject(evictable);
    }
  }

  /**
   * Pin a cached CG for the duration of an in-flight tool call so LRU-cap
   * eviction can't close it mid-use. Returns the resolved-root key to release
   * (or null if the root can't be resolved — a no-op release). The default CG
   * is never cached, so callers skip borrowing it.
   *
   * Lifecycle: the count is keyed by RESOLVED ROOT (not CG identity) and is
   * owned solely by this borrow/release pair — every {@link borrow} is matched by
   * a `release()` in the caller's `finally`. The forced-close paths (`evictProject`,
   * `closeProjectsMatching`) deliberately do NOT clear it: a still-running call
   * that took the borrow must drain its own count, and because the key is the root
   * (stable across a close+reopen) the count stays correct even if the project is
   * evicted and re-opened under a different CG instance mid-call — clearing it
   * there would let one call's release under-count another's live borrow on the
   * same root, re-opening the very use-after-close window this guards. Only
   * `closeAll` clears the map, as a whole-server-shutdown reset where no later
   * `release()` will run. (One narrow residual race: a stale-fingerprint eviction
   * between preflight resolving the CG and `ToolHandler.execute` taking the borrow
   * can still close the handle pre-pin; that requires a DB-file swap concurrent
   * with the call and is left as a documented limitation.)
   */
  borrow(cg: Cartograph): string | null {
    let root: string;
    try {
      root = resolvePath(cg.projectRoot);
    } catch {
      return null;
    }
    this.st.borrows.set(root, (this.st.borrows.get(root) ?? 0) + 1);
    return root;
  }

  /** Release a borrow taken by {@link borrow}. No-op on null or an unknown root. */
  release(root: string | null): void {
    if (root === null) return;
    const n = this.st.borrows.get(root);
    if (n === undefined) return;
    if (n <= 1) this.st.borrows.delete(root);
    else this.st.borrows.set(root, n - 1);
  }

  private touchRoot(root: string): void {
    if (!this.st.cachedRoots.has(root)) return;
    this.st.cachedRoots.delete(root);
    this.st.cachedRoots.set(root, true);
  }

  /**
   * Evict one cached project by its resolved root: drop the LRU entry, clear the
   * db fingerprint, remove every alias-path that pointed at it, stop its watcher
   * (if running), and close the Cartograph instance. Errors at watcher-stop and
   * close-time are idempotent — best-effort cleanup, never throw. Safe no-op when
   * the root was never cached.
   *
   * Public surface: also called to bust a stale in-memory Cartograph after
   * config.json is rewritten (e.g. llm-apply).
   */
  evictProject(root: string): void {
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
    if (this.st.watchedRoots.size >= MAX_WATCHED_PROJECTS) {
      // No push-based watcher for this project past the soft-cap. Reads still get
      // pull-based staleness detection from the freshness gate (which compares
      // indexed vs current HEAD independently of the watcher), but uncommitted
      // working-tree edits won't auto-sync — so surface it instead of leaving the
      // project silently frozen. Rare: it takes 16+ distinct projects in one server.
      process.stderr.write(
        `[Cartograph MCP] Watcher soft-cap (${MAX_WATCHED_PROJECTS}) reached; ${root} will not auto-sync ` +
          `on file edits — its reads rely on the freshness gate. Pass \`allowStale: false\` tools a fresh sync if needed.\n`,
      );
      return;
    }
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
