import * as fs from 'node:fs';
import * as path from 'node:path';
import { errMsg, logWarn } from '../../errors.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';
import type { WriteResult } from './types.js';

/** Best-effort copy to `<path>.backup`. Swallows errors — backup is advisory. */
function safeBackupFile(filePath: string): void {
  try {
    fs.copyFileSync(filePath, filePath + '.backup');
  } catch {
    /* ignore backup failure */
  }
}

/**
 * Read a JSON file, returning `{}` when missing or unparseable.
 *
 * Unparseable files are backed up to `<path>.backup` BEFORE we return
 * `{}` — so an idempotent re-run never silently deletes a user's
 * existing config that happened to break JSON parse temporarily.
 */
export function readJsonFile(filePath: string): Record<string, any> {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    logWarn(`Could not parse ${path.basename(filePath)}: ${errMsg(err)}`);
    logWarn(`A backup will be created before overwriting.`);
    safeBackupFile(filePath);
    return {};
  }
}

/** Best-effort delete — swallows errors (used to clean up tmp files on a failed atomic write). */
function safeUnlinkSync(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function resolveWritablePath(filePath: string): string {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isSymbolicLink()) return filePath;
    try {
      return fs.realpathSync(filePath);
    } catch {
      const target = fs.readlinkSync(filePath);
      return path.resolve(path.dirname(filePath), target);
    }
  } catch {
    return filePath;
  }
}

/**
 * Write a file atomically: write to `<path>.tmp.<pid>`, then rename.
 *
 * Prevents corruption if the process crashes mid-write. The temp
 * file is cleaned up on rename failure. If `<path>` is a symlink,
 * write through to its target so shared instruction/config symlinks
 * survive re-install.
 */
export function atomicWriteFileSync(filePath: string, content: string): void {
  const writePath = resolveWritablePath(filePath);
  const dir = path.dirname(writePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmpPath = writePath + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmpPath, content);
    fs.renameSync(tmpPath, writePath);
  } catch (err) {
    safeUnlinkSync(tmpPath);
    throw err;
  }
}

export function writeMarkedInstructionsFile(filePath: string): 'created' | 'updated' | 'unchanged' {
  const action = replaceOrAppendMarkedSection({
    filePath,
    body: INSTRUCTIONS_TEMPLATE,
    startMarker: CARTOGRAPH_SECTION_START,
    endMarker: CARTOGRAPH_SECTION_END,
  });
  if (action === 'created' || action === 'unchanged') return action;
  return 'updated';
}

/**
 * Atomic JSON write. Trailing newline matches the convention every
 * existing target had — preserves diff-friendly file shape.
 */
export function writeJsonFile(filePath: string, data: Record<string, any>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function removeNestedJsonEntry(
  filePath: string,
  parentKey: string,
  entryKey: string,
): WriteResult['files'][number] {
  const config = readJsonFile(filePath);
  const parent = config[parentKey];
  if (parent === null || typeof parent !== 'object' || Array.isArray(parent) || !parent[entryKey]) {
    return { path: filePath, action: 'not-found' };
  }

  delete parent[entryKey];
  if (Object.keys(parent).length === 0) {
    delete config[parentKey];
  }
  writeJsonFile(filePath, config);
  return { path: filePath, action: 'removed' };
}

/** Element-by-element array equality. Only called once both sides are
 *  confirmed arrays. */
function arrayDeepEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((v, i) => jsonDeepEqual(v, b[i]));
}

/** Key-set + value equality for plain objects. Sorts keys so the
 *  order of `Object.keys` doesn't matter. */
function objectDeepEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ak = Object.keys(a).sort((x, y) => Number(x > y) - Number(x < y));
  const bk = Object.keys(b).sort((x, y) => Number(x > y) - Number(x < y));
  if (ak.length !== bk.length) return false;
  if (!ak.every((k, i) => k === bk[i])) return false;
  return ak.every((k) => jsonDeepEqual(a[k], b[k]));
}

/**
 * Compare two JSON values for deep equality, ignoring key order.
 *
 * Used for idempotency: when the on-disk config already exactly
 * matches what we'd write, return action=`unchanged` instead of
 * re-writing (and emitting a confusing "Updated" log line).
 */
export function jsonDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return arrayDeepEqual(a, b);
  return objectDeepEqual(a as Record<string, unknown>, b as Record<string, unknown>);
}

interface ReplaceOrAppendMarkedSectionArgs {
  filePath: string;
  body: string;
  startMarker: string;
  endMarker: string;
}

/**
 * Replace or append a marker-delimited section in a markdown-ish file.
 *
 * Used by Claude / Codex for the `<!-- CARTOGRAPH_START --> ... <!--
 * CARTOGRAPH_END -->` block. Preserves all content outside the
 * markers verbatim.
 *
 * Returns `created` when the file didn't exist; `updated` when
 * markers were found and content swapped; `appended` when markers
 * weren't found and section was added at end. `unchanged` when the
 * existing block already matches `body`.
 */
export function replaceOrAppendMarkedSection(
  args: ReplaceOrAppendMarkedSectionArgs,
): 'created' | 'updated' | 'appended' | 'unchanged' {
  const { filePath, body, startMarker, endMarker } = args;
  if (!fs.existsSync(filePath)) {
    atomicWriteFileSync(filePath, body + '\n');
    return 'created';
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);

  if (startIdx !== -1 && endIdx > startIdx) {
    const existingBlock = content.substring(startIdx, endIdx + endMarker.length);
    if (existingBlock === body) {
      return 'unchanged';
    }
    const before = content.substring(0, startIdx);
    const after = content.substring(endIdx + endMarker.length);
    atomicWriteFileSync(filePath, before + body + after);
    return 'updated';
  }

  // No markers — append. Preserve existing content with a separating
  // blank line.
  const trimmed = content.trimEnd();
  const sep = trimmed.length > 0 ? '\n\n' : '';
  atomicWriteFileSync(filePath, trimmed + sep + body + '\n');
  return 'appended';
}

/**
 * Inverse of `replaceOrAppendMarkedSection`. Strips the marker
 * block from `filePath` if present. If the file becomes empty after
 * removal, deletes the file entirely (matches the existing Claude
 * uninstall behavior).
 *
 * Returns `removed` when content was stripped, `not-found` when
 * the markers weren't present, `kept` when the file didn't exist.
 */
export function removeMarkedSection(
  filePath: string,
  startMarker: string,
  endMarker: string,
): 'removed' | 'not-found' | 'kept' {
  if (!fs.existsSync(filePath)) return 'kept';

  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf-8');
  } catch {
    return 'kept';
  }

  const startIdx = content.indexOf(startMarker);
  const endIdx = content.indexOf(endMarker);
  if (startIdx === -1 || endIdx <= startIdx) return 'not-found';

  const before = content.substring(0, startIdx).trimEnd();
  const after = content.substring(endIdx + endMarker.length).trimStart();
  const joined = before + (before && after ? '\n\n' : '') + after;

  if (joined.trim() === '') {
    try {
      fs.unlinkSync(resolveWritablePath(filePath));
    } catch {
      /* ignore */
    }
  } else {
    atomicWriteFileSync(filePath, joined.trim() + '\n');
  }
  return 'removed';
}
