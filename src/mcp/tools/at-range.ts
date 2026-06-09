/**
 * cartograph_at_range — find every indexed symbol whose line range
 * overlaps [startLine, endLine] in the given file.
 *
 * O(log n) via the `nodes_rtree` R*Tree virtual table (migration 034).
 * Results are ordered smallest-enclosing-first: the innermost scope
 * (function, method) surfaces before the class or module wrapping it.
 *
 * Supports two input modes:
 *   1. Single range: pass `file`, `startLine`, `endLine`
 *   2. Bulk ranges: pass `ranges` as an array of `{file, startLine, endLine}` objects
 *      (saves N round-trips on PR review with N hunks)
 *
 * Cost-benefit: ~50ms per call (MCP round-trip + SQLite + WASM). Pays off most on
 * dense files (100+ symbols) and multi-range bulk lookups. For tiny preview fetches
 * on small files, raw `head -N` is comparable.
 *
 * Primary use-cases:
 *   - PR-review: "what symbols does this diff hunk touch?"
 *   - Live diff overlay in the viewer: highlight the symbol cards that
 *     intersect a visible line range.
 */

import { z } from 'zod';
import { lowTokensField, projectPathField } from './_common-fields.js';
import { numArg, validatePathWithinRootReal } from '../../utils.js';
import { type AtRangeFieldName, textResult, validateStringOutcome } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { getNodesAtRange, type NodeAtRange } from '../../db/queries-rtree.js';
import { getFileByPath } from '../../db/queries-files.js';
import { parseUnifiedDiff } from '../../compare/diff-parser.js';
import * as path from 'node:path';
import type { Node } from '../../types.js';
import { parseStrictUnsignedDecimalInteger } from '../../strict-numeric.js';

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 200;
const MAX_BULK_RANGES = 100;
/**
 * Cap on the raw `diff` input size — 1 MB. Covers any practical PR
 * diff (a 1 MB unified diff is already in the "reviewer can't load
 * this" tier) while keeping a malicious or runaway caller from
 * pushing a multi-MB string through `parseUnifiedDiff`. Mirrors the
 * cap used by `review-context.ts` for the same reason.
 */
const MAX_DIFF_BYTES = 1_048_576;

/**
 * A single range as it arrives from the unified-diff parser
 * (`parseUnifiedDiff`) — that path is NOT Zod-validated, so the fields
 * stay `unknown` and `validateRangeInput` re-checks them. The bulk
 * (`ranges`) form is already validated by {@link rangeSchema}.
 */
interface RangeInput {
  file: unknown;
  startLine: unknown;
  endLine: unknown;
}

/** Canonical compact-row field names — kept in sync with `AtRangeFieldName`. */
const AT_RANGE_FIELD_NAMES = ['name', 'kind', 'path', 'line', 'endLine', 'signature'] as const;

/**
 * Zod schema for `cartograph_at_range`.
 *
 * No top-level required field — the handler enforces the choice
 * between single-range (`file`+`startLine`+`endLine`), bulk (`ranges`)
 * and diff (`diff`) forms. `startLine`/`endLine` are `.int().min(1)`
 * (1-indexed) and OPTIONAL so the form-discrimination logic in
 * `handleAtRange` still sees a partially-filled single form; the
 * cross-field `endLine >= startLine` check stays in the handler. A
 * non-integer or sub-1 line number is REJECTED at the dispatch
 * boundary (the locked reject-out-of-range decision) — the handler's
 * old `Math.floor(numArg(...))` coercion is therefore dead code.
 *
 * `limit` is `.int().min(1).max(200)`: an out-of-range value is
 * rejected, not clamped — replaces the handler's `clampInt(numArg(...))`.
 */
const rangeSchema = z.object({
  file: z.string().describe('Repo-relative or absolute file path.'),
  startLine: z.number().int().min(1).describe('First line (1-indexed, inclusive).'),
  endLine: z.number().int().min(1).describe('Last line (1-indexed, inclusive; >= startLine).'),
});

