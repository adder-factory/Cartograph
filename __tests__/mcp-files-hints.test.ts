/**
 * cartograph_files — empty-result hint scenarios (handoff #5).
 *
 * Three sub-issues:
 *   (i)   Absolute path inside the project root silently returned
 *         "No files found". Now: emit a "did you mean…?" hint with
 *         the project-relative form.
 *   (ii)  The legacy `path` alias on the MCP schema (intended as a
 *         pre-rename compat shim) was never mirrored on the CLI.
 *         Now: dropped from the schema; passing `path` errors out
 *         at the Zod boundary.
 *   (iii) An unsupported glob construct like `[abc]` was silently
 *         treated as a literal character sequence (the implementation
 *         is a deliberate `*`/`?`/`**`-only simple-glob), so an
 *         honest agent expectation produced an empty result with no
 *         feedback. Now: detect unsupported constructs and emit a
 *         hint pointing at the supported syntax.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_files — empty-result hints (handoff #5)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cg-files-hints-')));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try {
      handler?.closeAll();
    } catch {
      /* ignore */
    }
    try {
      cg?.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // ── sub-i: absolute path inside project ──────────────────────────
  it('emits a "did you mean …?" hint when dir is an absolute path inside the project', async () => {
    const absoluteDir = path.join(tempDir, 'src');
    const result = await handler.runHandler('cartograph_files', { dir: absoluteDir });
    const text = textOf(result);
    expect(text).toContain('looks like an absolute path inside the project');
    expect(text).toContain('"src"');
    expect(text).toContain('Path filters are project-relative');
  });

  it('absolute path to the project root itself hints at omitting `dir`', async () => {
    const result = await handler.runHandler('cartograph_files', { dir: tempDir });
    const text = textOf(result);
    expect(text).toContain('looks like an absolute path inside the project');
    expect(text).toContain('(omit `dir`)');
  });

  // ── sub-ii: legacy `path` alias dropped ──────────────────────────
  it('rejects the dropped `path` alias at the schema boundary', async () => {
    const result = await handler.runHandler('cartograph_files', { path: 'src' });
    // The Zod schema no longer declares `path` — `safeParse` rejects
    // it as an unknown key (the registry wraps every tool in a
    // strict schema). The exact wording depends on the dispatch
    // layer, but it must be an error result and must NOT silently
    // succeed with src/ files (which would mean the alias still
    // works as `dir`).
    expect(result.isError).toBe(true);
  });

  // ── sub-iii: unsupported glob constructs ─────────────────────────
  it('hints at unsupported `[...]` character classes on empty pattern result', async () => {
    const result = await handler.runHandler('cartograph_files', { pattern: '[abc].ts' });
    const text = textOf(result);
    expect(text).toContain('No files found');
    expect(text).toContain('character classes');
    expect(text).toContain('Only `*` / `?` / `**`');
  });

  it('hints at unsupported `{a,b}` alternation on empty pattern result', async () => {
    const result = await handler.runHandler('cartograph_files', { pattern: '{a,b}.ts' });
    const text = textOf(result);
    expect(text).toContain('alternation');
  });

  it('hints at leading `!` negation on empty pattern result', async () => {
    const result = await handler.runHandler('cartograph_files', { pattern: '!*.ts' });
    const text = textOf(result);
    expect(text).toContain('negation');
  });

  it('explains when a pattern filters out an otherwise matching directory scope', async () => {
    const result = await handler.runHandler('cartograph_files', { dir: 'src', pattern: '**/*.md' });
    const text = textOf(result);
    expect(text).toContain('directory scope matched 1 file');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('filtered all of them out');
  });

  it('does NOT emit the unsupported-glob hint on a normal `*`/`**` pattern that matches', async () => {
    const result = await handler.runHandler('cartograph_files', { pattern: '**/*.ts' });
    const text = textOf(result);
    expect(text).toContain('a.ts');
    expect(text).not.toContain('unsupported');
  });
});
