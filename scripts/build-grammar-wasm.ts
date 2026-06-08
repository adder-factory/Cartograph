/**
 * scripts/build-grammar-wasm.ts — the grammar `.wasm` (re)build tool.
 *
 * Produces a web-tree-sitter 0.26.x-compatible `.wasm` for every grammar
 * cartograph supports, into `src/extraction/wasm/`. Originally written
 * for Phase 1 of the web-tree-sitter migration; kept as the maintenance
 * tool for regenerating a grammar after an upstream update.
 *
 * Strategy per grammar:
 *   1. HARVEST — if the npm grammar package ships a `.wasm` AND it
 *      load-tests clean in web-tree-sitter, copy it (fast path).
 *   2. BUILD   — otherwise `tree-sitter build --wasm` from the package's
 *      grammar source. The 0.26 CLI uses wasi-sdk and auto-downloads it.
 *   Every output is load-tested in web-tree-sitter before it is kept.
 *
 * Prerequisites:
 *   - web-tree-sitter   — the load-test runtime (a runtime dependency)
 *   - tree-sitter-cli   — the `tree-sitter build --wasm` toolchain
 *                         (a devDependency)
 *   - the grammar source packages must be installed under node_modules.
 *     As of the web-tree-sitter migration (Phase 3) NO grammar npm
 *     packages are declared in package.json — `tree-sitter build
 *     --wasm` only needs each grammar's `src/parser.c` (+ `scanner.c`)
 *     from its source package. Install the ones you want to (re)build
 *     transiently with `npm install --no-save <pkg>`; this script
 *     prints the exact command for any it cannot resolve. The
 *     `.wasm` build path is C-toolchain only — it does NOT need the
 *     native node-gyp binding, so no binding patch is required.
 *
 * Run:  bun scripts/build-grammar-wasm.ts [--only=<wasm>] [--force-build]
 *
 * DRAFT — Phase 1 starting point. Package names / subdirs below should
 * be cross-checked against `grammar.npmPackage` in
 * `src/extraction/languages/*.ts`; per-grammar build quirks may need
 * tweaks on first run.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(REPO_ROOT, 'src', 'extraction', 'wasm');
/** Vendored `tags.scm` files for `TagsQueryExtractor`-backed languages. */
const TAGS_DIR = path.join(REPO_ROOT, 'src', 'extraction', 'tags');

/** One grammar to produce a `.wasm` for. */
interface Grammar {
  /** Output name → `src/extraction/wasm/<wasm>.wasm`. */
  wasm: string;
  /** npm package carrying the grammar source (and maybe a bundled `.wasm`). */
  pkg: string;
  /** Sub-directory inside the package holding `grammar.js` + `src/`
   *  (only for packages that ship more than one grammar). */
  subdir?: string;
  /** Minimal snippet in the language, for the post-build load-test. */
  sample: string;
  /** True for the 5 grammars (dart / fish / graphql / pascal / rescript)
   *  whose source package was historically hard to obtain. As of the
   *  web-tree-sitter migration NO grammar package is in package.json —
   *  every entry's source must be installed transiently to rebuild it —
   *  so this flag now only tunes the "package not installed" hint. */
  vendored?: boolean;
  /** Harvest the package's `queries/tags.scm` into
   *  `src/extraction/tags/<wasm>.scm`. Set for languages onboarded via
   *  the generic `TagsQueryExtractor` (`src/extraction/tags-query-extractor.ts`)
   *  rather than a hand-written extractor. A flagged grammar that ships
   *  no `tags.scm` is a build failure. */
  tagsScm?: boolean;
}

/**
 * Grammar `.wasm` files cartograph ships (the original set commit 2442417
 * deleted from `src/extraction/wasm/` when it swapped WASM→native, plus
 * later language-slice additions).
 */
