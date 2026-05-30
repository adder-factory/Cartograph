import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type { ToolResult } from '../tool-types.js';
import { getStringImports } from '../../db/queries-string-imports.js';
import { getImportNodes } from '../../db/queries.js';
import { join } from 'path';
import {
  classifyImport,
  readGoModuleAlias,
  buildTsPathAliasResolver,
  type TsPathAliases,
} from '../../import-classifier.js';
import type Cartograph from '../../index.js';
import { isFixturePath, pathFilterStripHint, textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/** Default `limit` when the caller omits it. */
const DEFAULT_LIMIT = 200;
/** Hard ceiling on caller-supplied `limit` — keeps a single response bounded. */
const MAX_LIMIT = 1000;

interface Hit {
  file: string;
  line: number;
  spec: string;
  signature: string;
  kind: 'file' | 'directory' | 'bare' | 'unresolvable' | 'literal';
  extMissing: boolean;
  isDynamic: boolean;
  origin: 'static' | 'literal';
  /** Lowercase language label (e.g. 'go', 'typescript'). Empty for
   *  literal-source hits whose origin file isn't tracked individually. */
  language: string;
}

interface ImportFilters {
  target: string | undefined;
  extMissingFilter: boolean | undefined;
  dynamicFilter: boolean | undefined;
  pathFilter: string | undefined;
  excludeFixtures: boolean;
  /** Case-insensitive language label (e.g. 'go'). When set, only hits
   *  whose origin file has the matching `language` survive. */
  language: string | undefined;
}

interface ImportRenderParams {
  source: 'static' | 'literal' | 'all';
  filters: ImportFilters;
  limit: number;
  projectRoot: string;
}

/**
 * Zod schema for `cartograph_imports`. `limit` is `.int().min(1).max(1000)`
 * — a zero, negative, over-cap, or non-integer value is REJECTED at the
 * dispatch boundary (the locked reject-out-of-range decision), never
 * silently clamped. The handler therefore drops the old `clamp` /
 * `numArg` plumbing.
 */
const importsSchema = z.object({
  source: z
    .enum(['static', 'literal', 'all'])
    .default('static')
    .describe(
      "Where to read imports from. 'static' (default) = real import / dynamic-import AST nodes. " +
        "'literal' = import-shaped strings inside template or string literals. 'all' = both.",
    ),
  target: z
    .enum(['file', 'directory', 'bare', 'unresolvable'])
    .optional()
    .describe(
      "Filter by resolution kind: 'file' (relative spec resolves to a file), 'directory' " +
        "(resolves to a dir via index.* lookup), 'bare' (non-relative specifier), 'unresolvable' " +
        '(relative spec missing on disk).',
    ),
  extMissing: z
    .boolean()
    .optional()
    .describe(
      'true = only extension-less relative imports (`./foo`); false = only those with an ' +
        'extension; omit for both. Finds NodeNext-incompatible imports.',
    ),
  dynamic: z
    .boolean()
    .optional()
    .describe("Restrict to dynamic imports (`import('./foo')` / `require('./foo')`). false shows static only."),
  pathFilter: z
    .string()
    .optional()
    .describe('Restrict to files whose project-relative path STARTS WITH this prefix (e.g. "src/").'),
  language: z
    .string()
    .optional()
    .describe(
      'Restrict to imports from files of this language (case-insensitive, e.g. "go", "typescript"). ' +
        'Useful in polyglot repos. Literal-source hits carry no language and are excluded when set.',
    ),
  excludeFixtures: z
    .boolean()
    .default(true)
    .describe(
      'Drop hits under known fixture directories (e.g. `__tests__/fixtures/`). Default true so ' +
        'migration audits are not drowned by fixtures; pass false to include them.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe('Maximum results (default: 200). Integer in [1, 1000]; out-of-range is rejected, not clamped.'),
  projectPath: projectPathField,
});

type ImportsArgs = z.infer<typeof importsSchema>;

async function handleImports(ctx: ToolCtx, args: ImportsArgs): Promise<ToolResult> {
  const cg = ctx.getCartograph(args.projectPath);
  const filters: ImportFilters = {
    target: args.target,
    extMissingFilter: args.extMissing,
    dynamicFilter: args.dynamic,
    pathFilter: args.pathFilter,
    excludeFixtures: args.excludeFixtures,
    language: args.language?.toLowerCase(),
  };
  const source = args.source;
  // `limit` is already an integer in [1, 1000] — Zod's `.int().min().max()`
  // rejected anything else at the dispatch boundary.
  const limit = args.limit;

  const hits: Hit[] = [];
  if (source === 'static' || source === 'all') {
    hits.push(...collectStaticImports(cg));
  }
  if (source === 'literal' || source === 'all') {
    hits.push(...collectLiteralImports(cg));
  }

  const filtered = applyImportFilters(hits, filters);
  return textResult(formatImportsResponse(hits, filtered, { source, filters, limit, projectRoot: cg.projectRoot }));
}

/**
 * Collect static imports — real `import` / `require` / `import()`
 * AST nodes from the index. The `import-classifier` decides whether
 * each spec resolves to a file, directory, bare-package, or
 * unresolvable, and flags missing extensions for ESM-migration
 * triage.
 */
function collectStaticImports(cg: Cartograph): Hit[] {
  const projectRoot = cg.projectRoot;
  // Read go.mod once so per-row classifyImport can re-anchor intra-module
  // Go imports against the project root. Null on non-Go projects.
  const goModuleAlias = readGoModuleAlias(projectRoot);
  // Per-directory tsconfig.paths lookup with caching — one FS walk per
  // unique importing-directory across the whole run. Returns null when
  // the file has no tsconfig.json ancestor with `paths` set.
  const lookupTsAliases = buildTsPathAliasResolver(projectRoot);
  const out: Hit[] = [];
  for (const r of getImportNodes(cg.queries)) {
    const sig = (r.signature ?? '').trim();
    // Derive C/C++ include style from the signature: `#include "x"` vs
    // `#include <x>`. Cheap regex peek; non-C/C++ imports skip the check.
    const isCFamily = r.language === 'c' || r.language === 'cpp';
    const cIncludeStyle = isCFamily ? (sig.includes('"') ? 'quoted' : 'angled') : undefined;
    // TS / TSX / JS / JSX imports may carry path aliases.
    const isTsFamily =
      r.language === 'typescript' || r.language === 'tsx' || r.language === 'javascript' || r.language === 'jsx';
    const tsPathAliases: TsPathAliases | null = isTsFamily ? lookupTsAliases(join(projectRoot, r.filePath)) : null;
    const classifyOpts: {
      goModuleAlias?: string;
      cIncludeStyle?: 'quoted' | 'angled';
      tsPathAliases?: TsPathAliases;
    } = {};
    if (goModuleAlias) classifyOpts.goModuleAlias = goModuleAlias;
    if (cIncludeStyle) classifyOpts.cIncludeStyle = cIncludeStyle;
    if (tsPathAliases) classifyOpts.tsPathAliases = tsPathAliases;
    const c = classifyImport({
      importingFileAbs: join(projectRoot, r.filePath),
      spec: r.name,
      projectRootAbs: projectRoot,
      opts: classifyOpts,
    });
    out.push({
      file: r.filePath,
      line: r.line,
      spec: r.name,
      signature: sig,
      kind: c.kind,
      extMissing: c.extMissing,
      isDynamic: sig.startsWith('import(') || sig.includes('require('),
      origin: 'static',
      language: r.language.toLowerCase(),
    });
  }
  return out;
}

/**
 * Collect literal imports — import-shaped strings inside template
 * literals or quoted strings (test fixtures, codegen sources, doc
 * examples). These are NOT real imports; the dedicated
 * `string_imports` table surfaces them so an agent can audit a
 * mechanical rewrite (e.g. ESM-migration sed) before running it.
 */
function collectLiteralImports(cg: Cartograph): Hit[] {
  const out: Hit[] = [];
  for (const r of getStringImports(cg.queries, { limit: 5000 })) {
    out.push({
      file: r.filePath,
      line: r.line,
      spec: r.moduleName,
      signature: r.raw,
      kind: 'literal',
      extMissing: r.moduleName.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(r.moduleName),
      isDynamic: false,
      origin: 'literal',
      language: '',
    });
  }
  return out;
}

/**
 * Filter hits by `target` (static-only kind match), `extMissing`
 * (boolean tri-state), `dynamic` (boolean tri-state), `pathFilter`
 * (literal prefix on the project-relative file path), and
 * `excludeFixtures` (drop hits under known fixture directories —
 * `docs/test-beds/`, `__tests__/fixtures/`, `test/fixtures/`,
 * `spec/fixtures/`; default true so the canonical NodeNext-migration
 * audit isn't drowned by ext-missing fixture files). The `target`
 * filter rejects literal hits up-front — literals have no resolution
 * kind to match.
 */
function applyImportFilters(hits: Hit[], filters: ImportFilters): Hit[] {
  const { target, extMissingFilter, dynamicFilter, pathFilter, excludeFixtures, language } = filters;
  return hits.filter((h) => {
    if (target) {
      if (h.origin === 'literal') return false;
      if (h.kind !== target) return false;
    }
    if (extMissingFilter === true && !h.extMissing) return false;
    if (extMissingFilter === false && h.extMissing) return false;
    if (dynamicFilter === true && !h.isDynamic) return false;
    if (dynamicFilter === false && h.isDynamic) return false;
    if (pathFilter && !h.file.startsWith(pathFilter)) return false;
    if (excludeFixtures && isFixturePath(h.file)) return false;
    if (language && h.language !== language) return false;
    return true;
  });
}

/** Group order for the rendered output — most-actionable kinds first. */
const KIND_GROUP_ORDER = ['unresolvable', 'directory', 'file', 'bare', 'literal', 'matched'];

/**
 * Build the markdown response: title + filter summary + per-group
 * file:line listings. When `target` is set, a single 'matched'
 * group consolidates the hits (suppresses per-kind subheadings);
 * otherwise hits group by their resolution kind in priority order.
 */
function formatImportsResponse(hits: Hit[], filtered: Hit[], params: ImportRenderParams): string {
  const { source, filters, limit, projectRoot } = params;
  const truncated = filtered.length > limit;
  const slice = filtered.slice(0, limit);

  const lines: string[] = [];
  lines.push(buildImportsTitle(source, filters));
  lines.push('');
  lines.push(`**Matched:** ${filtered.length}${truncated ? ` (showing first ${limit})` : ''} / ${hits.length} total`);

  appendFixtureExclusionNote({ lines, hits, filters });
  appendLiteralExclusionNote({ lines, hits, source, filters });
  lines.push('');

  if (slice.length === 0) {
    lines.push('_No imports match the given filters._');
    // Friction hint: pathFilter often gets the host-relative prefix
    // (e.g. `cartograph/src/...`) when the index stores project-
    // relative paths (`src/...`). If stripping the project-root
    // basename WOULD have matched, nudge the agent.
    const stripHint = pathFilterStripHint({
      pathFilter: filters.pathFilter,
      projectRoot,
      probe: (stripped) => applyImportFilters(hits, { ...filters, pathFilter: stripped }).length > 0,
    });
    if (stripHint) lines.push(stripHint.trimStart());
    return lines.join('\n').trimEnd();
  }

  // Build per-kind counts from the FULL filtered set (before slicing)
  // so truncated bucket headers can say "file (17, showing 9)" instead
  // of the misleading "file (9)".
  const matchedGroupCounts: Map<string, number> | undefined = truncated
    ? buildGroupCounts(filtered, filters)
    : undefined;

  const groups = groupHitsByKindOrTarget(slice, filters);
  appendGroupedHits({
    lines,
    groups,
    filters,
    source,
    ...(matchedGroupCounts !== undefined ? { matchedGroupCounts } : {}),
  });
  return lines.join('\n').trimEnd();
}

/** Count hits per kind across the full filtered set (pre-slice). Used when
 *  the result is truncated so each bucket header can show the true total. */
function buildGroupCounts(filtered: Hit[], filters: ImportRenderParams['filters']): Map<string, number> {
  const counts = new Map<string, number>();
  for (const h of filtered) {
    const key = filters.target ? 'matched' : h.kind;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

interface AppendFixtureExclusionNoteArgs {
  lines: string[];
  hits: Hit[];
  filters: ImportRenderParams['filters'];
}

/**
 * When `excludeFixtures` (the default) hid fixture-path imports, emit a
 * one-line note — otherwise the user sees a reduced `Matched N / M total`
 * count with no explanation of why the rows are missing.
 */
function appendFixtureExclusionNote(args: AppendFixtureExclusionNoteArgs): void {
  const { lines, hits, filters } = args;
  if (!filters.excludeFixtures) return;
  const excluded = hits.filter((h) => isFixturePath(h.file)).length;
  if (excluded === 0) return;
  lines.push(
    `_(${excluded} fixture import${excluded === 1 ? '' : 's'} excluded; pass \`includeFixtures: true\` (i.e. \`excludeFixtures: false\`) to show)_`,
  );
}

/**
 * When the caller filtered by `target` and the source admits literal hits,
 * emit a single-line note explaining that literals were excluded (target
 * resolution doesn't apply to them).
 */
interface AppendLiteralExclusionNoteArgs {
  lines: string[];
  hits: Hit[];
  source: ImportRenderParams['source'];
  filters: ImportRenderParams['filters'];
}

function appendLiteralExclusionNote(args: AppendLiteralExclusionNoteArgs): void {
  const { lines, hits, source, filters } = args;
  if (!filters.target) return;
  if (source !== 'all' && source !== 'literal') return;
  const literalCount = hits.filter((h) => h.origin === 'literal').length;
  if (literalCount > 0) {
    lines.push(
      `_Note: ${literalCount} literal hit(s) excluded — \`target\` filter only applies to static imports (literals have no resolution kind)._`,
    );
  }
}

/** Group hits by kind (default) or by a single 'matched' bucket when target-filtered. */
function groupHitsByKindOrTarget(slice: Hit[], filters: ImportRenderParams['filters']): Map<string, Hit[]> {
  const groups = new Map<string, Hit[]>();
  for (const h of slice) {
    const key = filters.target ? 'matched' : h.kind;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(h);
  }
  return groups;
}

interface AppendGroupedHitsArgs {
  lines: string[];
  groups: Map<string, Hit[]>;
  filters: ImportRenderParams['filters'];
  source: ImportRenderParams['source'];
  /** True matched count per kind across the FULL (pre-slice) filtered set.
   *  Only provided when the result was truncated; used to render
   *  `### file (17, showing 9)` headers instead of the misleading `### file (9)`. */
  matchedGroupCounts?: Map<string, number>;
}

/** `### kind (N)` count label — `17, showing 9` when the slice was
 *  truncated below the full matched total, else the plain shown count. */
function formatGroupCountLabel(shownCount: number, matchedCount: number | undefined): string {
  if (matchedCount !== undefined && matchedCount > shownCount) {
    return `${matchedCount}, showing ${shownCount}`;
  }
  return String(shownCount);
}

/**
 * Build the per-kind H3 bullet-list spec for one resolution-kind
 * group (`file` / `directory` / `bare` / `unresolvable` / `literal` /
 * `matched`). Title interpolates the count label (e.g. `file (17,
 * showing 9)` when the slice truncates the full matched total).
 * formatRow emits the canonical hit bullet shape
 * `- \`file:line\` → "spec"[ext-missing, dynamic, …]`.
 *
 * Only used on the non-`filters.target` path — the target case
 * collapses every kind into a single 'matched' bucket with no H3
 * subheading (bullets sit directly under the `**Matched:**` line),
 * which the heading-required `MarkdownBulletListSpec` can't model
 * without an `omitHeading?: boolean` extension. The target case
 * keeps its inline bullets in {@link appendGroupedHits} for now.
 */
export function buildImportsGroupSpec(args: {
  key: string;
  hits: ReadonlyArray<Hit>;
  countLabel: string;
  source: 'static' | 'literal' | 'all';
}): MarkdownBulletListSpec<Hit> {
  const { key, hits, countLabel, source } = args;
  return {
    title: `${key} (${countLabel})`,
    headingLevel: 3,
    rows: hits,
    formatRow: (h) => `- \`${h.file}:${h.line}\` → "${h.spec}"${formatHitFlags(h, source)}`,
    emptyState: '',
  };
}

function appendGroupedHits(args: AppendGroupedHitsArgs): void {
  const { lines, groups, filters, source } = args;
  for (const key of KIND_GROUP_ORDER) {
    const group = groups.get(key);
    if (!group || group.length === 0) continue;
    if (filters.target) {
      // Single 'matched' bucket — bullets sit directly under the
      // `**Matched:**` line with no H3 subheading. Emit inline (the
      // bullet-list spec mandates a heading).
      for (const h of group) {
        lines.push(`- \`${h.file}:${h.line}\` → "${h.spec}"${formatHitFlags(h, source)}`);
      }
      lines.push('');
      continue;
    }
    const countLabel = formatGroupCountLabel(group.length, args.matchedGroupCounts?.get(key));
    lines.push(renderMarkdownBulletList(buildImportsGroupSpec({ key, hits: group, countLabel, source })));
  }
}

/** Compose the active-filter title row, omitting the implicit `source=static` default. */
function buildImportsTitle(source: 'static' | 'literal' | 'all', filters: ImportFilters): string {
  const parts: string[] = ['## Imports'];
  if (source !== 'static') parts.push(`(source=${source})`);
  if (filters.target) parts.push(`(target=${filters.target})`);
  if (filters.extMissingFilter !== undefined) parts.push(`(extMissing=${filters.extMissingFilter})`);
  if (filters.dynamicFilter !== undefined) parts.push(`(dynamic=${filters.dynamicFilter})`);
  if (filters.pathFilter) parts.push(`(pathFilter=${filters.pathFilter})`);
  if (filters.language) parts.push(`(language=${filters.language})`);
  // Only surface excludeFixtures when explicitly disabled — the default
  // (true) is the silent norm and listing it on every title row would
  // be noise.
  if (filters.excludeFixtures === false) parts.push(`(excludeFixtures=false)`);
  return parts.join(' ');
}

/** Build the bracketed flag suffix on a hit row, e.g. ` [ext-missing, dynamic, static]`. */
function formatHitFlags(h: Hit, source: 'static' | 'literal' | 'all'): string {
  const flags: string[] = [];
  if (h.extMissing) flags.push('ext-missing');
  if (h.isDynamic) flags.push('dynamic');
  if (source === 'all') flags.push(h.origin);
  return flags.length > 0 ? ` [${flags.join(', ')}]` : '';
}

export const IMPORTS_TOOL = defineTool({
  name: 'cartograph_imports',
  description:
    'Import statements graph data — every `from X` / `require(X)` / dynamic import in the project. ' +
    'Filter by resolution kind (`file`/`directory`/`bare`/`unresolvable`), missing-extension, dynamic shape, ' +
    "or `source: 'literal'` for import-shaped strings. Use for migration audits (ESM rewrites, sed-scope checks).",
  schema: importsSchema,
  handle: handleImports,
});