const atRangeSchema = z.object({
  diff: z
    .string()
    .optional()
    .describe(
      'Raw unified diff (e.g. from `git diff`); server parses each `@@ -…,… +…,… @@` hunk and queries its post-image range. ' +
        'Mutually exclusive with `file`/`startLine`/`endLine` and `ranges`. ' +
        `Max ${MAX_BULK_RANGES} hunks per call. ` +
        'Accepts `diff --git a/… b/…` and plain `+++ b/…` headers; pure-deletion hunks and deleted files are skipped.',
    ),
  file: z.string().optional().describe('Repo-relative or absolute file path (single-range mode).'),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('First line of the range (1-indexed, inclusive; single-range mode).'),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Last line of the range (1-indexed, inclusive; >= startLine; single-range mode).'),
  ranges: z
    .array(rangeSchema)
    .optional()
    .describe(`Bulk array of {file, startLine, endLine} ranges to query in one call. Max ${MAX_BULK_RANGES} ranges.`),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      `Max symbols per range (default ${DEFAULT_LIMIT}, integer in [1, ${MAX_LIMIT}]). Out-of-range values are rejected, not clamped.`,
    ),
  compact: z
    .boolean()
    .optional()
    .describe(
      'Emit terse `name|kind|path:line[|end:N][|sig:<...>]` rows instead of the markdown table. Default false.',
    ),
  fields: z
    .array(z.enum(AT_RANGE_FIELD_NAMES))
    .optional()
    .describe(
      "Restrict compact rows to a subset of fields; only effective when `compact: true`. Default: all six columns. E.g. `['name', 'kind']`.",
    ),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type AtRangeToolArgs = z.infer<typeof atRangeSchema>;
type AtRangeCompactField = NonNullable<AtRangeToolArgs['fields']>[number];

const LOW_TOKEN_AT_RANGE_FIELDS: AtRangeCompactField[] = ['name', 'kind', 'path', 'line'];
const LOW_TOKEN_AT_RANGE_LIMIT = 10;

function applyAtRangeLowTokens(args: AtRangeToolArgs): AtRangeToolArgs {
  if (args.lowTokens !== true) return args;

  const out: AtRangeToolArgs = { ...args };
  if (out.limit > LOW_TOKEN_AT_RANGE_LIMIT) {
    out.limit = LOW_TOKEN_AT_RANGE_LIMIT;
  }
  if (out.compact !== false) {
    out.compact = true;
    out.fields ??= LOW_TOKEN_AT_RANGE_FIELDS;
  }
  return out;
}

function validateFileWithinRoot(projectRoot: string, filePath: string): string | null {
  return validatePathWithinRootReal(projectRoot, filePath)
    ? null
    : `file path '${filePath}' is outside the project root.`;
}

function toIndexedFilePath(projectRoot: string, filePath: string): string {
  const trimmed = filePath.trim();
  if (!path.isAbsolute(trimmed)) return trimmed;
  return path.relative(path.resolve(projectRoot), path.resolve(trimmed)).split(path.sep).join('/');
}

function compactCell(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('|', String.raw`\|`).replaceAll('\n', String.raw`\n`);
}

/** Format the signature cell — escape pipe characters or show dash when absent. */
function formatSigCell(n: NodeAtRange): string {
  const hasSignature = n.signature !== undefined && n.signature !== null && n.signature.length > 0;
  if (!hasSignature) return '—';
  const escapedSignature = n.signature!.replaceAll('|', String.raw`\|`);
  return `\`${escapedSignature}\``;
}

/** Format the line-range cell — single number when start === end. */
function formatRangeCell(n: NodeAtRange): string {
  const isSingleLine = n.start_line === n.end_line;
  return isSingleLine ? `${n.start_line}` : `${n.start_line}–${n.end_line}`;
}

/**
 * Render a markdown table body (rows only, no header or title).
 */
function formatTableRows(nodes: NodeAtRange[]): string {
  const rows = nodes.map((n) => {
    const sig = formatSigCell(n);
    const range = formatRangeCell(n);
    return `| ${n.kind} | \`${n.name}\` | ${range} | ${sig} |`;
  });
  return rows.join('\n');
}

/**
 * Compact one-line-per-node renderer for `cartograph_at_range`. Format:
 *
 *   name|kind|path:line[|end:N][|sig:<...>]
 *
 * No markdown table, no separator rows. When `fields` is set, only the
 * named columns appear (canonical order regardless of input order).
 * Defaults to name|kind|path|line|endLine|signature — every column the
 * markdown table renders, but in pipe-delimited form.
 */
function formatRowsCompact(nodes: NodeAtRange[], fields?: ReadonlyArray<AtRangeFieldName>): string {
  const defaultFields: ReadonlyArray<AtRangeFieldName> = ['name', 'kind', 'path', 'line', 'endLine', 'signature'];
  const hasExplicitFields = Array.isArray(fields) && fields.length > 0;
  const fieldSet = hasExplicitFields ? new Set<string>(fields) : new Set<string>(defaultFields);

  return nodes
    .map((n) => {
      const cols: string[] = [];
      if (fieldSet.has('name')) cols.push(compactCell(n.name));
      if (fieldSet.has('kind')) cols.push(compactCell(n.kind));
      // `path` and `line` collapse into ONE column rendered as `path:line`
      // (matches the universal `file:line` editor-jump convention; matches
      // the documented playbook shape). If only one of the two fields is
      // included, render that field alone — no orphan leading colon.
      const hasPathField = fieldSet.has('path');
      const hasLineField = fieldSet.has('line');
      if (hasPathField && hasLineField) cols.push(`${compactCell(n.file_path)}:${n.start_line}`);
      else if (hasPathField) cols.push(compactCell(n.file_path));
      else if (hasLineField) cols.push(String(n.start_line));
      const showEndLine = fieldSet.has('endLine') && n.end_line !== n.start_line;
      if (showEndLine) cols.push(`end:${n.end_line}`);
      if (fieldSet.has('signature') && n.signature) cols.push(`sig:${compactCell(n.signature)}`);
      return cols.join('|');
    })
    .join('\n');
}

function toNodeAtRange(node: Node): NodeAtRange {
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualified_name: node.qualifiedName,
    file_path: node.filePath,
    start_line: node.startLine,
    end_line: node.endLine,
    signature: node.signature ?? null,
  };
}