const GRAMMARS: Grammar[] = [
  { wasm: 'apex', pkg: 'tree-sitter-sfapex', subdir: 'apex', sample: 'public class A {}\n', vendored: true },
  { wasm: 'typescript', pkg: 'tree-sitter-typescript', subdir: 'typescript', sample: 'const x: number = 1;' },
  { wasm: 'tsx', pkg: 'tree-sitter-typescript', subdir: 'tsx', sample: 'const x = <div/>;' },
  { wasm: 'javascript', pkg: 'tree-sitter-javascript', sample: 'const x = 1;' },
  { wasm: 'python', pkg: 'tree-sitter-python', sample: 'x = 1\n' },
  { wasm: 'go', pkg: 'tree-sitter-go', sample: 'package main\n' },
  { wasm: 'rust', pkg: 'tree-sitter-rust', sample: 'fn main() {}\n' },
  { wasm: 'java', pkg: 'tree-sitter-java', sample: 'class A {}\n' },
  { wasm: 'c', pkg: 'tree-sitter-c', sample: 'int main(){return 0;}\n' },
  { wasm: 'cpp', pkg: 'tree-sitter-cpp', sample: 'int main(){return 0;}\n' },
  { wasm: 'css', pkg: 'tree-sitter-css', sample: '.a { color: red; }\n' },
  { wasm: 'ruby', pkg: 'tree-sitter-ruby', sample: 'x = 1\n' },
  { wasm: 'bash', pkg: 'tree-sitter-bash', sample: 'x=1\n' },
  { wasm: 'php', pkg: 'tree-sitter-php', subdir: 'php', sample: '<?php $x = 1;' },
  { wasm: 'c_sharp', pkg: 'tree-sitter-c-sharp', sample: 'class A {}\n' },
  { wasm: 'kotlin', pkg: 'tree-sitter-kotlin', sample: 'fun main() {}\n' },
  { wasm: 'scala', pkg: 'tree-sitter-scala', sample: 'object A\n' },
  { wasm: 'swift', pkg: 'tree-sitter-swift', sample: 'let x = 1\n' },
  { wasm: 'embedded_template', pkg: 'tree-sitter-embedded-template', sample: '<%= user.name %>\n' },
  { wasm: 'haskell', pkg: 'tree-sitter-haskell', sample: 'module M where\nx = 1\n' },
  { wasm: 'html', pkg: 'tree-sitter-html', sample: '<main><h1>Hello</h1></main>\n' },
  { wasm: 'hcl', pkg: '@tree-sitter-grammars/tree-sitter-hcl', sample: 'x = 1\n' },
  { wasm: 'jsdoc', pkg: 'tree-sitter-jsdoc', sample: '/** Adds one. */\n' },
  { wasm: 'json', pkg: 'tree-sitter-json', sample: '{ "x": 1 }\n' },
  { wasm: 'julia', pkg: 'tree-sitter-julia', sample: 'module M\nx = 1\nend\n' },
  { wasm: 'lua', pkg: '@tree-sitter-grammars/tree-sitter-lua', sample: 'local x = 1\n' },
  {
    wasm: 'luau',
    pkg: 'tree-sitter-luau',
    sample: 'export type User = { name: string }\nfunction greet(name: string): string\n  return name\nend\n',
    vendored: true,
  },
  { wasm: 'sql', pkg: '@derekstride/tree-sitter-sql', sample: 'SELECT 1;\n' },
  { wasm: 'solidity', pkg: 'tree-sitter-solidity', sample: 'contract A { function run() public {} }\n' },
  { wasm: 'r', pkg: '@davisvaughan/tree-sitter-r', sample: 'x <- 1\n' },
  { wasm: 'ocaml', pkg: 'tree-sitter-ocaml', sample: 'let x = 1\n', tagsScm: true },
  { wasm: 'ocaml_interface', pkg: 'tree-sitter-ocaml', sample: 'val x : int\n', tagsScm: true },
  { wasm: 'prisma', pkg: 'tree-sitter-prisma', sample: 'model A {\n  id Int @id\n}\n' },
  { wasm: 'regex', pkg: 'tree-sitter-regex', sample: '^[a-z]+$\n' },
  { wasm: 'verilog', pkg: 'tree-sitter-verilog', sample: 'module top; endmodule\n' },
  // ── currently vendored — source packages not in package.json ──────
  // dart: `tree-sitter-dart@1.0.0` ships a BUNDLED `tree-sitter-dart.wasm`
  // that is NOT web-tree-sitter-loadable (malformed dylink metadata —
  // its `Language.load` throws a bare empty Error). MUST be built from
  // source — `--force-build` skips the broken harvest. `tree-sitter
  // build --wasm` from the package's `src/parser.c` + `src/scanner.c`
  // produces a clean ABI-14 grammar.
  { wasm: 'dart', pkg: 'tree-sitter-dart', sample: 'void main() {}\n', vendored: true },
  { wasm: 'fish', pkg: '@esdmr/tree-sitter-fish', sample: 'set x 1\n', vendored: true },
  { wasm: 'glsl', pkg: 'tree-sitter-glsl', sample: 'void main() { gl_Position = vec4(1.0); }\n', vendored: true },
  { wasm: 'groovy', pkg: 'tree-sitter-groovy', sample: 'class A { def run() { helper() } }\n', vendored: true },
  // graphql: ⚠ `tree-sitter-graphql@1.0.0` on npm is a DIFFERENT grammar
  // dialect — it emits PascalCase node types (`Document`, `ObjectType-
  // Definition`, `Name`, …). cartograph's `GraphqlExtractor` is written
  // against the lowercase-node-type grammar (`document`, `object_type_-
  // definition`, `name`, …). The shipped `graphql.wasm` is the
  // pre-native-swap artifact (recoverable: `git show
  // 2442417^:src/extraction/wasm/tree-sitter-graphql.wasm`), which loads
  // clean in web-tree-sitter 0.26.8. Do NOT regenerate graphql.wasm from
  // this npm package — the load-test passes but extraction silently
  // yields nothing. Sourcing a buildable lowercase-dialect graphql
  // grammar is a tracked follow-up.
  { wasm: 'graphql', pkg: 'tree-sitter-graphql', sample: 'type Q { a: Int }\n', vendored: true },
  { wasm: 'pascal', pkg: 'tree-sitter-pascal', sample: 'begin end.\n', vendored: true },
  { wasm: 'rescript', pkg: 'tree-sitter-rescript', sample: 'let x = 1\n', vendored: true },
  // elixir: onboarded 2026-05-17 via the tags.scm fallback extractor —
  // the new-language onramp's first validation language. The
  // `tree-sitter-elixir` npm package ships grammar source + a
  // `queries/tags.scm`; build from source and harvest the query.
  { wasm: 'elixir', pkg: 'tree-sitter-elixir', sample: 'defmodule M do\nend\n', vendored: true, tagsScm: true },
];
// Package names above are verified against `grammar.npmPackage` in
// `src/extraction/languages/*.ts` (2026-05-17).
//
// Intentionally NOT in this list: `zsh` (reuses bash.wasm at runtime),
// `jsx` (reuses javascript.wasm); `svelte` / `liquid` use custom
// extractors and have no tree-sitter grammar. Don't add entries for them.

