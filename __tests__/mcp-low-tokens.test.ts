/**
 * `lowTokens` MCP option — shared opt-in for compact agent output.
 *
 * The individual tools already expose lower-level knobs (`compact`,
 * `fields`, `summary`, `code:false`). These tests guard the convenience
 * switch that maps onto those knobs without changing default behaviour.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]?.text ?? '';
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function expectTokenBudget(text: string, maxTokens: number): void {
  expect(approxTokens(text)).toBeLessThanOrEqual(maxTokens);
}

describe('MCP lowTokens option', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-low-tokens-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'core.ts'),
      [
        'export function alpha(): number { return 1; }',
        'export function beta(): number { return alpha(); }',
        'export function gamma(): number { return beta() + alpha(); }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'consumer.ts'),
      "import { alpha } from './core';\nexport const delta = alpha();\n",
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
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('cartograph_find lowTokens compacts exact name rows', async () => {
    const text = textOf(await handler.execute('cartograph_find', { by: 'name', query: 'alpha', lowTokens: true }));

    expect(text).toMatch(/^Search Results \(/);
    expect(text).toMatch(/alpha\|function\|src\/core\.ts:1\|id:n_[0-9a-f]{8}/);
    expect(text).not.toMatch(/^## Search Results/m);
    expect(text).not.toMatch(/^### alpha/m);
    expect(text).not.toContain('sig:');
    expectTokenBudget(text, 220);
  });

  it('server lowTokensDefault compacts supported tools when caller omits lowTokens', async () => {
    const lowDefaultHandler = new ToolHandler(cg, { lowTokensDefault: true });
    const text = textOf(await lowDefaultHandler.execute('cartograph_find', { by: 'name', query: 'alpha' }));

    expect(text).toMatch(/^Search Results \(/);
    expect(text).toMatch(/alpha\|function\|src\/core\.ts:1\|id:n_[0-9a-f]{8}/);
    expect(text).not.toMatch(/^## Search Results/m);
  });

  it('explicit lowTokens false wins over the server lowTokensDefault', async () => {
    const lowDefaultHandler = new ToolHandler(cg, { lowTokensDefault: true });
    const text = textOf(
      await lowDefaultHandler.execute('cartograph_find', { by: 'name', query: 'alpha', lowTokens: false }),
    );

    expect(text).toMatch(/^## Search Results/m);
    expect(text).toMatch(/^### alpha/m);
    expect(text).not.toMatch(/alpha\|function\|src\/core\.ts:1\|id:n_[0-9a-f]{8}/);
  });

  it('server lowTokensDefault leaves unsupported tools unchanged', async () => {
    const lowDefaultHandler = new ToolHandler(cg, { lowTokensDefault: true });
    const text = textOf(await lowDefaultHandler.execute('cartograph_status', {}));

    expect(text).toMatch(/Server config/);
    expect(text).toMatch(/Default `lowTokens`.*true/);
    expect(text).not.toMatch(/Unknown argument.*lowTokens/);
  });

  it('cartograph_find lowTokens does not inject exact-only compact args into fuzzy mode', async () => {
    const text = textOf(
      await handler.execute('cartograph_find', { by: 'name', mode: 'fuzzy', query: 'alpa', lowTokens: true }),
    );

    expect(text).toMatch(/^## Fuzzy search/);
    expect(text).not.toContain("`compact` / `fields` require `mode: 'exact'`");
    expectTokenBudget(text, 300);
  });

  it('cartograph_graph lowTokens compacts one-hop callers', async () => {
    const text = textOf(
      await handler.execute('cartograph_graph', { direction: 'callers', start: 'alpha', lowTokens: true }),
    );

    expect(text).toMatch(/^Callers of alpha \(/);
    expect(text).toMatch(/gamma\|function\|src\/core\.ts:3\|id:n_[0-9a-f]{8}/);
    expect(text).not.toMatch(/^- gamma /m);
    expectTokenBudget(text, 260);
  });

  it('cartograph_context lowTokens suppresses code snippets', async () => {
    const text = textOf(await handler.execute('cartograph_context', { task: 'alpha', lowTokens: true }));

    expect(text).toContain('## Code Context');
    expect(text).not.toContain('```typescript');
    expectTokenBudget(text, 1_200);
  });

  it('cartograph_context accepts query as a task alias', async () => {
    const text = textOf(await handler.execute('cartograph_context', { query: 'alpha', lowTokens: true }));

    expect(text).toContain('## Code Context');
    expect(text).toContain('**Query:** alpha');
  });

  it('cartograph_context reports blank task or query as a clean tool error', async () => {
    const result = await handler.execute('cartograph_context', { task: '   ' });
    const text = textOf(result);

    expect(result.isError).toBe(true);
    expect(text).toContain('requires `task` or `query`');
  });

  it('cartograph_context format:plan emits route calls and nextActions metadata', async () => {
    const result = await handler.execute('cartograph_context', { task: 'alpha', format: 'plan', maxNodes: 5 });
    const text = textOf(result);

    expect(text).toContain('## Context route plan');
    expect(text).toContain('cartograph_node');
    expect(text).toContain('cartograph_tests_for');
    expect(text).not.toContain('```typescript');
    expect(result.metadata?.nextActions?.some((action) => action.tool === 'cartograph_node')).toBe(true);
  });

  it('cartograph_explore lowTokens switches to summary-only output', async () => {
    const text = textOf(await handler.execute('cartograph_explore', { query: 'alpha', lowTokens: true }));

    expect(text).toContain('_Summary mode: source-code blocks suppressed');
    expect(text).toContain('defines:');
    expect(text).not.toContain('```typescript');
    expectTokenBudget(text, 1_000);
  });

  it('cartograph_at_range lowTokens emits compact projected rows', async () => {
    const text = textOf(
      await handler.execute('cartograph_at_range', {
        file: 'src/core.ts',
        startLine: 1,
        endLine: 1,
        lowTokens: true,
      }),
    );

    expect(text).toContain('## Symbols overlapping src/core.ts:1-1');
    expect(text).toMatch(/alpha\|function\|src\/core\.ts:1/);
    expect(text).not.toContain('| Kind | Name | Lines | Signature |');
    expect(text).not.toContain('sig:');
    expectTokenBudget(text, 220);
  });

  it('cartograph_node lowTokens caps batched symbols and keeps cards metadata-only', async () => {
    const symbols = ['alpha', 'beta', 'gamma', 'delta', 'alpha', 'beta', 'gamma', 'delta', 'alpha', 'beta'];
    const text = textOf(await handler.execute('cartograph_node', { symbols, lowTokens: true }));

    expect(text).toMatch(/^# \d+ symbols? resolved/);
    expect(text).toContain('omitted by lowTokens cap');
    expect(text).not.toContain('```typescript');
    expectTokenBudget(text, 700);
  });

  it('cartograph_files lowTokens defaults to summary output with shallow metadata-free rows', async () => {
    const text = textOf(await handler.execute('cartograph_files', { lowTokens: true }));

    expect(text).toContain('## Project Summary');
    expect(text).toContain('| Directory | Files | Symbols |');
    expect(text).not.toContain('## Project Structure');
    expect(text).not.toContain('(typescript,');
    expectTokenBudget(text, 260);
  });

  it('cartograph_imports lowTokens keeps the import audit bounded', async () => {
    const text = textOf(await handler.execute('cartograph_imports', { lowTokens: true }));

    expect(text).toContain('## Imports');
    expect(text).toContain('src/consumer.ts:1');
    expect(text).toContain('"./core"');
    expectTokenBudget(text, 260);
  });
});
