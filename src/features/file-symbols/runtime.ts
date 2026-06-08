import * as path from 'node:path';
import type { Node, NodeKind } from '../../types.js';

export const FILE_SYMBOL_NODE_KINDS = [
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
  'table',
  'resource',
] as const satisfies readonly NodeKind[];

export const DEFAULT_FILE_SYMBOL_LIMIT = 200;
export const LOW_TOKEN_FILE_SYMBOL_LIMIT = 80;
export const MAX_FILE_SYMBOL_LIMIT = 1000;

export interface ResolveIndexedFilePathArgs {
  file: string;
  projectRoot: string;
  indexedFiles: readonly { path: string }[];
}

export type ResolveIndexedFilePathResult =
  | { ok: true; filePath: string; note?: string }
  | { ok: false; message: string };

export interface CollectFileSymbolsOptions {
  nodes: readonly Node[];
  kinds?: readonly NodeKind[] | undefined;
  includeParameters?: boolean | undefined;
  includeImports?: boolean | undefined;
  limit?: number | undefined;
  lowTokens?: boolean | undefined;
}

export interface FileSymbolRow {
  name: string;
  qualifiedName: string;
  kind: NodeKind;
  language: string;
  startLine: number;
  endLine: number;
  startColumn: number;
  endColumn: number;
  signature?: string | undefined;
  visibility?: string | undefined;
  isExported?: boolean | undefined;
}

export interface FileSymbolsResult {
  symbols: FileSymbolRow[];
  total: number;
  limit: number;
}

export interface RenderFileSymbolsArgs {
  filePath: string;
  result: FileSymbolsResult;
  note?: string | undefined;
  lowTokens?: boolean | undefined;
}

export function parseFileSymbolKinds(
  raw: string | undefined,
): { ok: true; kinds?: NodeKind[] } | { ok: false; message: string } {
  if (!raw) return { ok: true };
  const allowed = new Set<string>(FILE_SYMBOL_NODE_KINDS);
  const kinds = raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const invalid = kinds.filter((kind) => !allowed.has(kind));
  if (invalid.length > 0) {
    return {
      ok: false,
      message: `Invalid kind value(s): ${invalid.join(', ')}. Valid kinds: ${FILE_SYMBOL_NODE_KINDS.join(', ')}`,
    };
  }
  return { ok: true, kinds: kinds as NodeKind[] };
}

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
  if (indexedPaths.size === 0) return { ok: false, message: 'No files indexed. Run `cartograph admin index` first.' };

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

function fileSymbolLimit(options: CollectFileSymbolsOptions): number {
  const fallback = options.lowTokens ? LOW_TOKEN_FILE_SYMBOL_LIMIT : DEFAULT_FILE_SYMBOL_LIMIT;
  const limit = options.limit ?? fallback;
  return Math.min(Math.max(1, limit), MAX_FILE_SYMBOL_LIMIT);
}

function includeNode(
  node: Node,
  options: CollectFileSymbolsOptions,
  kindFilter: ReadonlySet<NodeKind> | null,
): boolean {
  if (node.kind === 'file') return false;
  if (!options.includeImports && (node.kind === 'import' || node.kind === 'export')) return false;
  if (!options.includeParameters && node.kind === 'parameter') return false;
  return kindFilter === null || kindFilter.has(node.kind);
}

function toFileSymbolRow(node: Node): FileSymbolRow {
  return {
    name: node.name,
    qualifiedName: node.qualifiedName,
    kind: node.kind,
    language: node.language,
    startLine: node.startLine,
    endLine: node.endLine,
    startColumn: node.startColumn,
    endColumn: node.endColumn,
    signature: node.signature,
    visibility: node.visibility,
    isExported: node.isExported,
  };
}

export function collectFileSymbols(options: CollectFileSymbolsOptions): FileSymbolsResult {
  const kindFilter = options.kinds && options.kinds.length > 0 ? new Set(options.kinds) : null;
  const all = options.nodes
    .filter((node) => includeNode(node, options, kindFilter))
    .sort(
      (a, b) =>
        a.startLine - b.startLine ||
        a.startColumn - b.startColumn ||
        a.endLine - b.endLine ||
        a.kind.localeCompare(b.kind) ||
        a.name.localeCompare(b.name),
    )
    .map(toFileSymbolRow);
  const limit = fileSymbolLimit(options);
  return { symbols: all.slice(0, limit), total: all.length, limit };
}

function lineRange(symbol: FileSymbolRow): string {
  return symbol.startLine === symbol.endLine ? String(symbol.startLine) : `${symbol.startLine}-${symbol.endLine}`;
}

function compactName(symbol: FileSymbolRow): string {
  return symbol.signature ? `${symbol.name} ${symbol.signature}` : symbol.name;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function renderFileSymbolTableRow(symbol: FileSymbolRow): string {
  const line = lineRange(symbol);
  const name = truncate(compactName(symbol), 90);
  const qualifiedName = truncate(symbol.qualifiedName, 120);
  return `| ${line} | ${symbol.kind} | ${name} | ${qualifiedName} |`;
}

export function renderFileSymbols(args: RenderFileSymbolsArgs): string {
  const { filePath, result, note, lowTokens } = args;
  const shown = result.symbols.length;
  const suffix = shown === result.total ? `${shown}` : `${shown} of ${result.total}`;
  const lines: string[] = [`## Symbols in \`${filePath}\` (${suffix})`, ''];
  if (note) lines.push(`> ${note}`, '');
  if (result.total === 0) {
    lines.push('_No indexed symbols in this file with the requested filters._');
    return lines.join('\n');
  }
  if (lowTokens) {
    for (const symbol of result.symbols) {
      lines.push(`- L${lineRange(symbol)} ${symbol.kind} ${truncate(compactName(symbol), 96)}`);
    }
    return lines.join('\n');
  }
  lines.push('| Line | Kind | Name | Qualified Name |', '|---:|---|---|---|');
  for (const symbol of result.symbols) {
    lines.push(renderFileSymbolTableRow(symbol));
  }
  return lines.join('\n');
}