// ── CLI flags ───────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const only = argv.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const forceBuild = argv.includes('--force-build');

// ── helpers ─────────────────────────────────────────────────────────

/** Absolute dir of an installed npm package, or null when not installed.
 *  Uses the node_modules path directly — `require.resolve(pkg +
 *  '/package.json')` throws on packages with a restrictive `exports`
 *  map, and grammar packages are all top-level (hoisted) deps. */
function resolvePackageDir(pkg: string): string | null {
  const dir = path.join(REPO_ROOT, 'node_modules', ...pkg.split('/'));
  return fs.existsSync(dir) ? dir : null;
}

/** A `.wasm` bundled in the package whose name matches the grammar, or null. */
function findBundledWasm(pkgDir: string, g: Grammar): string | null {
  const norm = (s: string) => s.replaceAll(/[-_]/g, '').toLowerCase();
  const want = norm(g.wasm);
  // Scan the package root AND (when set) the grammar subdir — packages
  // vary on where they place a bundled `.wasm`.
  const dirs = g.subdir ? [pkgDir, path.join(pkgDir, g.subdir)] : [pkgDir];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = fs.readdirSync(dir).filter((f) => f.endsWith('.wasm'));
    } catch {
      continue;
    }
    if (entries.length === 0) continue;
    const hit =
      // Prefer a name match; for a single-grammar package fall back to
      // its sole `.wasm`. A subdir grammar always requires a name match
      // (the package ships several — don't blind-pick).
      entries.find((f) => norm(path.basename(f, '.wasm')).endsWith(want)) ??
      (entries.length === 1 && !g.subdir ? entries[0] : undefined);
    if (hit) return path.join(dir, hit);
  }
  return null;
}

