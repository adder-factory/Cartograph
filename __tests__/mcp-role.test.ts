/**
 * Tests for `cartograph_role` input-validation — specifically the
 * mutual-exclusion guards (`role` / `symbol` / `symbols` are three
 * distinct modes; passing more than one is contradictory).
 *
 * Regression guard: those guards return `err(...)` (→ `isError: true`,
 * exit 1 on the CLI) — they previously returned `ok(textResult(...))`
 * (a SUCCESS result, exit 0), which let a caller mistake the advisory
 * for a real result. The CLI `role` command is generated from this
 * schema, so this handler is the single enforcement point.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('cartograph_role — mutual-exclusion guards', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-role-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
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

  it('errors (isError) when both `role` and `symbol` are supplied', async () => {
    const result = await handler.execute('cartograph_role', { role: 'util', symbol: 'alpha' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/not both/);
  });

  it('errors (isError) when both `symbol` and `symbols` are supplied', async () => {
    const result = await handler.execute('cartograph_role', { symbol: 'alpha', symbols: ['alpha'] });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text ?? '').toMatch(/not both/);
  });

  it('does NOT error for a single valid mode (`symbol` alone)', async () => {
    const result = await handler.execute('cartograph_role', { symbol: 'alpha' });
    expect(result.isError).toBeFalsy();
  });

  it('no-arg distribution scopes the denominator to classifier-target kinds (bug #12)', async () => {
    // Bug #12 regression guard: the no-arg distribution path USED to
    // fold every NULL-role node (file/import/constant/etc.) into the
    // percentage base, inflating the "unclassified %" by thousands of
    // nodes the classifier never targets. The fix scopes the denominator
    // to classifier-target kinds (function/method/class/interface/struct/
    // trait/protocol/component) and surfaces non-target NULL-role nodes
    // in a separate "intentionally not classified" disclosure footer.
    const result = await handler.execute('cartograph_role', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    // Header now names the scope explicitly so the agent can't misread
    // the percentages as project-wide-including-skipped.
    expect(text).toMatch(/classifier-target kinds only/);
    // Either the table appears (with our `alpha` function classified or
    // unclassified) or the empty-state lands. A fixture with at least
    // one function-kind node must include the alpha row in the table.
    if (!/No roles classified yet/.test(text)) {
      // The intentionally-skipped disclosure footer is what tells the
      // agent that file/import/constant counts are excluded by design.
      // On a tiny fixture there will be at least 1 `file` node + ≥1
      // `import` node — so the footer must fire.
      expect(text).toMatch(/intentionally not classified/);
    }
  });
});
