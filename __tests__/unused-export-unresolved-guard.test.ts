/**
 * Regression for issue #13 — `unused_export` must not emit a confident
 * "dead" verdict for a symbol that still has a PENDING unresolved
 * reference by its name.
 *
 * Resolution can be transiently incomplete: a partial / interrupted
 * sync, or two cartograph processes with different
 * EXTRACTION_LOGIC_VERSIONs thrashing the re-extract heal on one index,
 * can leave a real usage stranded in `unresolved_refs` with no edge yet.
 * Before the guard that surfaced as a false `unused_export` on a live
 * symbol (the same class the version-heal itself was built to fix) —
 * observed in the wild on `TimeoutHandle`/`IntervalHandle` in
 * src/sync/watcher.ts during the #5–#12 fix session.
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

describe('unused_export resolution-incompleteness guard (#13)', () => {
  it('does not flag a live symbol whose only usage is stranded in unresolved_refs', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-uue-guard-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      // TimeoutHandle is used via a same-file type annotation; useWatcher
      // is exported but never referenced (genuinely dead).
      fs.writeFileSync(
        path.join(dir, 'src', 'watcher.ts'),
        [
          'export interface TimeoutHandle { id: number; }',
          'export class Watcher { debounceTimer: TimeoutHandle | null = null; }',
          'export function useWatcher(): Watcher { return new Watcher(); }',
        ].join('\n'),
      );
      const cg = Cartograph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();

      // Baseline: fully resolved — only the genuine orphan is flagged.
      expect(findUnusedExports(cg.queries).map((r) => r.name)).toEqual(['useWatcher']);

      // Simulate incomplete resolution: drop the type_of edge to
      // TimeoutHandle and strand its reference back in unresolved_refs,
      // exactly the state a partial / thrashed re-extract leaves.
      const th = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'TimeoutHandle'`).get() as { id: string };
      const watcher = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'Watcher'`).get() as { id: string };
      cg.queries.db.prepare(`DELETE FROM edges WHERE target = ?`).run(th.id);
      cg.queries.db
        .prepare(
          `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
           VALUES (?, 'TimeoutHandle', 'type_of', 3, 30, 'src/watcher.ts', 'typescript')`,
        )
        .run(watcher.id);

      // The guard must suppress the false positive on TimeoutHandle while
      // still surfacing the genuine orphan (no matching unresolved ref).
      const flagged = findUnusedExports(cg.queries).map((r) => r.name);
      expect(flagged).not.toContain('TimeoutHandle');
      expect(flagged).toContain('useWatcher');

      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('structural / field_access unresolved refs do NOT mask a genuinely dead export', async () => {
    // The guard mirrors the rule's edge filter: a stranded `imports` ref
    // (structural) or a `.map`-style `field_access` ref must not suppress
    // a real dead-export finding.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-uue-guard2-'));
    try {
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function deadFn(): number { return 1; }\n');
      const cg = Cartograph.initSync(dir, { config: { include: ['src/**/*.ts'], exclude: [] } });
      await cg.indexAll();
      const dead = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'deadFn'`).get() as { id: string };

      // A field_access and an imports unresolved ref with the same name —
      // neither is a real symbol usage the rule counts.
      for (const kind of ['field_access', 'imports']) {
        cg.queries.db
          .prepare(
            `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
             VALUES (?, 'deadFn', ?, 1, 1, 'src/a.ts', 'typescript')`,
          )
          .run(dead.id, kind);
      }
      expect(findUnusedExports(cg.queries).map((r) => r.name)).toContain('deadFn');
      cg.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
