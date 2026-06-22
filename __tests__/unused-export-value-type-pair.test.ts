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
    // The guard requires the value twin to have REAL usage. If the twin is
    // also dead, the alias is not spared (no false negative for a truly
    // dead value/type pair).
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
});
