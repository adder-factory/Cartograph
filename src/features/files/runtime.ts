import {
  type FileTreeNode,
  buildFileTree,
  compareFileTreeChildren,
  recurseFileTreeChildren as sharedRecurseFileTreeChildren,
} from '../../file-tree-render.js';
import { globToSafeRegex } from '../../utils.js';

export interface FilesCommandOptions {
  projectPath?: string;
  dir?: string;
  pattern?: string;
  format?: string;
  maxDepth?: string;
  metadata?: boolean;
  json?: boolean;
  lowTokens?: boolean;
}

export interface FileListingRow {
  path: string;
  language: string;
  nodeCount: number;
  size?: number;
}

export type FileListing = FileListingRow[];
export type FileListFormat = 'tree' | 'flat' | 'grouped' | 'summary';

export interface DirRollupRow {
  dir: string | null;
  files: number;
  symbols: number;
}

export interface DirRollup {
  rows: DirRollupRow[];
  totalFiles: number;
  totalSymbols: number;
}

export interface FilesRenderStyle {
  bold: (s: string) => string;
  dim: (s: string) => string;
  cyan: (s: string) => string;
}

export type FilesOutputOptionsResult =
  | { ok: true; format: FileListFormat; maxDepth: number | undefined }
  | { ok: false; error: string };

export type FilterFilesResult =
  | { ok: true; files: FileListing }
  | { ok: false; reason: 'empty-index' | 'no-matches'; message: string };

export interface FilterFilesArgs {
  files: FileListing;
  options: FilesCommandOptions;
  filterFilesByDir: <T extends { path: string }>(files: ReadonlyArray<T>, dir: string) => T[];
}

export interface RenderFilesOutputArgs {
  files: FileListing;
  format: FileListFormat;
  includeMetadata: boolean;
  maxDepth: number | undefined;
  dir: string | undefined;
  summaries?: ReadonlyMap<string, string>;
  buildDirRollup: (files: ReadonlyArray<FileListingRow>, maxDepth?: number, dir?: string) => DirRollup;
  style?: FilesRenderStyle;
}

export interface RenderFileTreeArgs {
  files: FileListing;
  includeMetadata: boolean;
  maxDepth: number | undefined;
  style?: Pick<FilesRenderStyle, 'dim' | 'cyan'>;
}

export interface RenderFlatFilesArgs {
  files: FileListing;
  includeMetadata: boolean;
  summaries?: ReadonlyMap<string, string>;
  style?: Pick<FilesRenderStyle, 'bold' | 'dim'>;
}

export interface RenderFileSummaryArgs {
  files: FileListing;
  maxDepth: number | undefined;
  dir: string | undefined;
  buildDirRollup: (files: ReadonlyArray<FileListingRow>, maxDepth?: number, dir?: string) => DirRollup;
  style?: Pick<FilesRenderStyle, 'bold' | 'cyan' | 'dim'>;
}

interface AppendFlatFileLinesArgs {
  lines: string[];
  file: FileListingRow;
  includeMetadata: boolean;
  summaries: ReadonlyMap<string, string> | undefined;
  style: Pick<FilesRenderStyle, 'dim'>;
}

interface AppendGroupedLanguageFilesArgs {
  lines: string[];
  langFiles: FileListing;
  includeMetadata: boolean;
  style: Pick<FilesRenderStyle, 'dim'>;
}

interface RenderCliTreeArgs {
  node: FileTreeNode;
  prefix: string;
  isLast: boolean;
  depth: number;
  includeMetadata: boolean;
  maxDepth: number | undefined;
  style: Pick<FilesRenderStyle, 'dim' | 'cyan'>;
  lines: string[];
}

type CliTreeStyle = Pick<FilesRenderStyle, 'dim' | 'cyan'>;

const VALID_FILE_FORMATS: FileListFormat[] = ['tree', 'flat', 'grouped', 'summary'];
const SUMMARY_DIR_LABEL_WIDTH = 40;
const LOW_TOKEN_FILES_MAX_DEPTH = 3;
const identityStyle: FilesRenderStyle = {
  bold: (s) => s,
  dim: (s) => s,
  cyan: (s) => s,
};

