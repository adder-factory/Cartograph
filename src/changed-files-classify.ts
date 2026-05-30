/**
 * Shared classification of the orchestrator's per-file drift snapshot
 * into added / modified / removed / heal-only buckets — used by both
 * the `cartograph status` CLI and the `cartograph_status` MCP tool.
 *
 * `ExtractionOrchestrator.getChangedFiles` folds EXTRACTION_LOGIC_VERSION
 * heal-flagged paths into `modified` even though their on-disk content
 * is unchanged (`eoClassifyFileChange` puts a file in `modified` when
 * `content_hash != disk_hash` OR `needs_reextract` is set — an OR).
 * Calling those "modified" reads as a lie next to `cartograph
 * changed_since`, which content-hashes files itself. This module splits
 * genuine content drift from pure heal pressure ONCE so both status
 * surfaces agree. (Backlog H4 / FRICTION-A 2026-05-14.)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type Cartograph from './index.js';
import { getFilesNeedingReextract, getFileByPath } from './db/queries-files.js';
import { hashContent } from './extraction/index.js';

/** A drift snapshot split into change buckets. */
export interface ChangedFiles {
  added: string[];
  modified: string[];
  removed: string[];
  /**
   * Subset of `modified` present ONLY because of the `needs_reextract`
   * heal-flag union — these files have NO on-disk content drift; the
   * EXTRACTION_LOGIC_VERSION self-heal just needs to re-walk them so the
   * new extractor emit-set takes effect.
   */
  healOnly: string[];
}

/** True when `relPath` is heal-flagged with NO genuine on-disk drift:
 *  its current disk content hashes to the same value the index stored.
 *  Returns false on any read/lookup failure — a file we can't verify is
 *  conservatively treated as genuine drift so the content-changed count
 *  never under-reports. */
function isHealOnlyPath(cg: Cartograph, relPath: string): boolean {
  try {
    const tracked = getFileByPath(cg.queries, relPath);
    if (!tracked) return false;
    const abs = path.isAbsolute(relPath) ? relPath : path.join(cg.projectRoot, relPath);
    const content = fs.readFileSync(abs, 'utf-8');
    return hashContent(content) === tracked.contentHash;
  } catch {
    return false;
  }
}

/** Pull the heal-flagged path set. Best-effort: empty on pre-migration
 *  DBs or query failure (the status surfaces stay diagnostic). */
function readHealFlaggedSetSafe(cg: Cartograph): string[] {
  try {
    return getFilesNeedingReextract(cg.queries);
  } catch {
    return [];
  }
}

/**
 * Classify the orchestrator's drift probe into change buckets.
 *
 * Returns null when the probe throws (best-effort — the orchestrator
 * stat-checks every tracked path and can throw on permission errors or
 * fs races); callers decide whether that is fatal or degrades quietly.
 *
 * `healOnly` is computed by re-hashing each ambiguous candidate
 * (heal-flagged ∧ in `modified` ∧ not added/removed) and comparing
 * against the indexed `content_hash`: hash-equal → heal-only,
 * hash-differs / unreadable → genuine drift, left in `modified`. The
 * re-hash set is bounded by the heal-flagged ∩ modified intersection.
 */
export function classifyChangedFiles(cg: Cartograph): ChangedFiles | null {
  try {
    const base = cg.internals.orchestrator.getChangedFiles();
    const healFlagged = readHealFlaggedSetSafe(cg);
    const inAddedOrRemoved = new Set<string>([...base.added, ...base.removed]);
    const modifiedSet = new Set<string>(base.modified);
    const healOnly: string[] = [];
    for (const p of healFlagged) {
      if (!modifiedSet.has(p)) continue;
      if (inAddedOrRemoved.has(p)) continue;
      if (isHealOnlyPath(cg, p)) healOnly.push(p);
    }
    return { ...base, healOnly };
  } catch {
    return null;
  }
}

/** Genuine content-drift modified count — heal-only entries excluded.
 *  Both status surfaces apply this same correction; sharing it keeps
 *  the `max(0, modified - healOnly)` formula in one place. */
export function realModifiedCount(changes: ChangedFiles): number {
  return Math.max(0, changes.modified.length - changes.healOnly.length);
}
