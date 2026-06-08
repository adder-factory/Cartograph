import * as path from 'node:path';
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

export interface RenderMcpFilesOutputArgs {
  format: FileListFormat;
  files: FileListing;
  includeMetadata: boolean;
  maxDepth: number | undefined;
  dirFilter: string | undefined;
  projectFileCount: number | undefined;
  flatSummaries?: ReadonlyMap<string, string> | undefined;
}

export interface BuildFilesNoMatchesMessageArgs {
  allFiles: ReadonlyArray<FileListingRow>;
  dir: string | undefined;
  pattern: string | undefined;
  projectRoot: string;
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

export const MAX_FILES_FOR_INLINE_SUMMARY = 80;
export const LOW_TOKEN_FILES_MAX_DEPTH = 3;

const VALID_FILE_FORMATS: FileListFormat[] = ['tree', 'flat', 'grouped', 'summary'];
const SUMMARY_DIR_LABEL_WIDTH = 40;
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

function trimLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length && value.codePointAt(start) === 47) start++;
  return value.slice(start);
}

export function buildFilesNoMatchesMessage(args: BuildFilesNoMatchesMessageArgs): string {
  const dirHint = buildFilesEmptyDirHint(args.allFiles, args.dir, args.projectRoot);
  const unsupported = args.pattern ? detectUnsupportedGlobConstruct(args.pattern) : undefined;
  const patternHint = unsupported
    ? `\n\n> _\`pattern\` "${args.pattern}" contains ${unsupported}, which is NOT honored. Only \`*\` / \`?\` / \`**\` glob syntax is supported — unsupported metacharacters are treated as literals. Use a simpler pattern (\`*.ts\`, \`**/*.test.ts\`)._`
    : '';
  return `No files found matching the criteria.${dirHint}${patternHint}`;
}

export function buildFilesEmptyDirHint(
  allFiles: ReadonlyArray<FileListingRow>,
  dir: string | undefined,
  projectRoot: string,
): string {
  if (!dir) return '';
  const absoluteHint = buildAbsoluteDirHint(allFiles, dir, projectRoot);
  if (absoluteHint) return absoluteHint;
  const leadingSlashHint = buildLeadingSlashDirHint(allFiles, dir);
  if (leadingSlashHint) return leadingSlashHint;
  return buildRootBasenameDirHint(allFiles, dir, projectRoot);
}

function buildAbsoluteDirHint(allFiles: ReadonlyArray<FileListingRow>, dir: string, projectRoot: string): string {
  if (!path.isAbsolute(dir)) return '';
  const normRoot = trimTrailingSlashes(projectRoot);
  if (dir !== normRoot && !dir.startsWith(normRoot + '/')) return '';

  const stripped = dir === normRoot ? '' : dir.slice(normRoot.length + 1);
  if (stripped.length > 0 && filterFilesByDir(allFiles, stripped).length === 0) return '';

  const suggestion = stripped.length === 0 ? '(omit `dir`)' : `"${stripped}"`;
  return `\n\n> _\`dir\` "${dir}" looks like an absolute path inside the project. Did you mean ${suggestion}? Path filters are project-relative._`;
}

function buildLeadingSlashDirHint(allFiles: ReadonlyArray<FileListingRow>, dir: string): string {
  if (!dir.startsWith('/')) return '';
  const stripped = trimLeadingSlashes(dir);
  if (stripped.length === 0 || filterFilesByDir(allFiles, stripped).length === 0) return '';
  return `\n\n> _\`dir\` "${dir}" matched 0 files. Did you mean "${stripped}"? Path filters are index-relative — drop the leading "/"._`;
}

function buildRootBasenameDirHint(allFiles: ReadonlyArray<FileListingRow>, dir: string, projectRoot: string): string {
  const slash = dir.indexOf('/');
  if (slash <= 0) return '';
  const head = dir.slice(0, slash);
  const rootBasename = path.basename(projectRoot);
  if (!rootBasename || head !== rootBasename) return '';
  const stripped = dir.slice(slash + 1);
  if (stripped.length === 0 || filterFilesByDir(allFiles, stripped).length === 0) return '';
  return (
    `\n\n> _\`dir\` "${dir}" matched 0 files. ` +
    `Did you mean "${stripped}"? Path filters are index-relative ` +
    `(project root is "${rootBasename}")._`
  );
}