function fileUnderDir(filePath: string, dir: string): boolean {
  const normDir = trimTrailingSlashes(dir) ?? '';
  if (!normDir) return true;
  return filePath === normDir || filePath.startsWith(normDir + '/');
}

export function filterFilesByDir<T extends { path: string }>(files: ReadonlyArray<T>, dir: string): T[] {
  const normDir = trimTrailingSlashes(dir)?.replace(/^\.\//, '') ?? '';
  return files.filter((file) => {
    const filePath = file.path.replace(/^\.\//, '');
    return fileUnderDir(filePath, normDir);
  });
}

export function buildDirRollup(files: ReadonlyArray<FileListingRow>, maxDepth?: number, dirFilter?: string): DirRollup {
  const dirStats = new Map<string, { files: number; symbols: number }>();
  let totalSymbols = 0;
  let rootBucketFiles = 0;
  let rootBucketSymbols = 0;
  for (const file of files) {
    totalSymbols += file.nodeCount;
    if (isRootFile(file)) {
      rootBucketFiles++;
      rootBucketSymbols += file.nodeCount;
      continue;
    }
    addFileAncestors(dirStats, file, maxDepth);
  }

  const filterPrefix = dirFilter ? trimTrailingSlashes(dirFilter) : null;
  const rows = buildDirRollupRows(dirStats, filterPrefix ?? null);
  if (rootBucketFiles > 0) rows.push({ dir: null, files: rootBucketFiles, symbols: rootBucketSymbols });
  return { rows, totalFiles: files.length, totalSymbols };
}

function isRootFile(file: FileListingRow): boolean {
  return !file.path.includes('/');
}

function addFileAncestors(
  dirStats: Map<string, { files: number; symbols: number }>,
  file: FileListingRow,
  maxDepth: number | undefined,
): void {
  const parts = file.path.split('/');
  for (let depth = 1; depth < parts.length; depth++) {
    if (maxDepth !== undefined && depth > maxDepth) break;
    const dir = parts.slice(0, depth).join('/');
    if (!dir) continue;
    const cur = dirStats.get(dir) ?? { files: 0, symbols: 0 };
    cur.files++;
    cur.symbols += file.nodeCount;
    dirStats.set(dir, cur);
  }
}

function buildDirRollupRows(
  dirStats: ReadonlyMap<string, { files: number; symbols: number }>,
  filterPrefix: string | null,
): DirRollupRow[] {
  return [...dirStats.entries()]
    .sort((a, b) => b[1].symbols - a[1].symbols || a[0].localeCompare(b[0]))
    .filter(([dir]) => !isStrictAncestorOfFilter(dir, filterPrefix))
    .map(([dir, stats]) => ({ dir, files: stats.files, symbols: stats.symbols }));
}

function isStrictAncestorOfFilter(dir: string, filterPrefix: string | null): boolean {
  return filterPrefix !== null && dir !== filterPrefix && filterPrefix.startsWith(dir + '/');
}

export function buildEffectiveFilesOptions(
  dirArg: string | undefined,
  options: FilesCommandOptions,
): FilesCommandOptions {
  return options.dir || !dirArg ? options : { ...options, dir: dirArg };
}

export function parseFilesOutputOptions(options: {
  format?: string;
  maxDepth?: string;
  lowTokens?: boolean;
}): FilesOutputOptionsResult {
  const format = (options.format ?? (options.lowTokens ? 'summary' : 'tree')) as FileListFormat;
  if (!VALID_FILE_FORMATS.includes(format)) {
    return {
      ok: false,
      error: `Invalid value for --format: "${format}" — valid values: ${VALID_FILE_FORMATS.join(', ')}`,
    };
  }
  if (!options.maxDepth) {
    return { ok: true, format, maxDepth: options.lowTokens ? LOW_TOKEN_FILES_MAX_DEPTH : undefined };
  }
  const maxDepth = Number(options.maxDepth);
  if (!Number.isInteger(maxDepth) || !Number.isFinite(maxDepth)) {
    return { ok: false, error: `Invalid value for --max-depth: "${options.maxDepth}" is not a number` };
  }
  if (maxDepth < 1) return { ok: false, error: 'Invalid value for --max-depth: must be >= 1' };
  return { ok: true, format, maxDepth };
}

export function filterFilesForCli({ files, options, filterFilesByDir }: FilterFilesArgs): FilterFilesResult {
  if (files.length === 0) {
    return { ok: false, reason: 'empty-index', message: 'No files indexed. Run "cartograph admin index" first.' };
  }
  const filtered = filterFilesByPattern({ files, options, filterFilesByDir });
  if (filtered.length > 0) return { ok: true, files: filtered };
  return { ok: false, reason: 'no-matches', message: 'No files found matching the criteria.' };
}

export function filterFilesByPattern({ files, options, filterFilesByDir }: FilterFilesArgs): FileListing {
  let filtered = files;
  if (options.dir) filtered = filterFilesByDir(filtered, options.dir);
  if (!options.pattern) return filtered;
  const regexBody = globToSafeRegex(options.pattern);
  const regex = regexBody === null ? /(?!)/ : new RegExp(regexBody);
  return filtered.filter((f) => regex.test(f.path));
}

export function buildFilesJsonRows(files: FileListing): Array<{
  path: string;
  language: string;
  nodeCount: number;
  size: number | undefined;
}> {
  return files.map((f) => ({
    path: f.path,
    language: f.language,
    nodeCount: f.nodeCount,
    size: f.size,
  }));
}

export function renderFilesOutput(args: RenderFilesOutputArgs): string[] {
  const style = args.style ?? identityStyle;
  switch (args.format) {
    case 'flat': {
      const flatArgs: RenderFlatFilesArgs = {
        files: args.files,
        includeMetadata: args.includeMetadata,
        style,
      };
      if (args.summaries) flatArgs.summaries = args.summaries;
      return renderFlatFiles(flatArgs);
    }
    case 'grouped':
      return renderGroupedFiles(args.files, args.includeMetadata, style);
    case 'summary':
      return renderFileSummary({
        files: args.files,
        maxDepth: args.maxDepth,
        dir: args.dir,
        buildDirRollup: args.buildDirRollup,
        style,
      });
    default:
      return [
        style.bold(`\nProject Structure (${args.files.length} files):\n`),
        ...renderFileTree({
          files: args.files,
          includeMetadata: args.includeMetadata,
          maxDepth: args.maxDepth,
          style,
        }),
      ];
  }
}

export function renderFlatFiles({
  files,
  includeMetadata,
  summaries,
  style = identityStyle,
}: RenderFlatFilesArgs): string[] {
  const lines = [style.bold(`\nFiles (${files.length}):\n`)];
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedFiles) appendFlatFileLines({ lines, file, includeMetadata, summaries, style });
  return lines;
}

function appendFlatFileLines(args: AppendFlatFileLinesArgs): void {
  const { lines, file, includeMetadata, summaries, style } = args;
  if (includeMetadata) {
    const metadata = style.dim(`(${file.language}, ${file.nodeCount} symbols)`);
    lines.push(`  ${file.path} ${metadata}`);
  } else {
    lines.push(`  ${file.path}`);
  }
  const summary = summaries?.get(file.path);
  if (summary) lines.push(`    ${style.dim(summary)}`);
}

export function renderGroupedFiles(
  files: FileListing,
  includeMetadata: boolean,
  style: Pick<FilesRenderStyle, 'bold' | 'cyan' | 'dim'> = identityStyle,
): string[] {
  const lines = [style.bold(`\nFiles by Language (${files.length} total):\n`)];
  const byLang = groupFilesByLanguage(files);
  for (const [lang, langFiles] of sortLanguageGroups(byLang)) {
    lines.push(style.cyan(`${lang} (${langFiles.length}):`));
    appendGroupedLanguageFiles({ lines, langFiles, includeMetadata, style });
    lines.push('');
  }
  return lines;
}

function groupFilesByLanguage(files: FileListing): Map<string, FileListing> {
  const byLang = new Map<string, FileListing>();
  for (const file of files) {
    const existing = byLang.get(file.language) || [];
    existing.push(file);
    byLang.set(file.language, existing);
  }
  return byLang;
}

function sortLanguageGroups(byLang: ReadonlyMap<string, FileListing>): Array<[string, FileListing]> {
  return [...byLang.entries()].sort((a, b) => b[1].length - a[1].length);
}

function appendGroupedLanguageFiles(args: AppendGroupedLanguageFilesArgs): void {
  const { lines, langFiles, includeMetadata, style } = args;
  const sortedLangFiles = [...langFiles].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedLangFiles) {
    if (includeMetadata) {
      const metadata = style.dim(`(${file.nodeCount} symbols)`);
      lines.push(`  ${file.path} ${metadata}`);
    } else {
      lines.push(`  ${file.path}`);
    }
  }
}

