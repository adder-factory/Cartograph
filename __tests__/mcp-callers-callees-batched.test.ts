import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function textOf(result: Awaited<ReturnType<ToolHandler['execute']>>): string {
  return result.content[0]?.text ?? '';
}

describe('cartograph_graph callers/callees batched behavior', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callers-callees-batch-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src', 'helpers.ts'),
      [
        'export function target() { return 1; }',
        'export function helperA() { return 2; }',
        'export function helperB() { return 3; }',
        'export function paint() { return 4; }',
        'export function clean() { return 5; }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'callers.ts'),
      [
        'import { target, helperA, helperB } from "./helpers.js";',
        'export function alpha() {',
        '  helperA();',
        '  helperB();',
        '  return target();',
        '}',
        'export function omega() { return target(); }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'widget.ts'),
      [
        'import { paint, clean } from "./helpers.js";',
        'export class Widget {',
        '  render() { return paint(); }',
        '  reset() { return clean(); }',
        '}',
      ].join('\n') + '\n',
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
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('points container callee queries at callable child methods', async () => {
    const text = textOf(await handler.execute('cartograph_graph', { direction: 'callees', start: 'Widget' }));

    expect(text).toContain('"Widget" is a class');
    expect(text).toContain('callees live on its methods');
    expect(text).toContain('render');
    expect(text).toContain('reset');
    expect(text).toContain("direction: 'callees'");
  });

  it('groups batched callees per source symbol and keeps overflow local to each section', async () => {
    const text = textOf(
      await handler.execute('cartograph_graph', {
        direction: 'callees',
        symbols: ['alpha', 'omega'],
        limit: 3,
      }),
    );

    expect(text).toContain('# Callees — 2 symbols queried');
    expect(text).toContain('### alpha');
    expect(text).toContain('## Callees of alpha');
    expect(text).toContain('helperA');
    expect(text).toContain('helperB');
    expect(text).toContain('target');
    expect(text).toContain('### omega');
    expect(text).toContain('## Callees of omega');
    expect(text).toContain('pass as `since` for delta-only follow-ups');
  });

  it('renders valid and missing symbols in one batched callers response', async () => {
    const text = textOf(
      await handler.execute('cartograph_graph', {
        direction: 'callers',
        symbols: ['target', 'MissingSymbol'],
        limit: 5,
      }),
    );

    expect(text).toContain('## Callers of target');
    expect(text).toContain('alpha');
    expect(text).toContain('omega');
    expect(text).toContain('### MissingSymbol');
    expect(text).toContain('Symbol "MissingSymbol" not found in the codebase');
  });
});
