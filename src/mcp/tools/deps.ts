import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { analyzeUnusedDeps } from '../../deps/unused.js';
import { textResult } from './shared.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';

/** Maximum number of used packages to show in deps response. */
const DEPS_DISPLAY_LIMIT = 20;

const depsSchema = z.object({
  projectPath: projectPathField,
});

type DepsArgs = z.infer<typeof depsSchema>;

async function handleDeps(ctx: ToolCtx, args: DepsArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const result = analyzeUnusedDeps(cg.queries, cg.projectRoot);
  return ok(textResult(formatDepsResponse(result)));
}

/** Render header + summary line for the deps audit. */
function formatDepsHeader(r: ReturnType<typeof analyzeUnusedDeps>): string[] {
  const undeclaredPart = r.undeclared.length > 0 ? ` | ${r.undeclared.length} undeclared` : '';
  const workspaceCount = r.workspaceManifestPaths.length;
  // workspaceManifestPaths always includes the root manifest (length
  // >= 1); a `workspaces:` field surfaces additional entries. Render
  // the workspace line only when at least one child manifest was
  // resolved, so single-package repos keep the old terse output.
  const packageJsonLine =
    workspaceCount > 1
      ? `**package.json:** ${r.packageJsonPath} (+ ${workspaceCount - 1} workspace manifest${workspaceCount - 1 === 1 ? '' : 's'})`
      : `**package.json:** ${r.packageJsonPath}`;
  return [
    '## Unused Dependencies Audit',
    '',
    packageJsonLine,
    '',
    `**Summary:** ${r.used.length} package(s) imported | ${r.unusedRuntime.length} unused runtime | ${r.unusedDev.length} unused dev | ${r.unusedOptional.length} unused optional${undeclaredPart}`,
    '',
  ];
}

/** Render zero or more "### Unused X dependencies" sections. Returns empty array when all are clean. */
function formatUnusedSections(r: ReturnType<typeof analyzeUnusedDeps>): string[] {
  const lines: string[] = [];
  if (r.unusedRuntime.length > 0) {
    lines.push(renderMarkdownBulletList(buildDepsUnusedSpec('runtime', r.unusedRuntime)));
  }
  if (r.unusedDev.length > 0) {
    lines.push(renderMarkdownBulletList(buildDepsUnusedSpec('dev', r.unusedDev)));
  }
  if (r.unusedOptional.length > 0) {
    lines.push(renderMarkdownBulletList(buildDepsUnusedSpec('optional', r.unusedOptional)));
  }
  if (r.unusedRuntime.length === 0 && r.unusedDev.length === 0 && r.unusedOptional.length === 0) {
    lines.push(DEPS_ALL_CLEAN_NOTE);
    lines.push('');
  }
  return lines;
}

/** Render the "### Imported but not declared" section when undeclared packages exist. */
function formatUndeclaredSection(undeclared: readonly string[]): string[] {
  if (undeclared.length === 0) return [];
  return [renderMarkdownBulletList(buildDepsUndeclaredSpec(undeclared))];
}

/** Render the "### Imported packages" section with a display cap. */
function formatUsedPackagesSection(used: readonly string[]): string[] {
  if (used.length === 0) return [];
  return [renderMarkdownBulletList(buildDepsImportedPackagesSpec(used, DEPS_DISPLAY_LIMIT))];
}

function formatDepsResponse(r: ReturnType<typeof analyzeUnusedDeps>): string {
  if (!r.packageJsonPath) {
    const base = 'No package.json found at project root.';
    if (!r.nestedManifests || r.nestedManifests.length === 0) return base;
    // Surface nested manifests so a Go-dominant repo with an embedded
    // JS sub-app (e.g. ollama's `app/ui/app/package.json`) doesn't get
    // a terse no-op message that misses the obvious next move.
    const HINT_LIMIT = 5;
    const shown = r.nestedManifests.slice(0, HINT_LIMIT);
    const more =
      r.nestedManifests.length > HINT_LIMIT ? ` (+${r.nestedManifests.length - HINT_LIMIT} more not shown)` : '';
    const lines = [
      base,
      '',
      `Found ${r.nestedManifests.length} nested manifest${r.nestedManifests.length === 1 ? '' : 's'}${more} — initialize Cartograph in one of those directories (\`cartograph admin init <dir>\`) and re-run the deps audit there to inspect them:`,
      ...shown.map((p) => `- ${p}`),
    ];
    return lines.join('\n');
  }

  return [
    ...formatDepsHeader(r),
    ...formatUnusedSections(r),
    ...formatUndeclaredSection(r.undeclared),
    ...formatUsedPackagesSection(r.used),
  ].join('\n');
}

/** Affirmative clean-state note shown when every declared dep was
 *  marked used by at least one signal. Exported as a constant so the
 *  wording-lint walks the same string the handler emits. */
