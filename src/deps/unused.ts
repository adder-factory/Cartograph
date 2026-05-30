import type { QueryBuilder } from '../db/queries.js';
import { readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';
import { builtinModules } from 'module';
import { loadConfig } from '../config.js';
import { stripJsComments } from '../resolution/import-resolver.js';

export interface UnusedDepsResult {
  declaredRuntime: string[];
  declaredDev: string[];
  declaredOptional: string[];
  /**
   * Considered-used: any dep marked used by ANY of three signals —
   * imported in JS/TS source, referenced by package name or bin name
   * in `package.json.scripts`, or listed in
   * `CartographConfig.dependenciesAllowlist`.
   */
  used: string[];
  unusedRuntime: string[];
  unusedDev: string[];
  unusedOptional: string[];
  /**
   * Packages imported in source but absent from every package.json
   * dependency bucket — e.g. used only by a throwaway script, or a
   * genuinely missing dependency. Derived from AST-extracted imports
   * ONLY: the fuzzy regex source-scan feeds `used` but never this
   * bucket, so an `import()`/`require()` token matched inside a string
   * literal can't surface a false "undeclared" finding. A package whose
   * `@types/` counterpart IS declared is also excluded — a declared type
   * stub is an affirmative "the maintainer intends this package" signal
   * (the common shape: an optional native backend loaded behind a
   * try/catch, kept out of package.json on purpose).
   */
  undeclared: string[];
  packageJsonPath: string;
  /**
   * Every package.json the audit unioned, root first. Length 1 for a
   * normal repo; longer when the root declares `workspaces:` (npm /
   * bun / yarn-classic). The union covers per-workspace declared deps +
   * per-workspace scripts so a `react`/`zod`/`tsc` declared in a child
   * package.json doesn't false-flag as undeclared / unused at the root.
   */
  workspaceManifestPaths: string[];
  /**
   * Discovered package.json files that the audit could NOT use as a
   * root — populated ONLY when no root manifest exists at projectRoot.
   * Surfaces "the audit didn't run, but there's a nested JS app you
   * could point us at" so a Go-dominant repo with an embedded JS
   * sub-app (e.g. ollama's `app/ui/app/package.json`) doesn't get a
   * terse no-op message that misses the obvious next move. Capped at
   * depth 5; node_modules / dot-dirs excluded.
   */
  nestedManifests?: string[];
}

/**
 * One package.json read during a deps audit. The root manifest is
 * always present; child manifests are only added when the root
 * declares a `workspaces:` field (npm / bun / yarn-classic).
 *
 * `isRoot` is true for the project-root manifest and false for every
 * resolved workspace child. The audit unions declared deps + scripts
 * across all manifests but keeps node_modules + scripts-dir + test
 * runner config scans rooted at the project root (those state shapes
 * are hoisted by every package manager that supports `workspaces:`).
 */
interface WorkspaceManifest {
  packageJsonPath: string;
  packageJson: Record<string, any>;
  isRoot: boolean;
}

interface ReadPackageJsonArgs {
  projectRoot: string;
}

interface ExtractDeclaredDepsArgs {
  manifests: ReadonlyArray<WorkspaceManifest>;
}

interface CollectImportsFromGraphArgs {
  qb: QueryBuilder;
}

interface CollectUsedFromScriptsAndAllowlistArgs {
  projectRoot: string;
  manifests: ReadonlyArray<WorkspaceManifest>;
  declaredDeps: Set<string>;
  usedSet: Set<string>;
  binToPackage: Map<string, string>;
}

interface CollectUsedFromScriptFilesArgs {
  projectRoot: string;
  usedSet: Set<string>;
  binToPackage: Map<string, string>;
}

interface ComputeUnusedSetsArgs {
  declaredRuntime: string[];
  declaredDev: string[];
  declaredOptional: string[];
  usedSet: Set<string>;
}

function readPackageJson(args: ReadPackageJsonArgs): {
  packageJson: Record<string, any>;
  packageJsonPath: string;
} {
  const { projectRoot } = args;
  const packageJsonPath = join(projectRoot, 'package.json');

  if (existsSync(packageJsonPath)) {
    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      return { packageJson, packageJsonPath };
    } catch {
      return { packageJson: {}, packageJsonPath: '' };
    }
  }
  return { packageJson: {}, packageJsonPath: '' };
}

