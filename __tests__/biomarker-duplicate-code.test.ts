/**
 * Tests for the `duplicate_code` cross-file biomarker — Tier 1 (exact
 * Type-1 clones), Tier 2 (near Type-2 clones), Tier 3 (opt-in partial
 * Type-3 token-overlap clones), and Tier 4 (semantic Type-4 clones
 * from `similar_to` edges). Validates that
 *   - byte-identical function bodies across files form an `exact`
 *     clone class and every member gets a `warning` finding
 *   - the minimum-size floor suppresses tiny identical helpers
 *   - non-production (test-file) copies are excluded from clone classes
 *   - the `duplicateCodeAllowlist` config exempts matching paths
 *   - structurally-identical bodies that differ only in identifiers /
 *     literals form a `near` class at `info` severity
 *   - structurally-different bodies are not grouped
 *   - an exact pair plus a renamed variant form one `near` class
 *   - a high-cosine `similar_to` edge yields an `info` semantic clone
 *   - a sub-cutoff `similar_to` edge yields nothing
 *   - a node already flagged syntactically gets no semantic finding
 *   - a very-high-overlap (≥ 0.95) partial clone is flagged at `info`
 *     by default; the wider 0.80 partial band stays opt-in via
 *     `duplicateCodePartialClones`
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Cartograph from '../src/index.js';
import { findDuplicateCode } from '../src/biomarkers/duplicate-code.js';
import { insertSimilarToEdges } from '../src/db/queries-similarity.js';
import { getConfigPath } from '../src/config.js';

/** A 7-line function — clears the DUP_MIN_LOC (6) floor. */
const CLONE_BODY =
  'export function processItem(input: string): string {\n' +
  '  const trimmed = input.trim();\n' +
  '  const upper = trimmed.toUpperCase();\n' +
  "  const prefixed = 'ITEM:' + upper;\n" +
  "  const suffixed = prefixed + ':END';\n" +
  '  return suffixed;\n' +
  '}\n';

/** A 3-line function — below the size floor. */
const TINY_BODY = 'export function tinyHelper(x: number): string {\n' + '  return String(x);\n' + '}\n';

/** Two structurally-identical 14-line functions that differ only in
 *  identifiers and numeric literals — a Type-2 (near) clone pair.
 *  14 lines clears the DUP_NEAR_MIN_LOC (12) near-clone floor. */
const NEAR_A =
  'export function computeAlpha(seed: number): number {\n' +
  '  const base = seed * 2;\n' +
  '  const adjusted = base + 10;\n' +
  '  const scaled = adjusted * 3;\n' +
  '  const total = scaled - 1;\n' +
  '  const doubled = total * 2;\n' +
  '  const capped = doubled + 4;\n' +
  '  const shifted = capped - 7;\n' +
  '  const widened = shifted * 5;\n' +
  '  const tightened = widened + 2;\n' +
  '  const settled = tightened - 3;\n' +
  '  const result = settled * 6;\n' +
  '  return result;\n' +
  '}\n';
const NEAR_B =
  'export function computeBeta(input: number): number {\n' +
  '  const raw = input * 2;\n' +
  '  const tweaked = raw + 99;\n' +
  '  const grown = tweaked * 3;\n' +
  '  const sum = grown - 1;\n' +
  '  const pair = sum * 2;\n' +
  '  const lifted = pair + 8;\n' +
  '  const eased = lifted - 7;\n' +
  '  const stretched = eased * 5;\n' +
  '  const nudged = stretched + 2;\n' +
  '  const calmed = nudged - 3;\n' +
  '  const outcome = calmed * 6;\n' +
  '  return outcome;\n' +
  '}\n';

/** A 7-line function with a different structure (a for-loop) — must
 *  not normalise to the same token stream as NEAR_A / NEAR_B. */
const DIFFERENT_SHAPE =
  'export function unrelatedShape(items: number[]): number {\n' +
  '  let acc = 0;\n' +
  '  for (const it of items) {\n' +
  '    acc += it;\n' +
  '  }\n' +
  '  return acc;\n' +
  '}\n';

/** Two structurally-DIFFERENT functions — not syntactic clones of
 *  each other or anything else. Used for Tier 4 (semantic) tests,
 *  where a `similar_to` edge is inserted between them by hand. */
const SEMANTIC_A =
  'export function funcOne(values: number[]): number {\n' +
  '  let total = 0;\n' +
  '  for (const v of values) {\n' +
  '    total = total + v;\n' +
  '  }\n' +
  '  return total;\n' +
  '}\n';