export function renderFileSummary({
  files,
  maxDepth,
  dir,
  buildDirRollup,
  style = identityStyle,
}: RenderFileSummaryArgs): string[] {
  const rollup = buildDirRollup(files, maxDepth, dir);
  const lines = [style.bold(fileSummaryHeader(dir, rollup.totalFiles, rollup.totalSymbols))];
  for (const row of rollup.rows) {
    const label = row.dir === null ? '(root)' : `${row.dir}/`;
    const filesText = style.dim(`${row.files} files`.padStart(10));
    const symbolsText = style.dim(`${row.symbols} symbols`.padStart(14));
    lines.push(`  ${style.cyan(label.padEnd(SUMMARY_DIR_LABEL_WIDTH))} ${filesText} ${symbolsText}`);
  }
  return lines;
}

export function fileSummaryHeader(dir: string | undefined, totalFiles: number, totalSymbols: number): string {
  const filterPrefix = trimTrailingSlashes(dir);
  if (filterPrefix) return `\nSubtree Summary — ${filterPrefix}/ (${totalFiles} files, ${totalSymbols} symbols):\n`;
  return `\nProject Summary (${totalFiles} files, ${totalSymbols} symbols):\n`;
}

export function trimTrailingSlashes(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  let end = value.length;
  while (end > 0 && value.codePointAt(end - 1) === 47) end--;
  return value.slice(0, end);
}