/** `tree-sitter build --wasm` from the grammar source dir → `outPath`. */
function buildWasm(treeSitterBin: string, grammarDir: string, outPath: string): void {
  // cwd MUST be the grammar dir so relative scanner includes (e.g.
  // tree-sitter-typescript's `../../common/scanner.h`) resolve. The
  // `--output` flag (tree-sitter-cli >= 0.24; the migration pins
  // 0.26.x) redirects the artifact off the default cwd location.
  execFileSync(treeSitterBin, ['build', '--wasm', '--output', outPath, '.'], {
    cwd: grammarDir,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
}

/**
 * Regenerate `src/parser.c` from `grammar.js` with the current CLI —
 * the REPAIR step for a grammar whose shipped `parser.c` is a stale
 * parse table that builds cleanly yet traps at runtime in
 * web-tree-sitter (observed: tree-sitter-graphql, "memory access out
 * of bounds"). Used ONLY as a fallback, so a grammar that ships a
 * working `parser.c` keeps the maintainer's exact grammar + ABI rather
 * than being silently regenerated (which, for a grammar with no
 * `tree-sitter.json`, would downgrade ABI 15 → 14). Returns false when
 * there is no `grammar.js` or `generate` fails — caller keeps the
 * shipped `parser.c`.
 */
function regenerateGrammar(treeSitterBin: string, grammarDir: string): boolean {
  if (!fs.existsSync(path.join(grammarDir, 'grammar.js'))) return false;
  try {
    execFileSync(treeSitterBin, ['generate'], {
      cwd: grammarDir,
      stdio: ['ignore', 'ignore', 'inherit'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Harvest a grammar package's `queries/tags.scm` into the vendored
 * `src/extraction/tags/<wasm>.scm`. tree-sitter grammars ship this
 * query at `queries/tags.scm` under either the package root or the
 * grammar subdir. Returns null on success, else a reason string.
 */
function harvestTagsScm(g: Grammar, pkgDir: string, grammarDir: string): string | null {
  const candidates = [path.join(grammarDir, 'queries', 'tags.scm'), path.join(pkgDir, 'queries', 'tags.scm')];
  const src = candidates.find((p) => fs.existsSync(p));
  if (!src) return `no queries/tags.scm shipped in '${g.pkg}'`;
  fs.mkdirSync(TAGS_DIR, { recursive: true });
  fs.copyFileSync(src, path.join(TAGS_DIR, `${g.wasm}.scm`));
  return null;
}

/**
 * Run {@link harvestTagsScm} for a `tagsScm`-flagged grammar after its
 * `.wasm` is produced; record success/failure into the shared lists.
 * No-op for grammars not flagged for the tags-query extractor path.
 */
function maybeHarvestTags(
  g: Grammar,
  pkgDir: string,
  grammarDir: string,
  tagsHarvested: string[],
  failed: Array<{ wasm: string; reason: string }>,
): void {
  if (!g.tagsScm) return;
  const reason = harvestTagsScm(g, pkgDir, grammarDir);
  if (reason) {
    failed.push({ wasm: `${g.wasm} (tags.scm)`, reason });
  } else {
    tagsHarvested.push(g.wasm);
    console.log(`  tags.scm   ${g.wasm.padEnd(12)} → ${path.relative(REPO_ROOT, TAGS_DIR)}/${g.wasm}.scm`);
  }
}

// web-tree-sitter + ONE reused Parser, initialised lazily on the first
// load-test. The Parser is reused across all grammars — a fresh
// `new Parser()` per call would leak its WASM heap allocation.
let wts: typeof import('web-tree-sitter') | null = null;
let wtsParser: import('web-tree-sitter').Parser | null = null;
async function loadTest(wasmPath: string, sample: string): Promise<string | null> {
  if (!wts) {
    wts = await import('web-tree-sitter');
    await wts.Parser.init();
    wtsParser = new wts.Parser();
  }
  try {
    const lang = await wts.Language.load(fs.readFileSync(wasmPath));
    wtsParser!.setLanguage(lang);
    const tree = wtsParser!.parse(sample);
    if (!tree?.rootNode) return 'parse returned no tree';
    const rootType = tree.rootNode.type;
    tree.delete();
    return rootType ? null : 'empty root node';
  } catch (err) {
    // MUST return a NON-EMPTY string on any failure. web-tree-sitter's
    // dynamic-linking loader throws bare `Error`s with an empty
    // `message` for an ABI-incompatible / malformed `.wasm`; an empty
    // return would be falsy and the harvest branch's `if (!err)` would
    // false-pass the broken grammar (this bit dart.wasm in Phase 1).
    if (err instanceof Error) {
      return (
        err.message.split('\n')[0] ||
        err.name ||
        'Language.load threw an empty error (likely ABI-incompatible or malformed .wasm)'
      );
    }
    return String(err) || 'unknown load-test failure';
  }
}

interface BuildGrammarState {
  harvested: string[];
  built: string[];
  tagsHarvested: string[];
  failed: Array<{ wasm: string; reason: string }>;
  missingPkgs: string[];
}

async function tryHarvestBundledWasm(
  g: Grammar,
  pkgDir: string,
  grammarDir: string,
  outPath: string,
  state: BuildGrammarState,
): Promise<boolean> {
  const bundled = findBundledWasm(pkgDir, g);
  if (!bundled) return false;
  const err = await loadTest(bundled, g.sample);
  if (err) {
    console.log(`  (bundled ${g.wasm} rejected: ${err} — building from source)`);
    return false;
  }
  fs.copyFileSync(bundled, outPath);
  state.harvested.push(g.wasm);
  console.log(`  harvested  ${g.wasm.padEnd(12)} ← ${path.relative(REPO_ROOT, bundled)}`);
  maybeHarvestTags(g, pkgDir, grammarDir, state.tagsHarvested, state.failed);
  return true;
}

async function buildTargetWasm(
  g: Grammar,
  treeSitterBin: string,
  grammarDir: string,
  outPath: string,
  failed: Array<{ wasm: string; reason: string }>,
): Promise<boolean | null> {
  let outcome: string | null;
  try {
    buildWasm(treeSitterBin, grammarDir, outPath);
    outcome = await loadTest(outPath, g.sample);
  } catch (err) {
    outcome = `build failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`;
  }

  let repaired = false;
  if (outcome && regenerateGrammar(treeSitterBin, grammarDir)) {
    try {
      buildWasm(treeSitterBin, grammarDir, outPath);
      outcome = await loadTest(outPath, g.sample);
      repaired = outcome === null;
    } catch (err) {
      outcome = `rebuild failed: ${err instanceof Error ? err.message.split('\n')[0] : err}`;
    }
  }

  if (!outcome) return repaired;
  fs.rmSync(outPath, { force: true });
  failed.push({ wasm: g.wasm, reason: outcome });
  return null;
}

async function processGrammarTarget(g: Grammar, treeSitterBin: string, state: BuildGrammarState): Promise<void> {
  const pkgDir = resolvePackageDir(g.pkg);
  if (!pkgDir) {
    state.missingPkgs.push(g.pkg);
    state.failed.push({ wasm: g.wasm, reason: `source package '${g.pkg}' not installed` });
    return;
  }

  const grammarDir = g.subdir ? path.join(pkgDir, g.subdir) : pkgDir;
  const outPath = path.join(OUT_DIR, `${g.wasm}.wasm`);
  if (!forceBuild && (await tryHarvestBundledWasm(g, pkgDir, grammarDir, outPath, state))) return;

  const repaired = await buildTargetWasm(g, treeSitterBin, grammarDir, outPath, state.failed);
  if (repaired === null) return;

  state.built.push(g.wasm);
  console.log(
    `  built      ${g.wasm.padEnd(12)} ← tree-sitter build --wasm${repaired ? ' (regenerated — shipped parser.c was broken)' : ''}`,
  );
  maybeHarvestTags(g, pkgDir, grammarDir, state.tagsHarvested, state.failed);
}

// ── main ────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const treeSitterBin = path.join(REPO_ROOT, 'node_modules', '.bin', 'tree-sitter');
  if (!fs.existsSync(treeSitterBin)) {
    console.error('✗ tree-sitter-cli not found — add it as a devDependency:\n  npm i -D tree-sitter-cli');
    process.exit(1);
  }

  const targets = only ? GRAMMARS.filter((g) => g.wasm === only) : GRAMMARS;
  if (only && targets.length === 0) {
    console.error(`✗ --only='${only}' matched no grammar`);
    process.exit(1);
  }

  const state: BuildGrammarState = {
    harvested: [],
    built: [],
    tagsHarvested: [],
    failed: [],
    missingPkgs: [],
  };

  for (const g of targets) {
    await processGrammarTarget(g, treeSitterBin, state);
  }

  // ── summary ───────────────────────────────────────────────────────
  console.log(
    `\n${state.harvested.length} harvested · ${state.built.length} built · ${state.failed.length} failed` +
      `  →  ${path.relative(REPO_ROOT, OUT_DIR)}/`,
  );
  if (state.tagsHarvested.length > 0) {
    console.log(`${state.tagsHarvested.length} tags.scm harvested  →  ${path.relative(REPO_ROOT, TAGS_DIR)}/`);
  }
  if (state.missingPkgs.length > 0) {
    console.log(
      `\nInstall missing source packages, then re-run:\n  npm i -D ${[...new Set(state.missingPkgs)].join(' ')}`,
    );
  }
  if (state.failed.length > 0) {
    console.log('\nFailures:');
    for (const f of state.failed) console.log(`  ✗ ${f.wasm}: ${f.reason}`);
    process.exit(1);
  }
  console.log('✓ all grammars produced and load-tested clean in web-tree-sitter');
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