const SEMANTIC_B =
  'export function funcTwo(text: string): string {\n' +
  "  const parts = text.split(',');\n" +
  '  const cleaned = parts.map((p) => p.trim());\n' +
  "  const joined = cleaned.join('|');\n" +
  '  return joined.toUpperCase();\n' +
  '}\n';

/** A 13-line function and a 15-line superset of it (two extra
 *  statements) — a Type-3 partial clone: token multisets overlap
 *  ~85%, but the differing length means the Tier-2 hash misses it. */
const PARTIAL_A =
  'export function processChain(data: number): number {\n' +
  '  const a = data + 1;\n' +
  '  const b = a * 2;\n' +
  '  const c = b - 3;\n' +
  '  const d = c * 4;\n' +
  '  const e = d + 5;\n' +
  '  const f = e - 6;\n' +
  '  const g = f * 7;\n' +
  '  const h = g + 8;\n' +
  '  const i = h - 9;\n' +
  '  const j = i * 10;\n' +
  '  return j;\n' +
  '}\n';
const PARTIAL_B =
  'export function processChain(data: number): number {\n' +
  '  const a = data + 1;\n' +
  '  const b = a * 2;\n' +
  '  const c = b - 3;\n' +
  '  const d = c * 4;\n' +
  '  const e = d + 5;\n' +
  '  const f = e - 6;\n' +
  '  const g = f * 7;\n' +
  '  const h = g + 8;\n' +
  '  const i = h - 9;\n' +
  '  const j = i * 10;\n' +
  '  const k = j + 11;\n' +
  '  const l = k - 12;\n' +
  '  return l;\n' +
  '}\n';

/** Two SQL-string builders: identical JS shape `(clause) => template`
 *  but unrelated SQL. Each SQL line folds to the `L` placeholder, so
 *  the two normalise to the SAME near-empty token stream — the
 *  literal-density guard (DUP_NEAR_MAX_LITERAL_RATIO) must keep them
 *  OUT of a `near` class. 14 lines each — clears DUP_NEAR_MIN_LOC. */
const SQL_BUILDER_A =
  'export function buildAccountsQuery(clause: string): string {\n' +
  '  return `\n' +
  '    SELECT a.id, a.name, a.created_at, a.status\n' +
  '      FROM accounts a\n' +
  '      JOIN profiles p ON p.account_id = a.id\n' +
  '      LEFT JOIN orgs o ON o.id = a.org_id\n' +
  '     WHERE a.active = 1\n' +
  '       AND p.verified = 1\n' +
  '       ' +
  '${clause}\n' +
  '     ORDER BY a.created_at DESC\n' +
  '     LIMIT 100\n' +
  '  `;\n' +
  '}\n';
const SQL_BUILDER_B =
  'export function buildEventsQuery(clause: string): string {\n' +
  '  return `\n' +
  '    SELECT e.uuid, e.kind, e.payload, e.emitted_at\n' +
  '      FROM events e\n' +
  '      JOIN sources s ON s.id = e.source_id\n' +
  '      LEFT JOIN tags t ON t.event_id = e.uuid\n' +
  '     WHERE e.dropped = 0\n' +
  '       AND s.enabled = 1\n' +
  '       ' +
  '${clause}\n' +
  '     GROUP BY e.uuid\n' +
  '     LIMIT 250\n' +
  '  `;\n' +
  '}\n';

/** Two functions with the SAME 12 statements in a DIFFERENT order.
 *  The Tier-2 hash is order-sensitive so it misses them; their token
 *  multisets are identical, so they are a ~1.0-overlap Type-3 partial
 *  clone — caught by the always-on high-overlap band WITHOUT the
 *  `duplicateCodePartialClones` opt-in. 14 lines — clears the floor. */
const SHAPE_CHAIN_A =
  'export function shapeChain(seed: number): number {\n' +
  '  const a = seed + 1;\n' +
  '  const b = seed * 2;\n' +
  '  const c = seed - 3;\n' +
  '  const d = seed + 4;\n' +
  '  const e = seed * 5;\n' +
  '  const f = seed - 6;\n' +
  '  const g = seed + 7;\n' +
  '  const h = seed * 8;\n' +
  '  const i = seed - 9;\n' +
  '  const j = seed + 10;\n' +
  '  const k = seed * 11;\n' +
  '  const m = seed - 12;\n' +
  '  return a + b + c + d + e + f + g + h + i + j + k + m;\n' +
  '}\n';
