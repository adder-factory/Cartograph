/**
 * Cross-file biomarker graph queries — the three SQL-based detectors
 * that compute findings from the global node + edge graph rather
 * than from a single file's AST.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain biomarker scanners as direct members. The functions
 * read the `nodes` + `edges` tables via the `@internal`-tagged `db`
 * field on the parent `QueryBuilder`. Note: this module covers the
 * graph-derived biomarker SCANNERS only; finding STORAGE
 * (appendFindings, etc.) lives in `queries-findings.ts`.
 *
 * MIGRATED TO TYPED QUERIES (2026-05-20) — all three module-level
 * static SQL strings are declared via {@link defineQuery}; Zod
 * schemas validate params + rows. Lazy-cached on `qb.queries.X`.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

/**
 * Find class-like nodes whose `contains` subtree has at least
 * `minMembers` method/function/property/field children AND carries
 * at least one method/function child. Backs the `god_class`
 * biomarker — a class with dozens of members is almost always a
 * candidate for splitting. Sorted by memberCount desc so the worst
 * offenders surface first.
 *
 * The method-presence requirement excludes pure data shapes: a
 * `struct` / `interface` with many fields and zero methods — e.g. a
 * Zod `z.object({...})` schema, which the extractor records as a
 * struct with one `field` child per property — is a data record,
 * not a god class. "God class" is a behavior smell (Weighted Methods
 * per Class); a container with no methods cannot exhibit it, so
 * counting its fields toward the WMC band is a misclassification.
 *
 * Includes interfaces and structs (Go's `interface`/`struct`
 * with attached methods can grow just as unwieldy as a Java class).
 */
const GodClassRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  memberCount: z.number(),
});
type GodClassRow = z.infer<typeof GodClassRowSchema>;

const findGodClassesQuery = defineQuery({
  sql: `
    SELECT n.id, n.name, n.file_path AS filePath, COUNT(child.id) AS memberCount
    FROM nodes n
    JOIN edges e ON e.source = n.id AND e.kind = 'contains'
    JOIN nodes child ON e.target = child.id
    WHERE n.kind IN ('class', 'struct', 'interface', 'trait', 'protocol')
      AND child.kind IN ('method', 'function', 'property', 'field')
    GROUP BY n.id, n.name, n.file_path
    HAVING memberCount >= @minMembers
       AND SUM(CASE WHEN child.kind IN ('method', 'function') THEN 1 ELSE 0 END) > 0
    ORDER BY memberCount DESC
  `,
  params: z.object({ minMembers: z.number() }),
  row: GodClassRowSchema,
});

export function findGodClasses(qb: QueryBuilder, minMembers: number): GodClassRow[] {
  qb.queries.findGodClasses ??= findGodClassesQuery(qb.db);
  return qb.queries.findGodClasses.all({ minMembers });
}

/**
 * Find methods showing "feature envy" via Lanza & Marinescu's
 * ATFD / LAA / FDP detection scheme — a method that reads many
 * fields off ANOTHER class while barely touching its own data.
 * That's the canonical OO smell: the method belongs on the class
 * whose data it's pestering.
 *
 * Definitions (Lanza & Marinescu, "Object-Oriented Metrics in
 * Practice"):
 *   - ATFD (Access to Foreign Data): distinct foreign field/property
 *     nodes the method emits `field_access` edges to. "Foreign" =
 *     not a `contains`-child of the method's own enclosing class.
 *   - LAA (Locality of Attribute Accesses): own-class accesses /
 *     total accesses. Below 1/3 means the method's data interest
 *     is concentrated outside its own class.
 *   - FDP (Foreign Data Providers): distinct foreign classes whose
 *     fields are accessed. Small FDP (≤ 2) means the envy is
 *     focused — the method belongs on a specific other class —
 *     versus diffuse reach across many classes (which is just
 *     normal coordination, not envy).
 *
 * Detection fires when ALL three hold:
 *   ATFD > minATFD  AND  FDP ≤ maxFDP  AND  LAA < maxLAA
 *
 * Why this beats the prior call-edge metric:
 *   - The old proxy ("calls into other files more than this file")
 *     conflated normal cross-module work with envy. ATFD/LAA
 *     specifically targets DATA dependencies, the actual smell.
 *   - The infrastructure-exclusion lists the old metric needed
 *     (src/utils.ts, src/db/, etc.) drop out: free functions don't
 *     have an enclosing class, so they're naturally skipped, and
 *     calls don't enter the metric at all.
 *
 * Scope notes:
 *   - Only fires on methods on `class | struct | trait`. Free
 *     functions have no "own class" — LAA is undefined, the smell
 *     doesn't apply.
 *   - Field/property targets must themselves be `contains`-members
 *     of a class for foreign-class attribution to work. Fields on
 *     interfaces are typically declarations only (no body access)
 *     so this rarely matters in practice.
 *   - Counts DISTINCT field nodes for ATFD/FDP (the edges table
 *     dedupes on insert) but SUMs raw access counts for LAA — a
 *     method reading `this.size` once and `other.size` once should
 *     have LAA = 0.5, not 0.
 *   - Per-language `field_access` edge emission depends on the
 *     extractor having an entry in `FIELD_ACCESS_SHAPE_BY_LANGUAGE`
 *     (`src/extraction/ts-extract-bodies.ts`) — that map is the
 *     authoritative list of languages this biomarker can evaluate.
 *     Languages without an entry won't be considered until their
 *     extractors land the edge kind.
 */
