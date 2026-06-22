import * as fs from 'node:fs';
import * as path from 'node:path';
import { errMsg, logWarn } from '../../errors.js';
import { asJsonObject } from '../../json-object.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';
import type { WriteResult } from './types.js';

export { asJsonObject, type JsonObject } from '../../json-object.js';

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
export function readJsonFile(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    // A JSON file's top level can be any value; the installer only ever
    // operates on object-shaped configs. Anything else (array, scalar,
    // null) degrades to `{}` so callers never index a non-object.
    return asJsonObject(parsed) ?? {};
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
 * Write a file we own outright (skill / command artifacts), creating
 * parent directories as needed. Single read derives both existence
 * and content — no TOCTOU window — so idempotent re-runs report
 * `unchanged` instead of rewriting.
 */
export function writeOwnedFile(filePath: string, content: string): WriteResult['files'][number] {
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(filePath, 'utf-8');
  } catch {
    /* absent or unreadable — treat as create */
  }
  if (existing === content) return { path: filePath, action: 'unchanged' };
  atomicWriteFileSync(filePath, content);
  return { path: filePath, action: existing === null ? 'created' : 'updated' };
}

/**
 * Inverse of `writeOwnedFile`. Deletes the file, then best-effort
 * removes each `pruneDirs` entry in order — `rmdirSync` only deletes
 * EMPTY directories, so a `skills/` dir shared with other skills
 * survives untouched.
 */
export function removeOwnedFile(filePath: string, pruneDirs: readonly string[] = []): WriteResult['files'][number] {
  if (!fs.existsSync(filePath)) return { path: filePath, action: 'not-found' };
  safeUnlinkSync(filePath);
  for (const dir of pruneDirs) {
    try {
      fs.rmdirSync(dir);
    } catch {
      /* not empty or already gone — keep */
    }
  }
  return { path: filePath, action: 'removed' };
}

/**
 * Atomic JSON write. Trailing newline matches the convention every
 * existing target had — preserves diff-friendly file shape.
 */
export function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  atomicWriteFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function getOwnJsonField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/**
 * Read `config[wrapperKey][entryKey]` when both levels are objects.
 * Returns `undefined` when either level is missing or not an object —
 * so a caller's truthiness check stays the same as the old `any`-typed
 * `config[wrapperKey]?.[entryKey]` chain, now without `any`.
 */
export function getNestedJsonEntry(config: Record<string, unknown>, wrapperKey: string, entryKey: string): unknown {
  const wrapper = asJsonObject(getOwnJsonField(config, wrapperKey));
  if (!wrapper || !Object.hasOwn(wrapper, entryKey)) return undefined;
  return wrapper[entryKey];
}

/**
 * Set `config[wrapperKey][entryKey] = value`, creating the wrapper
 * object when absent (or replacing a non-object wrapper). Mutates and
 * returns `config` so callers can chain a `writeJsonFile`.
 */
export function setNestedJsonEntry(args: {
  config: Record<string, unknown>;
  wrapperKey: string;
  entryKey: string;
  value: unknown;
}): Record<string, unknown> {
  const { config, wrapperKey, entryKey, value } = args;
  let wrapper = asJsonObject(getOwnJsonField(config, wrapperKey));
  wrapper ??= {};
  config[wrapperKey] = wrapper;
  wrapper[entryKey] = value;
  return config;
}

/**
 * Delete `config[wrapperKey][entryKey]` in memory, pruning the wrapper
 * object when it becomes empty. Returns `true` when an entry was
 * actually removed. The on-disk variant is {@link removeNestedJsonEntry}.
 */
export function deleteNestedJsonEntry(config: Record<string, unknown>, wrapperKey: string, entryKey: string): boolean {
  const wrapper = asJsonObject(getOwnJsonField(config, wrapperKey));
  if (!wrapper || !Object.hasOwn(wrapper, entryKey) || wrapper[entryKey] === undefined) return false;
  delete wrapper[entryKey];
  if (Object.keys(wrapper).length === 0) delete config[wrapperKey];
  else config[wrapperKey] = wrapper;
  return true;
}

/**
 * Read `config[wrapperKey][listKey]` as a `string[]`, or `null` when
 * either level is missing / not the expected shape. Non-string members
 * are dropped so the caller traffics in a clean `string[]`.
 */
export function getNestedStringArray(
  config: Record<string, unknown>,
  wrapperKey: string,
  listKey: string,
): string[] | null {
  const wrapper = asJsonObject(getOwnJsonField(config, wrapperKey));
  if (!wrapper || !Object.hasOwn(wrapper, listKey)) return null;
  const list = wrapper[listKey];
  if (!Array.isArray(list)) return null;
  return list.filter((v): v is string => typeof v === 'string');
}

/**
 * Ensure `config[wrapperKey][listKey]` is a string array, creating the
 * wrapper object and/or the array when absent, and returns that array
 * (mutating `config`). A non-array existing value is replaced with `[]`.
 */
export function ensureNestedStringArray(
  config: Record<string, unknown>,
  wrapperKey: string,
  listKey: string,
): string[] {
  let wrapper = asJsonObject(getOwnJsonField(config, wrapperKey));
  wrapper ??= {};
  config[wrapperKey] = wrapper;
  const existing = wrapper[listKey];
  if (Array.isArray(existing)) {
    // Coerce to string[] in place — drop any non-string member.
    const cleaned = existing.filter((v): v is string => typeof v === 'string');
    wrapper[listKey] = cleaned;
    return cleaned;
  }
  const fresh: string[] = [];
  wrapper[listKey] = fresh;
  return fresh;
}

export function removeNestedJsonEntry(
  filePath: string,
  parentKey: string,
  entryKey: string,
): WriteResult['files'][number] {
  const config = readJsonFile(filePath);
  if (!deleteNestedJsonEntry(config, parentKey, entryKey)) {
    return { path: filePath, action: 'not-found' };
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
  const objectA = asJsonObject(a);
  const objectB = asJsonObject(b);
  if (!objectA || !objectB) return false;
  return objectDeepEqual(objectA, objectB);
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
