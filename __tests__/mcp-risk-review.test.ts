/**
 * MCP `cartograph_risk_review` — composed risk-triage report. Single
 * call returns biomarker findings, hotspots, low-coverage symbols,
 * and static dead-code candidates. The "where do I look first?"
 * entry point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

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
});