export function detectUnsupportedGlobConstruct(pattern: string): string | undefined {
  if (pattern.includes('[') || pattern.includes(']')) return '`[...]` character classes';
  let sawOpenBrace = false;
  for (const char of pattern) {
    if (char === '{') sawOpenBrace = true;
    if (char === '}' && sawOpenBrace) return '`{a,b}` alternation';
  }
  if (pattern.startsWith('!')) return 'leading `!` negation';
  return undefined;
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

export function renderFilesMcpOutput(args: RenderMcpFilesOutputArgs): string {
  switch (args.format) {
    case 'flat':
      return formatMcpFilesFlat(args.files, args.includeMetadata, args.flatSummaries);
    case 'grouped':
      return formatMcpFilesGrouped(args.files, args.includeMetadata);
    case 'summary':
      return formatMcpFilesSummary(args);
    default:
      return formatMcpFilesTree(args.files, args.includeMetadata, args.maxDepth);
  }
}

function formatMcpFilesFlat(
  files: FileListing,
  includeMetadata: boolean,
  summaries?: ReadonlyMap<string, string>,
): string {
  const lines: string[] = [`## Files (${files.length})`, ''];
  const sortedFiles = [...files].sort((a, b) => a.path.localeCompare(b.path));
  for (const file of sortedFiles) {
    if (includeMetadata) {
      lines.push(`- ${file.path} (${file.language}, ${file.nodeCount} symbols)`);
    } else {
      lines.push(`- ${file.path}`);
    }
    const summary = summaries?.get(file.path);
    if (summary) lines.push(`    ${summary}`);
  }
  return lines.join('\n');
}

function formatMcpFilesGrouped(files: FileListing, includeMetadata: boolean): string {
  const lines: string[] = [`## Files by Language (${files.length} total)`, ''];
  const byLang = groupFilesByLanguage(files);
  for (const [lang, langFiles] of sortLanguageGroups(byLang)) {
    lines.push(`### ${lang} (${langFiles.length})`);
    const sortedLangFiles = [...langFiles].sort((a, b) => a.path.localeCompare(b.path));
    for (const file of sortedLangFiles) {
      if (includeMetadata) {
        lines.push(`- ${file.path} (${file.nodeCount} symbols)`);
      } else {
        lines.push(`- ${file.path}`);
      }
    }
    lines.push('');
  }
  return lines.join('\n');
}

function formatMcpFilesSummary(args: RenderMcpFilesOutputArgs): string {
  const rollup = buildDirRollup(args.files, args.maxDepth, args.dirFilter);
  const header = buildMcpSummaryHeader(rollup, args.dirFilter, args.projectFileCount);
  const lines: string[] = [
    header,
    '',
    'Directory rollups — file + symbol counts per directory, sorted by symbol density.',
    '',
    '| Directory | Files | Symbols |',
    '|-----------|------:|--------:|',
  ];
  for (const row of rollup.rows) {
    const label = row.dir === null ? '(root)' : `${row.dir}/`;
    lines.push(`| \`${label}\` | ${row.files} | ${row.symbols} |`);
  }
  return lines.join('\n');
}

function buildMcpSummaryHeader(
  rollup: DirRollup,
  dirFilter: string | undefined,
  projectFileCount: number | undefined,
): string {
  const filterPrefix = dirFilter ? trimTrailingSlashes(dirFilter) : null;
  if (!filterPrefix) {
    return `## Project Summary (${rollup.totalFiles} files, ${rollup.totalSymbols} symbols)`;
  }
  const base = `## Subtree Summary — \`${filterPrefix}/\` (${rollup.totalFiles} files, ${rollup.totalSymbols} symbols`;
  const showProjectTotal =
    projectFileCount !== undefined && projectFileCount !== 0 && projectFileCount !== rollup.totalFiles;
  const suffix = showProjectTotal ? `; project-wide total ${projectFileCount} files)` : ')';
  return base + suffix;
}

function formatMcpFilesTree(files: FileListing, includeMetadata: boolean, maxDepth?: number): string {
  return [
    `## Project Structure (${files.length} files)`,
    '',
    ...renderFileTree({ files, includeMetadata, maxDepth }),
  ].join('\n');
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

export function trimTrailingSlashes(value: string): string;
export function trimTrailingSlashes(value: undefined): undefined;
export function trimTrailingSlashes(value: string | undefined): string | undefined;
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
