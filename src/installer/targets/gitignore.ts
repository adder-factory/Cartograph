import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Location, WriteResult } from './types.js';
import { atomicWriteFileSync } from './file-writes.js';

export function projectGitignorePath(): string {
  return path.join(process.cwd(), '.gitignore');
}

export function writeProjectGitignoreEntries(entries: readonly string[]): WriteResult['files'][number] {
  const file = projectGitignorePath();
  const created = !fs.existsSync(file);
  const content = created ? '' : fs.readFileSync(file, 'utf-8');
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !lines.has(entry));
  if (missing.length === 0 && !created) {
    return { path: file, action: 'unchanged' };
  }

  const base = content.trimEnd();
  const next = [base, ...missing].filter((part) => part.length > 0).join('\n') + '\n';
  atomicWriteFileSync(file, next);
  return { path: file, action: created ? 'created' : 'updated' };
}

export function writeProjectGitignoreFileEntries(files: readonly string[]): WriteResult['files'][number] {
  const entries = files.map(projectRelativeIgnoreEntry).filter((entry): entry is string => entry !== null);
  if (entries.length === 0) {
    return { path: projectGitignorePath(), action: 'unchanged' };
  }
  return writeProjectGitignoreEntries(entries);
}

export function withLocalGitignoreFileEntries(
  loc: Location,
  result: WriteResult,
  files: readonly string[],
): WriteResult {
  if (loc !== 'local') return result;
  return { ...result, files: [...result.files, writeProjectGitignoreFileEntries(files)] };
}

function projectRelativeIgnoreEntry(file: string): string | null {
  const relative = path.relative(process.cwd(), file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}