interface FindFeatureEnvyArgs {
  qb: QueryBuilder;
  /** ATFD threshold — strict greater-than. L/M textbook value: 5 (FEW). */
  minATFD: number;
  /** FDP threshold — less-than-or-equal. L/M textbook value: 2 (FEW). */
  maxFDP: number;
  /** LAA threshold — strict less-than. L/M textbook value: 1/3. */
  maxLAA: number;
}

const FeatureEnvyRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  atfd: z.number(),
  fdp: z.number(),
  laa: z.number(),
  ownAccesses: z.number(),
  foreignAccesses: z.number(),
});
type FeatureEnvyRow = z.infer<typeof FeatureEnvyRowSchema>;

const FeatureEnvyParamsSchema = z.object({
  minATFD: z.number(),
  maxFDP: z.number(),
  maxLAA: z.number(),
});
type FeatureEnvyParams = z.infer<typeof FeatureEnvyParamsSchema>;

/**
 * ATFD/LAA/FDP SQL — extracted to module scope so {@link findFeatureEnvy}
 * stays a thin wrapper around the prepared statement. The CTE chain:
 *
 *   1. source_class:        each method's immediate parent class
 *   2. field_target_class:  each class member's enclosing class
 *   3. accesses:            field_access edges joined to the above
 *
 * field_target_class includes kind=method because accessing a foreign
 * method-as-value (callback passing, .bind(), function reference) is
 * a real data coupling that the field_access extractor emits the same
 * shape of edge for. Method calls are excluded per-language by
 * `captureBodyFieldAccess` — see `FIELD_ACCESS_SHAPE_BY_LANGUAGE` in
 * `src/extraction/ts-extract-bodies.ts` for the authoritative per-grammar
 * dispatch table (one entry per language carries the AST node kind +
 * field-child name + parent-types-to-skip).
 *
 * The HAVING placeholders bind to (@minATFD, @maxFDP, @maxLAA).
 */
const findFeatureEnvyQuery = defineQuery({
  sql: `
  WITH source_class AS (
    SELECT n.id AS srcId, n.name AS srcName, n.file_path AS srcFile,
           c.id AS srcClassId
    FROM nodes n
    JOIN edges ce ON ce.target = n.id AND ce.kind = 'contains'
    JOIN nodes c  ON c.id = ce.source
    WHERE n.kind = 'method'
      AND c.kind IN ('class', 'struct', 'trait')
  ),
  field_target_class AS (
    SELECT f.id AS fieldId, fc.id AS fieldClassId
    FROM nodes f
    JOIN edges fe ON fe.target = f.id AND fe.kind = 'contains'
    JOIN nodes fc ON fc.id = fe.source
    WHERE f.kind IN ('field', 'property', 'method')
      AND fc.kind IN ('class', 'struct', 'trait', 'interface')
  ),
  accesses AS (
    SELECT sc.srcId, sc.srcName, sc.srcFile, sc.srcClassId,
           ftc.fieldId, ftc.fieldClassId
    FROM edges e
    JOIN source_class sc       ON sc.srcId = e.source
    JOIN field_target_class ftc ON ftc.fieldId = e.target
    WHERE e.kind = 'field_access'
  )
  SELECT
    srcId AS id, srcName AS name, srcFile AS filePath,
    COUNT(DISTINCT CASE WHEN fieldClassId != srcClassId THEN fieldId      END) AS atfd,
    COUNT(DISTINCT CASE WHEN fieldClassId != srcClassId THEN fieldClassId END) AS fdp,
    SUM(CASE WHEN fieldClassId  = srcClassId THEN 1 ELSE 0 END) AS ownAccesses,
    SUM(CASE WHEN fieldClassId != srcClassId THEN 1 ELSE 0 END) AS foreignAccesses,
    CAST(SUM(CASE WHEN fieldClassId = srcClassId THEN 1 ELSE 0 END) AS REAL) /
      NULLIF(COUNT(*), 0) AS laa
  FROM accesses
  GROUP BY srcId, srcName, srcFile, srcClassId
  HAVING atfd > @minATFD AND fdp <= @maxFDP AND laa < @maxLAA
  ORDER BY atfd DESC, foreignAccesses DESC
  `,
  params: FeatureEnvyParamsSchema,
  row: FeatureEnvyRowSchema,
});