const FILE_CONTEXT_SIBLING_COUNT = 3;

interface FileContextFallback {
  nodes: NodeAtRange[];
  note: string;
}

function buildFileContextFallback(args: {
  cg: ReturnType<ToolCtx['getCartograph']>;
  filePath: string;
  startLine: number;
  endLine: number;
}): FileContextFallback | null {
  const { cg, filePath, startLine, endLine } = args;
  const fileSymbols = cg.queries.getNodesByFile(filePath);
  const fileNode = fileSymbols.find((n) => n.kind === 'file');
  if (!fileNode) return null;
  if (fileNode.startLine > endLine || fileNode.endLine < startLine) return null;

  const anchorLine = startLine;
  const siblingCandidates = fileSymbols
    .filter((n) => n.kind !== 'file' && n.kind !== 'import')
    .map((n) => ({ node: n, distance: Math.abs(n.startLine - anchorLine) }))
    .sort((a, b) => a.distance - b.distance || a.node.startLine - b.node.startLine)
    .slice(0, FILE_CONTEXT_SIBLING_COUNT)
    .map(({ node }) => node);

  const nearestSymbols = siblingCandidates.map((n) => `${n.name} (${n.kind}) at line ${n.startLine}`).join(', ');
  const siblings = siblingCandidates.length === 0 ? '' : ` Nearest symbols: ${nearestSymbols}.`;
  return {
    nodes: [toNodeAtRange(fileNode)],
    note: `No symbol body overlaps this range; showing file-level context.${siblings}`,
  };
}

interface ExactRangeProbe {
  nodes: NodeAtRange[];
  hitLimit: boolean;
  contextNote?: string;
}

function probeExactRangeWithFileContext(
  cg: ReturnType<ToolCtx['getCartograph']>,
  rng: ValidatedRange,
  limit: number,
): ExactRangeProbe {
  const fetched = getNodesAtRange(cg.queries, {
    filePath: rng.file,
    startLine: rng.startLine,
    endLine: rng.endLine,
    limit: limit + 1,
  });
  if (fetched.length > 0) {
    return { nodes: fetched.slice(0, limit), hitLimit: fetched.length > limit };
  }

  const fallback = buildFileContextFallback({
    cg,
    filePath: rng.file,
    startLine: rng.startLine,
    endLine: rng.endLine,
  });
  if (!fallback) return { nodes: [], hitLimit: false };
  return { nodes: fallback.nodes.slice(0, limit), hitLimit: fallback.nodes.length > limit, contextNote: fallback.note };
}

/** Arguments for {@link formatResults}. */
interface FormatResultsArgs {
  nodes: NodeAtRange[];
  filePath: string;
  startLine: number;
  endLine: number;
  /** Stage 6 #6.1 — emit terse pipe-delimited rows instead of a markdown table. */
  compact?: boolean;
  /** Stage 6 #6.3 — restrict compact rows to a subset of fields. Only effective when `compact:true`. */
  fields?: ReadonlyArray<AtRangeFieldName>;
  contextNote?: string;
}

/**
 * Render a markdown table of matching nodes. Ordered smallest-
 * enclosing-first per the SQL ORDER BY. Used for single-range responses.
 *
 * When `compact:true`, emits one pipe-delimited row per node and skips
 * the markdown table chrome — saves 50-70% of output tokens on chained
 * range queries (e.g. PR-review hunks).
 */