const SHAPE_CHAIN_B =
  'export function shapeChain(seed: number): number {\n' +
  '  const b = seed * 2;\n' +
  '  const a = seed + 1;\n' +
  '  const d = seed + 4;\n' +
  '  const c = seed - 3;\n' +
  '  const f = seed - 6;\n' +
  '  const e = seed * 5;\n' +
  '  const h = seed * 8;\n' +
  '  const g = seed + 7;\n' +
  '  const j = seed + 10;\n' +
  '  const i = seed - 9;\n' +
  '  const m = seed - 12;\n' +
  '  const k = seed * 11;\n' +
  '  return a + b + c + d + e + f + g + h + i + j + k + m;\n' +
  '}\n';

/** A 12-line function — exactly at the DUP_NEAR_MIN_LOC (12) floor. */
const CHAIN12_A =
  'export function chain12(seed: number): number {\n' +
  '  const a = seed + 1;\n' +
  '  const b = seed * 2;\n' +
  '  const c = seed - 3;\n' +
  '  const d = seed + 4;\n' +
  '  const e = seed * 5;\n' +
  '  const f = seed - 6;\n' +
  '  const g = seed + 7;\n' +
  '  const h = seed * 8;\n' +
  '  const i = seed - 9;\n' +
  '  return a + b + c + d + e + f + g + h + i;\n' +
  '}\n';
/** Same 9 statements as CHAIN12_A, reordered — identical token multiset
 *  (overlap 1.0) so the always-on partial band catches it, and exactly
 *  12 lines so it sits ON the DUP_NEAR_MIN_LOC floor (proves the floor
 *  is `< 12`, i.e. a 12-line candidate is admitted). */
const CHAIN12_B =
  'export function chain12(seed: number): number {\n' +
  '  const b = seed * 2;\n' +
  '  const a = seed + 1;\n' +
  '  const d = seed + 4;\n' +
  '  const c = seed - 3;\n' +
  '  const f = seed - 6;\n' +
  '  const e = seed * 5;\n' +
  '  const h = seed * 8;\n' +
  '  const g = seed + 7;\n' +
  '  const i = seed - 9;\n' +
  '  return a + b + c + d + e + f + g + h + i;\n' +
  '}\n';
/** CHAIN12 dropped to 11 lines — one statement short of the
 *  DUP_NEAR_MIN_LOC (12) floor, so the partial tier must skip it. */
const CHAIN11_A = CHAIN12_A.replace('  const i = seed - 9;\n', '');
const CHAIN11_B = CHAIN12_B.replace('  const i = seed - 9;\n', '');

/** Two functions of IDENTICAL token count (same statement shape) but
 *  only ~0.61 multiset overlap — A is an all-`+` chain, B an all-`*`
 *  chain with a disjoint identifier set. Equal sizes keep them inside
 *  the comparison window (no early break), so the overlap maths is
 *  actually exercised; the ~0.61 ratio sits below even the 0.80 opt-in
 *  band, so they must NOT link. This guards the intersection-size
 *  `Math.min`, the `/ max(total)` ratio, and the `>= minOverlap` gate —
 *  a mutant that inflates the overlap (min→max, /→*) or drops the gate
 *  (`>=`→true) would wrongly link them. */
const MODERATE_OVERLAP_A =
  'export function adderRun(seed: number): number {\n' +
  '  const aa = seed + 1;\n' +
  '  const bb = aa + 2;\n' +
  '  const cc = bb + 3;\n' +
  '  const dd = cc + 4;\n' +
  '  const ee = dd + 5;\n' +
  '  const ff = ee + 6;\n' +
  '  const gg = ff + 7;\n' +
  '  const hh = gg + 8;\n' +
  '  const ii = hh + 9;\n' +
  '  const jj = ii + 10;\n' +
  '  const kk = jj + 11;\n' +
  '  return kk;\n' +
  '}\n';
const MODERATE_OVERLAP_B =
  'export function timesRun(base: number): number {\n' +
  '  const mm = base * 1;\n' +
  '  const nn = mm * 2;\n' +
  '  const oo = nn * 3;\n' +
  '  const pp = oo * 4;\n' +
  '  const qq = pp * 5;\n' +
  '  const rr = qq * 6;\n' +
  '  const ss = rr * 7;\n' +
  '  const tt = ss * 8;\n' +
  '  const uu = tt * 9;\n' +
  '  const vv = uu * 10;\n' +
  '  const ww = vv * 11;\n' +
  '  return ww;\n' +
  '}\n';

