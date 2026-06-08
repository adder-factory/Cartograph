import type { Node, NodeKind } from '../../types.js';

export const FILE_DEPS_DIRECTIONS = ['both', 'dependencies', 'dependents'] as const;
export type FileDepsDirection = (typeof FILE_DEPS_DIRECTIONS)[number];

export const DEFAULT_FILE_DEPS_LIMIT = 100;
export const LOW_TOKEN_FILE_DEPS_LIMIT = 30;
export const MAX_FILE_DEPS_LIMIT = 1000;

const FILE_DEPS_SYMBOL_KINDS: ReadonlySet<NodeKind> = new Set([
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
  'route',
  'component',
  'table',
  'resource',
]);

export interface FileDepsSymbolRow {
  name: string;
  kind: NodeKind;
  startLine: number;
  signature?: string | undefined;
}

export interface CollectFileDepsOptions {
  filePath: string;
  dependencies: readonly string[];
  dependents: readonly string[];
  nodes: readonly Node[];
  direction?: FileDepsDirection | undefined;
  symbols?: boolean | undefined;
  limit?: number | undefined;
  lowTokens?: boolean | undefined;
}

export interface FileDepsResult {
  filePath: string;
  direction: FileDepsDirection;
  dependencies: string[];
  dependencyTotal: number;
  dependents: string[];
  dependentTotal: number;
  symbols: FileDepsSymbolRow[];
  symbolTotal: number;
  limit: number;
}

export interface RenderFileDepsArgs {
  result: FileDepsResult;
  note?: string | undefined;
  lowTokens?: boolean | undefined;
}

export function parseFileDepsDirection(
  raw = 'both',
): { ok: true; direction: FileDepsDirection } | { ok: false; message: string } {
  if (FILE_DEPS_DIRECTIONS.includes(raw as FileDepsDirection)) {
    return { ok: true, direction: raw as FileDepsDirection };
  }
  return {
    ok: false,
    message: `Invalid direction "${raw}". Valid directions: ${FILE_DEPS_DIRECTIONS.join(', ')}`,
  };
}

export function parseFileDepsLimit(
  raw: string | undefined,
): { ok: true; limit?: number } | { ok: false; message: string } {
  if (raw === undefined) return { ok: true };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_FILE_DEPS_LIMIT) {
    return { ok: false, message: `--limit must be an integer between 1 and ${MAX_FILE_DEPS_LIMIT}` };
  }
  return { ok: true, limit };
}

function fileDepsLimit(options: CollectFileDepsOptions): number {
  const fallback = options.lowTokens ? LOW_TOKEN_FILE_DEPS_LIMIT : DEFAULT_FILE_DEPS_LIMIT;
  const limit = options.limit ?? fallback;
  return Math.min(Math.max(1, limit), MAX_FILE_DEPS_LIMIT);
}

function sortedUnique(paths: readonly string[]): string[] {
  return [...new Set(paths)].sort((a, b) => a.localeCompare(b));
}

function shouldCollectDependencies(direction: FileDepsDirection): boolean {
  return direction === 'both' || direction === 'dependencies';
}

function shouldCollectDependents(direction: FileDepsDirection): boolean {
  return direction === 'both' || direction === 'dependents';
}

function collectDefinedSymbols(
  nodes: readonly Node[],
  limit: number,
  lowTokens: boolean | undefined,
): FileDepsSymbolRow[] {
  const symbolLimit = Math.min(limit, lowTokens ? 8 : 20);
  return nodes
    .filter((node) => FILE_DEPS_SYMBOL_KINDS.has(node.kind))
    .sort(
      (a, b) =>
        a.startLine - b.startLine ||
        a.startColumn - b.startColumn ||
        a.kind.localeCompare(b.kind) ||
        a.name.localeCompare(b.name),
    )
    .slice(0, symbolLimit)
    .map((node) => ({
      name: node.name,
      kind: node.kind,
      startLine: node.startLine,
      signature: node.signature,
    }));
}