function formatResults(args: FormatResultsArgs): string {
  const { nodes, filePath, startLine, endLine, compact = false, fields, contextNote } = args;
  const header = `## Symbols overlapping ${filePath}:${startLine}-${endLine}\n\n`;
  const note = contextNote ? `_${contextNote}_\n\n` : '';
  if (compact) return header + note + formatRowsCompact(nodes, fields);
  const tableHeader = '| Kind | Name | Lines | Signature |\n' + '|------|------|-------|-----------|';
  return header + note + tableHeader + '\n' + formatTableRows(nodes);
}

/**
 * Validate a single range object from a bulk request. Returns the
 * validated range, or `{ error }` carrying the message on failure.
 * The `index` is used in error messages to identify which array element failed.
 */
function validateRangeInput(
  rangeObj: RangeInput,
  index: number,
): { file: string; startLine: number; endLine: number } | { error: string } {
  const fileRaw = rangeObj.file;
  if (typeof fileRaw !== 'string' || fileRaw.trim().length === 0) {
    return { error: `\`ranges[${index}].file\` must be a non-empty string` };
  }
  const filePath = fileRaw.trim();

  const startLine = Math.floor(numArg(rangeObj.startLine, 0));
  const endLine = Math.floor(numArg(rangeObj.endLine, 0));

  if (startLine < 1) {
    return { error: `\`ranges[${index}].startLine\` must be a positive integer (1-indexed)` };
  }
  if (endLine < startLine) {
    return { error: `\`ranges[${index}].endLine\` must be >= \`ranges[${index}].startLine\`` };
  }

  return { file: filePath, startLine, endLine };
}

/** Single-range path — backward-compatible {file, startLine, endLine} form. */
async function handleAtRangeSingle(
  args: AtRangeToolArgs,
  cg: ReturnType<ToolCtx['getCartograph']>,
  limit: number,
): Promise<ToolOutcome> {
  const fileRaw = args.file;
  if (typeof fileRaw !== 'string' || fileRaw.trim().length === 0) {
    return err('`file` must be a non-empty string');
  }
  const filePath = fileRaw.trim();
  const pathError = validateFileWithinRoot(cg.projectRoot, filePath);
  if (pathError) return err(pathError);
  const indexedFilePath = toIndexedFilePath(cg.projectRoot, filePath);

  // `startLine`/`endLine` are Zod-validated integers ≥ 1 when present;
  // a sub-1 or non-integer value was already rejected at the dispatch
  // boundary. Only the presence + cross-field `endLine >= startLine`
  // checks remain handler-side.
  const { startLine, endLine } = args;
  if (startLine === undefined) return err('`startLine` must be a positive integer (1-indexed)');
  if (endLine === undefined || endLine < startLine) return err('`endLine` must be >= `startLine`');

  // Over-fetch by one so "exactly `limit` rows exist" can be told apart
  // from "more than `limit` rows exist" — `getNodesAtRange` does a plain
  // `LIMIT ?` with no over-fetch of its own (audit-4 #2). When no symbol
  // body overlaps but the range is inside an indexed file, fall back to the
  // file node so top-level/import/comment edits still return context.
  const probed = probeExactRangeWithFileContext(cg, { file: indexedFilePath, startLine, endLine }, limit);
  const hitsCapReached = probed.hitLimit;
  const nodes = probed.nodes;
  if (nodes.length === 0) {
    // Distinguish "file not in index" from "file indexed but no symbols overlap this range".
    const indexed = getFileByPath(cg.queries, indexedFilePath);
    if (!indexed) {
      // DECISION (task #16): a non-indexed path is almost always a typo or a
      // wrong-cwd-relative path — fail LOUD with the `err` arm (isError/exit 1)
      // so the caller can't mistake a mistyped path for a genuinely empty
      // file. An indexed file with no overlapping symbols (the branch below)
      // is a real empty answer and stays a success result (exit 0).
      return err(
        `File not indexed: "${indexedFilePath}" is not in the cartograph index. ` +
          'Run `cartograph admin index` to add it, or check the path is relative to the project root.',
      );
    }
    return ok(
      renderToolResponse({
        body: '',
        empty: { message: `No symbols overlap ${indexedFilePath}:${startLine}-${endLine}` },
      }),
    );
  }

  const compact = args.compact === true;
  const fields = args.fields;
  const rendered = formatResults({
    nodes,
    filePath: indexedFilePath,
    startLine,
    endLine,
    ...(probed.contextNote ? { contextNote: probed.contextNote } : {}),
    ...(compact ? { compact: true } : {}),
    ...(fields ? { fields } : {}),
  });
  // The over-fetch "N results shown" footer routes through the
  // chokepoint's footer slot — the symbol table is truncated first, so a
  // dense range can't push the "pass a higher limit" hint off-budget.
  let capFooter: string | undefined;
  if (hitsCapReached) {
    capFooter = `> ${nodes.length} ${nodes.length === 1 ? 'result' : 'results'} shown — pass a higher \`limit\` to see more.`;
  }
  return ok(renderToolResponse({ body: rendered, footers: [capFooter] }));
}