/** A function spanning EXACTLY 6 source lines (the DUP_MIN_LOC floor).
 *  Two copies are a byte-identical exact clone sitting ON the floor — a
 *  `>= DUP_MIN_LOC` filter admits it, a `> DUP_MIN_LOC` mutant would
 *  drop it. */
const SIX_LINE_EXACT =
  'export function sixExact(x: number): number {\n' +
  '  const a = x + 1;\n' +
  '  const b = a + 2;\n' +
  '  const c = b + 3;\n' +
  '  return c;\n' +
  '}\n';

/** An 8-line structurally-identical, renamed pair — a Type-2 *near*
 *  match, but BELOW the DUP_NEAR_MIN_LOC (12) near floor (and above the
 *  6-line candidate floor, so it still reaches the near pass). The
 *  stricter near floor must drop it. */
const NEAR8_A =
  'export function eightAlpha(seed: number): number {\n' +
  '  const aa = seed + 1;\n' +
  '  const bb = aa + 2;\n' +
  '  const cc = bb + 3;\n' +
  '  const dd = cc + 4;\n' +
  '  const ee = dd + 5;\n' +
  '  return ee;\n' +
  '}\n';
const NEAR8_B =
  'export function eightBeta(base: number): number {\n' +
  '  const pp = base + 9;\n' +
  '  const qq = pp + 8;\n' +
  '  const rr = qq + 7;\n' +
  '  const ss = rr + 6;\n' +
  '  const tt = ss + 5;\n' +
  '  return tt;\n' +
  '}\n';

/** A 12-line structurally-identical, renamed pair — a Type-2 *near*
 *  match sitting EXACTLY on the DUP_NEAR_MIN_LOC (12) floor, so it must
 *  be flagged (`>= 12` admits; a `> 12` mutant would drop it). */
const NEAR12_A =
  'export function twelveAlpha(seed: number): number {\n' +
  '  const aa = seed + 1;\n' +
  '  const bb = aa + 2;\n' +
  '  const cc = bb + 3;\n' +
  '  const dd = cc + 4;\n' +
  '  const ee = dd + 5;\n' +
  '  const ff = ee + 6;\n' +
  '  const gg = ff + 7;\n' +
  '  const hh = gg + 8;\n' +
  '  const ii = hh + 9;\n' +
  '  return ii;\n' +
  '}\n';
const NEAR12_B =
  'export function twelveBeta(base: number): number {\n' +
  '  const pp = base + 9;\n' +
  '  const qq = pp + 8;\n' +
  '  const rr = qq + 7;\n' +
  '  const ss = rr + 6;\n' +
  '  const tt = ss + 5;\n' +
  '  const uu = tt + 4;\n' +
  '  const vv = uu + 3;\n' +
  '  const ww = vv + 2;\n' +
  '  const xx = ww + 1;\n' +
  '  return xx;\n' +
  '}\n';

/** A third semantically-unique function for Tier-4 multi-member-class
 *  tests (a 3-node `similar_to` chain). */
const SEMANTIC_C =
  'export function funcThree(n: number): number {\n' +
  '  const x = n * 3;\n' +
  '  const y = x + 7;\n' +
  '  const z = y - 2;\n' +
  '  return z;\n' +
  '}\n';

async function makeProject(files: Record<string, string>): Promise<{ dir: string; cg: Cartograph }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-dup-bm-'));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 't', version: '0.0.0' }));
  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  return { dir, cg };
}

