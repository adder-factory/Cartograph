import * as path from 'node:path';

export interface ResolveIndexedFilePathArgs {
  file: string;
  projectRoot: string;
  indexedFiles: readonly { path: string }[];
}

export type ResolveIndexedFilePathResult =
  | { ok: true; filePath: string; note?: string }
  | { ok: false; message: string };

function normalizeIndexedPath(value: string): string {
  return value.trim().replaceAll('\\', '/').replace(/^\.\//, '').replaceAll(/\/+/g, '/');
}

function absolutePathCandidate(raw: string, projectRoot: string): string | null {
  if (!path.isAbsolute(raw)) return null;
  const root = path.resolve(projectRoot);
  const relative = path.relative(root, path.resolve(raw));
  if (relative === '') return '';
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

function suffixMatches(indexedPaths: ReadonlySet<string>, candidate: string): string[] {
  const clean = candidate.replace(/^\/+/, '');
  if (!clean) return [];
  return [...indexedPaths].filter((filePath) => filePath === clean || filePath.endsWith(`/${clean}`));
}

export function resolveIndexedFilePath(args: ResolveIndexedFilePathArgs): ResolveIndexedFilePathResult {
  const raw = args.file.trim();
  if (!raw) return { ok: false, message: '`file` must be a non-empty indexed file path.' };
  const indexedPaths = new Set(args.indexedFiles.map((file) => normalizeIndexedPath(file.path)));
  if (indexedPaths.size === 0) return { ok: false, message: 'No files indexed. Run `cartograph quickstart` first.' };

  const candidates = new Set<string>();
  const normalized = normalizeIndexedPath(raw);
  candidates.add(normalized);
  candidates.add(normalized.replace(/^\/+/, ''));

  const absolute = absolutePathCandidate(raw, args.projectRoot);
  if (absolute === null && path.isAbsolute(raw)) {
    return { ok: false, message: '`file` must point inside the project root.' };
  }
  if (absolute) candidates.add(normalizeIndexedPath(absolute));

  for (const candidate of candidates) {
    if (indexedPaths.has(candidate)) return { ok: true, filePath: candidate };
  }

  const matches = suffixMatches(indexedPaths, normalized);
  if (matches.length === 1) {
    return { ok: true, filePath: matches[0]!, note: `Matched \`${raw}\` by indexed-path suffix.` };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      message: `\`file\` "${raw}" is ambiguous; matches ${matches.length} indexed files. Pass the full project-relative path.`,
    };
  }
  return { ok: false, message: `No indexed file matched "${raw}". Use \`cartograph_files\` to inspect indexed paths.` };
}