interface ValidatedRange {
  file: string;
  startLine: number;
  endLine: number;
}
interface RangeResult {
  file: string;
  startLine: number;
  endLine: number;
  nodes: NodeAtRange[];
  contextNote?: string;
}

/** Validate every entry in the bulk-form `ranges` array. Returns the
 *  validated list OR the FIRST per-range `{ error }` (callers return
 *  early so the agent gets one specific message instead of having to
 *  bisect a partial response). */
function validateBulkRanges(rangesRaw: unknown, projectRoot: string): ValidatedRange[] | { error: string } {
  if (!Array.isArray(rangesRaw)) return { error: '`ranges` must be an array of {file, startLine, endLine} objects' };
  if (rangesRaw.length === 0) return { error: '`ranges` must be a non-empty array' };
  if (rangesRaw.length > MAX_BULK_RANGES) {
    return { error: `\`ranges\` must contain at most ${MAX_BULK_RANGES} ranges; got ${rangesRaw.length}` };
  }

  const validatedRanges: ValidatedRange[] = [];
  for (let i = 0; i < rangesRaw.length; i++) {
    const validated = validateRangeInput(rangesRaw[i] as RangeInput, i);
    if ('error' in validated) return validated;
    const pathError = validateFileWithinRoot(projectRoot, validated.file);
    if (pathError) return { error: `ranges[${i}]: ${pathError}` };
    validatedRanges.push({ ...validated, file: toIndexedFilePath(projectRoot, validated.file) });
  }
  return validatedRanges;
}

/** Args for {@link renderBulkRangeReport}. Bundles the per-call rendering knobs
 *  so the param list stays short and the signature is stable across compact
 *  / field-projection feature flags. */
interface RenderBulkRangeReportArgs {
  rangeResults: RangeResult[];
  totalRanges: number;
  /** Stage 6 #6.1 — emit terse pipe-delimited rows instead of markdown tables. */
  compact?: boolean;
  /** Stage 6 #6.3 — restrict compact rows to a subset of fields. */
  fields?: ReadonlyArray<AtRangeFieldName>;
}

/** Render the per-range bulk response sections (body only — the
 *  per-range cap footer is appended by the `renderToolResponse`
 *  chokepoint so it survives body truncation). */
function renderBulkRangeReport(args: RenderBulkRangeReportArgs): string {
  const { rangeResults, totalRanges, compact = false, fields } = args;
  const parts: string[] = [`## Symbols overlapping ${totalRanges} ranges\n`];
  for (const result of rangeResults) {
    parts.push(`### ${result.file}:${result.startLine}-${result.endLine}`);
    if (result.nodes.length === 0) {
      parts.push('_No symbols overlap this range._');
    } else if (compact) {
      if (result.contextNote) parts.push(`_${result.contextNote}_`);
      parts.push(formatRowsCompact(result.nodes, fields));
    } else {
      if (result.contextNote) parts.push(`_${result.contextNote}_`);
      parts.push(
        '| Kind | Name | Lines | Signature |\n|------|------|-------|-----------|',
        formatTableRows(result.nodes),
      );
    }
    parts.push('');
  }
  return parts.join('\n');
}

/** Per-range cap footer, verbatim wording — bulk form. */
const BULK_CAP_FOOTER = '> One or more ranges hit the per-range limit — pass a higher `limit` to see more.';
/** Per-range cap footer, verbatim wording — diff form. */
const DIFF_CAP_FOOTER = '> One or more hunks hit the per-range limit — pass a higher `limit` to see more.';