export function findFeatureEnvy(args: FindFeatureEnvyArgs): FeatureEnvyRow[] {
  const { qb, minATFD, maxFDP, maxLAA } = args;
  qb.queries.findFeatureEnvy ??= findFeatureEnvyQuery(qb.db);
  return qb.queries.findFeatureEnvy.all({ minATFD, maxFDP, maxLAA });
}

/**
 * Find exported nodes that have no incoming graph edge from outside
 * their own file. Used by the `unused_export` biomarker to flag
 * dead public API after refactors.
 *
 * Excluded as "not real use":
 *   - `contains`: structural; every method is contained by its class
 *   - `exports`:  re-export barrels (`export { foo } from './a'`)
 *                 forward the symbol but don't consume it. Without
 *                 excluding this kind a re-export chain would mark
 *                 every dead-but-re-exported symbol as "used".
 *   - `imports`:  the import statement itself isn't a use; it just
 *                 brings the name into scope. Real use shows up as
 *                 `calls`/`references`/`instantiates`/`extends`/etc.
 *   - `tests`:    convention-derived test→subject edges aren't a
 *                 semantic call into the symbol's API.
 *
 * Also excludes node kinds that are never meaningful targets of the
 * rule: file/import/parameter/enum_member/field.
 */
/**
 * Package main-entry source files. Symbols defined here are public API
 * by definition — external consumers import from the compiled main
 * entry, which has no cross-file caller anywhere in the source tree.
 * Excluded so the rule doesn't flag every public-API definition.
 */
const PACKAGE_MAIN_ENTRY_FILES = ['src/index.ts'];

/**
 * Framework-convention exports are consumed BY NAME by the framework's
 * router/bundler, never via an import statement — so no use-edge can ever
 * exist in the graph, and flagging them as unused is a guaranteed false
 * positive with a destructive "fix" (deleting `metadata` from a Next.js page
 * silently strips its SEO; deleting `dynamic` changes rendering semantics).
 * This is the same modelling Knip ships in its framework plugins.
 *
 * Scope is kept deliberately tight: Next.js App Router segment files plus
 * the root middleware/instrumentation entrypoints. Extend the tables when
 * another framework's conventions surface the same FP class.
 */
/* The path shape and the special-file stem are checked separately (a
   regex carrying the 16-stem alternation tripped complexity limits and
   was harder to extend anyway). */
const NEXTJS_SEGMENT_PATH_RE = /(^|\/)app\/(?:.+\/)?([\w-]+)\.(?:ts|tsx|js|jsx|mjs)$/;
const NEXTJS_SEGMENT_STEMS: ReadonlySet<string> = new Set([
  'page',
  'layout',
  'template',
  'route',
  'error',
  'global-error',
  'loading',
  'not-found',
  'default',
  'sitemap',
  'robots',
  'manifest',
  'icon',
  'apple-icon',
  'opengraph-image',
  'twitter-image',
]);

function nextjsSegmentStem(filePath: string): string | null {
  const m = NEXTJS_SEGMENT_PATH_RE.exec(filePath);
  if (!m) return null;
  const stem = m[2] ?? '';
  return NEXTJS_SEGMENT_STEMS.has(stem) ? stem : null;
}
/** Shared route-segment config + generation hooks — valid in every
 *  segment file kind (nextjs.org/docs/app/api-reference/file-conventions/route-segment-config). */
