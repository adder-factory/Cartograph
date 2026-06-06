import { parsePositiveIntValue } from '../shared/cli-args.js';

export interface AtRangeOptions {
  projectPath?: string;
  limit?: string;
  diff?: string;
  ranges?: string;
  compact?: boolean;
  fields?: string;
  lowTokens?: boolean;
}

export interface BuildAtRangeArgsInput {
  file: string | undefined;
  startLine: string | undefined;
  endLine: string | undefined;
  options: AtRangeOptions;
  diffText?: string;
}

export type AtRangeArgsResult = { ok: true; args: Record<string, unknown> } | { ok: false; error: string };

const DEFAULT_LIMIT = '20';
const DECIMAL_RADIX = 10;

export function buildAtRangeMcpArgs(input: BuildAtRangeArgsInput): AtRangeArgsResult {
  const { file, startLine, endLine, options } = input;
  const args: Record<string, unknown> = {};
  const limit = parsePositiveIntValue(options.limit ?? DEFAULT_LIMIT, '--limit');
  if (!limit.ok) return limit;
  args['limit'] = limit.value;
  if (options.compact) args['compact'] = true;
  if (options.lowTokens) args['lowTokens'] = true;
  const fields = parseFieldsOption(options.fields);
  if (fields) args['fields'] = fields;

  const modeFlags = [options.diff !== undefined, options.ranges !== undefined].filter(Boolean).length;
  if (modeFlags > 1) return { ok: false, error: '--diff and --ranges are mutually exclusive.' };
  if (options.diff !== undefined) return buildDiffArgs({ args, file, startLine, endLine, diffText: input.diffText });
  if (options.ranges !== undefined) return buildRangesArgs({ args, file, startLine, endLine, ranges: options.ranges });
  return buildPositionalArgs({ args, file, startLine, endLine });
}

interface ModeArgsInput {
  args: Record<string, unknown>;
  file: string | undefined;
  startLine: string | undefined;
  endLine: string | undefined;
}

function buildDiffArgs(input: ModeArgsInput & { diffText: string | undefined }): AtRangeArgsResult {
  if (input.file !== undefined || input.startLine !== undefined || input.endLine !== undefined) {
    return { ok: false, error: '--diff is mutually exclusive with positional file/startLine/endLine.' };
  }
  input.args['diff'] = input.diffText ?? '';
  return { ok: true, args: input.args };
}

function buildRangesArgs(input: ModeArgsInput & { ranges: string }): AtRangeArgsResult {
  if (input.file !== undefined || input.startLine !== undefined || input.endLine !== undefined) {
    return { ok: false, error: '--ranges is mutually exclusive with positional file/startLine/endLine.' };
  }
  const ranges = parseRangeSpecs(input.ranges);
  if (!ranges.ok) return ranges;
  input.args['ranges'] = ranges.ranges;
  return { ok: true, args: input.args };
}

function buildPositionalArgs(input: ModeArgsInput): AtRangeArgsResult {
  if (input.file === undefined || input.startLine === undefined || input.endLine === undefined) {
    return {
      ok: false,
      error: 'Pass <file> <startLine> <endLine> positionally OR use --diff <pathOrText|-> OR --ranges <list>.',
    };
  }
  const startNum = parsePositiveIntValue(input.startLine, 'startLine');
  const endNum = parsePositiveIntValue(input.endLine, 'endLine');
  if (!startNum.ok || !endNum.ok) return { ok: false, error: 'startLine and endLine must be numbers.' };
  input.args['file'] = input.file;
  input.args['startLine'] = startNum.value;
  input.args['endLine'] = endNum.value;
  return { ok: true, args: input.args };
}

export type ParseRangeSpecsResult =
  | { ok: true; ranges: Array<{ file: string; startLine: number; endLine: number }> }
  | { ok: false; error: string };

export function parseRangeSpecs(raw: string): ParseRangeSpecsResult {
  const ranges: Array<{ file: string; startLine: number; endLine: number }> = [];
  for (const spec of raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const match = /^(.+):(\d+)-(\d+)$/.exec(spec);
    if (!match) {
      return { ok: false, error: `Invalid --ranges spec '${spec}' — expected 'file:startLine-endLine'.` };
    }
    ranges.push({
      file: match[1]!,
      startLine: Number.parseInt(match[2]!, DECIMAL_RADIX),
      endLine: Number.parseInt(match[3]!, DECIMAL_RADIX),
    });
  }
  if (ranges.length === 0) return { ok: false, error: '--ranges had no valid `file:startLine-endLine` specs.' };
  return { ok: true, ranges };
}

function parseFieldsOption(fields: string | undefined): string[] | undefined {
  return fields
    ?.split(',')
    .map((f) => f.trim())
    .filter(Boolean);
}
