/**
 * MCP `cartograph_risk_review` — composed risk-triage report. Single
 * call returns biomarker findings, hotspots, low-coverage symbols,
 * and static dead-code candidates. The "where do I look first?"
 * entry point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { appendFindings } from '../src/db/queries-findings.js';
import { upsertNodeCoverage } from '../src/db/queries-coverage.js';

const SCOPED_FINDING_METRIC = 40;
const UNRELATED_FINDING_METRIC = 41;
const UNCOVERED_LINES = 0;
const TOTAL_COVERAGE_LINES = 10;
const SCOPED_CENTRALITY = 0.8;
const UNRELATED_CENTRALITY = 0.9;
const SCOPED_COMMIT_COUNT = 10;
const UNRELATED_COMMIT_COUNT = 12;

function section(text: string, heading: string): string {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return '';
  const next = text.indexOf('\n## ', start + 1);
  return next < 0 ? text.slice(start) : text.slice(start, next);
}

describe('cartograph_risk_review MCP tool', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-risk-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    // A small project with a god_class biomarker (many methods on one
    // class) and a clearly orphaned function. Hotspots/coverage will
    // be empty — they degrade gracefully.
    //
    // The orphan lives in `aaa.ts` (file_path sorts ahead of big.ts)
    // and is NOT exported — `findOrphanedSymbols` filters
    // `is_exported = 0`, and the dead-code lens orders by
    // (file_path, start_line), so `neverCalled` deterministically
    // lands in slot 1 of the topN list ahead of Big's methods.
    const methods = Array.from({ length: 40 }, (_, i) => `  m${i}(): void { }`).join('\n');
    fs.writeFileSync(
      path.join(testDir, 'src', 'aaa.ts'),
      `function neverCalled(): number { return 1; }\nexport const KEEP = 1;\n`,
    );
    fs.writeFileSync(path.join(testDir, 'src', 'big.ts'), `export class Big {\n${methods}\n}\n`);
    fs.mkdirSync(path.join(testDir, 'src', 'scoped'));
    fs.mkdirSync(path.join(testDir, 'src', 'unrelated'));
    fs.writeFileSync(
      path.join(testDir, 'src', 'scoped', 'risk.ts'),
      `function scopedDead(): number { return 2; }\nexport const SCOPED_KEEP = 2;\n`,
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'unrelated', 'risk.ts'),
      `function unrelatedDead(): number { return 3; }\nexport const UNRELATED_KEEP = 3;\n`,
    );
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('emits all five lenses with the expected section headers', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'risk', topN: 3 });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/# Risk review/);
    expect(text).toMatch(/## Biomarker findings/);
    expect(text).toMatch(/## Hotspots/);
    expect(text).toMatch(/## Coverage gaps/);
    expect(text).toMatch(/## Structural bridges/);
    expect(text).toMatch(/## Dead-code candidates/);
  });

  it('Structural bridges lens degrades gracefully when no betweenness data', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'risk' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/enableBetweenness: true/);
  });

  it('mode=agent-audit renders the agent-prone lens with per-detector grouping (G26-P3)', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'agent-audit' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/# Agent-audit review/);
    // The fixture has no agent-prone findings — but the rollup line
    // still confirms the audit ran.
    expect(text).toMatch(/Audited 16 detectors\./);
  });

  it('mode=agent-audit honours minSeverity filter (G26-P3)', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'agent-audit', minSeverity: 'error' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/min-severity: `error`/);
  });

  it('mode=trust renders freshness, coverage, biomarker, dead-code, and LLM checks', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'trust' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/# Trust self-check/);
    expect(text).toMatch(/Freshness/);
    expect(text).toMatch(/Coverage/);
    expect(text).toMatch(/Cross-file biomarkers/);
    expect(text).toMatch(/Dead-code signal/);
    expect(text).toMatch(/Ask\/dead-code LLM/);
  });

  it('degrades gracefully when coverage data is missing', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'risk' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/coverage --mode load --report-path <lcov>/);
  });

  it('surfaces the orphaned function as a dead-code candidate', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'risk', topN: 10 });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/neverCalled/);
  });

  it('respects topN per lens', async () => {
    const r = await handler.execute('cartograph_review', { mode: 'risk', topN: 1 });
    const text = r.content[0]?.text ?? '';
    // Each lens should have at most 1 row. Count `^- ` (bullet) lines
    // per section by splitting on H2 headers.
    const sections = text.split(/^## /m).slice(1);
    for (const s of sections) {
      const bullets = s.split('\n').filter((l) => l.startsWith('- ')).length;
      expect(bullets).toBeLessThanOrEqual(1);
    }
  });

  it('mode=risk pathFilter excludes unrelated paths from scoped risk lenses', async () => {
    seedPathFilterRiskRows(cg);
    const r = await handler.execute('cartograph_review', {
      mode: 'risk',
      topN: 10,
      pathFilter: 'src/scoped/',
      coverageSource: 'unit',
    });
    const text = r.content[0]?.text ?? '';

    expect(text).toContain('_pathFilter: `src/scoped/`_');

    const biomarkers = section(text, 'Biomarker findings');
    expect(biomarkers).toContain('scopedDead');
    expect(biomarkers).not.toContain('unrelatedDead');

    const hotspots = section(text, 'Hotspots');
    expect(hotspots).toContain('src/scoped/risk.ts');
    expect(hotspots).not.toContain('src/unrelated/risk.ts');

    const coverage = section(text, 'Coverage gaps');
    expect(coverage).toContain('scopedDead');
    expect(coverage).not.toContain('unrelatedDead');

    const deadCode = section(text, 'Dead-code candidates');
    expect(deadCode).toContain('scopedDead');
    expect(deadCode).not.toContain('unrelatedDead');
    expect(deadCode).not.toContain('neverCalled');
  });
});

function nodeId(cg: Cartograph, name: string): string {
  const row = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = ? LIMIT 1`).get(name) as
    | { id: string }
    | undefined;
  if (!row) throw new Error(`test fixture missing node ${name}`);
  return row.id;
}

function seedPathFilterRiskRows(cg: Cartograph): void {
  const scopedId = nodeId(cg, 'scopedDead');
  const unrelatedId = nodeId(cg, 'unrelatedDead');
  appendFindings(
    cg.queries,
    [
      { nodeId: scopedId, biomarker: 'large_method', severity: 'warning', metric: SCOPED_FINDING_METRIC },
      { nodeId: unrelatedId, biomarker: 'large_method', severity: 'warning', metric: UNRELATED_FINDING_METRIC },
    ],
    'full-pass',
  );
  const now = Date.now();
  upsertNodeCoverage(cg.queries, {
    nodeId: scopedId,
    source: 'unit',
    coveredLines: UNCOVERED_LINES,
    totalLines: TOTAL_COVERAGE_LINES,
    coveredBranches: null,
    totalBranches: null,
    ingestedAt: now,
  });
  upsertNodeCoverage(cg.queries, {
    nodeId: unrelatedId,
    source: 'unit',
    coveredLines: UNCOVERED_LINES,
    totalLines: TOTAL_COVERAGE_LINES,
    coveredBranches: null,
    totalBranches: null,
    ingestedAt: now,
  });
  cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(SCOPED_CENTRALITY, scopedId);
  cg.queries.db.prepare(`UPDATE nodes SET centrality = ? WHERE id = ?`).run(UNRELATED_CENTRALITY, unrelatedId);
  cg.queries.db
    .prepare(`UPDATE files SET commit_count = ? WHERE path = ?`)
    .run(SCOPED_COMMIT_COUNT, 'src/scoped/risk.ts');
  cg.queries.db
    .prepare(`UPDATE files SET commit_count = ? WHERE path = ?`)
    .run(UNRELATED_COMMIT_COUNT, 'src/unrelated/risk.ts');
}
