/**
 * audit-4 search/navigation regression tests.
 *
 * Covers the symbol-resolver fixes from the 2026-05-18 audit-4 sweep:
 *
 *  - #10 / group-3 #1 — the FTS top-1 *fuzzy fallback* had no
 *    relevance gate, so a clearly-bogus query (`zzznotreal`) could
 *    resolve to an unrelated symbol and downstream tools
 *    (biomarkers / coverage / tests-for) reported it as healthy.
 *    `findSymbol` and `resolveSymbolToNode` now reject a fuzzy
 *    candidate that shares no real similarity with the query.
 *
 *  - #1 — a stale / cross-process `n_xxxxxxxx` UID is a cache miss,
 *    not a genuine absence. `isUnresolvedUid` detects it so callers
 *    can emit a UID-specific message instead of the misleading
 *    "true negative" footer.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { findSymbol, resolveSymbolToNode, isUnresolvedUid, staleUidMessage } from '../src/mcp/tools/symbol-resolver.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('audit-4 — symbol-resolver fuzzy-fallback gate + stale-UID detection', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-audit4-search-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'engine.ts'),
      [
        'export function computeChecksum(input: string): number { return input.length; }',
        'export function renderReport(rows: string[]): string { return rows.join("\\n"); }',
        'export const MAX_RETRY_COUNT = 5;',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // ---------------------------------------------------------------
  // #10 / group-3 #1 — fuzzy-fallback relevance gate
  // ---------------------------------------------------------------

  it('findSymbol returns null for a clearly-bogus query (no nonsense fuzzy match)', () => {
    // `zzznotreal` shares no real edit / containment / subsequence
    // relationship with any indexed name — it must not resolve.
    expect(findSymbol(cg, 'zzznotreal')).toBeNull();
    expect(findSymbol(cg, 'xqzwvkbogus')).toBeNull();
  });

  it('resolveSymbolToNode returns null for a clearly-bogus query', () => {
    expect(resolveSymbolToNode(cg, 'zzznotreal', undefined)).toBeNull();
    expect(resolveSymbolToNode(cg, 'xqzwvkbogus', undefined)).toBeNull();
  });

  it('findSymbol still resolves real names exactly (gate does not over-reject)', () => {
    for (const name of ['computeChecksum', 'renderReport', 'MAX_RETRY_COUNT']) {
      const match = findSymbol(cg, name);
      expect(match, `findSymbol should resolve "${name}"`).not.toBeNull();
      expect(match!.node.name).toBe(name);
    }
  });

  it('findSymbol still accepts a genuine typo via the fuzzy fallback', () => {
    // A one-edit typo of a real name keeps resolving — the gate only
    // drops coincidence-tier matches, not real edit-distance hits.
    const match = findSymbol(cg, 'computeChecksm');
    expect(match).not.toBeNull();
    expect(match!.node.name).toBe('computeChecksum');
    // Fuzzy hits carry a "did you mean" note.
    expect(match!.note).toContain('No exact match');
  });

  // ---------------------------------------------------------------
  // #1 — stale / cross-process UID detection
  // ---------------------------------------------------------------

  it('isUnresolvedUid flags an n_ UID that no cache can resolve', () => {
    // A `n_xxxxxxxx`-shaped string with no cache present, or a cache
    // that has no entry for it, is an unresolved UID.
    expect(isUnresolvedUid('n_deadbeef', undefined)).toBe(true);
    const emptyCache = { resolve: (_uid: string) => null };
    expect(isUnresolvedUid('n_deadbeef', emptyCache)).toBe(true);
  });

  it('isUnresolvedUid returns false for a plain symbol name', () => {
    expect(isUnresolvedUid('computeChecksum', undefined)).toBe(false);
    expect(isUnresolvedUid('zzznotreal', undefined)).toBe(false);
  });

  it('isUnresolvedUid returns false when the cache DOES resolve the UID', () => {
    const liveCache = { resolve: (uid: string) => (uid === 'n_abcdef12' ? 'function:abc' : null) };
    expect(isUnresolvedUid('n_abcdef12', liveCache)).toBe(false);
  });

  it('staleUidMessage names the UID and omits any "true negative" claim', () => {
    const msg = staleUidMessage('n_deadbeef');
    expect(msg).toContain('n_deadbeef');
    expect(msg).toContain('no longer cached');
    // The misleading freshness footer must NOT be appended.
    expect(msg).not.toContain('true negative');
  });
});