export function renderFileTree({
  files,
  includeMetadata,
  maxDepth,
  style = identityStyle,
}: RenderFileTreeArgs): string[] {
  const lines: string[] = [];
  appendCliTreeNode({
    node: buildFileTree(files),
    prefix: '',
    isLast: true,
    depth: 0,
    includeMetadata,
    maxDepth,
    style,
    lines,
  });
  return lines;
}

function appendCliTreeNode(args: RenderCliTreeArgs): void {
  const { node, prefix, isLast, depth, includeMetadata, maxDepth, style, lines } = args;
  if (maxDepth !== undefined && depth > maxDepth) return;
  const connector = isLast ? '└── ' : '├── ';
  const childPrefix = isLast ? '    ' : '│   ';
  if (node.name) lines.push(buildTreeNodeLine({ node, prefix, connector, includeMetadata, style }));
  const children = [...node.children.values()].sort(compareFileTreeChildren);
  sharedRecurseFileTreeChildren<FileTreeNode, CliTreeStyle>(
    children,
    { prefix, childPrefix, depth, includeMetadata, maxDepth, parentName: node.name, extra: style },
    (child, cArgs, childIsLast) =>
      appendCliTreeNode({
        node: child,
        prefix: cArgs.prefix,
        isLast: childIsLast,
        depth: cArgs.depth,
        includeMetadata: cArgs.includeMetadata,
        maxDepth: cArgs.maxDepth,
        style: cArgs.extra,
        lines,
      }),
  );
}

function buildTreeNodeLine(args: {
  node: FileTreeNode;
  prefix: string;
  connector: string;
  includeMetadata: boolean;
  style: Pick<FilesRenderStyle, 'dim'>;
}): string {
  const { node, prefix, connector, includeMetadata, style } = args;
  let line = prefix + connector + node.name;
  if (node.file && includeMetadata) {
    line += style.dim(` (${node.file.language}, ${node.file.nodeCount} symbols)`);
  }
  return line;
}
