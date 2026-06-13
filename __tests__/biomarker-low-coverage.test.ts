/**
 * Tests for the `low_coverage` cross-file biomarker. Validates that
 *   - it's silent when no coverage rows exist (so no-lcov projects
 *     never see a wall of false findings)
 *   - it emits `warning` when centrality clears the floor and coverage
 *     sits at or below the ceiling
 *   - it escalates to `error` when both signals are extreme
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { findLowCoverage } from '../src/biomarkers/low-coverage.js';
import { ingestCoverage } from '../src/coverage/index.js';
import { upsertNodeCoverage } from '../src/db/queries-coverage.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function makeProject(): Promise<{ dir: string; cg: Cartograph }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-low-cov-bm-'));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(
    path.join(dir, 'src', 'a.ts'),
    'export function alpha(): number { return 1; }\n' + 'export function beta(): number { return alpha() + 1; }\n',
  );
  fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  return { dir, cg };
}

describe('biomarker: low_coverage', () => {
  it('emits nothing when no coverage rows exist', async () => {
    const { dir, cg } = await makeProject();
    try {
      const findings = findLowCoverage(cg.queries);
      expect(findings).toEqual([]);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits warning for a high-centrality, low-coverage function', async () => {
    const { dir, cg } = await makeProject();
    try {
      // Find alpha and pin a centrality value above the floor.
      const alpha = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'alpha' AND kind = 'function' LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(alpha).toBeDefined();
      cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(0.01, alpha!.id);

      // 20% coverage — clears max-pct floor (50%) but not the error-tier (10%).
      upsertNodeCoverage(cg.queries, {
        nodeId: alpha!.id,
        source: 'unit',
        coveredLines: 1,
        totalLines: 5,
        coveredBranches: null,
        totalBranches: null,
        ingestedAt: Date.now(),
      });

      const findings = findLowCoverage(cg.queries);
      expect(findings.length).toBe(1);
      expect(findings[0]!.biomarker).toBe('low_coverage');
      expect(findings[0]!.severity).toBe('warning');
      expect(findings[0]!.metric).toBe(20);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('escalates to error when centrality is high AND coverage is very low', async () => {
    const { dir, cg } = await makeProject();
    try {
      const alpha = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'alpha' AND kind = 'function' LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(alpha).toBeDefined();
      cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(0.1, alpha!.id);

      upsertNodeCoverage(cg.queries, {
        nodeId: alpha!.id,
        source: 'unit',
        coveredLines: 0,
        totalLines: 10,
        coveredBranches: null,
        totalBranches: null,
        ingestedAt: Date.now(),
      });

      const findings = findLowCoverage(cg.queries);
      expect(findings.length).toBe(1);
      expect(findings[0]!.severity).toBe('error');
      expect(findings[0]!.metric).toBe(0);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ingestCoverage persists low_coverage findings without a manual biomarker pass', async () => {
    // Regression: `cartograph_biomarkers({mode: 'stats'})` used to miss
    // `low_coverage` findings after a coverage load until the next
    // index/sync ran the cross-file biomarker pass. Coverage ingest
    // now re-runs the rule inline so stats reflect the just-loaded
    // rows.
    const { dir, cg } = await makeProject();
    try {
      const alpha = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'alpha' AND kind = 'function' LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(alpha).toBeDefined();
      cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(0.01, alpha!.id);

      // Stretch the symbol's span so the synthetic lcov record below
      // overlaps every covered line — the makeProject() source has
      // single-line bodies that summariseSpan would otherwise score
      // as "totalLines === 0".
      cg.queries.db.prepare(`UPDATE nodes SET start_line = 1, end_line = 5 WHERE id = ?`).run(alpha!.id);

      // Write a real lcov report and ingest it through the public
      // entry point — this exercises the new refresh hook.
      const reportPath = path.join(dir, 'lcov.info');
      fs.writeFileSync(
        reportPath,
        ['TN:', 'SF:src/a.ts', 'DA:1,1', 'DA:2,0', 'DA:3,0', 'DA:4,0', 'DA:5,0', 'end_of_record'].join('\n'),
      );

      // No `low_coverage` rows exist yet — the rule is silent until
      // node_coverage has data.
      const before = cg.queries.db
        .prepare(`SELECT COUNT(*) AS n FROM code_health_findings WHERE biomarker = 'low_coverage'`)
        .get() as { n: number };
      expect(before.n).toBe(0);

      await ingestCoverage({
        queries: cg.queries,
        projectRoot: dir,
        reportPath,
        options: { source: 'unit' },
      });

      const after = cg.queries.db
        .prepare(`SELECT COUNT(*) AS n FROM code_health_findings WHERE biomarker = 'low_coverage'`)
        .get() as { n: number };
      // alpha's centrality clears the floor (0.001) and its coverage
      // pct (1/5 = 20%) is at or below the warning ceiling (50%) — so
      // exactly one row should land.
      expect(after.n).toBeGreaterThanOrEqual(1);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('ignores symbols below the RELATIVE centrality floor (issue #5)', async () => {
    // The bar is a percentile of the tested population, not an absolute
    // constant. A peripheral under-covered symbol is ignored while a
    // central under-covered symbol in the same project is flagged.
    const { dir, cg } = await makeProject();
    try {
      const alpha = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'alpha' AND kind = 'function' LIMIT 1`)
        .get() as { id: string } | undefined;
      const beta = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'beta' AND kind = 'function' LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();

      // alpha: top of the distribution + under-covered → flagged.
      // beta: bottom of the distribution + under-covered → ignored.
      cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(0.5, alpha!.id);
      cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(0.001, beta!.id);
      for (const id of [alpha!.id, beta!.id]) {
        upsertNodeCoverage(cg.queries, {
          nodeId: id,
          source: 'unit',
          coveredLines: 1,
          totalLines: 10,
          coveredBranches: null,
          totalBranches: null,
          ingestedAt: Date.now(),
        });
      }

      const flagged = new Set(findLowCoverage(cg.queries).map((f) => f.nodeId));
      expect(flagged.has(alpha!.id)).toBe(true);
      expect(flagged.has(beta!.id)).toBe(false);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags an under-covered component, not only function/method (issue #5)', async () => {
    // The old `kind IN ('function','method')` filter made components —
    // the dominant TS/TSX logic unit — permanently invisible.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-low-cov-comp-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'Card.tsx'),
      'export default function Card() {\n  return <section>hi</section>;\n}\n',
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const card = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'Card' AND kind = 'component' LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(card).toBeDefined();
      cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(0.1, card!.id);
      upsertNodeCoverage(cg.queries, {
        nodeId: card!.id,
        source: 'unit',
        coveredLines: 0,
        totalLines: 3,
        coveredBranches: null,
        totalBranches: null,
        ingestedAt: Date.now(),
      });

      const findings = findLowCoverage(cg.queries);
      expect(findings.map((f) => f.nodeId)).toContain(card!.id);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