/** Bulk-form path — `ranges: [{file, startLine, endLine}, …]`. */
async function handleAtRangeBulk(
  args: AtRangeToolArgs,
  cg: ReturnType<ToolCtx['getCartograph']>,
  limit: number,
): Promise<ToolOutcome> {
  // `ranges` entries are Zod-validated to {file: string, startLine,
  // endLine: int ≥ 1}; `validateBulkRanges` still adds the count cap,
  // path-traversal scoping, and the cross-field `endLine >= startLine`
  // check (none of which Zod can express).
  const validated = validateBulkRanges(args.ranges, cg.projectRoot);
  if ('error' in validated) return err(validated.error);

  const rangeResults: RangeResult[] = [];
  let anyHitLimit = false;
  for (const rng of validated) {
    // Over-fetch by one per range (audit-4 #2) — see `handleAtRangeSingle`.
    const probed = probeExactRangeWithFileContext(cg, rng, limit);
    if (probed.hitLimit) anyHitLimit = true;
    rangeResults.push({
      file: rng.file,
      startLine: rng.startLine,
      endLine: rng.endLine,
      nodes: probed.nodes,
      ...(probed.contextNote ? { contextNote: probed.contextNote } : {}),
    });
  }
  const compact = args.compact === true;
  const fields = args.fields;
  return ok(
    renderToolResponse({
      body: renderBulkRangeReport({
        rangeResults,
        totalRanges: validated.length,
        ...(compact ? { compact: true } : {}),
        ...(fields ? { fields } : {}),
      }),
      footers: [anyHitLimit ? BULK_CAP_FOOTER : undefined],
    }),
  );
}

/**
 * Lines added (8) on each side of a diff hunk when an exact overlap probe
 * returns nothing. A unified diff hunk only carries ~3 lines of context
 * around the change, so a tight signature-only edit (e.g.
 * `@@ -310,3 +310,3 @@`) can land entirely above the definition line of
 * the function it edits. A modest symmetric expansion reaches the def
 * line without broadening so far that an unrelated neighbour gets
 * pulled in. Kept deliberately small — exact overlaps must still win.
 */
const DIFF_HUNK_FUZZ_LINES = 8;

/** A diff-derived range plus the result of probing it (with fuzz fallback). */
interface DiffRangeResult extends RangeResult {
  /** True when the exact-overlap probe found nothing and the rows shown
   *  come from the fuzzed re-probe — surfaced with a "near hunk" label. */
  fuzzed: boolean;
  /** True when the over-fetch (audit-4 #2) saw more rows than `limit`. */
  hitLimit: boolean;
}

/**
 * Probe one diff-derived range. Exact R*Tree overlap first; if that
 * yields nothing, retry once with a small symmetric line expansion so a
 * tight context-only hunk still resolves to the symbol it edits. The
 * `fuzzed` flag tells the renderer to label such rows.
 */
function probeDiffRange(cg: ReturnType<ToolCtx['getCartograph']>, rng: ValidatedRange, limit: number): DiffRangeResult {
  // Over-fetch by one (audit-4 #2) so the "hit the per-range limit"
  // footer fires only when rows were genuinely truncated.
  const exact = probeExactRangeWithFileContext(cg, rng, limit);
  if (exact.nodes.length > 0 && !exact.contextNote) {
    return {
      file: rng.file,
      startLine: rng.startLine,
      endLine: rng.endLine,
      nodes: exact.nodes,
      fuzzed: false,
      hitLimit: exact.hitLimit,
    };
  }
  // Zero exact overlaps — retry with a modest expansion each side.
  const fuzzStart = Math.max(1, rng.startLine - DIFF_HUNK_FUZZ_LINES);
  const fuzzEnd = rng.endLine + DIFF_HUNK_FUZZ_LINES;
  const fuzzed = getNodesAtRange(cg.queries, {
    filePath: rng.file,
    startLine: fuzzStart,
    endLine: fuzzEnd,
    limit: limit + 1,
  });
  if (exact.contextNote) {
    const fallbackNodes = exact.nodes;
    const roomForFuzz = Math.max(0, limit - fallbackNodes.length);
    return {
      file: rng.file,
      startLine: rng.startLine,
      endLine: rng.endLine,
      nodes: [...fallbackNodes, ...fuzzed.slice(0, roomForFuzz)],
      fuzzed: roomForFuzz > 0 && fuzzed.length > 0,
      hitLimit: fuzzed.length > roomForFuzz,
      contextNote: exact.contextNote,
    };
  }
  return {
    file: rng.file,
    startLine: rng.startLine,
    endLine: rng.endLine,
    nodes: fuzzed.slice(0, limit),
    fuzzed: fuzzed.length > 0,
    hitLimit: fuzzed.length > limit,
  };
}

/** Args for {@link renderDiffRangeReport}. */
interface RenderDiffRangeReportArgs {
  rangeResults: DiffRangeResult[];
  compact?: boolean;
  fields?: ReadonlyArray<AtRangeFieldName>;
}

/**
 * Render the per-hunk diff response (body only — the per-range cap
 * footer is appended by the `renderToolResponse` chokepoint). Identical
 * to {@link renderBulkRangeReport} except fuzz-resolved ranges get a
 * "near hunk" label so the agent knows the rows are an enclosing-symbol
 * fallback, not an exact overlap.
 */