function extractDeclaredDeps(args: ExtractDeclaredDepsArgs): {
  declaredRuntime: string[];
  declaredDev: string[];
  declaredOptional: string[];
} {
  const { manifests } = args;
  const runtime = new Set<string>();
  const dev = new Set<string>();
  const optional = new Set<string>();
  for (const m of manifests) {
    for (const k of Object.keys(m.packageJson['dependencies'] ?? {})) runtime.add(k);
    for (const k of Object.keys(m.packageJson['devDependencies'] ?? {})) dev.add(k);
    for (const k of Object.keys(m.packageJson['optionalDependencies'] ?? {})) optional.add(k);
  }
  return {
    declaredRuntime: Array.from(runtime).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    declaredDev: Array.from(dev).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    declaredOptional: Array.from(optional).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

/**
 * Pull workspace patterns out of a root package.json. Supports the
 * shipped shapes:
 *
 *   - `"workspaces": ["apps/*", "packages/*"]` — npm / bun /
 *     yarn-modern (the form nextssh + most 2026 monorepos use).
 *   - `"workspaces": { "packages": ["apps/*"], "nohoist": [...] }` —
 *     yarn-classic extended object form.
 *
 * Returns `[]` when no workspaces field is declared (single-package
 * repo) — the audit then degrades to the pre-2026-05-22 behaviour:
 * one manifest = the root.
 *
 * pnpm-workspace.yaml is intentionally NOT parsed here — it lives in
 * a separate YAML file and pnpm-only repos are a follow-up. The bug
 * #1 surface (npm/bun/yarn `workspaces:` field) covers ~all 2026
 * monorepos cartograph indexes.
 *
 * Negation entries like `!apps/excluded` (npm DOES support them but
 * very few repos use them) are returned as-is; `readWorkspaceManifests`
 * filters them out before invoking the glob. The audit then
 * overcollects rather than failing on that rare construct — the
 * trade-off favours simplicity over exclusion fidelity.
 */
function parseWorkspacePatterns(packageJson: Record<string, any>): string[] {
  const ws = packageJson['workspaces'];
  if (Array.isArray(ws)) return ws.filter((s): s is string => typeof s === 'string');
  if (ws !== null && typeof ws === 'object') {
    const packages = (ws as { packages?: unknown }).packages;
    if (Array.isArray(packages)) return packages.filter((s): s is string => typeof s === 'string');
  }
  return [];
}

/**
 * Resolve `workspaces:` globs to actual package.json paths and load
 * each manifest. The root manifest is always the first element. A
 * malformed or unreadable workspace package.json is silently skipped
 * — a syntax error in a single workspace shouldn't kill the whole
 * audit (the root manifest still contributes, and the workspace's
 * imports still flow through the AST scan).
 *
 * Globs are matched via `Bun.Glob.scanSync` (`onlyFiles` default),
 * resolved against `projectRoot`. We append `/package.json` to each
 * workspace pattern so `apps/*` resolves to `apps/<name>/package.json`
 * rather than `apps/<name>` (the directory) — saves a second
 * directory-walk pass.
 */
function readWorkspaceManifests(
  projectRoot: string,
  rootPackageJson: Record<string, any>,
  rootPackageJsonPath: string,
): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [
    { packageJsonPath: rootPackageJsonPath, packageJson: rootPackageJson, isRoot: true },
  ];
  for (const pattern of parseWorkspacePatterns(rootPackageJson)) {
    // Skip npm-style exclusion entries (`!apps/excluded`) — passing
    // them straight to `Bun.Glob` would silently match zero files
    // (`!apps/.../package.json` is not a valid Bun.Glob pattern), and
    // the positive entry still includes the excluded child anyway.
    // The audit then overcollects in that rare case rather than
    // failing, which matches the JSDoc trade-off in
    // `parseWorkspacePatterns`.
    if (pattern.startsWith('!')) continue;
    // Normalise trailing slash + append /package.json so `apps/*`
    // matches every direct child's manifest.
    const stripped = pattern.replace(/\/+$/, '');
    const glob = new Bun.Glob(`${stripped}/package.json`);
    for (const match of glob.scanSync({ cwd: projectRoot })) {
      const fullPath = join(projectRoot, match);
      try {
        const json = JSON.parse(readFileSync(fullPath, 'utf-8')) as Record<string, any>;
        manifests.push({ packageJsonPath: fullPath, packageJson: json, isRoot: false });
      } catch {
        // Malformed / unreadable workspace package.json — skip silently.
        // The audit still completes against the surviving manifests.
      }
    }
  }
  return manifests;
}

function collectImportsFromGraph(args: CollectImportsFromGraphArgs): Set<string> {
  const { qb } = args;
  const usedSet = new Set<string>();
  const builtinSet = new Set(builtinModules);

  // Exclude fixture directories (docs/test-beds/, __tests__/fixtures/,
  // test/fixtures/, spec/fixtures/) so demo/test import specifiers like
  // "fmt", "foo", "pkg", "require-cast-pkg" don't pollute the used-set.
  // These are DB-side LIKE conditions rather than a JS post-filter so
  // the DB does the heavy lifting before rows cross the FFI boundary.
  // Deliberately narrower than `isFixturePath()` (path-class.ts), which
  // matches any `fixtures/` directory anywhere — here the four anchored
  // top-level prefixes are the only fixture roots a dependency scan
  // needs to exclude, and an anchored LIKE stays sargable.
  const rows = qb.db
    .prepare(
      `SELECT DISTINCT name FROM nodes
       WHERE kind = 'import'
         AND language IN ('typescript', 'javascript', 'tsx', 'jsx')
         AND name NOT LIKE './%'
         AND name NOT LIKE '../%'
         AND name NOT LIKE '/%'
         AND file_path NOT LIKE 'docs/test-beds/%'
         AND file_path NOT LIKE '__tests__/fixtures/%'
         AND file_path NOT LIKE 'test/fixtures/%'
         AND file_path NOT LIKE 'spec/fixtures/%'`,
    )
    .all() as Array<{ name: string }>;

  for (const row of rows) {
    addSpecToUsedSet(row.name, usedSet, builtinSet);
  }

  return usedSet;
}

/**
 * Normalise an import specifier and add the resolved package name to
 * `usedSet`. Returns early on relative paths, on `node:`-scheme
 * specifiers, and on bare Node builtins; otherwise pulls the
 * scoped/unscoped package root (`@scope/pkg` or `lodash`).
 *
 * The `node:` URL scheme is reserved exclusively for Node core modules
 * — no npm package can be imported through it — so the prefix alone is
 * a sufficient builtin signal. `builtinModules` from `node:module`
 * OMITS experimental cores (e.g. `node:sqlite`), so stripping the
 * prefix and checking list-membership would leak a phantom `sqlite`
 * npm package into the used / undeclared sets.
 *
 * Extracted so the graph-side and source-scan paths share the same
 * normalisation — keeps the two signals symmetrical and prevents drift.
 */
function addSpecToUsedSet(spec: string, usedSet: Set<string>, builtinSet: Set<string>): void {
  if (spec.startsWith('./') || spec.startsWith('../') || spec.startsWith('/')) {
    return;
  }
  // `node:`-scheme specifiers are always core modules — return on the
  // prefix itself rather than slicing it off and checking `builtinModules`
  // (which omits experimental cores like `node:sqlite`).
  if (spec.startsWith('node:')) return;
  if (builtinSet.has(spec)) return;
  const pkgName = extractPackageName(spec);
  if (pkgName) usedSet.add(pkgName);
}

/**
 * Regex scan source files for dynamic-import / require() specifiers
 * that the graph extractor MIGHT have missed. Two failure modes this
 * covers:
 *   1. Stale extraction — the live index pre-dates a fix to
 *      `tsTryEmitDynamicImport` (e.g. the `tsUnwrapStringArg` patch),
 *      so the graph has no import node for `await import('pkg' as any)`
 *      even though the source line exists.
 *   2. Novel TS wrapper syntax not yet handled by the AST unwrap
 *      (future-proofing — every new wrapper type would otherwise need
 *      its own AST handler before `cartograph_deps` stops false-flagging).
 *
 * Matches both `import('pkg')` and `require('pkg')` forms with single,
 * double, or backtick string quotes. Pulls the string literal AFTER
 * the `(` and stops at the matching closing quote — TS casts like
 * `'pkg' as any` sit OUTSIDE the closing quote so this is a pure
 * lexer-level match. Scans only JS/TS files registered in `files`,
 * skipping the project's own `node_modules/` and `.cartograph/`.
 *
 * **Comments ARE stripped** (via `stripJsComments`) before the regex
 * runs. A commented-out `// await import('some-pkg')` is dead code, so
 * counting it as used would be a false-USED that masks a real removal
 * candidate. Stripping comments only removes false-USED entries — a
 * real `import()` call (the actual stale-graph defense target) is never
 * inside a comment — so this is a strict improvement. Test files are
 * also excluded from the file query: the scan is a stale-graph backup,
 * and the graph-extraction path already covers real test-file imports.
 */
interface CollectImportsFromSourceArgs {
  qb: QueryBuilder;
  projectRoot: string;
  usedSet: Set<string>;
}

function collectImportsFromSourceScan(args: CollectImportsFromSourceArgs): void {
  const { qb, projectRoot, usedSet } = args;
  const builtinSet = new Set(builtinModules);

  // Fixture directories excluded — mirrors the graph-path filter above.
  // Test files are also excluded: this source-scan is a stale-graph
  // backup, and the graph-extraction path already covers real
  // test-file imports. Without this, `import('pkg' as any)` calls
  // inside test-fixture template strings (e.g. in this very repo's
  // __tests__/unused-deps.test.ts) leak into the used-set as phantoms.
  const rows = qb.db
    .prepare(
      `SELECT path FROM files
       WHERE language IN ('typescript', 'javascript', 'tsx', 'jsx')
         AND path NOT LIKE 'docs/test-beds/%'
         AND path NOT LIKE '__tests__/fixtures/%'
         AND path NOT LIKE 'test/fixtures/%'
         AND path NOT LIKE 'spec/fixtures/%'
         AND path NOT LIKE '%.test.%'
         AND path NOT LIKE '%.spec.%'
         AND path NOT LIKE '__tests__/%'`,
    )
    .all() as Array<{ path: string }>;

  // `import(` and `require(` with a string literal in argument position.
  // Capture group 1 = quote, 2 = specifier. We accept any quote style.
  const dynPattern = /\b(?:import|require)\s*\(\s*(['"`])([^'"`\r\n]+)\1/g;

  for (const row of rows) {
    const abs = row.path.startsWith('/') ? row.path : join(projectRoot, row.path);
    let content: string;
    try {
      content = readFileSync(abs, 'utf-8');
    } catch {
      continue; // File missing on disk — ignore.
    }
    // Strip `//` and `/* */` comments first — a commented-out
    // `import('pkg')` is dead code and must not mark `pkg` as used.
    content = stripJsComments(content);
    let m: RegExpExecArray | null;
    while ((m = dynPattern.exec(content)) !== null) {
      const spec = m[2]!;
      // Drop noise: doc-string fragments, regex literals, and any
      // text that doesn't look like a valid npm specifier. npm names
      // are [a-z0-9-_.] with optional `@scope/` prefix and may carry
      // a subpath. Anything with spaces / parens / brackets / special
      // chars came from a comment or string-literal example, not from
      // a real import call.
      if (!isPlausibleNpmSpecifier(spec)) continue;
      addSpecToUsedSet(spec, usedSet, builtinSet);
    }
  }
}

/**
 * Cheap shape check for an npm import specifier. Lets through scoped
 * (`@scope/pkg`), unscoped (`lodash`), subpath (`lodash/debounce`),
 * and relative imports (which the caller will drop anyway). Rejects
 * anything with whitespace, parens, brackets, backticks, or other
 * obvious-not-a-package-name chars — those came from doc-comments or
 * string-literal examples that the regex picked up accidentally.
 * The character class deliberately mirrors npm's published name rules
 * plus `/` for subpaths and `.` for relative segments.
 *
 * Also rejects specs with NO alphanumeric character at all — a real
 * npm name (or relative path segment) always has at least one
 * `[a-zA-Z0-9]`. This kills punctuation-only matches like `...`
 * (an ellipsis literal in example prose), `./`, or `--` that would
 * otherwise slip through the char class.
 */
function isPlausibleNpmSpecifier(spec: string): boolean {
  if (spec.length === 0 || spec.length > 214) return false;
  if (!/[a-zA-Z0-9]/.test(spec)) return false;
  return /^[@a-zA-Z0-9_./-]+$/.test(spec);
}

function collectUsedFromScriptsAndAllowlist(args: CollectUsedFromScriptsAndAllowlistArgs): void {
  const { projectRoot, manifests, declaredDeps, usedSet, binToPackage } = args;

  // Walk scripts across EVERY workspace manifest (root + each
  // workspace child). Without this a workspace's `typecheck: tsc
  // --noEmit` would never surface `tsc → typescript` as a used
  // bin invocation and the typescript devDep would false-flag as
  // unused. Same shape for every workspace-local bin invocation
  // (vite / vitest / tauri / drizzle-kit etc.).
  for (const m of manifests) {
    const scripts = m.packageJson['scripts'] ?? {};
    for (const [, scriptBody] of Object.entries(scripts)) {
      const tokens = tokenizeScript(scriptBody as string);
      for (const token of tokens) {
        if (binToPackage.has(token)) {
          usedSet.add(binToPackage.get(token)!);
        }
        if (declaredDeps.has(token)) {
          usedSet.add(token);
        }
      }
    }
  }

  let allowlist: string[] = [];
  try {
    const config = loadConfig(projectRoot);
    allowlist = config.dependenciesAllowlist ?? [];
  } catch {
    // Ignore config load errors
  }

  for (const dep of allowlist) {
    usedSet.add(dep);
  }
}

/** Script-file extensions scanned for bin-name invocations. Limited to
 *  the executable-script formats that conventionally live under
 *  `scripts/` — TS / JS / mjs / cjs and POSIX shell flavours. */
const SCRIPT_FILE_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.sh', '.bash']);

/** Per-package limit on how deep we walk under `scripts/` before giving
 *  up. Keeps the scan O(small) even on monorepos with vendored tools.
 *  4 levels covers `scripts/<group>/<subgroup>/<file>` comfortably. */
const SCRIPT_SCAN_MAX_DEPTH = 4;

function walkScriptsDir(dir: string, depth: number, out: string[]): void {
  if (depth > SCRIPT_SCAN_MAX_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === '.git' || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walkScriptsDir(full, depth + 1, out);
      continue;
    }
    if (st.isFile() && SCRIPT_FILE_EXTENSIONS.has(extname(name))) out.push(full);
  }
}

/**
 * Widen the "used" heuristic to bin invocations that live in source
 * files under `scripts/` rather than `package.json.scripts`. Canonical
 * case (2026-05-22): `tree-sitter-cli` is invoked by
 * `scripts/build-grammar-wasm.ts` via `tree-sitter build --wasm`,
 * never appears in `package.json.scripts`, and the pre-fix audit
 * false-flagged it as unused dev.
 *
 * Scans only files whose extension is in `SCRIPT_FILE_EXTENSIONS` to
 * keep the read cost predictable. Uses an anchored word-boundary
 * regex per bin name (NOT arbitrary substring) so `tree-sitter`
 * inside a longer token like `tree-sitter-cli` doesn't false-match
 * — the bin invocation is a discrete shell token. `binToPackage` is
 * built once at audit start and reused here so we don't re-read
 * each dep's `node_modules/<pkg>/package.json` per scan target.
 *
 * Strip comments before scanning so a commented-out
 * `// tree-sitter build --wasm` example in a doc-string doesn't mark
 * its package as used. Shell scripts (`.sh` / `.bash`) get the same
 * pass: `#`-prefixed lines inside `stripJsComments` aren't handled,
 * but the regex's word-boundary anchor + the rare reality of a
 * commented `tree-sitter` token inside a shell script make this a
 * negligible false-USED risk.
 */
function collectUsedFromScriptFiles(args: CollectUsedFromScriptFilesArgs): void {
  const { projectRoot, usedSet, binToPackage } = args;
  if (binToPackage.size === 0) return;
  const scriptsDir = join(projectRoot, 'scripts');
  if (!existsSync(scriptsDir)) return;
  const files: string[] = [];
  walkScriptsDir(scriptsDir, 0, files);
  if (files.length === 0) return;

  // Pre-build one regex per bin name (word-boundary anchored). Escapes
  // shell-significant chars so a bin name with a `.` or `-` (e.g.
  // `tree-sitter`) matches literally.
  const binRegexes: Array<{ bin: string; pkg: string; re: RegExp }> = [];
  for (const [bin, pkg] of binToPackage) {
    const escaped = bin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // (?:^|[^A-Za-z0-9_./-]) and lookahead mirror — keeps the bin
    // name as a standalone shell token (preceded / followed by
    // whitespace, line boundary, or a shell metacharacter).
    binRegexes.push({ bin, pkg, re: new RegExp(`(?:^|[^A-Za-z0-9_./-])${escaped}(?=$|[^A-Za-z0-9_./-])`, 'm') });
  }

  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    content = stripJsComments(content);
    for (const { pkg, re } of binRegexes) {
      if (re.test(content)) usedSet.add(pkg);
    }
  }
}

/**
 * F-P fix: test-runner coverage providers (e.g. `@vitest/coverage-v8`)
 * are loaded by the runner itself based on `test.coverage.provider` in
 * `vitest.config.*` — they are never `import`ed from source, so the
 * static AST scan and the regex source-scan both miss them and the
 * package false-flags as an unused devDependency.
 *
 * Rather than hardcode a list, we DETECT the provider: read every
 * `vitest.config.*` / `vite.config.*` file at the project root, find a
 * `provider: '<name>'` entry inside the `coverage` block, and map the
 * provider value to its npm package via `COVERAGE_PROVIDER_PACKAGES`.
 * Vitest accepts `provider: 'v8'` or `provider: 'istanbul'`, served by
 * `@vitest/coverage-v8` / `@vitest/coverage-istanbul` respectively.
 *
 * Injected into `usedSet` only — they never reach the `undeclared`
 * bucket (that is AST-imports-only) because a config-loaded provider
 * produces no import node.
 */
const COVERAGE_PROVIDER_PACKAGES: Record<string, string> = {
  v8: '@vitest/coverage-v8',
  istanbul: '@vitest/coverage-istanbul',
};

/**
 * Specifiers a runtime can resolve WITHOUT a matching package.json
 * dependency — typically because the runner ships a built-in shim
 * intercepting the bare specifier. The canonical case is `bun test`'s
 * vitest-compatibility shim: `from 'vitest'` resolves to bun:test's
 * own `describe` / `it` / `expect` / `vi` etc. when running under
 * `bun test`, even though `vitest` itself is not installed.
 *
 * Each entry is `[specifier, isShimmed(projectRoot, packageJson)]`.
 * When the predicate returns true and the specifier is ALSO absent
 * from every package.json dep bucket, the specifier is dropped from
 * the `undeclared` bucket — the runner provides it. The specifier
 * still flows through the normal used-set (so it can never false-flag
 * a sibling package as unused), but the absence in package.json is
 * deliberate, not a missing-dep bug.
 *
 * Detection lives in code rather than as a static list so new bun
 * shims (or other runtime-provided modules) can be added by appending
 * an entry without re-touching the heuristic.
 */
const RUNTIME_SHIMMED_SPECIFIERS: Array<{
  spec: string;
  isShimmed: (projectRoot: string, manifests: ReadonlyArray<WorkspaceManifest>) => boolean;
}> = [
  {
    // vitest is shimmed by bun:test when the project runs under `bun
    // test` AND vitest is not a real devDep ANYWHERE in the workspace
    // tree. The vitest-shaped imports in the 245-file test suite still
    // resolve through bun's built-in shim; flagging them as undeclared
    // is wrong. Pre-2026-05-22: this only checked the root manifest, so
    // a workspaces monorepo declaring vitest in one workspace would
    // fool the shim check on every other workspace — fixed by walking
    // every manifest's devDependencies.
    spec: 'vitest',
    isShimmed: (projectRoot, manifests) => {
      for (const m of manifests) {
        const declaredDev = m.packageJson['devDependencies'] ?? {};
        if (Object.hasOwn(declaredDev, 'vitest')) return false;
      }
      // Signal A: `bun test` in ANY manifest's test script. Workspaces
      // commonly only put `bun test` in the leaf packages, not the root.
      for (const m of manifests) {
        const scripts = m.packageJson['scripts'] ?? {};
        const testScript = typeof scripts['test'] === 'string' ? (scripts['test'] as string) : '';
        if (/\bbun\s+test\b/.test(testScript)) return true;
      }
      // Signal B: a bunfig.toml at the project root — bun-native project.
      if (existsSync(join(projectRoot, 'bunfig.toml'))) return true;
      return false;
    },
  },
];

function collectRuntimeShimmedSpecifiers(
  projectRoot: string,
  manifests: ReadonlyArray<WorkspaceManifest>,
): Set<string> {
  const shimmed = new Set<string>();
  for (const entry of RUNTIME_SHIMMED_SPECIFIERS) {
    if (entry.isShimmed(projectRoot, manifests)) shimmed.add(entry.spec);
  }
  return shimmed;
}

/** Config-file basenames a coverage provider can be declared in. */
const TEST_RUNNER_CONFIG_BASENAMES = [
  'vitest.config.ts',
  'vitest.config.js',
  'vitest.config.mjs',
  'vitest.config.cjs',
  'vite.config.ts',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.cjs',
];

/**
 * Scan test-runner config files at the project root for a configured
 * coverage provider and add the matching provider package to
 * `usedSet`. Cheap: a handful of small files read at the project root,
 * a single regex per file. The regex looks for `provider:` followed by
 * a quoted value anywhere in the config text — narrow enough that a
 * bare `provider:` outside a coverage block is the only false hit, and
 * such a value would simply not map in `COVERAGE_PROVIDER_PACKAGES`.
 */
function collectTestRunnerProviderPackages(projectRoot: string, usedSet: Set<string>): void {
  const providerRe = /\bprovider\s*:\s*['"`]([a-z0-9-]+)['"`]/gi;
  for (const basename of TEST_RUNNER_CONFIG_BASENAMES) {
    const configPath = join(projectRoot, basename);
    if (!existsSync(configPath)) continue;
    let content: string;
    try {
      content = readFileSync(configPath, 'utf-8');
    } catch {
      continue; // Unreadable config — ignore.
    }
    content = stripJsComments(content);
    let m: RegExpExecArray | null;
    while ((m = providerRe.exec(content)) !== null) {
      const pkg = COVERAGE_PROVIDER_PACKAGES[m[1]!.toLowerCase()];
      if (pkg) usedSet.add(pkg);
    }
  }
}

function computeUnusedSets(args: ComputeUnusedSetsArgs): {
  unusedRuntime: string[];
  unusedDev: string[];
  unusedOptional: string[];
} {
  const { declaredRuntime, declaredDev, declaredOptional, usedSet } = args;

  const unusedRuntime = declaredRuntime.filter((p) => !usedSet.has(p));
  const unusedOptional = declaredOptional.filter((p) => !usedSet.has(p));

  const unusedDev = declaredDev.filter((p) => {
    if (!usedSet.has(p)) {
      if (p.startsWith('@types/')) {
        const upstream = extractTypesUpstream(p);
        // @types/node is special: its "upstream" is the Node.js runtime
        // itself, which has no importable npm package — Node built-ins are
        // consumed via bare specifiers (`fs`, `path`, `node:*`) that the
        // builtin-filter in addSpecToUsedSet strips before they reach
        // usedSet. There is therefore no `usedSet.has('node')` hit, and
        // the normal @types/X check would always flag it as unused. Keep
        // @types/node (and any other @types/<builtin-namespace> whose
        // upstream maps to a Node.js built-in module or the reserved name
        // "node") since it is consumed ambiently by the TS compiler.
        if (upstream === 'node' || builtinModules.includes(upstream)) return false;
        return !usedSet.has(upstream);
      }
      return true;
    }
    return false;
  });

  return { unusedRuntime, unusedDev, unusedOptional };
}

/** Returns an empty/unavailable result when no package.json was found. */
function emptyUnusedDepsResult(): UnusedDepsResult {
  return {
    declaredRuntime: [],
    declaredDev: [],
    declaredOptional: [],
    used: [],
    unusedRuntime: [],
    unusedDev: [],
    unusedOptional: [],
    undeclared: [],
    packageJsonPath: '',
    workspaceManifestPaths: [],
  };
}

interface ComputeDepAnalysisArgs {
  qb: QueryBuilder;
  projectRoot: string;
  manifests: ReadonlyArray<WorkspaceManifest>;
  declaredRuntime: string[];
  declaredDev: string[];
  declaredOptional: string[];
}

/**
 * Context passed to every {@link UsedSignalRule}'s `apply` — each rule
 * decides whether to mutate `usedSet` by adding packages it considers
 * used by some signal beyond direct AST imports.
 *
 * `packageJson` is the ROOT manifest (back-compat for rules that only
 * care about the project root — config-file location, test runner
 * config, etc.). `manifests` is the union (root + every resolved
 * workspace child) — rules that need union semantics (script
 * tokenisation, multi-workspace allowlists) iterate this list. Length
 * 1 for a non-workspaces repo so iterating it is equivalent to reading
 * `packageJson` for any single-manifest project.
 */
export interface UsedSignalContext {
  qb: QueryBuilder;
  projectRoot: string;
  /**
   * Root manifest only. Currently unread by any built-in rule —
   * retained on the context shape because every external rule
   * registry call site that pre-dates the 2026-05-22 workspaces
   * union destructures from this field. New rules that need
   * cross-workspace data should iterate `manifests` instead.
   */
  packageJson: Record<string, unknown>;
  manifests: ReadonlyArray<WorkspaceManifest>;
  declaredDeps: ReadonlySet<string>;
  binToPackage: Map<string, string>;
  usedSet: Set<string>;
}

/**
 * One additive "used" signal. The deps audit composes a registry of
 * these so adding a new signal (e.g. a future test-runner-config
 * pattern beyond vitest's coverage provider, or a build-tool config
 * format) is ONE entry — no editing of the dispatcher in
 * {@link computeDepAnalysis}.
 *
 * The AST-extracted imports set is the BASELINE, not a rule — it's
 * the reliable signal everything else widens. The "undeclared" output
 * later derives from that baseline only, so a rule that adds noise to
 * `usedSet` can never create a phantom undeclared finding (the rule
 * registry only ever SUPPRESSES "unused" via wider coverage).
 */
export interface UsedSignalRule {
  /** Stable identifier — used in diagnostics, prose, and future audit
   *  output (`"detected via 'script-files-bin-invocations'"`). */
  name: string;
  /** One-line user-facing description of what the rule detects. */
  description: string;
  /** Mutate `ctx.usedSet` to add packages this rule considers used. */
  apply: (ctx: UsedSignalContext) => void;
}

/**
 * Registry of additive "used" signals. Order doesn't matter
 * semantically — all rules union into the same `usedSet` — but the
 * registry order drives the audit-log walk so keep declarative
 * (cheapest first, fuzziest last) for readability.
 */
export const USED_SIGNAL_RULES: ReadonlyArray<UsedSignalRule> = [
  {
    name: 'source-scan-dynamic-imports',
    description:
      'Regex source-scan for dynamic `await import(...)` and `require(...)` calls — catches lazily-loaded / optional imports the AST extractor misses (the canonical case is a try/catch-guarded optional native backend).',
    apply: ({ qb, projectRoot, usedSet }) => collectImportsFromSourceScan({ qb, projectRoot, usedSet }),
  },
  {
    name: 'package-json-scripts-and-allowlist',
    description:
      "Packages referenced by name or bin in any workspace manifest's `package.json.scripts`, or listed in `CartographConfig.dependenciesAllowlist`. The script walk unions across the root + every resolved workspace child so a `typecheck: tsc` declared inside `apps/cli/package.json` correctly marks `typescript` as used at the audit level.",
    apply: ({ projectRoot, manifests, declaredDeps, usedSet, binToPackage }) =>
      collectUsedFromScriptsAndAllowlist({
        projectRoot,
        manifests,
        declaredDeps: new Set(declaredDeps),
        usedSet,
        binToPackage,
      }),
  },
  {
    name: 'script-files-bin-invocations',
    description:
      "Files under `scripts/**/*.{ts,tsx,mts,cts,js,mjs,cjs,sh,bash}` that invoke a declared package's bin (e.g. `scripts/build-grammar-wasm.ts` invoking `tree-sitter build --wasm`) — without this, every script-only CLI false-flags as unused.",
    apply: ({ projectRoot, usedSet, binToPackage }) =>
      collectUsedFromScriptFiles({ projectRoot, usedSet, binToPackage }),
  },
  {
    name: 'test-runner-coverage-provider',
    description:
      'Coverage provider package (e.g. `@vitest/coverage-v8`) declared in `vitest.config.*` / `vite.config.*` — loaded by the runner from config, never imported.',
    apply: ({ projectRoot, usedSet }) => collectTestRunnerProviderPackages(projectRoot, usedSet),
  },
];

/**
 * Context passed to every {@link UndeclaredSuppressionRule}'s
 * `shouldSuppress`. Computed once per audit so rules don't repeat
 * filesystem reads.
 */
export interface UndeclaredSuppressionContext {
  projectRoot: string;
  packageJson: Record<string, unknown>;
  /** Upstream package names of every declared `@types/X` entry. */
  typedUpstreams: ReadonlySet<string>;
  /** Specifiers a runtime shim resolves without a matching dep. */
  shimmedSpecifiers: ReadonlySet<string>;
}

/**
 * One reason to KEEP a candidate out of the "undeclared" output even
 * though it's imported in source and absent from every package.json
 * bucket. Adding a new exception (e.g. a future "this specifier is
 * resolved by the bundler's built-in polyfills" pattern) is one entry.
 */
export interface UndeclaredSuppressionRule {
  name: string;
  description: string;
  /** Return `true` to keep `candidate` OUT of the undeclared list. */
  shouldSuppress: (candidate: string, ctx: UndeclaredSuppressionContext) => boolean;
}

/**
 * Registry of "don't flag this as undeclared" rules. Each rule
 * independently vetoes a candidate — `shouldSuppress` returning true
 * is enough to drop it.
 */
export const UNDECLARED_SUPPRESSION_RULES: ReadonlyArray<UndeclaredSuppressionRule> = [
  {
    name: 'typed-upstream-declared',
    description:
      'Candidate X is suppressed when `@types/X` is in the declared set — declaring the type stub is an affirmative "I intend this package" signal (the canonical shape is an optional native backend loaded behind a try/catch, kept out of package.json on purpose).',
    shouldSuppress: (candidate, ctx) => ctx.typedUpstreams.has(candidate),
  },
  {
    name: 'runtime-shimmed-specifier',
    description:
      "Candidate is resolved by a runtime shim that intercepts the bare specifier (e.g. `vitest` under `bun test`'s built-in shim). The runner provides the module, no matching package.json dep is needed.",
    shouldSuppress: (candidate, ctx) => ctx.shimmedSpecifiers.has(candidate),
  },
];

function computeDepAnalysis(args: ComputeDepAnalysisArgs): {
  used: string[];
  unusedRuntime: string[];
  unusedDev: string[];
  unusedOptional: string[];
  undeclared: string[];
} {
  const { qb, projectRoot, manifests, declaredRuntime, declaredDev, declaredOptional } = args;
  const rootPackageJson = manifests[0]?.packageJson ?? {};

  // AST-extracted imports — the reliable baseline. Snapshot BEFORE
  // any rule fires; the "undeclared" output is derived from this
  // snapshot only so a fuzzy `apply` mutation can never create a
  // phantom undeclared finding.
  const astImports = collectImportsFromGraph({ qb });
  const usedSet = new Set(astImports);
  const declaredDeps = new Set([...declaredRuntime, ...declaredDev, ...declaredOptional]);
  // bin-name → package map. Built ONCE here so the
  // `package-json-scripts-and-allowlist` and `script-files-bin-invocations`
  // rules share the cache — each pass would otherwise re-read every
  // dep's `node_modules/<dep>/package.json`.
  // node_modules is hoisted to the project root by every workspace
  // manager cartograph supports (npm/bun/yarn-classic/pnpm), so this
  // root-rooted scan covers every workspace child's bin set.
  const binToPackage = buildBinToPackageMap(projectRoot, declaredDeps);

  const ctx: UsedSignalContext = {
    qb,
    projectRoot,
    packageJson: rootPackageJson,
    manifests,
    declaredDeps,
    binToPackage,
    usedSet,
  };
  for (const rule of USED_SIGNAL_RULES) {
    rule.apply(ctx);
  }

  const used = Array.from(usedSet).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const { unusedRuntime, unusedDev, unusedOptional } = computeUnusedSets({
    declaredRuntime,
    declaredDev,
    declaredOptional,
    usedSet,
  });

  // `undeclared` derivation runs the suppression registry over each
  // candidate. Any rule returning `shouldSuppress: true` drops the
  // candidate. See `UNDECLARED_SUPPRESSION_RULES` for the catalogue.
  const typedUpstreams = new Set([...declaredDeps].filter((p) => p.startsWith('@types/')).map(extractTypesUpstream));
  const shimmedSpecifiers = collectRuntimeShimmedSpecifiers(projectRoot, manifests);
  const suppressCtx: UndeclaredSuppressionContext = {
    projectRoot,
    packageJson: rootPackageJson,
    typedUpstreams,
    shimmedSpecifiers,
  };
  const undeclared = used.filter((p) => {
    if (declaredDeps.has(p)) return false;
    if (!astImports.has(p)) return false;
    return !UNDECLARED_SUPPRESSION_RULES.some((rule) => rule.shouldSuppress(p, suppressCtx));
  });

  return { used, unusedRuntime, unusedDev, unusedOptional, undeclared };
}

/**
 * Discover nested package.json files under `projectRoot` (depth-capped,
 * excludes node_modules + dot-dirs). Used only when the project has no
 * root manifest — surfaces the "you might want to audit this nested
 * sub-app" hint instead of returning a terse silent no-op.
 *
 * Depth 5 covers typical monorepo + embedded-app shapes (e.g.
 * `app/ui/app/package.json`, or an `apps/<name>/package.json`).
 * Capped to keep scan time bounded on large polyglot trees.
 */
function discoverNestedManifests(projectRoot: string): string[] {
  const out: string[] = [];
  // Bun.Glob doesn't ship a built-in `!` exclude form; lean on its
  // wildcard depth handling and post-filter the matches instead.
  const glob = new Bun.Glob('**/package.json');
  for (const match of glob.scanSync({ cwd: projectRoot })) {
    if (match.includes('node_modules/')) continue;
    if (match.split('/').some((seg) => seg.startsWith('.') && seg.length > 1)) continue;
    // Depth cap (5 path segments under root, including the file itself).
    if (match.split('/').length > 5) continue;
    out.push(match);
  }
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export function analyzeUnusedDeps(qb: QueryBuilder, projectRoot: string): UnusedDepsResult {
  const { packageJson, packageJsonPath } = readPackageJson({ projectRoot });
  if (!packageJsonPath) {
    const nestedManifests = discoverNestedManifests(projectRoot);
    const result = emptyUnusedDepsResult();
    if (nestedManifests.length > 0) result.nestedManifests = nestedManifests;
    return result;
  }

  const manifests = readWorkspaceManifests(projectRoot, packageJson, packageJsonPath);
  const { declaredRuntime, declaredDev, declaredOptional } = extractDeclaredDeps({ manifests });
  const { used, unusedRuntime, unusedDev, unusedOptional, undeclared } = computeDepAnalysis({
    qb,
    projectRoot,
    manifests,
    declaredRuntime,
    declaredDev,
    declaredOptional,
  });
  return {
    declaredRuntime,
    declaredDev,
    declaredOptional,
    used,
    unusedRuntime,
    unusedDev,
    unusedOptional,
    undeclared,
    packageJsonPath,
    workspaceManifestPaths: manifests.map((m) => m.packageJsonPath),
  };
}

function extractPackageName(spec: string): string | null {
  if (spec.startsWith('@')) {
    // Scoped: @scope/pkg or @scope/pkg/sub/path
    const parts = spec.split('/');
    if (parts.length >= 2) {
      return `${parts[0]}/${parts[1]}`;
    }
    return null;
  }
  // Unscoped: lodash or lodash/debounce
  const parts = spec.split('/');
  return parts[0] ?? null;
}

function extractTypesUpstream(typesPackage: string): string {
  // @types/foo → foo
  // @types/scope__pkg → @scope/pkg
  if (!typesPackage.startsWith('@types/')) {
    return typesPackage;
  }

  const name = typesPackage.slice(7); // Remove "@types/"
  // Replace __ with / for scoped packages
  const result = name.replace(/__/g, '/');
  // If result contains /, it was a scoped package; prepend @
  if (result.includes('/')) {
    return `@${result}`;
  }
  return result;
}

function tokenizeScript(script: string): string[] {
  // Split by shell metacharacters and whitespace
  const tokens = script.split(/[\s|;&'"<>()=]+/);
  return tokens.filter((t) => t.length > 0);
}

/** Read one dep's `bin` field from its package.json and emit
 *  bin-name → package-name pairs into `out`. Extracted to flatten the
 *  per-dep nested-conditional in `buildBinToPackageMap`. */
function recordBinForDep(out: Map<string, string>, nodeModulesDir: string, depName: string): void {
  const depPackageJsonPath = join(nodeModulesDir, depName, 'package.json');
  if (!existsSync(depPackageJsonPath)) return;

  let depPackageJson: { bin?: string | Record<string, string> };
  try {
    depPackageJson = JSON.parse(readFileSync(depPackageJsonPath, 'utf-8'));
  } catch {
    return; // Ignore errors reading dep's package.json.
  }

  const bin = depPackageJson.bin;
  if (typeof bin === 'string') {
    // Single executable: the package name is its bin name.
    out.set(depName, depName);
    return;
  }
  if (typeof bin === 'object' && bin !== null) {
    // Multi-bin map: each key is a bin name routed to this package.
    for (const binName of Object.keys(bin)) out.set(binName, depName);
  }
}

function buildBinToPackageMap(projectRoot: string, declaredDeps: Set<string>): Map<string, string> {
  const binToPackage = new Map<string, string>();
  const nodeModulesDir = join(projectRoot, 'node_modules');
  if (!existsSync(nodeModulesDir)) return binToPackage;
  for (const depName of declaredDeps) recordBinForDep(binToPackage, nodeModulesDir, depName);
  return binToPackage;
}
