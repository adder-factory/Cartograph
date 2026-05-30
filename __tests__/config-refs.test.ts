/**
 * Config-refs tests: parser unit tests + end-to-end through Cartograph.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getConfigKeys, getConfigKeysForNode, getConfigRefsByKey } from '../src/db/queries-refs.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  extractConfigRefs,
  CONFIG_REFS_ALGO_VERSION,
  LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY,
} from '../src/config-refs/index.js';
import { getMetadata, setMetadata } from '../src/db/queries-metadata.js';
import Cartograph from '../src/index.js';

let testDir: string;
let cg: Cartograph | null = null;

function write(rel: string, content: string) {
  const abs = path.join(testDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-config-'));
});

afterEach(() => {
  if (cg) {
    cg.destroy();
    cg = null;
  }
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Pure parser tests (no Cartograph)
// ============================================================================

describe('extractConfigRefs', () => {
  it('extracts process.env.X from TS', () => {
    write('a.ts', `const port = process.env.OBSIDIAN_PORT;\n`);
    const refs = extractConfigRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs.length).toBe(1);
    expect(refs[0]!.configKey).toBe('OBSIDIAN_PORT');
    expect(refs[0]!.line).toBe(1);
  });

  it('extracts process.env["X"] from JS', () => {
    write('a.js', `module.exports = { port: process.env["MY_KEY"] };\n`);
    const refs = extractConfigRefs(testDir, [{ path: 'a.js', language: 'javascript' }], () => null);
    expect(refs.map((r) => r.configKey)).toEqual(['MY_KEY']);
  });

  it('extracts os.getenv / os.environ from Python', () => {
    write(
      'a.py',
      [
        `import os`,
        `port = os.getenv("PYTHON_PORT")`,
        `host = os.environ.get("PYTHON_HOST")`,
        `path = os.environ["PYTHON_PATH"]`,
        `name = getenv("PYTHON_NAME")`,
      ].join('\n'),
    );
    const refs = extractConfigRefs(testDir, [{ path: 'a.py', language: 'python' }], () => null);
    expect(new Set(refs.map((r) => r.configKey))).toEqual(
      new Set(['PYTHON_PORT', 'PYTHON_HOST', 'PYTHON_PATH', 'PYTHON_NAME']),
    );
  });

  it('does not double-count os.getenv() (bare-getenv pattern must not re-match)', () => {
    // `os.getenv("X")` used to match BOTH the `os.getenv` pattern and
    // the bare-`getenv` pattern (the `\b` boundary fires after the `.`),
    // recording the read twice. The `(?<!\.)` guard fixes it.
    write(
      'a.py',
      [`import os`, `from os import getenv`, `a = os.getenv("DOTTED_KEY")`, `b = getenv("BARE_KEY")`].join('\n'),
    );
    const refs = extractConfigRefs(testDir, [{ path: 'a.py', language: 'python' }], () => null);
    // Exactly one ref per call site — no duplicates.
    expect(refs.map((r) => r.configKey).sort()).toEqual(['BARE_KEY', 'DOTTED_KEY']);
  });

  it('extracts os.Getenv / os.LookupEnv from Go', () => {
    write(
      'a.go',
      [`package main`, `import "os"`, `var Port = os.Getenv("GO_PORT")`, `var Host, _ = os.LookupEnv("GO_HOST")`].join(
        '\n',
      ),
    );
    const refs = extractConfigRefs(testDir, [{ path: 'a.go', language: 'go' }], () => null);
    expect(new Set(refs.map((r) => r.configKey))).toEqual(new Set(['GO_PORT', 'GO_HOST']));
  });

  it('extracts ENV[...] / ENV.fetch from Ruby', () => {
    write('a.rb', `port = ENV["RUBY_PORT"]\nhost = ENV.fetch("RUBY_HOST")\n`);
    const refs = extractConfigRefs(testDir, [{ path: 'a.rb', language: 'ruby' }], () => null);
    expect(new Set(refs.map((r) => r.configKey))).toEqual(new Set(['RUBY_PORT', 'RUBY_HOST']));
  });

  it('extracts env!/std::env::var from Rust', () => {
    write('a.rs', [`let port = env!("RUST_PORT");`, `let host = std::env::var("RUST_HOST").unwrap();`].join('\n'));
    const refs = extractConfigRefs(testDir, [{ path: 'a.rs', language: 'rust' }], () => null);
    expect(new Set(refs.map((r) => r.configKey))).toEqual(new Set(['RUST_PORT', 'RUST_HOST']));
  });

  it('extracts System.getenv from Java/Kotlin', () => {
    write('A.java', `String port = System.getenv("JAVA_PORT");\n`);
    const refs = extractConfigRefs(testDir, [{ path: 'A.java', language: 'java' }], () => null);
    expect(refs.map((r) => r.configKey)).toEqual(['JAVA_PORT']);
  });

  it('only matches UPPER_CASE keys (skips lower-case identifiers)', () => {
    write('a.ts', `const x = process.env.somethingDynamic;\nconst y = process.env.GOOD_KEY;\n`);
    const refs = extractConfigRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs.map((r) => r.configKey)).toEqual(['GOOD_KEY']);
  });

  it('skips files in unsupported languages without crashing', () => {
    write('a.swift', `let port = ProcessInfo.processInfo.environment["SWIFT_PORT"]\n`);
    const refs = extractConfigRefs(testDir, [{ path: 'a.swift', language: 'swift' }], () => null);
    // Swift not in PATTERNS for v1.
    expect(refs).toEqual([]);
  });

  it('captures the correct 1-indexed line number', () => {
    write(
      'a.ts',
      [
        `// line 1`,
        `// line 2`,
        `const x = process.env.LINE_THREE_KEY;`,
        `// line 4`,
        `const y = process.env.LINE_FIVE_KEY;`,
      ].join('\n'),
    );
    const refs = extractConfigRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([
      expect.objectContaining({ configKey: 'LINE_THREE_KEY', line: 3 }),
      expect.objectContaining({ configKey: 'LINE_FIVE_KEY', line: 5 }),
    ]);
  });

  it('threads the resolveEnclosing closure correctly', () => {
    write('a.ts', `const x = process.env.FOO;\n`);
    const calls: Array<[string, number]> = [];
    extractConfigRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], (filePath, line) => {
      calls.push([filePath, line]);
      return 'fake-node-id';
    });
    expect(calls).toEqual([['a.ts', 1]]);
  });

  it('ignores env reads inside JS/TS comments but keeps real reads', () => {
    write(
      'a.ts',
      [
        `// process.env.GHOST should NOT be recorded (line comment)`,
        `/* block comment mentioning process.env.GHOST_BLOCK */`,
        `/**`,
        ` * Doc example: process.env.GHOST_DOC`,
        ` */`,
        `const real = process.env.REALVAR;`,
      ].join('\n'),
    );
    const refs = extractConfigRefs(testDir, [{ path: 'a.ts', language: 'typescript' }], () => null);
    expect(refs.map((r) => r.configKey)).toEqual(['REALVAR']);
    expect(refs[0]!.line).toBe(6);
  });

  it('ignores env reads inside Python comments/docstrings but keeps real reads', () => {
    write(
      'a.py',
      [
        `import os`,
        `# os.getenv("GHOST_PY") should NOT be recorded`,
        `"""`,
        `Docstring example: os.getenv("GHOST_DOC")`,
        `"""`,
        `real = os.environ.get("REAL_PY")`,
      ].join('\n'),
    );
    const refs = extractConfigRefs(testDir, [{ path: 'a.py', language: 'python' }], () => null);
    expect(refs.map((r) => r.configKey)).toEqual(['REAL_PY']);
  });

  it('survives a missing file (skips, no throw)', () => {
    const refs = extractConfigRefs(testDir, [{ path: 'does-not-exist.ts', language: 'typescript' }], () => null);
    expect(refs).toEqual([]);
  });
});