export function collectFileDeps(options: CollectFileDepsOptions): FileDepsResult {
  const direction = options.direction ?? 'both';
  const limit = fileDepsLimit(options);
  const dependencies = shouldCollectDependencies(direction) ? sortedUnique(options.dependencies) : [];
  const dependents = shouldCollectDependents(direction) ? sortedUnique(options.dependents) : [];
  const shouldIncludeSymbols = options.symbols !== false;
  const symbols = shouldIncludeSymbols ? collectDefinedSymbols(options.nodes, limit, options.lowTokens) : [];
  const symbolTotal = shouldIncludeSymbols
    ? options.nodes.filter((node) => FILE_DEPS_SYMBOL_KINDS.has(node.kind)).length
    : 0;
  return {
    filePath: options.filePath,
    direction,
    dependencies: dependencies.slice(0, limit),
    dependencyTotal: dependencies.length,
    dependents: dependents.slice(0, limit),
    dependentTotal: dependents.length,
    symbols,
    symbolTotal,
    limit,
  };
}

function countLabel(returned: number, total: number): string {
  return returned === total ? `${total}` : `${returned} of ${total}`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

function symbolLabel(symbol: FileDepsSymbolRow): string {
  const name = symbol.signature ? `${symbol.name} ${symbol.signature}` : symbol.name;
  return `${symbol.kind} ${truncate(name, 96)} @ L${symbol.startLine}`;
}

interface AppendPathSectionArgs {
  lines: string[];
  title: string;
  paths: readonly string[];
  total: number;
  empty: string;
}

function appendPathSection(args: AppendPathSectionArgs): void {
  const { lines, title, paths, total, empty } = args;
  lines.push(`### ${title} (${countLabel(paths.length, total)})`, '');
  if (total === 0) {
    lines.push(`_${empty}_`, '');
    return;
  }
  for (const filePath of paths) lines.push(`- \`${filePath}\``);
  lines.push('');
}

function appendSymbolsSection(lines: string[], symbols: readonly FileDepsSymbolRow[], total: number): void {
  lines.push(`### Defines (${countLabel(symbols.length, total)})`, '');
  if (total === 0) {
    lines.push('_No indexed definitions in this file._', '');
    return;
  }
  for (const symbol of symbols) lines.push(`- ${symbolLabel(symbol)}`);
  lines.push('');
}

function renderLowTokenFileDeps(args: RenderFileDepsArgs): string {
  const { result, note } = args;
  const lines: string[] = [`deps ${result.filePath}`];
  if (note) lines.push(`note ${note}`);
  for (const filePath of result.dependencies) lines.push(`dep ${filePath}`);
  for (const filePath of result.dependents) lines.push(`by ${filePath}`);
  for (const symbol of result.symbols) lines.push(`def ${symbolLabel(symbol)}`);
  if (lines.length === (note ? 2 : 1)) lines.push('empty no local file dependencies or dependents');
  return lines.join('\n');
}

export function renderFileDeps(args: RenderFileDepsArgs): string {
  if (args.lowTokens) return renderLowTokenFileDeps(args);

  const { result, note } = args;
  const lines: string[] = [`## File dependencies for \`${result.filePath}\``, ''];
  if (note) lines.push(`> ${note}`, '');
  if (shouldCollectDependencies(result.direction)) {
    appendPathSection({
      lines,
      title: 'Depends On',
      paths: result.dependencies,
      total: result.dependencyTotal,
      empty: 'No local indexed dependencies.',
    });
  }
  if (shouldCollectDependents(result.direction)) {
    appendPathSection({
      lines,
      title: 'Depended On By',
      paths: result.dependents,
      total: result.dependentTotal,
      empty: 'No indexed dependents.',
    });
  }
  if (result.symbolTotal > 0 || result.symbols.length > 0)
    appendSymbolsSection(lines, result.symbols, result.symbolTotal);
  return lines.join('\n').trimEnd();
}