function renderDiffRangeReport(args: RenderDiffRangeReportArgs): string {
  const { rangeResults, compact = false, fields } = args;
  const hunkCount = rangeResults.length;
  const parts: string[] = [`## Symbols overlapping ${hunkCount} diff ${hunkCount === 1 ? 'hunk' : 'hunks'}\n`];
  for (const result of rangeResults) {
    const label = result.fuzzed ? ' _(near hunk — exact overlap was empty)_' : '';
    parts.push(`### ${result.file}:${result.startLine}-${result.endLine}${label}`);
    if (result.nodes.length === 0) {
      parts.push('_No symbols overlap this range._');
    } else if (compact) {
      if (result.contextNote) parts.push(`_${result.contextNote}_`);
      parts.push(formatRowsCompact(result.nodes, fields));
    } else {
      if (result.contextNote) parts.push(`_${result.contextNote}_`);
      parts.push(
        '| Kind | Name | Lines | Signature |\n|------|------|-------|-----------|',
        formatTableRows(result.nodes),
      );
    }
    parts.push('');
  }
  return parts.join('\n');
}

/**
 * Hunk header — `@@ -<oldStart>[,<oldLen>] +<newStart>[,<newLen>] @@`.
 * Mirrors the `HUNK_HEADER` regex in `compare/diff-parser.ts`; kept
 * local so the all-pure-deletion diagnostic (audit-4 #7) can classify
 * dropped hunks without widening the parser's public surface.
 */
const AT_RANGE_HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,(\d+))? @@/;

/**
 * Classify a diff whose `parseUnifiedDiff` returned no ranges. The
 * parser drops a hunk for two unrelated reasons — (a) it had no file
 * header to attribute it to, or (b) it was a pure-deletion hunk
 * (`+…,0` post-image) — and both collapse to an empty result. Without
 * this, the handler always blamed a missing file header even when one
 * was present (audit-4 #7).
 *
 * Returns the count of `@@` headers seen, how many were pure-deletion,
 * and whether ANY file header (`diff --git` / `+++ b/…`) is present.
 */
function classifyEmptyDiff(diff: string): {
  hunkCount: number;
  pureDeletionCount: number;
  hasFileHeader: boolean;
} {
  let hunkCount = 0;
  let pureDeletionCount = 0;
  let hasFileHeader = false;
  for (const rawLine of diff.split('\n')) {
    if (rawLine.startsWith('diff --git ') || rawLine.startsWith('+++ ')) {
      hasFileHeader = true;
      continue;
    }
    const m = AT_RANGE_HUNK_HEADER.exec(rawLine);
    if (!m) continue;
    hunkCount++;
    // newLen absent → exactly one line per the unified-diff spec.
    const newLen = m[1] === undefined ? 1 : (parseStrictUnsignedDecimalInteger(m[1]) ?? 0);
    if (newLen === 0) pureDeletionCount++;
  }
  return { hunkCount, pureDeletionCount, hasFileHeader };
}

/**
 * Build the user-facing outcome for a diff that `parseUnifiedDiff`
 * collapsed to zero ranges. `parseUnifiedDiff` drops hunks for two
 * unrelated reasons — no file header, or pure-deletion (`+…,0`) — so
 * this classifies the raw diff and names the real cause instead of
 * always blaming a missing header (audit-4 #7).
 */
function reportEmptyDiffParse(diff: string): ToolOutcome {
  const { hunkCount, pureDeletionCount, hasFileHeader } = classifyEmptyDiff(diff);
  if (hunkCount === 0) {
    return err('no hunks found in diff (expected `@@ -…,… +…,… @@` lines)');
  }
  // Every hunk was pure-deletion — a valid, correctly-handled input
  // (the schema documents pure-deletion hunks as "skipped"), not a
  // malformed diff. Report it honestly as a non-error success.
  if (pureDeletionCount === hunkCount) {
    return ok(
      textResult(
        `Diff contained only pure-deletion hunks (${pureDeletionCount} hunk${pureDeletionCount === 1 ? '' : 's'}) — ` +
          'no post-image lines to probe. Deleted code has no symbols to overlap.',
      ),
    );
  }
  // Hunks remain but none were attributable to a file.
  if (!hasFileHeader) {
    return err(
      `found ${hunkCount} \`@@\` hunk header(s) but no file header — each hunk must be ` +
        'preceded by `+++ b/path` or `diff --git a/... b/...`. Pass full `git diff` output.',
    );
  }
  // File header present, hunks present, some non-pure-deletion, yet
  // nothing parsed — a header/hunk attribution gap (e.g. a hunk before
  // its header). Keep the file-header guidance but don't claim the
  // header is absent.
  const pureDeletionAside =
    pureDeletionCount > 0 ? ` (${pureDeletionCount} were pure-deletion hunks, correctly skipped)` : '';
  return err(
    `found ${hunkCount} \`@@\` hunk header(s)${pureDeletionAside} but ${hunkCount - pureDeletionCount} could not be ` +
      'attributed to a file — each hunk must be preceded by its `+++ b/path` or `diff --git a/... b/...` header. ' +
      'Pass full `git diff` output.',
  );
}

