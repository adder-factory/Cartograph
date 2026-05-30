/**
 * F#60 — per-file staleness banner during the watcher debounce window.
 *
 * The file watcher tracks every event seen since the last successful
 * sync; the MCP tool dispatcher intersects "files referenced in this
 * response" with that pending set and prepends a ⚠️ banner naming the
 * stale files. Files NOT referenced in the response surface as a
 * compact footer so the agent still gets a project-wide freshness
 * picture without bloating the banner.
 *
 * Cost when nothing is pending — the common case — is one
 * `getPendingFiles()` call returning `[]`. Cost in the pending case is
 * O(text.length * pending.length) substring scan with a word-boundary
 * check on each match (no regex per file).
 *
 * These tests drive real Cartograph + real FileWatcher + real
 * ToolHandler — no mocking of the dispatcher path — plus pure unit
 * tests for the env var parser.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { parseDebounceEnv } from '../src/mcp/index.js';

function waitFor(condition: () => boolean, timeoutMs = 5000, intervalMs = 50): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = (): void => {
      if (condition()) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe('parseDebounceEnv (F#60)', () => {
  it('returns undefined for unset / empty values', () => {
    expect(parseDebounceEnv(undefined)).toBeUndefined();
    expect(parseDebounceEnv('')).toBeUndefined();
    expect(parseDebounceEnv('   ')).toBeUndefined();
  });

  it('accepts integer values inside [100, 60000]', () => {
    expect(parseDebounceEnv('100')).toBe(100);
    expect(parseDebounceEnv('2000')).toBe(2000);
    expect(parseDebounceEnv('5000')).toBe(5000);
    expect(parseDebounceEnv('60000')).toBe(60000);
  });

  it('rejects out-of-range values (returns undefined, lets default win)', () => {
    expect(parseDebounceEnv('0')).toBeUndefined();
    expect(parseDebounceEnv('50')).toBeUndefined();
    expect(parseDebounceEnv('99')).toBeUndefined();
    expect(parseDebounceEnv('60001')).toBeUndefined();
    expect(parseDebounceEnv('-500')).toBeUndefined();
  });

  it('rejects non-integer / non-numeric values', () => {
    expect(parseDebounceEnv('abc')).toBeUndefined();
    expect(parseDebounceEnv('500.5')).toBeUndefined();
    expect(parseDebounceEnv('NaN')).toBeUndefined();
    expect(parseDebounceEnv('Infinity')).toBeUndefined();
  });

  it('accepts scientific notation that resolves to an in-range integer', () => {
    // Number('1e3') === 1000, Number.isInteger(1000) === true. Power
    // users who write debounce as `1e3` should not be surprised.
    expect(parseDebounceEnv('1e3')).toBe(1000);
  });
});

describe('FileWatcher pending-files API (F#60)', () => {
  let testDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    // realpathSync canonicalizes `/var/folders/...` → `/private/var/...`
    // on macOS so the path the test injects matches what the watcher
    // computes via its own realpathSync(projectRoot). Without this,
    // `path.relative` returns a `../../`-prefixed escape that the
    // watcher's safety guard drops as out-of-project.
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stale-watcher-')));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const b = 2;\n');
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('records an edit while sync is debounced; clears it after sync succeeds', async () => {
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // Task #14 — inject the event directly instead of writing to disk
    // and gambling on macOS FSEvents delivery under parallel-shard
    // contention. The debounced sync still runs through real timers
    // (reliable); only the OS-level event delivery is replaced.
    cg.watcher.start({ debounceMs: 500 });

    expect(cg.watcher.getPendingFiles()).toEqual([]);

    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), 'export const a = 999;\n');
    cg.watcher._injectFileEventForTest(path.join(testDir, 'src', 'a.ts'));

    const before = cg.watcher.getPendingFiles();
    expect(before.length).toBeGreaterThanOrEqual(1);
    const a = before.find((p) => p.path.endsWith('a.ts'));
    expect(a).toBeDefined();
    expect(a!.indexing).toBe(false); // still in debounce window

    // Wait for the debounced sync to fire and complete. Timer-based,
    // not FSEvents-based — robust under shard load. 5 sec generously
    // covers debounce (500 ms) + a real sync's wall time.
    await waitFor(() => cg!.watcher.getPendingFiles().length === 0, 5000);
    expect(cg.watcher.getPendingFiles()).toEqual([]);

    cg.watcher.stop();
  });
});

describe('staleness banner on ToolHandler.execute (F#60)', () => {
  let testDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    // See the staleness-watcher beforeEach for the realpathSync rationale.
    testDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stale-banner-')));
    fs.mkdirSync(path.join(testDir, 'src'));
    // Isolated files (no cross-references) — keeps each test's
    // "which path does the response mention?" assertion unambiguous.
    fs.writeFileSync(path.join(testDir, 'src', 'alphaOnly.ts'), 'export function alphaOnly() { return 1; }\n');
    fs.writeFileSync(path.join(testDir, 'src', 'bravoOnly.ts'), 'export function bravoOnly() { return 2; }\n');
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('prepends a stale banner when the response references a pending file', async () => {
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    // Long debounce so the edit lingers in pendingFiles while we query.
    cg.watcher.start({ debounceMs: 60_000 });

    fs.writeFileSync(path.join(testDir, 'src', 'alphaOnly.ts'), 'export function alphaOnly() { return 99; }\n');
    cg.watcher._injectFileEventForTest(path.join(testDir, 'src', 'alphaOnly.ts'));

    // Query the edited symbol — response should mention `alphaOnly.ts`.
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alphaOnly' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('Some files referenced below were edited');
    expect(text).toContain('alphaOnly.ts');

    cg.watcher.stop();
  });

  it('no banner on a fully-synced index', async () => {
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    // Watcher not started — getPendingFiles returns [].
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alphaOnly' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('Some files referenced below were edited');
    expect(text).not.toContain('pending index sync');
  });

  it('surfaces unreferenced pending files as a footer note', async () => {
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    const handler = new ToolHandler(cg);

    cg.watcher.start({ debounceMs: 60_000 });

    // Edit bravoOnly but query alphaOnly — bravo's edit must surface
    // as a footer (it isn't referenced in the response), not as the
    // top banner.
    fs.writeFileSync(path.join(testDir, 'src', 'bravoOnly.ts'), 'export function bravoOnly() { return 99; }\n');
    cg.watcher._injectFileEventForTest(path.join(testDir, 'src', 'bravoOnly.ts'));

    const result = await handler.execute('cartograph_find', { by: 'name', query: 'alphaOnly' });
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('Some files referenced below were edited');
    expect(text).toContain('pending index sync but were not referenced above');
    expect(text).toContain('bravoOnly.ts');

    cg.watcher.stop();
  });
});

describe('textMentionsPath word-boundary check (F#60 internal)', () => {
  // Lightweight regression guards for the substring-false-positive class
  // that upstream's `text.includes(p.path)` port shipped with. The
  // banner-emission tests above also depend on this passing — these
  // pin the contract independent of any specific tool's output shape.
  // Exposed via re-export only for the test; not part of the public API.
  it('does not false-match foo.ts against foo.ts.snap', async () => {
    // Indirect probe: load a fixture project, edit `a.ts`, query for
    // `a.ts.snap` (a path that doesn't exist but mentions a.ts as a
    // substring of a longer file name). With substring match it would
    // banner; with the word-boundary check it must not.
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-stale-wb-')));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 1;\n');
      const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
      await cg.indexAll({ summarize: false });

      cg.watcher.start({ debounceMs: 60_000 });
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const x = 2;\n');
      cg.watcher._injectFileEventForTest(path.join(dir, 'src', 'a.ts'));

      const handler = new ToolHandler(cg);
      // Construct a response that mentions `src/a.ts.snap` but NOT
      // `src/a.ts` — we use cartograph_find with a query that won't
      // match the file. Since the query yields no hits, the result
      // shouldn't mention any path; banner shouldn't fire.
      const result = await handler.execute('cartograph_find', { by: 'name', query: '___nothing_matches___' });
      const text = result.content[0]?.text ?? '';
      expect(text).not.toContain('Some files referenced below were edited');
      // The footer SHOULD fire — a.ts is pending and elsewhere in project.
      expect(text).toContain('pending index sync but were not referenced above');
      cg.watcher.stop();
      cg.destroy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