// ============================================================================
// End-to-end through Cartograph
// ============================================================================

describe('Cartograph config refs', () => {
  it('persists env reads after indexAll and resolves enclosing function', async () => {
    write(
      'src/server.ts',
      [
        `export function start() {`,
        `  const port = process.env.OBSIDIAN_PORT ?? 8080;`,
        `  return port;`,
        `}`,
        ``,
        `export function getApiKey() {`,
        `  return process.env.OBSIDIAN_API_KEY;`,
        `}`,
        ``,
        `// top-level read`,
        `export const HOST = process.env.OBSIDIAN_HOST;`,
      ].join('\n'),
    );
    cg = Cartograph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [] },
    });
    await cg.indexAll();

    // All three keys should be visible.
    const keys = getConfigKeys(cg.queries, { configKind: 'env' });
    expect(keys.map((k) => k.configKey).sort()).toEqual(['OBSIDIAN_API_KEY', 'OBSIDIAN_HOST', 'OBSIDIAN_PORT']);

    // The OBSIDIAN_PORT read should be attributed to `start`.
    const portSites = getConfigRefsByKey(cg.queries, 'OBSIDIAN_PORT');
    expect(portSites.length).toBe(1);
    expect(portSites[0]!.sourceName).toBe('start');

    // The HOST read is at the top level — sourceName should be null.
    const hostSites = getConfigRefsByKey(cg.queries, 'OBSIDIAN_HOST');
    expect(hostSites[0]!.sourceName).toBeNull();
  });

  it('reverse view: getConfigKeysForNode returns keys read by a function', async () => {
    write(
      'src/a.ts',
      [
        `export function loadConfig() {`,
        `  const a = process.env.KEY_A;`,
        `  const b = process.env.KEY_B;`,
        `  return { a, b };`,
        `}`,
      ].join('\n'),
    );
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const node = cg.queries.getNodesByFile('src/a.ts').find((n) => n.name === 'loadConfig')!;
    const keys = getConfigKeysForNode(cg.queries, node.id)
      .map((r) => r.configKey)
      .sort();
    expect(keys).toEqual(['KEY_A', 'KEY_B']);
  });

  it('respects enableConfigRefs=false', async () => {
    write('src/a.ts', `export const PORT = process.env.PORT;\n`);
    cg = Cartograph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [], enableConfigRefs: false },
    });
    await cg.indexAll();
    expect(getConfigKeys(cg.queries)).toEqual([]);
  });

  it('incremental sync replaces refs for changed files only', async () => {
    write('src/a.ts', `export const A = process.env.OLD_KEY;\n`);
    write('src/b.ts', `export const B = process.env.UNCHANGED_KEY;\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(
      getConfigKeys(cg.queries)
        .map((k) => k.configKey)
        .sort(),
    ).toEqual(['OLD_KEY', 'UNCHANGED_KEY']);

    // Edit only a.ts — UNCHANGED_KEY should still be there.
    write('src/a.ts', `export const A = process.env.NEW_KEY;\n`);
    await cg.sync();

    const keys = getConfigKeys(cg.queries)
      .map((k) => k.configKey)
      .sort();
    expect(keys).toContain('NEW_KEY');
    expect(keys).toContain('UNCHANGED_KEY');
    expect(keys).not.toContain('OLD_KEY');
  });

  it('drops refs when a file is edited to remove its last env read', async () => {
    // Regression for the empty-rows early-return data-corruption bug:
    // applyConfigRefs([]) used to short-circuit without deleting the
    // stale rows for the file. The sync path now explicitly invalidates
    // rows for every changed file *before* extracting, regardless of
    // whether the new content has any reads.
    write('src/a.ts', `export const PORT = process.env.REMOVED_KEY;\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(getConfigKeys(cg.queries).some((k) => k.configKey === 'REMOVED_KEY')).toBe(true);

    // Edit a.ts to remove the env read entirely (no remaining reads).
    write('src/a.ts', `export const PORT = 8080; // no env read here\n`);
    await cg.sync();

    expect(getConfigKeys(cg.queries).some((k) => k.configKey === 'REMOVED_KEY')).toBe(false);
  });

  it('drops refs for files removed between syncs', async () => {
    write('src/a.ts', `export const A = process.env.GOING_AWAY;\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    expect(getConfigKeys(cg.queries).some((k) => k.configKey === 'GOING_AWAY')).toBe(true);

    fs.unlinkSync(path.join(testDir, 'src/a.ts'));
    await cg.sync();

    expect(getConfigKeys(cg.queries).some((k) => k.configKey === 'GOING_AWAY')).toBe(false);
  });

  // (Removed: a defensive test for the v4-migration-collision bug class.
  // With file-based migrations (NNN-name.ts), two PRs claiming the same
  // version produces a filesystem-level conflict, so the silent skip the
  // defensive guard protected against can no longer happen.)
});

// ============================================================================
// Algo-version self-heal
// ============================================================================

describe('config-refs hook algo-version self-heal', () => {
  it('forces a full re-mine of ALL files when the stored algo version is stale', async () => {
    // Two files: one will be "changed" in the sync; one will NOT be
    // in the changed-file set. The stale algo path should re-mine both.
    write('src/a.ts', `export const A = process.env.KEY_A;\n`);
    write('src/b.ts', `export const B = process.env.KEY_B;\n`);

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Confirm both keys were indexed.
    const keysBefore = getConfigKeys(cg.queries)
      .map((k) => k.configKey)
      .sort();
    expect(keysBefore).toEqual(['KEY_A', 'KEY_B']);

    // Stamp a bogus algo version — simulates a pre-fix install where the
    // old miner persisted phantom rows (e.g. FOO / X from doc-comment
    // scans) and the stored version doesn't match the current binary.
    setMetadata(cg.queries, LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY, '0');

    // Only touch src/a.ts. Without the self-heal, a naive incremental
    // sync would re-mine only a.ts; b.ts' stale rows would survive.
    write('src/a.ts', `export const A = process.env.KEY_A_NEW;\n`);
    await cg.sync();

    const keysAfter = getConfigKeys(cg.queries)
      .map((k) => k.configKey)
      .sort();
    // KEY_A_NEW comes from the changed a.ts — always present.
    expect(keysAfter).toContain('KEY_A_NEW');
    // KEY_B comes from the UNCHANGED b.ts — only present if b.ts was
    // re-mined (i.e. the full-rescan path fired, not the per-file path).
    expect(keysAfter).toContain('KEY_B');
    // The stale version is gone.
    expect(keysAfter).not.toContain('KEY_A');

    // The hook must stamp the current algo version so the NEXT sync
    // stays incremental.
    expect(getMetadata(cg.queries, LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY)).toBe(CONFIG_REFS_ALGO_VERSION);
  });

  it('stamps the algo version after indexAll so the first sync is incremental', async () => {
    write('src/a.ts', `export const A = process.env.INIT_KEY;\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    expect(getMetadata(cg.queries, LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY)).toBe(CONFIG_REFS_ALGO_VERSION);
  });

  it('fires the full re-mine even when the sync touches zero files (no-op sync)', async () => {
    // Regression: the pre-fix code placed the algo-mismatch check INSIDE the
    // `if (changedFilePaths.length > 0 || filesRemoved > 0)` guard.  A no-op
    // sync (e.g. right after pulling a miner-logic fix without editing anything)
    // would skip the block entirely and never trigger the self-heal.
    write('src/a.ts', `export const A = process.env.NOOP_KEY;\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Confirm the key was indexed and the current version is stamped.
    expect(getConfigKeys(cg.queries).map((k) => k.configKey)).toContain('NOOP_KEY');
    expect(getMetadata(cg.queries, LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY)).toBe(CONFIG_REFS_ALGO_VERSION);

    // Stamp a bogus version — simulates the state after pulling a miner fix.
    setMetadata(cg.queries, LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY, '0');

    // Run a sync with NO file-system changes at all.
    await cg.sync();

    // The full re-mine must have fired: NOOP_KEY is still present (not wiped)
    // and the algo version is back to current.
    expect(getConfigKeys(cg.queries).map((k) => k.configKey)).toContain('NOOP_KEY');
    expect(getMetadata(cg.queries, LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY)).toBe(CONFIG_REFS_ALGO_VERSION);
  });
});