describe('biomarker: duplicate_code (Tier 1 exact + Tier 2 near clones)', () => {
  it('flags a byte-identical function cloned across two production files', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
      'src/unique.ts': 'export function soloFn(n: number): number {\n  return n * 2;\n}\n',
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2); // one finding per clone-class member
      for (const f of findings) {
        expect(f.biomarker).toBe('duplicate_code');
        expect(f.severity).toBe('warning');
        // CLONE_BODY is 7 lines — pin the `endLine - startLine + 1` LOC
        // arithmetic on both the finding `metric` and `detail.loc`.
        expect(f.metric).toBe(7);
        const detail = f.detail as {
          cloneType: string;
          loc: number;
          cloneClassSize: number;
          members: Array<{ name: string; location: string }>;
        };
        expect(detail.cloneType).toBe('exact');
        expect(detail.loc).toBe(7);
        expect(detail.cloneClassSize).toBe(2);
        expect(detail.members.length).toBe(1); // the one sibling
        // The sibling payload names the OTHER member by name + location,
        // never the finding's own node (the `nodeId !== member.nodeId`
        // filter) — and the location is `${filePath}:${startLine}`.
        const sibling = detail.members[0]!;
        expect(sibling.name).toBe('processItem');
        expect(['src/a.ts:1', 'src/b.ts:1']).toContain(sibling.location);
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does not flag identical helpers below the size floor', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': TINY_BODY,
      'src/b.ts': TINY_BODY,
    });
    try {
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 1: flags a byte-identical pair sitting exactly on the DUP_MIN_LOC floor', async () => {
    // SIX_LINE_EXACT spans exactly 6 lines = DUP_MIN_LOC. The exact floor
    // is `>= DUP_MIN_LOC`, so a 6-line clone IS flagged; a `> DUP_MIN_LOC`
    // mutant would drop it.
    const { dir, cg } = await makeProject({
      'src/a.ts': SIX_LINE_EXACT,
      'src/b.ts': SIX_LINE_EXACT,
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.severity).toBe('warning');
        expect(f.metric).toBe(6);
        expect((f.detail as { cloneType: string }).cloneType).toBe('exact');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 2: a renamed pair below the near floor (but above the candidate floor) is dropped', async () => {
    // NEAR8_A / NEAR8_B are 8 lines — they clear the 6-line candidate
    // floor (so they reach the near pass) but fall under DUP_NEAR_MIN_LOC
    // (12). The stricter near floor must drop them: a small renamed
    // structural match is usually coincidence, not real duplication.
    const { dir, cg } = await makeProject({
      'src/a.ts': NEAR8_A,
      'src/b.ts': NEAR8_B,
    });
    try {
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 2: a renamed pair sitting exactly on the DUP_NEAR_MIN_LOC floor is flagged', async () => {
    // NEAR12_A / NEAR12_B are 12 lines = DUP_NEAR_MIN_LOC. The near floor
    // is `>= DUP_NEAR_MIN_LOC`, so a 12-line near pair IS flagged; a
    // `> DUP_NEAR_MIN_LOC` mutant would drop it.
    const { dir, cg } = await makeProject({
      'src/a.ts': NEAR12_A,
      'src/b.ts': NEAR12_B,
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.severity).toBe('info');
        expect(f.metric).toBe(12);
        expect((f.detail as { cloneType: string }).cloneType).toBe('near');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('excludes non-production (test-file) copies from the clone class', async () => {
    // a.ts + b.ts are a real 2-member class; the .test.ts copy must
    // NOT join it — so the class stays size 2, not 3.
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
      'src/thing.test.ts': CLONE_BODY,
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect((f.detail as { cloneClassSize: number }).cloneClassSize).toBe(2);
        expect(f.nodeId).toBeTruthy();
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the duplicateCodeAllowlist config exempts matching paths', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
    });
    try {
      // Exempt b.ts — the clone class drops to a single member, so no
      // finding survives.
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodeAllowlist: ['**/b.ts'] }));
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a non-matching allowlist glob exempts nothing — the clone is still flagged', async () => {
    // The allowlist regex is fully anchored; a glob that matches no
    // candidate path must NOT exempt anyone (a mutant that compiled the
    // glob to a match-everything regex would wrongly silence the clone).
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
    });
    try {
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodeAllowlist: ['**/zzz.ts'] }));
      expect(findDuplicateCode(cg.queries, dir).length).toBe(2);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an allowlist of only invalid (empty) globs exempts nothing', async () => {
    // An empty glob compiles to no usable regex, so the predicate has no
    // patterns — it must exempt NOTHING (a mutant that returns `true`
    // from the empty-regex branch would silence every clone).
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
    });
    try {
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodeAllowlist: [''] }));
      expect(findDuplicateCode(cg.queries, dir).length).toBe(2);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an allowlist exempts a path when ANY glob matches (some, not every)', async () => {
    // Two globs: one matches nothing, one matches b.ts. A path is exempt
    // if ANY glob matches; exempting b.ts collapses the class to one
    // member, so nothing is flagged. (A mutant requiring EVERY glob to
    // match would exempt no one, leaving the clone flagged.)
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
    });
    try {
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodeAllowlist: ['**/nope.ts', '**/b.ts'] }));
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 2: flags a near (Type-2) clone — same structure, renamed identifiers/literals', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': NEAR_A,
      'src/b.ts': NEAR_B,
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.biomarker).toBe('duplicate_code');
        expect(f.severity).toBe('info'); // near clones are info, not warning
        // NEAR_A / NEAR_B are 14 lines each — pin the near-finding LOC.
        expect(f.metric).toBe(14);
        const detail = f.detail as { cloneType: string; loc: number; cloneClassSize: number };
        expect(detail.cloneType).toBe('near');
        expect(detail.loc).toBe(14);
        expect(detail.cloneClassSize).toBe(2);
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 2: does not group structurally different functions', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': NEAR_A,
      'src/b.ts': DIFFERENT_SHAPE,
    });
    try {
      // Each function is unique → no clone class forms.
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 2: does not group literal-dominated bodies (SQL builders) as near clones', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': SQL_BUILDER_A,
      'src/b.ts': SQL_BUILDER_B,
    });
    try {
      // Same `(clause) => template-literal` JS shape, unrelated SQL.
      // The normalised token streams collide (every SQL line → `L`),
      // but the literal-density guard keeps them out of a near class.
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 1: still flags byte-identical literal-dominated bodies as exact clones', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': SQL_BUILDER_A,
      'src/b.ts': SQL_BUILDER_A,
    });
    try {
      // The literal-density guard drops only the *near* tier — a
      // byte-identical body_hash is still a real Type-1 clone.
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.severity).toBe('warning');
        expect((f.detail as { cloneType: string }).cloneType).toBe('exact');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: flags a semantic clone from a high-score similar_to edge', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
    });
    try {
      const a = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcOne' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const b = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcTwo' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      // funcOne / funcTwo are structurally different — no syntactic
      // tier flags them. A high-cosine similar_to edge makes them a
      // Tier-4 semantic clone pair.
      insertSimilarToEdges(cg.queries, [{ source: a.id, target: b.id, score: 0.97 }]);
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.biomarker).toBe('duplicate_code');
        expect(f.severity).toBe('info');
        // funcOne spans 7 lines, funcTwo 6 — each finding's metric is its
        // OWN node's `endLine - startLine + 1`, pinning the arithmetic
        // (a `- 1` or `+ startLine` mutant lands outside {6, 7}). loc and
        // metric are the same expression, so they must agree.
        expect([6, 7]).toContain(f.metric);
        const detail = f.detail as { cloneType: string; loc: number };
        expect(detail.loc).toBe(f.metric);
        expect(detail.cloneType).toBe('semantic');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: ignores similar_to edges below the score cutoff', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
    });
    try {
      const a = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcOne' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const b = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcTwo' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      // 0.80 is below DUP_SEMANTIC_MIN_SCORE (0.95) — no finding.
      insertSimilarToEdges(cg.queries, [{ source: a.id, target: b.id, score: 0.8 }]);
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: a syntactically-flagged node gets no duplicate semantic finding', async () => {
    // a.ts + b.ts are an exact clone pair. Even with a high-cosine
    // similar_to edge between them, Tier 4 must not add a second
    // (semantic) finding — each node already has its exact finding.
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
    });
    try {
      const ids = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'processItem' AND kind = 'function'`)
        .all() as Array<{ id: string }>;
      expect(ids.length).toBe(2);
      insertSimilarToEdges(cg.queries, [{ source: ids[0]!.id, target: ids[1]!.id, score: 0.99 }]);
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2); // exactly one finding per node, not two
      for (const f of findings) {
        expect((f.detail as { cloneType: string }).cloneType).toBe('exact');
        expect(f.severity).toBe('warning');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: partial clones are NOT flagged unless opted in', async () => {
    // PARTIAL_A / PARTIAL_B are neither exact nor (Tier-2) near —
    // different lengths give different normalised hashes. With Tier 3
    // off (the default) nothing is flagged.
    const { dir, cg } = await makeProject({
      'src/a.ts': PARTIAL_A,
      'src/b.ts': PARTIAL_B,
    });
    try {
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: flags a partial (Type-3) clone when duplicateCodePartialClones is set', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': PARTIAL_A,
      'src/b.ts': PARTIAL_B,
    });
    try {
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodePartialClones: true }));
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.biomarker).toBe('duplicate_code');
        expect(f.severity).toBe('info');
        // PARTIAL_A is 13 lines, PARTIAL_B is 15 — each finding's metric
        // is its OWN node's LOC, pinning the partial-finding arithmetic.
        expect([13, 15]).toContain(f.metric);
        const detail = f.detail as { cloneType: string; loc: number; cloneClassSize: number };
        expect(detail.cloneType).toBe('partial');
        expect(detail.loc).toBe(f.metric);
        expect(detail.cloneClassSize).toBe(2);
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: flags a 12-line reordered partial pair exactly at the near floor', async () => {
    // CHAIN12_A / CHAIN12_B are 12 lines each — exactly DUP_NEAR_MIN_LOC.
    // The floor is `< 12`, so a 12-line candidate IS admitted; their
    // identical token multisets (reordered statements) give ~1.0 overlap,
    // caught by the always-on high-overlap partial band (no opt-in).
    const { dir, cg } = await makeProject({
      'src/a.ts': CHAIN12_A,
      'src/b.ts': CHAIN12_B,
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.severity).toBe('info');
        expect(f.metric).toBe(12);
        expect((f.detail as { cloneType: string }).cloneType).toBe('partial');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: a reordered pair one line below the near floor is not flagged', async () => {
    // CHAIN11_A / CHAIN11_B are 11 lines — one short of DUP_NEAR_MIN_LOC
    // (12). Despite a ~1.0 token-multiset overlap, the partial tier's
    // size floor drops them: no finding.
    const { dir, cg } = await makeProject({
      'src/a.ts': CHAIN11_A,
      'src/b.ts': CHAIN11_B,
    });
    try {
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: equal-size functions with sub-threshold overlap are not linked, even opted in', async () => {
    // MODERATE_OVERLAP_A / _B have identical token counts (so they stay
    // inside the comparison window — the size-ratio break never fires)
    // but only ~0.61 multiset overlap, below the 0.80 opt-in band. The
    // overlap maths must keep them apart: a mutant that inflates the
    // overlap (intersection Math.min→max, the `/ max(total)` ratio→`*`)
    // or drops the gate (`>= minOverlap`→true) would wrongly link them.
    const { dir, cg } = await makeProject({
      'src/a.ts': MODERATE_OVERLAP_A,
      'src/b.ts': MODERATE_OVERLAP_B,
    });
    try {
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodePartialClones: true }));
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: an exact pair gets no extra partial finding when opted in', async () => {
    // With Tier 3 ON, a symbol already caught syntactically (here an
    // exact pair) must not also receive a `partial` finding — the
    // flaggedSyntactic guard excludes it from the Tier-3 pass.
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
    });
    try {
      fs.writeFileSync(getConfigPath(dir), JSON.stringify({ duplicateCodePartialClones: true }));
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2); // still exactly one per node
      for (const f of findings) {
        expect((f.detail as { cloneType: string }).cloneType).toBe('exact');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 3: flags a very-high-overlap partial clone by default (no opt-in)', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': SHAPE_CHAIN_A,
      'src/b.ts': SHAPE_CHAIN_B,
    });
    try {
      // Same 12 statements, reordered: the order-sensitive Tier-2 hash
      // misses it, but the token multisets are identical (~1.0 overlap)
      // — the always-on high-overlap partial band flags it WITHOUT the
      // duplicateCodePartialClones opt-in.
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.severity).toBe('info');
        expect((f.detail as { cloneType: string }).cloneType).toBe('partial');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exact pair in a renamed-clone bucket surfaces as exact, with the near singleton residue dropped', async () => {
    // a.ts + b.ts are byte-identical (NEAR_A); c.ts is the renamed
    // variant (NEAR_B). All three share a normalised-token hash so
    // bucketSyntacticClasses puts them in one bucket.
    //
    // The peel-exact-first behaviour (added when the bench caught
    // findDuplicateCode silently dropping real exact clones inside
    // larger near buckets) now splits this case: the a+b exact pair
    // gets flagged as `exact` warnings under DUP_MIN_LOC, and the
    // remaining {c} singleton residue can't form a near class (needs
    // ≥ 2 members). Pre-fix the whole class was reported as one
    // 3-member `near` group — that consolidation hid byte-identical
    // duplicates whose floor would have caught them.
    const { dir, cg } = await makeProject({
      'src/a.ts': NEAR_A,
      'src/b.ts': NEAR_A,
      'src/c.ts': NEAR_B,
    });
    try {
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect(f.biomarker).toBe('duplicate_code');
        expect(f.severity).toBe('warning');
        const detail = f.detail as { cloneType: string; cloneClassSize: number };
        expect(detail.cloneType).toBe('exact');
        expect(detail.cloneClassSize).toBe(2);
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: a similar_to score of exactly the cutoff (0.95) is flagged', async () => {
    // The semantic gate is `score < DUP_SEMANTIC_MIN_SCORE` (0.95) → skip,
    // so a score EXACTLY at 0.95 must NOT be skipped — it is a clone.
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
    });
    try {
      const a = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcOne' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const b = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcTwo' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      insertSimilarToEdges(cg.queries, [{ source: a.id, target: b.id, score: 0.95 }]);
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect((f.detail as { cloneType: string }).cloneType).toBe('semantic');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: an out-of-range similar_to score (> 1) is rejected', async () => {
    // A score above 1 is not a valid cosine — it signals a stale index
    // that persisted a raw dot-product. The `score > 1` guard drops it
    // so a degenerate edge does not flag every semantic pair as a clone.
    // (A score of exactly 1.0 stays valid — covered by the high-score
    // test — so the bound is strict `> 1`, not `>= 1`.)
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
    });
    try {
      const a = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcOne' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const b = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcTwo' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      insertSimilarToEdges(cg.queries, [{ source: a.id, target: b.id, score: 1.5 }]);
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: a similar_to score of exactly 1.0 is still flagged (bound is strict > 1)', async () => {
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
    });
    try {
      const a = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcOne' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const b = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcTwo' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      insertSimilarToEdges(cg.queries, [{ source: a.id, target: b.id, score: 1.0 }]);
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect((f.detail as { cloneType: string }).cloneType).toBe('semantic');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: a similar_to edge whose other end is not a clone candidate yields nothing', async () => {
    // funcOne is an in-scope candidate; tinyHelper is below the size
    // floor so it never enters the candidate set (byId). A high-cosine
    // edge between them must be dropped — BOTH ends have to be in scope.
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
      'src/tiny.ts': TINY_BODY,
    });
    try {
      const a = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcOne' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const tiny = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'tinyHelper' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      insertSimilarToEdges(cg.queries, [{ source: a.id, target: tiny.id, score: 0.99 }]);
      expect(findDuplicateCode(cg.queries, dir)).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: an edge linking ONE flagged node to an unflagged node adds no semantic finding', async () => {
    // a.ts + b.ts are an exact clone pair (both syntactically flagged);
    // c.ts (funcThree) is a unique, unflagged production fn. A semantic
    // edge from a flagged node to the unflagged one must be skipped —
    // the `flagged.has(src) || flagged.has(tgt)` guard fires when EITHER
    // end is already covered, so funcThree gets no semantic finding.
    const { dir, cg } = await makeProject({
      'src/a.ts': CLONE_BODY,
      'src/b.ts': CLONE_BODY,
      'src/c.ts': SEMANTIC_C,
    });
    try {
      const flagged = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'processItem' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      const unflagged = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'funcThree' AND kind = 'function' LIMIT 1`)
        .get() as { id: string };
      insertSimilarToEdges(cg.queries, [{ source: flagged.id, target: unflagged.id, score: 0.99 }]);
      const findings = findDuplicateCode(cg.queries, dir);
      // Only the two exact-clone findings; no semantic finding for funcThree.
      expect(findings.length).toBe(2);
      for (const f of findings) {
        expect((f.detail as { cloneType: string }).cloneType).toBe('exact');
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Tier 4: a 3-node similar_to chain forms one semantic class of three', async () => {
    // funcOne~funcTwo and funcTwo~funcThree edges union into a single
    // connected component — every member gets a finding whose class size
    // is 3 (exercises the union-find component grouping, not just pairs).
    const { dir, cg } = await makeProject({
      'src/a.ts': SEMANTIC_A,
      'src/b.ts': SEMANTIC_B,
      'src/c.ts': SEMANTIC_C,
    });
    try {
      const id = (name: string): string =>
        (
          cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = ? AND kind = 'function' LIMIT 1`).get(name) as {
            id: string;
          }
        ).id;
      insertSimilarToEdges(cg.queries, [
        { source: id('funcOne'), target: id('funcTwo'), score: 0.99 },
        { source: id('funcTwo'), target: id('funcThree'), score: 0.99 },
      ]);
      const findings = findDuplicateCode(cg.queries, dir);
      expect(findings.length).toBe(3);
      for (const f of findings) {
        const detail = f.detail as { cloneType: string; cloneClassSize: number; members: unknown[] };
        expect(detail.cloneType).toBe('semantic');
        expect(detail.cloneClassSize).toBe(3);
        expect(detail.members.length).toBe(2); // the two siblings
      }
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
