/**
 * Default project configuration.
 *
 * Lives in its own file (separate from `types.ts`) because the
 * `include` glob list is derived from the language registry — and
 * the registry transitively imports `types.ts` via per-language
 * files, which would create an evaluation cycle if `default-config`
 * were itself imported by `types.ts` eagerly.
 *
 * **Lazy include resolution.** The `include` array is built on
 * first access via a property getter, not at module load. By the
 * time anything reads `DEFAULT_CONFIG.include`, the registry has
 * fully evaluated, so all language definitions are available.
 */

import type { CartographConfig } from './types.js';
import { getLanguageDefs } from './extraction/languages/registry.js';

let _includeCache: string[] | null = null;
export const MAX_INDEX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_INDEX_FILE_SIZE_LABEL = '10mb';

function buildIncludeGlobs(): string[] {
  if (_includeCache) return _includeCache;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const def of getLanguageDefs()) {
    for (const glob of def.includeGlobs) {
      if (seen.has(glob)) continue;
      seen.add(glob);
      out.push(glob);
    }
  }
  _includeCache = out;
  return out;
}

const baseConfig: CartographConfig = {
  version: 1,
  rootDir: '.',
  include: [], // populated lazily via the getter below
  exclude: [
    // Version control
    '**/.git/**',

    // Dependencies
    '**/node_modules/**',
    '**/vendor/**',
    '**/Pods/**',

    // Generic build outputs.
    //
    // NOTE: a bare `**/bin/**` was previously listed here because Java
    // and .NET projects emit compiled output to a `bin/` directory.
    // That convention conflicts with npm/Node projects, where `bin/`
    // (or `src/bin/`) is the canonical home for CLI entry sources. On
    // those projects the broad pattern silently dropped the entire CLI
    // surface from the index, breaking cross-file caller discovery
    // for anything called from a CLI subcommand `.action(...)`. We
    // now anchor the pattern to the project root so only top-level
    // `bin/` (the typical Java/.NET layout) is excluded; `src/bin/`
    // and `packages/<x>/bin/` remain indexed.
    '**/dist/**',
    '**/build/**',
    '**/out/**',
    'bin/**',
    '**/obj/**',
    '**/target/**',

    // JavaScript/TypeScript
    '**/*.min.js',
    '**/*.bundle.js',
    '**/.next/**',
    '**/.nuxt/**',
    '**/.svelte-kit/**',
    '**/.output/**',
    '**/.turbo/**',
    '**/.cache/**',
    '**/.parcel-cache/**',
    '**/.vite/**',
    '**/.astro/**',
    '**/.docusaurus/**',
    '**/.gatsby/**',
    '**/.webpack/**',
    '**/.nx/**',
    '**/.yarn/cache/**',
    '**/.pnpm-store/**',
    '**/storybook-static/**',

    // React Native / Expo
    '**/.expo/**',
    '**/web-build/**',
    '**/ios/Pods/**',
    '**/ios/build/**',
    '**/android/build/**',
    '**/android/.gradle/**',

    // Python
    '**/__pycache__/**',
    '**/.venv/**',
    '**/venv/**',
    '**/site-packages/**',
    '**/dist-packages/**',
    '**/.pytest_cache/**',
    '**/.mypy_cache/**',
    '**/.ruff_cache/**',
    '**/.tox/**',
    '**/.nox/**',
    '**/*.egg-info/**',
    '**/.eggs/**',

    // Go
    '**/go/pkg/mod/**',

    // Rust
    '**/target/debug/**',
    '**/target/release/**',

    // Java/Kotlin/Gradle
    '**/.gradle/**',
    '**/.m2/**',
    '**/generated-sources/**',
    '**/.kotlin/**',

    // Dart/Flutter
    '**/.dart_tool/**',

    // C#/.NET
    '**/.vs/**',
    '**/.nuget/**',
    '**/artifacts/**',
    '**/publish/**',

    // C/C++
    '**/cmake-build-*/**',
    '**/CMakeFiles/**',
    '**/bazel-*/**',
    '**/vcpkg_installed/**',
    '**/.conan/**',
    '**/Debug/**',
    '**/Release/**',
    '**/x64/**',
    '**/.pio/**', // Platform.io (IoT/embedded build artifacts and library deps)

    // Electron
    '**/release/**',
    '**/*.app/**',
    '**/*.asar',

    // Swift/iOS/Xcode
    '**/DerivedData/**',
    '**/.build/**',
    '**/.swiftpm/**',
    '**/xcuserdata/**',
    '**/Carthage/Build/**',
    '**/SourcePackages/**',

    // Delphi/Pascal
    '**/__history/**',
    '**/__recovery/**',
    '**/*.dcu',

    // PHP
    '**/.composer/**',
    '**/storage/framework/**',
    '**/bootstrap/cache/**',

    // Ruby
    '**/.bundle/**',
    '**/tmp/cache/**',
    '**/public/assets/**',
    '**/public/packs/**',
    '**/.yardoc/**',

    // Testing/Coverage — root-relative to avoid catching legitimate
    // source dirs like `src/coverage/` or `packages/foo/coverage` that
    // happen to share the name. Users with monorepo coverage reports
    // can add `**/coverage/**` to their project's exclude list.
    'coverage/**',
    'htmlcov/**',
    '.nyc_output/**',
    'test-results/**',
    '.coverage/**',

    // Test fixtures / snapshots / baselines — checked into git but not
    // source code. These are frozen expected-output files the test suite
    // diffs against; indexing them floods the graph with thousands of
    // phantom nodes (e.g. microsoft/TypeScript ships 13 806 baseline JS
    // files under tests/baselines/reference/ — nearly all of the 38 574
    // non-source files pulled in on a fresh index). Each pattern below
    // is deliberately narrow — bare `**/baselines/**` is intentionally
    // omitted because some benchmarking libraries use that name for real
    // source. See the `bin/**` note above for why over-broad patterns
    // are a footgun.
    '**/__snapshots__/**', // Jest inline snapshots (toMatchSnapshot)
    '**/__image_snapshots__/**', // jest-image-snapshot pixel-diff baselines
    '**/*.snap', // bare .snap files outside __snapshots__/
    '**/cassettes/**', // VCR/Betamax HTTP fixture recordings
    '**/tests/baselines/reference/**', // TypeScript compiler expected output (microsoft/TypeScript)
    '**/tests/fixtures/baselines/**', // generic "tests/fixtures/baselines" convention

    // IDE/Editor
    '**/.idea/**',

    // Logs and temp
    '**/logs/**',
    '**/tmp/**',
    '**/temp/**',

    // Documentation build output
    '**/_build/**',
    '**/docs/_build/**',
    '**/site/**',

    // Generated code — codegen output that lands INSIDE source trees,
    // so the directory globs above don't catch it. Restricted to
    // suffixes that are unambiguously generated (no hand-written file
    // would collide) — see the `bin/**` note above for why an
    // over-broad exclude glob is a footgun.
    '**/*.pb.go', // protobuf — Go
    '**/*_pb2.py', // protobuf — Python
    '**/*_pb2_grpc.py', // protobuf — Python gRPC
    '**/*.pb.cc', // protobuf — C++
    '**/*.pb.h', // protobuf — C++
    '**/*_pb.js', // protobuf — JavaScript
    '**/*.generated.ts', // ".generated." — an explicit codegen marker
    '**/*.generated.js',
    '**/*.g.dart', // Dart build_runner (json_serializable, …)
    '**/*.freezed.dart', // Dart freezed
  ],
  languages: [],
  frameworks: [],
  // 5 MB default, capped at 10 MB by config/CLI/API validation. Was
  // 1 MB until 2026-05-01, when the GraphQL stress test
  // (github's public schema is 1.4 MB) hit a silent skip. Real-world
  // generated SDL, vendored bundles, and large data fixtures routinely
  // sit between 1 and 5 MB; raising the cap closes the silent footgun
  // without exposing us to the truly-pathological multi-MB minified
  // outputs that warrant exclusion.
  maxFileSize: 5 * 1024 * 1024,
  extractDocstrings: true,
  trackCallSites: true,
  enableCentrality: true,
  // G23: opt-in. Brandes betweenness adds tens of seconds on
  // TS-scale even with the worker pool; users who want the
  // structural-bridge signal flip this on per-project.
  enableBetweenness: false,
  enableChurn: true,
  enableIssueHistory: true,
  enableConfigRefs: true,
  enableSqlRefs: true,
  enableBuildContextRefs: true,
  enableStringImports: true,
  indexSubmodules: true,
  indexEmbeddedRepos: true,
  enableCoChange: true,
  // F#12 slice 1: per-file mode threshold for nested-function extraction.
  // Files whose largest function body fits under this LOC get eager
  // nested-fn extraction; mega-files (above the threshold) defer to
  // slice 2's manifest mode and are left with current behaviour.
  largeFunctionThreshold: 500,
  // F#12 slice 3: how many `cartograph_node({deep:true})` calls a
  // manifest-mode nested fn must accumulate before it's auto-promoted
  // to a real graph node on the next sync. Pareto-aligned at 5 —
  // empirically <5% of nested fns on `checker.ts` ever cross.
  nestedPromotionThreshold: 5,
};

Object.defineProperty(baseConfig, 'include', {
  get: () => buildIncludeGlobs(),
  enumerable: true,
  configurable: true,
});

export const DEFAULT_CONFIG: CartographConfig = baseConfig;
