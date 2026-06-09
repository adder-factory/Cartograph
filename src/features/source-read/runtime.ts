import fs from 'node:fs';
import path from 'node:path';
import type { FileListing } from '../files/runtime.js';
import { resolveIndexedFilePath } from '../shared/indexed-file-path.js';

export const DEFAULT_SOURCE_READ_LINE_LIMIT = 120;
export const MAX_SOURCE_READ_LINE_LIMIT = 500;

export interface SourceWindowOptions {
  lineOffset?: number | undefined;
  lineLimit?: number | undefined;
}

export interface ReadIndexedFileSourceArgs extends SourceWindowOptions {
  projectRoot: string;
  file: string;
  indexedFiles: FileListing;
}

export interface SourceReadResult {
  filePath: string;
  absolutePath: string;
  language?: string | undefined;
  totalLines: number;
  startLine: number;
  endLine: number;
  lineOffset: number;
  lineLimit: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
  code: string;
  note?: string | undefined;
}

export type SourceReadOutcome = { ok: true; result: SourceReadResult } | { ok: false; message: string };

export function normalizeSourceWindow(options: SourceWindowOptions): { lineOffset: number; lineLimit: number } {
  return {
    lineOffset: options.lineOffset ?? 0,
    lineLimit: options.lineLimit ?? DEFAULT_SOURCE_READ_LINE_LIMIT,
  };
}

export function readIndexedFileSource(args: ReadIndexedFileSourceArgs): SourceReadOutcome {
  const resolved = resolveIndexedFilePath({
    file: args.file,
    projectRoot: args.projectRoot,
    indexedFiles: args.indexedFiles,
  });
  if (!resolved.ok) return { ok: false, message: resolved.message };

  const filePath = resolved.filePath;
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(args.projectRoot, filePath);
  let text: string;
  try {
    text = fs.readFileSync(absolutePath, 'utf8');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, message: `Unable to read \`${filePath}\`: ${message}` };
  }

  const { lineOffset, lineLimit } = normalizeSourceWindow(args);
  const lines = text.split('\n');
  const totalLines = lines.length;
  const startIndex = Math.min(lineOffset, totalLines);
  const endIndex = Math.min(startIndex + lineLimit, totalLines);
  const indexedFile = args.indexedFiles.find((f) => f.path === filePath);

  return {
    ok: true,
    result: {
      filePath,
      absolutePath,
      language: indexedFile?.language,
      totalLines,
      startLine: startIndex + 1,
      endLine: endIndex,
      lineOffset,
      lineLimit,
      truncatedBefore: startIndex > 0,
      truncatedAfter: endIndex < totalLines,
      code: lines.slice(startIndex, endIndex).join('\n'),
      note: resolved.note,
    },
  };
}

export function sliceSourceText(
  code: string,
  options: SourceWindowOptions,
): {
  code: string;
  lineOffset: number;
  lineLimit: number;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncatedBefore: boolean;
  truncatedAfter: boolean;
} {
  const { lineOffset, lineLimit } = normalizeSourceWindow(options);
  const lines = code.split('\n');
  const totalLines = lines.length;
  const startIndex = Math.min(lineOffset, totalLines);
  const endIndex = Math.min(startIndex + lineLimit, totalLines);
  return {
    code: lines.slice(startIndex, endIndex).join('\n'),
    lineOffset,
    lineLimit,
    startLine: startIndex + 1,
    endLine: endIndex,
    totalLines,
    truncatedBefore: startIndex > 0,
    truncatedAfter: endIndex < totalLines,
  };
}

export function renderSourceRead(result: SourceReadResult, lowTokens = false): string {
  const range = result.startLine <= result.endLine ? `${result.startLine}-${result.endLine}` : 'empty';
  const lang = result.language ?? '';
  if (lowTokens) {
    const lines = [`read ${result.filePath}:${range}/${result.totalLines}`, '```' + lang, result.code, '```'];
    if (result.truncatedAfter) lines.push(`more lineOffset=${result.endLine}`);
    return lines.join('\n');
  }

  const lines = [
    `## Source \`${result.filePath}\``,
    '',
    `- **lines:** ${range} of ${result.totalLines}`,
    `- **lineOffset:** ${result.lineOffset}`,
    `- **lineLimit:** ${result.lineLimit}`,
  ];
  if (result.note) lines.push(`- **match:** ${result.note}`);
  lines.push('', '```' + lang, result.code, '```');
  if (result.truncatedBefore || result.truncatedAfter) {
    const parts: string[] = [];
    if (result.truncatedBefore) parts.push('earlier lines omitted');
    if (result.truncatedAfter) parts.push(`more available with \`lineOffset: ${result.endLine}\``);
    lines.push('', `> ${parts.join('; ')}.`);
  }
  return lines.join('\n');
}