const NEXTJS_SHARED_EXPORTS: ReadonlySet<string> = new Set([
  'dynamic',
  'dynamicParams',
  'revalidate',
  'fetchCache',
  'runtime',
  'preferredRegion',
  'maxDuration',
  'experimental_ppr',
  'generateStaticParams',
  'generateImageMetadata',
  'generateSitemaps',
]);
/** Metadata API — meaningful in non-route segment files. */
const NEXTJS_METADATA_EXPORTS: ReadonlySet<string> = new Set([
  'metadata',
  'generateMetadata',
  'viewport',
  'generateViewport',
]);
/** HTTP handler methods — ONLY a convention in route files; a `GET`
 *  exported from page.tsx is an ordinary (flaggable) export. */
const NEXTJS_ROUTE_HANDLER_EXPORTS: ReadonlySet<string> = new Set([
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);
/** Root entrypoints anchored to the project root (or src/) — a helper
 *  named middleware.ts deeper in the tree is not the convention file. */
const NEXTJS_ROOT_FILE_RE = /^(src\/)?(middleware|instrumentation)\.(ts|js|mjs)$/;
const NEXTJS_MIDDLEWARE_EXPORTS: ReadonlySet<string> = new Set(['middleware', 'config']);
const NEXTJS_INSTRUMENTATION_EXPORTS: ReadonlySet<string> = new Set(['register', 'onRequestError']);

/**
 * TanStack Router file-based routing: every route module under a
 * `routes/` directory exports `const Route = createFileRoute(...)` /
 * `createRootRoute(...)` / `createLazyFileRoute(...)`. Its sole consumer
 * is the generated `routeTree.gen.ts`, which is routinely kept out of
 * the index (gitignored, or dropped by a project exclude / minification
 * heuristic on its long generated type lines), so the graph holds no
 * edge to the export and it reads as a dead `unused_export` (issue #12).
 */
const TANSTACK_ROUTE_DIR_RE = /(?:^|\/)routes\/.*\.[jt]sx?$/;
function isTanstackRouteExport(filePath: string, name: string): boolean {
  return name === 'Route' && TANSTACK_ROUTE_DIR_RE.test(filePath);
}

/**
 * React Router framework mode (v7) — route modules are consumed by the
 * framework through the generated route manifest / `routes.ts` config by
 * module convention, not by a source `import`, so their exports have no
 * usage edge and read as a dead `unused_export` (issue #50).
 *
 * Convention files all live under the `app` directory (the default
 * `appDirectory`): route modules under `app/routes/`, the app root at
 * `app/root.*`, and the SSR entry at `app/entry.server.*`. The `app/`
 * segment is matched anywhere in the path so monorepo / `src/app/`
 * layouts (e.g. `packages/web/app/routes/...`) are covered.
 *
 * The default export of each convention file is itself a convention (the
 * route/root component, or the entry.server request handler) but keeps an
 * arbitrary LOCAL name in the graph, so it is recognised via the node's
 * `isDefaultExport` flag rather than by name. Ordinary named exports
 * (helpers, even a named sub-component) stay flaggable — only the
 * documented convention names and the default export are exempt.
 *
 * Out of scope (still reported, by design): a route module mapped to a
 * path OUTSIDE `app/routes/` via a custom `app/routes.ts` config — that
 * needs parsing the config, which this static path predicate cannot do.
 * Also out of scope: a component default-exported via the re-export form
 * `export { Foo as default }` — the extractor sets `isDefaultExport` only
 * for the `export default <decl>` form, so that node reads as non-default
 * here. React Router route modules conventionally use `export default
 * function`, so this is a rare gap, not a regression.
 */
const RR_ROUTE_DIR_RE = /(?:^|\/)app\/routes\/.*\.[jt]sx?$/;
const RR_ROOT_FILE_RE = /(?:^|\/)app\/root\.[jt]sx?$/;
const RR_ENTRY_SERVER_RE = /(?:^|\/)app\/entry\.server\.[jt]sx?$/;
/** Named data / config / middleware exports plus named component exports
 *  valid in any route module (`ErrorBoundary` / `HydrateFallback`). Both
 *  the stable and `unstable_`-prefixed middleware names are accepted. */
const RR_ROUTE_EXPORTS: ReadonlySet<string> = new Set([
  'loader',
  'clientLoader',
  'action',
  'clientAction',
  'headers',
  'handle',
  'links',
  'meta',
  'shouldRevalidate',
  'middleware',
  'clientMiddleware',
  'unstable_middleware',
  'unstable_clientMiddleware',
  'ErrorBoundary',
  'HydrateFallback',
]);
/** The root module shares the route export set and adds the document `Layout`. */
const RR_ROOT_EXPORTS: ReadonlySet<string> = new Set([...RR_ROUTE_EXPORTS, 'Layout']);
/** SSR entry — the default request handler (commonly `handleRequest`) plus
 *  its optional sibling hooks. */
const RR_ENTRY_SERVER_EXPORTS: ReadonlySet<string> = new Set([
  'handleRequest',
  'handleDataRequest',
  'handleError',
  'streamTimeout',
]);

function isReactRouterConventionExport(filePath: string, name: string, isDefaultExport: boolean): boolean {
  // The default export of a convention file is the route/root component or
  // the entry.server handler — consumed by the framework, named arbitrarily
  // — so exempt it via the flag. Named exports are exempt only when they
  // match a documented convention name (so a named helper/sub-component in a
  // route module stays flaggable).
  if (RR_ROUTE_DIR_RE.test(filePath)) return isDefaultExport || RR_ROUTE_EXPORTS.has(name);
  if (RR_ROOT_FILE_RE.test(filePath)) return isDefaultExport || RR_ROOT_EXPORTS.has(name);
  if (RR_ENTRY_SERVER_RE.test(filePath)) return isDefaultExport || RR_ENTRY_SERVER_EXPORTS.has(name);
  return false;
}

/**
 * True when an exported symbol is consumed by framework convention (no
 * graph edge possible). `isDefaultExport` (the node's default-export flag)
 * is optional — it is only consulted to recognise framework default
 * exports, which carry an arbitrary local name (issue #50).
 */
export function isFrameworkConventionExport(filePath: string, name: string, isDefaultExport = false): boolean {
  if (isTanstackRouteExport(filePath, name)) return true;
  if (isReactRouterConventionExport(filePath, name, isDefaultExport)) return true;
  const stem = nextjsSegmentStem(filePath);
  if (stem !== null) {
    if (NEXTJS_SHARED_EXPORTS.has(name)) return true;
    if (stem === 'route') return NEXTJS_ROUTE_HANDLER_EXPORTS.has(name);
    return NEXTJS_METADATA_EXPORTS.has(name);
  }
  const root = NEXTJS_ROOT_FILE_RE.exec(filePath);
  if (!root) return false;
  return root[2] === 'middleware' ? NEXTJS_MIDDLEWARE_EXPORTS.has(name) : NEXTJS_INSTRUMENTATION_EXPORTS.has(name);
}

/**
 * SQL for `findUnusedExports`. The EXISTS sub-query excludes
 * `contains` (structural), `exports` (re-export forwarding, not use),
 * `imports` (statement alone isn't use), and `tests` (convention edge,
 * not symbol-level use). `*.d.ts` ambient declarations are excluded
 * up front — they declare for declaration-merging and have no call
 * sites by design. Symbols in PACKAGE_MAIN_ENTRY_FILES are also
 * excluded — they're the public API surface, used externally.
 *
 * The main-entry path list is bound via a single JSON-encoded
 * `@mainEntries` parameter consumed by `json_each` — keeps the SQL
 * fully static (a precondition of {@link defineQuery}) regardless of
 * how many paths the list grows to in the future.
 *
 * Known FP class: cross-file uses the resolver failed to produce
 * a `calls` edge for. The biomarker output should be treated as
 * CANDIDATES for review, not a delete list — see
 * `feedback_cartograph_unused_export_false_positives.md` in user
 * memory for the verification workflow.
 */
// Edge kinds that DO count as "this export is being used" — anything
// not in the NOT IN list. The exclusions:
//   - 'contains' / 'exports' / 'imports': structural plumbing, not
//     runtime use. A barrel re-exporting Foo doesn't prove anyone
//     consumes it; same for the file→symbol contains edge or the
//     import-statement edge that binds a name into scope.
//   - 'tests': convention-derived `tests` edge maps a test file to
//     its subject file. Counting it as "the subject is used" is
//     circular — every exported symbol in a test-covered file would
//     pass the check whether or not the test actually consumes it.
//     Real test consumption shows up as 'calls' / 'type_of' /
//     'references' edges from inside test bodies, which DO count.
// "Use" includes any non-structural edge to the symbol — from any
// source, any file. The original rule required cross-file consumption
// but produced two large FP classes:
//   - Args-bundle interfaces: `export interface Args {} export function
//     f(a: Args) {}` — `f → Args` via type_of, same file.
//   - Field-type references: `export interface Outer { x: Inner }` —
//     the type_of edge sources from the field node, not the exported
//     interface, so the rule didn't propagate exportedness up.
//   - Type-derivation patterns: `export const N = [...] as const;
//     export type T = (typeof N)[number]` — N has only same-file
//     references but is genuinely live.
//
// Practical posture: TS types are erased at runtime, so a "dead"
// classification only really makes sense when NOTHING in the codebase
// references the symbol. Any non-structural edge is enough signal.
// `interface` / `type_alias` exports kept in the rule so genuinely-
// dead types still surface.
const UnusedExportRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  filePath: z.string(),
  kind: z.string(),
  // Raw 0/1 default-export flag — used to exempt framework default exports
  // (route/root component, entry.server handler) that keep a local name.
  isDefaultExport: z.number(),
});
type UnusedExportRow = z.infer<typeof UnusedExportRowSchema>;