export const DEPS_ALL_CLEAN_NOTE = '✓ All declared dependencies are used.';

/** Bucket-kind for the three unused-deps sub-sections — runtime /
 *  dev / optional. The user-facing label strings flow into the
 *  spec's title via {@link buildDepsUnusedSpec}; the wording-lint
 *  walks the title through `specStrings`. */
export type DepsUnusedBucketKind = 'runtime' | 'dev' | 'optional';

/** Private label map for the three unused-deps sub-section titles.
 *  Not exported — callers either go through {@link buildDepsUnusedSpec}
 *  (which produces the spec carrying the label as its title) or walk
 *  the live `MarkdownBulletListSpec.title` field. */
const DEPS_UNUSED_BUCKET_LABELS: Record<DepsUnusedBucketKind, string> = {
  runtime: 'Unused runtime dependencies',
  dev: 'Unused dev dependencies',
  optional: 'Unused optional dependencies',
};

/**
 * Build the bullet-list spec for one of the three unused-dep buckets
 * (runtime / dev / optional). H3 heading-level so the composing
 * handler renders these under the top-level `## Unused Dependencies
 * Audit` H2. Each row is a package name; rendered as a markdown
 * code-span (`` `pkg` ``) inline bullet.
 *
 * **`emptyState` is unreachable in production**: `formatUnusedSections`
 * only calls this builder when the bucket is non-empty; the
 * structurally-different "everything is clean" path emits
 * {@link DEPS_ALL_CLEAN_NOTE} via the handler's own `formatUnusedSections`
 * branch. The `emptyState` field exists to satisfy the
 * `MarkdownBulletListSpec` interface and to give the wording lint a
 * target for the per-bucket "no unused X dependencies" copy.
 */
export function buildDepsUnusedSpec(
  kind: DepsUnusedBucketKind,
  packages: readonly string[],
): MarkdownBulletListSpec<string> {
  return {
    title: DEPS_UNUSED_BUCKET_LABELS[kind],
    headingLevel: 3,
    rows: packages,
    formatRow: (pkg) => `- \`${pkg}\``,
    emptyState: `No unused ${kind} dependencies.`,
  };
}

/**
 * Build the bullet-list spec for the "imported but not declared"
 * section. H3 heading-level with a trailing footer explaining the
 * resolution path. The `⚠` glyph is part of the title — same as
 * pre-migration — so a future renamer touches both the header and
 * its lint expectation in one place.
 */
export function buildDepsUndeclaredSpec(undeclared: readonly string[]): MarkdownBulletListSpec<string> {
  return {
    title: `⚠ Imported but not declared in package.json (${undeclared.length})`,
    headingLevel: 3,
    rows: undeclared,
    formatRow: (pkg) => `- \`${pkg}\``,
    emptyState: 'No undeclared packages.',
    footers: [
      '_Imported in source (possibly only by a script under `scripts/`) but absent from package.json. Either add it as a dependency or remove the import._',
    ],
  };
}

/**
 * Build the bullet-list spec for the "Imported packages" section.
 * H3 heading-level. The `display` cap matches the pre-migration
 * `DEPS_DISPLAY_LIMIT` slice — the spec carries the truncation
 * footer for any overflow so a reader sees the elided count.
 */
export function buildDepsImportedPackagesSpec(
  used: readonly string[],
  displayCap: number,
): MarkdownBulletListSpec<string> {
  const shown = used.slice(0, displayCap);
  const overflow = used.length - shown.length;
  const spec: MarkdownBulletListSpec<string> = {
    title: `Imported packages (${used.length})`,
    headingLevel: 3,
    rows: shown,
    formatRow: (pkg) => `- \`${pkg}\``,
    emptyState: 'No imported packages found.',
  };
  return overflow > 0 ? { ...spec, footers: [`- ... and ${overflow} more`] } : spec;
}

export const DEPS_TOOL = defineTool({
  name: 'cartograph_deps',
  description:
    "package.json dependency audit — flags declared deps that aren't actually used. Read-only.\n\n" +
    '"Used" = imported in JS/TS (static or dynamic, including dynamic imports of `optionalDependencies`), named in `package.json.scripts`, or listed in `CartographConfig.dependenciesAllowlist`. `@types/X` is kept when `X` is used. ' +
    'Also reports an `undeclared` bucket — packages imported in source but in no package.json bucket (a package whose `@types/` counterpart IS declared is treated as intentional). ' +
    'In a workspaces monorepo (npm/bun/yarn-classic `workspaces:` array or `{packages: [...]}` object), declared deps + scripts are unioned across all resolved workspace manifests; the header shows the manifest count when > 1.',
  schema: depsSchema,
  handle: handleDeps,
});
