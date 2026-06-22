/**
 * Regression for issue #51 — `unused_export` must not flag a live
 * TypeScript `type_alias` that shares its name with an exported value
 * companion in the same file (the branded-ID / parse-boundary pattern).
 *
 * TypeScript has separate value and type namespaces, so a file can export
 * `const UserId = …` and `type UserId = …`. A consumer's `import { UserId,
 * type UserId }` use of the TYPE frequently resolves to the same-name
 * VALUE node, leaving the `type_alias` with no incoming edge — a false
 * "dead" verdict even though the type is imported and used. The guard in
 * `findUnusedExports` spares the alias when a same-name exported value in
 * the same file has real (non-structural) usage; a genuinely-dead type
 * with no live value twin still surfaces.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { findUnusedExports } from '../src/db/queries-biomarkers-graph.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('unused_export value/type same-name guard (#51)', () => {
  it('spares a type alias with a used same-name value twin, still flags a dead type', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vt-pair-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'ids.ts'),
        [
          'const branded = <B extends string>(_brand: B) => ({',
          '  parse: (value: string) => value as string & { readonly __brand: B },',
          '});',
          'export const UserId = branded("UserId");',
          'export type UserId = ReturnType<typeof UserId.parse>;',
          'export type DeadType = { readonly id: string };',
        ].join('\n'),
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'consumer.ts'),
        [
          'import { UserId, type UserId as UserIdType } from "./ids.js";',
          'export function parseUserId(raw: string): UserIdType {',
          '  return UserId.parse(raw);',
          '}',
        ].join('\n'),
      );
      const cg = Cartograph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();

      const flagged = findUnusedExports(cg.queries).map((r) => r.name);

      // The live value/type pair: the `UserId` type alias must NOT be flagged.
      expect(flagged).not.toContain('UserId');
      // A type with no live value twin is still genuinely dead.
      expect(flagged).toContain('DeadType');

      // Guard against a vacuous pass: confirm the scenario is the intended
      // one — a same-name exported value companion exists AND has a
      // non-structural incoming edge (so the alias is spared by the guard,
      // not merely because it happened to get its own edge).
      const valueTwin = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'UserId' AND file_path = 'src/ids.ts' AND kind != 'type_alias'`)
        .get() as { id: string } | undefined;
      expect(valueTwin).toBeDefined();
      const twinUsage = cg.queries.db
        .prepare(
          `SELECT 1 FROM edges WHERE target = ? AND kind NOT IN ('contains','exports','imports','tests') LIMIT 1`,
        )
        .get(valueTwin!.id);
      expect(twinUsage).toBeDefined();

      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still flags a dead type alias whose same-name value twin is itself unused', async () => {
    // The guard requires the value twin to have real CROSS-FILE usage. If the
    // twin is also dead, the alias is not spared (no false negative for a
    // truly dead value/type pair).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vt-pair2-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'ids.ts'),
        ['export const Orphan = { parse: (v: string) => v };', 'export type Orphan = string;'].join('\n'),
      );
      const cg = Cartograph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();
      // Neither the value nor the type is used anywhere → both stay flaggable.
      expect(findUnusedExports(cg.queries).map((r) => r.name)).toContain('Orphan');
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('still flags a dead type whose value twin has only SAME-FILE usage (no over-suppression)', async () => {
    // Codex review of #51: a same-file value-only use is no evidence the TYPE
    // is consumed anywhere, so the guard must NOT spare it. Only cross-file
    // usage of the value twin (the import-mis-resolution scenario) counts.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vt-localonly-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'ids.ts'),
        [
          'export const Foo = () => 1;',
          'export type Foo = string;',
          'function local() { return Foo(); }', // same-file value use only
          'export function useLocal() { return local(); }',
        ].join('\n'),
      );
      const cg = Cartograph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();
      // The Foo TYPE is genuinely dead (no cross-file consumer) → still flagged.
      const flagged = findUnusedExports(cg.queries).filter((r) => r.name === 'Foo' && r.kind === 'type_alias');
      expect(flagged.length).toBe(1);
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('spares an interface with a cross-file-used same-name value twin (Gemini review)', async () => {
    // The same value/type namespace collision affects `interface`, not just
    // `type_alias` (e.g. a const object + same-name interface).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-vt-iface-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src', 'box.ts'),
        ['export const Box = { make: () => ({ v: 1 }) };', 'export interface Box { v: number; }'].join('\n'),
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'consumer.ts'),
        [
          'import { Box, type Box as BoxType } from "./box.js";',
          'export function makeBox(): BoxType { return Box.make(); }',
        ].join('\n'),
      );
      const cg = Cartograph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();
      expect(findUnusedExports(cg.queries).map((r) => r.name)).not.toContain('Box');
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
