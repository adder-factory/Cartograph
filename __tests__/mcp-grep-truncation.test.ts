/**
 * `cartograph_grep` truncation fairness — when the per-call limit is
 * smaller than the total match count, every file with hits should
 * surface in the result (round-robin), not just the file with the
 * most matches. Regression guard for the bias caught during the
 * cartograph-vs-grep gap analysis: `CREATE TABLE` returned 16 hits
 * all in test files and missed `src/db/schema.sql` (the canonical
 * 25-table file) at default limits because dominant-occurrence
 * files consumed the budget first.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('cartograph_grep truncation fairness', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-grep-trunc-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // Dominant file: 12 occurrences of NEEDLE
    const dominant = Array.from({ length: 12 }, (_, i) => `// NEEDLE ${i}`).join('\n');
    fs.writeFileSync(path.join(dir, 'src', 'dominant.ts'), dominant + '\nexport const X = 1;\n');
    // 5 sparse files with 1 occurrence each — these would be buried
    // under the prior depth-first truncation but should surface with
    // round-robin allocation.
    for (let i = 1; i <= 5; i++) {
      fs.writeFileSync(path.join(dir, 'src', `sparse${i}.ts`), `export const Y${i} = 1; // NEEDLE\n`);
    }
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces sparse files even when a dominant file has more matches than fit', async () => {
    // Total matches: 12 (dominant) + 5 (sparse) = 17.
    // With limit=10, the prior depth-first sweep would have grabbed
    // 10 from dominant.ts and never reached sparse{1..5}.ts. Round-
    // robin should give each sparse file its 1 hit before dominant
    // gets more than ~5.
    const result = await handler.execute('cartograph_find', { by: 'content', query: 'NEEDLE', limit: 10 });
    const text = result.content[0]?.text ?? '';

    // All five sparse files should appear in the truncated output.
    for (let i = 1; i <= 5; i++) {
      expect(text).toContain(`sparse${i}.ts`);
    }
    // Dominant file is also present, just not hogging the whole budget.
    expect(text).toContain('dominant.ts');
    // Truncation indicator fires (more hits than the limit).
    expect(text).toMatch(/Truncated at `limit=10`/);
  });

  it('surfaces all hits when limit exceeds total matches', async () => {
    const result = await handler.execute('cartograph_find', { by: 'content', query: 'NEEDLE', limit: 50 });
    const text = result.content[0]?.text ?? '';
    // Every file appears.
    expect(text).toContain('dominant.ts');
    for (let i = 1; i <= 5; i++) {
      expect(text).toContain(`sparse${i}.ts`);
    }
    // No truncation note when nothing was truncated.
    expect(text).not.toMatch(/Truncated at/);
  });

  it('reports a "X of N+" honest count when truncated', async () => {
    // Total matches are 17 (12 dominant + 5 sparse), but the per-file
    // scanner stops counting when it fills its memory cap (per-file
    // cap = limit = 10), so the reported tally reflects what was
    // scanned, not the absolute total. The trailing `+` flags the
    // truncation. What matters: the count is greater than the
    // returned hits and the `+` is present so the agent knows to
    // raise limit.
    const result = await handler.execute('cartograph_find', { by: 'content', query: 'NEEDLE', limit: 10 });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/10 of \d+\+ hits/);
  });
});