const findUnusedExportsQuery = defineQuery({
  sql: `
    SELECT n.id, n.name, n.file_path AS filePath, n.kind, n.is_default_export AS isDefaultExport
    FROM nodes n
    WHERE n.is_exported = 1
      AND n.kind NOT IN ('file', 'import', 'parameter', 'enum_member', 'field')
      AND n.file_path NOT LIKE '%.d.ts'
      AND n.file_path NOT IN (SELECT value FROM json_each(@mainEntries))
      AND NOT EXISTS (
        SELECT 1 FROM edges e
        WHERE e.target = n.id
          AND e.kind NOT IN ('contains', 'exports', 'imports', 'tests')
      )
      -- Resolution-incompleteness guard (issue #13): never emit a
      -- confident "dead" verdict for a symbol that still has a PENDING
      -- unresolved reference by its name. A resolved usage edge is the
      -- normal signal, but resolution can be transiently incomplete —
      -- a partial / interrupted sync, or two cartograph processes with
      -- different EXTRACTION_LOGIC_VERSIONs thrashing the re-extract heal
      -- on one index — leaving a real usage stranded in unresolved_refs
      -- with no edge yet. That used to surface as a false unused_export
      -- (the same class the version-heal itself was built to fix). The
      -- reference_kind filter mirrors the edge filter above (structural
      -- imports/exports/contains/tests don't count as use) and excludes
      -- field_access so an exported name that merely collides with a
      -- builtin property access (.map / .length) isn't masked.
      AND NOT EXISTS (
        SELECT 1 FROM unresolved_refs ur
        WHERE ur.reference_name = n.name
          AND ur.reference_kind IN (
            'calls', 'references', 'type_of', 'returns',
            'instantiates', 'extends', 'implements', 'overrides', 'decorates'
          )
      )
  `,
  params: z.object({ mainEntries: z.string() }),
  row: UnusedExportRowSchema,
});

export function findUnusedExports(qb: QueryBuilder): UnusedExportRow[] {
  qb.queries.findUnusedExports ??= findUnusedExportsQuery(qb.db);
  const rows = qb.queries.findUnusedExports.all({
    mainEntries: JSON.stringify(PACKAGE_MAIN_ENTRY_FILES),
  });
  // Post-filter (not SQL): the framework-convention predicate needs a real
  // regex over the path, and defineQuery requires fully static SQL.
  return rows.filter((row) => !isFrameworkConventionExport(row.filePath, row.name, row.isDefaultExport === 1));
}

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    findGodClasses?: TypedQuery<{ minMembers: number }, GodClassRow>;
    findFeatureEnvy?: TypedQuery<FeatureEnvyParams, FeatureEnvyRow>;
    findUnusedExports?: TypedQuery<{ mainEntries: string }, UnusedExportRow>;
  }
}
