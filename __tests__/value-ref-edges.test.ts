/**
 * value-ref-edges hook (handoff #7): emit `references` edges for
 * bare-identifier callbacks and Zod-refine-style call arguments.
 *
 * Closes the dead-code false-positive class where a function passed
 * as `{key: fn}` or `refine(fn)` had no incoming graph edge at all
 * and `findDeadCode` / the `unused_export` biomarker mistakenly
 * flagged it as unreachable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
}

describe('value-ref-edges hook (handoff #7)', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-value-ref-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'value-ref-fixture', version: '0.0.0' }));
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Pull every references edge whose target points at the named symbol
   *  in the given file. The miner emits file→symbol edges, so the
   *  source is always the file node id. */
  function refsToSymbol(name: string, filePath: string): EdgeRow[] {
    const q = (
      cg as unknown as { queries: { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } } }
    ).queries;
    return q.db
      .prepare(
        `SELECT e.source, e.target, e.kind
         FROM edges e
         JOIN nodes n ON n.id = e.target
        WHERE e.kind = 'references'
          AND n.name = ?
          AND n.file_path = ?`,
      )
      .all(name, filePath) as EdgeRow[];
  }

  it('emits a `references` edge for a function passed as an object-literal property value', async () => {
    // The exact pattern that bit the prior session — see
    // src/build-context-refs/index.ts:98 in the real repo.
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `function lineHasHint(line: string): boolean { return line.length > 0; }\n` +
        `export const config = {\n` +
        `  lineMatches: lineHasHint,\n` +
        `};\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const refs = refsToSymbol('lineHasHint', 'src/a.ts');
    expect(refs.length).toBeGreaterThan(0);
    expect(refs[0]?.kind).toBe('references');
  });

  it('emits a `references` edge for a function passed as a call argument', async () => {
    // The Zod-refine pattern — see src/config.ts:327 in the real repo.
    fs.writeFileSync(
      path.join(dir, 'src', 'b.ts'),
      `function isSafe(pattern: string): boolean { return pattern.length < 500; }\n` +
        `function refine(_fn: (s: string) => boolean): void { /* no-op */ }\n` +
        `export function build(): void {\n` +
        `  refine(isSafe);\n` +
        `}\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const refs = refsToSymbol('isSafe', 'src/b.ts');
    expect(refs.length).toBeGreaterThan(0);
  });

  it('emits references edges for identifiers passed in any argument position, not just the first', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'c.ts'),
      `function helperA(): void {}\n` +
        `function helperB(): void {}\n` +
        `function applyMany(_a: () => void, _b: () => void): void {}\n` +
        `export function entry(): void {\n` +
        `  applyMany(helperA, helperB);\n` +
        `}\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    expect(refsToSymbol('helperA', 'src/c.ts').length).toBeGreaterThan(0);
    expect(refsToSymbol('helperB', 'src/c.ts').length).toBeGreaterThan(0);
  });

  it('does NOT emit a `references` edge for an identifier in a member-access / call position', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'd.ts'),
      `function helperX(): number { return 1; }\n` +
        `const obj = { value: 5 };\n` +
        `export function entry(): void {\n` +
        `  // bare member access - not value position\n` +
        `  const _x = obj.value;\n` +
        `  // call - already a calls edge, not a references edge\n` +
        `  helperX();\n` +
        `}\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // helperX is called, not passed as a value — should have NO
    // value-ref `references` edge from the file node. (It WILL have
    // a `calls` edge from entry → helperX, but that's not what we're
    // checking here.)
    const refs = refsToSymbol('helperX', 'src/d.ts');
    expect(refs.length).toBe(0);
  });

  it('skips reserved keywords like `if` / `return` / `typeof`', async () => {
    // The regex would otherwise capture `return(x)` as if `return`
    // were a function name. The JS_RESERVED_HEAD set guards against
    // that — but more importantly, even without the guard, `return`
    // doesn't resolve to a symbol so no edge is emitted. This test
    // just confirms the obvious path doesn't blow up.
    fs.writeFileSync(
      path.join(dir, 'src', 'e.ts'),
      `export function entry(x: number): number {\n` +
        `  if (x > 0) {\n` +
        `    return (x);\n` +
        `  }\n` +
        `  return x;\n` +
        `}\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // No assertion needed — the test passes if indexAll didn't throw.
    // Cover the shape: indexed file has the entry function.
    const q = (
      cg as unknown as { queries: { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[] } } } }
    ).queries;
    const rows = q.db.prepare(`SELECT name FROM nodes WHERE file_path = 'src/e.ts' AND name = 'entry'`).all();
    expect(rows.length).toBe(1);
  });

  it('does not hang on pathological newline-heavy content (bounded lookbehind, 2026-05-24c)', async () => {
    // Regression for the hang found in microsoft/TypeScript at
    // `tests/cases/fourslash/reallyLargeFile.ts` (583K lines of
    // `////`-prefixed comments + a final `verify(...)` call). With
    // the original unbounded `\s*` inside the value-ref-edges regex
    // lookbehinds, V8 walked backwards across every newline run on
    // every candidate position → O(n²) on the cleaned output. The
    // worker would hit the 120s per-worker timeout and silently drop
    // its survivor edges. Bounded `\s{0,200}` (MAX_WS_RUN in
    // value-ref-edges.ts) caps the walk while preserving multi-line
    // capability.
    //
    // The 100K newlines below scale the pathology down to test-fast
    // size: with the original regex this would take ~30-60s to scan;
    // with the bounded regex it completes in <1s. We also write a
    // real source file alongside so we can prove the hook still
    // emits edges on the non-pathological inputs.
    const pathologicalContent =
      `/// <reference path="fourslash.ts" />\n` + '////\n'.repeat(100_000) + `verify.foo("1");\n`;
    fs.writeFileSync(path.join(dir, 'src', 'large-fixture.ts'), pathologicalContent);
    fs.writeFileSync(
      path.join(dir, 'src', 'normal.ts'),
      `function realCallback(): void {}\n` + `export const cfg = { onChange: realCallback };\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });

    // bun:test's default per-test timeout is 30s (set in npm scripts).
    // With the bounded regex this completes in 2-5s on M-series; with
    // the unbounded regex this test times out (the fail mode we are
    // guarding against).
    await cg.indexAll({ summarize: false });

    // Prove the hook still emits real edges from the non-pathological
    // sibling file — completing the test isn't enough on its own.
    const refs = refsToSymbol('realCallback', 'src/normal.ts');
    expect(refs.length).toBeGreaterThan(0);
  });

  it('preserves multi-line `{ key:\\n  value }` matching near the 200-char whitespace bound', async () => {
    // Bounding `\s*` → `\s{0,200}` is only safe if 200 chars of
    // whitespace covers every realistic indented multi-line form.
    // Stress the bound directly: 180 chars of WHITESPACE (not
    // strip-removable comments) between `:` and the value. After
    // stripJsComments runs the whitespace stays, so the lookbehind
    // sees the full ~180-char run. Comfortably under 200 — proves
    // the bound has real headroom on indented forms.
    const headroomSpaces = ' '.repeat(180);
    fs.writeFileSync(
      path.join(dir, 'src', 'multiline.ts'),
      `function deepHandler(): void {}\n` +
        `export const cfg = {\n` +
        `  onChange:${headroomSpaces}deepHandler,\n` +
        `};\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    expect(refsToSymbol('deepHandler', 'src/multiline.ts').length).toBeGreaterThan(0);
  });

  it('closes the dead-code false-positive: findDeadCode no longer flags a callback-referenced function', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'f.ts'),
      `function notDead(): number { return 1; }\n` + `export const config = {\n` + `  callback: notDead,\n` + `};\n`,
    );
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // Before this hook existed, notDead would have appeared in
    // findDeadCode's output. With the hook emitting a file →
    // notDead `references` edge, the function has incoming
    // non-`contains` evidence and the rule no longer flags it.
    const deadCode = (
      cg as unknown as { internals: { graphManager: { findDeadCode: (kinds: string[]) => Array<{ name: string }> } } }
    ).internals.graphManager.findDeadCode(['function']);
    const flagged = deadCode.find((n) => n.name === 'notDead');
    expect(flagged).toBeUndefined();
  });
});