/** Diff-form path — parse a raw unified diff into ranges, probe each
 *  with a conservative fuzz fallback for tight hunks. */
async function handleAtRangeDiff(
  args: AtRangeToolArgs,
  cg: ReturnType<ToolCtx['getCartograph']>,
  limit: number,
): Promise<ToolOutcome> {
  // validateStringOutcome rejects empty / whitespace-only input and
  // enforces the MAX_DIFF_BYTES cap — Zod typed `diff` as a plain
  // string, so the whitespace-only + size guards still belong here.
  const diffValidated = validateStringOutcome({ value: args.diff, name: 'diff', maxLength: MAX_DIFF_BYTES });
  if (typeof diffValidated !== 'string') return diffValidated;

  const parsed = parseUnifiedDiff(diffValidated);
  if (parsed.length === 0) {
    return reportEmptyDiffParse(diffValidated);
  }
  if (parsed.length > MAX_BULK_RANGES) {
    return err(
      `diff parsed to ${parsed.length} ranges which exceeds the maximum of ${MAX_BULK_RANGES}; split the diff into smaller chunks`,
    );
  }

  // Re-use the bulk-range validator (path-traversal scoping + shape).
  const validated = validateBulkRanges(parsed, cg.projectRoot);
  if ('error' in validated) return err(validated.error);

  // Probe each hunk with exact overlap, falling back to a small fuzz.
  const rangeResults: DiffRangeResult[] = [];
  let anyHitLimit = false;
  for (const rng of validated) {
    const result = probeDiffRange(cg, rng, limit);
    rangeResults.push(result);
    if (result.hitLimit) anyHitLimit = true;
  }
  const compact = args.compact === true;
  const fields = args.fields;
  return ok(
    renderToolResponse({
      body: renderDiffRangeReport({
        rangeResults,
        ...(compact ? { compact: true } : {}),
        ...(fields ? { fields } : {}),
      }),
      footers: [anyHitLimit ? DIFF_CAP_FOOTER : undefined],
    }),
  );
}

export async function handleAtRange(ctx: ToolCtx, args: AtRangeToolArgs): Promise<ToolOutcome> {
  args = applyAtRangeLowTokens(args);
  const cg = ctx.getCartograph(args.projectPath);
  // `limit` is Zod-validated to an integer in [1, 200] (default 20) —
  // the old `clampInt(numArg(...))` is dead code.
  const limit = args.limit;

  const hasDiffForm = typeof args.diff === 'string';
  const hasSingleForm = args.file !== undefined || args.startLine !== undefined || args.endLine !== undefined;
  const hasBulkForm = args.ranges !== undefined;

  if (hasDiffForm && (hasSingleForm || hasBulkForm)) {
    return err(
      'Cannot specify `diff` together with single-range form (file, startLine, endLine) or bulk form (ranges)',
    );
  }
  if (hasDiffForm) {
    return handleAtRangeDiff(args, cg, limit);
  }
  if (hasSingleForm && hasBulkForm) {
    return err('Cannot specify both single-range form (file, startLine, endLine) and bulk form (ranges)');
  }
  if (!hasSingleForm && !hasBulkForm) {
    return err(
      'Must provide either single-range form (file, startLine, endLine), bulk form (ranges), or diff form (diff)',
    );
  }
  return hasSingleForm ? handleAtRangeSingle(args, cg, limit) : handleAtRangeBulk(args, cg, limit);
}

export const AT_RANGE_TOOL = defineTool({
  name: 'cartograph_at_range',
  description:
    'Line-range → symbol lookup, smallest-enclosing first. R*Tree, O(log n).\n\n' +
    'Inputs: single (`file`+`startLine`+`endLine`), bulk (`ranges: [...]` up to 100), or `diff: <unified-diff>`. ' +
    '`compact: true` + `fields: [...]` for terse rows; `lowTokens: true` applies compact projected rows plus a lower per-range cap.',
  schema: atRangeSchema,
  handle: handleAtRange,
});
