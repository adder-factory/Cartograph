/**
 * cartograph_files --format=summary (B15). Per-directory rollup of
 * file + symbol counts, sorted by symbol density. Lets the agent
 * see "where the bulk of the code lives" without paying for the
 * full file list.
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

describe('cartograph_files --format=summary (B15)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-summary-'));
    fs.mkdirSync(path.join(tempDir, 'src/dense'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src/sparse'), { recursive: true });
    // dense/ files: many exports each. sparse/ files: one export.
    // Total dense > total sparse so dense should rank first.
    fs.writeFileSync(
      path.join(tempDir, 'src/dense/heavy.ts'),
      Array.from({ length: 20 }, (_, i) => `export function fn${i}(): number { return ${i}; }`).join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/dense/medium.ts'),
      Array.from({ length: 10 }, (_, i) => `export function mid${i}(): number { return ${i}; }`).join('\n'),
    );
    fs.writeFileSync(path.join(tempDir, 'src/sparse/light.ts'), 'export function only(): number { return 1; }\n');
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* ignore */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits a summary table with directory rollups', async () => {
    const text = textOf(await handler.runHandler('cartograph_files', { format: 'summary' }));
    expect(text).toContain('Project Summary');
    expect(text).toContain('| Directory | Files | Nodes |');
    expect(text).toContain('`src/`');
    expect(text).toContain('`src/dense/`');
    expect(text).toContain('`src/sparse/`');
  });

  it('rolls up subtree counts at every ancestor directory level', async () => {
    const text = textOf(await handler.runHandler('cartograph_files', { format: 'summary' }));
    // src/ should aggregate dense/ + sparse/. The exact symbol
    // count varies by what tree-sitter extracts (function nodes +
    // file nodes etc.), but src/ MUST have ≥ each child's count.
    const m = (re: RegExp): number | null => {
      const match = re.exec(text);
      return match ? Number(match[1]) : null;
    };
    const srcSymbols = m(/\| `src\/` \| \d+ \| (\d+) \|/);
    const denseSymbols = m(/\| `src\/dense\/` \| \d+ \| (\d+) \|/);
    const sparseSymbols = m(/\| `src\/sparse\/` \| \d+ \| (\d+) \|/);
    expect(srcSymbols).not.toBeNull();
    expect(denseSymbols).not.toBeNull();
    expect(sparseSymbols).not.toBeNull();
    expect(srcSymbols!).toBeGreaterThanOrEqual(denseSymbols! + sparseSymbols!);
  });

  it('symbol counts exclude the per-file `file` node (F15)', async () => {
    const text = textOf(await handler.runHandler('cartograph_files', { format: 'summary' }));
    const m = (re: RegExp): number | null => {
      const match = re.exec(text);
      return match ? Number(match[1]) : null;
    };
    // light.ts defines exactly one symbol (`only`). The reported count
    // must be 1, not 2 — the file's own `kind='file'` node is a file,
    // not a symbol, so it must not inflate the "symbols" figure.
    expect(m(/\| `src\/sparse\/` \| \d+ \| (\d+) \|/)).toBe(1);
    // dense/: heavy.ts (20 fns) + medium.ts (10 fns) = 30 symbols
    // exactly — two file nodes excluded.
    expect(m(/\| `src\/dense\/` \| \d+ \| (\d+) \|/)).toBe(30);
  });

  it('sorts directories by symbol density descending (densest first)', async () => {
    const text = textOf(await handler.runHandler('cartograph_files', { format: 'summary' }));
    const denseIdx = text.indexOf('`src/dense/`');
    const sparseIdx = text.indexOf('`src/sparse/`');
    expect(denseIdx).toBeGreaterThan(0);
    expect(sparseIdx).toBeGreaterThan(0);
    // dense has 30 symbols (heavy + medium), sparse has 1 → dense
    // must appear earlier in the table.
    expect(denseIdx).toBeLessThan(sparseIdx);
  });

  it('respects maxDepth — deeper directories are not rolled up', async () => {
    fs.mkdirSync(path.join(tempDir, 'src/deep/nested'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/deep/nested/deeper.ts'), 'export function deep(): number { return 1; }\n');
    await cg.sync();
    const text = textOf(await handler.runHandler('cartograph_files', { format: 'summary', maxDepth: 1 }));
    // Top-level src/ rolls up everything, but src/deep/ and
    // src/deep/nested/ shouldn't appear with maxDepth=1.
    expect(text).toContain('`src/`');
    expect(text).not.toContain('`src/deep/`');
    expect(text).not.toContain('`src/deep/nested/`');
  });

  it('default format remains tree (no breaking change for callers without `format`)', async () => {
    const text = textOf(await handler.runHandler('cartograph_files', {}));
    expect(text).toContain('Project Structure');
    expect(text).not.toContain('Project Summary');
  });

  it('keeps the dirFilter row + its descendants but drops strict ancestors (friction-N regression)', async () => {
    // Add a sub-directory under src/dense so we can prove the
    // dirFilter row AND its descendants render. With dir='src/dense'
    // the rollup must include `src/dense/` (the filtered scope) and
    // `src/dense/inner/` (descendant) but NOT `src/` (strict ancestor).
    fs.mkdirSync(path.join(tempDir, 'src/dense/inner'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/dense/inner/extra.ts'), 'export function inner(): number { return 1; }\n');
    await cg.sync();
    const text = textOf(await handler.runHandler('cartograph_files', { dir: 'src/dense', format: 'summary' }));
    expect(text).toContain('Subtree Summary');
    // The dirFilter's own row must be present — this is the bug fix.
    expect(text).toContain('`src/dense/`');
    // Descendant rows must be present.
    expect(text).toContain('`src/dense/inner/`');
    // Strict-ancestor rows must remain suppressed.
    expect(text).not.toMatch(/\| `src\/` \|/);
    // The dirFilter row's file count must reflect the in-scope subtree
    // (heavy.ts, medium.ts, inner/extra.ts = 3 files), not stay empty.
    const denseRowRe = /\| `src\/dense\/` \| (\d+) \| \d+ \|/;
    const m = denseRowRe.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(3);
  });

  it('renders a non-empty rollup for a leaf-directory dirFilter (no descendants)', async () => {
    // src/sparse contains exactly one file and no subdirectories.
    // The pre-fix bug suppressed the row whose path EQUALED the
    // dirFilter, leaving the table with only column headers.
    const text = textOf(await handler.runHandler('cartograph_files', { dir: 'src/sparse', format: 'summary' }));
    expect(text).toContain('Subtree Summary');
    expect(text).toContain('`src/sparse/`');
    const sparseRowRe = /\| `src\/sparse\/` \| (\d+) \| \d+ \|/;
    const m = sparseRowRe.exec(text);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBe(1);
  });

  it('dir filter does NOT match a sibling file sharing the path prefix (friction-AC regression)', async () => {
    // `src/dense.ts` is a SIBLING of the directory `src/dense/`.
    // A literal `path.startsWith('src/dense')` filter would wrongly
    // capture it, inflating the header file-count above the rollup
    // row count. A segment-boundary match must exclude it.
    fs.writeFileSync(path.join(tempDir, 'src/dense.ts'), 'export function sibling(): number { return 1; }\n');
    await cg.sync();
    const text = textOf(await handler.runHandler('cartograph_files', { dir: 'src/dense', format: 'summary' }));
    // The sibling file must NOT appear in the dir='src/dense' scope.
    expect(text).not.toContain('src/dense.ts');
    // Header file count must EQUAL the `src/dense/` rollup row count
    // (heavy.ts + medium.ts = 2 files) — they must agree, not drift.
    const headerRe = /## Subtree Summary — `src\/dense\/` \((\d+) files,/;
    const headerMatch = headerRe.exec(text);
    expect(headerMatch).not.toBeNull();
    expect(Number(headerMatch![1])).toBe(2);
    const denseRowRe = /\| `src\/dense\/` \| (\d+) \| \d+ \|/;
    const rowMatch = denseRowRe.exec(text);
    expect(rowMatch).not.toBeNull();
    expect(Number(rowMatch![1])).toBe(2);
    // The flat listing of the same filter must also exclude the sibling.
    const flat = textOf(await handler.runHandler('cartograph_files', { dir: 'src/dense', format: 'flat' }));
    expect(flat).not.toContain('src/dense.ts');
    expect(flat).toContain('src/dense/heavy.ts');
  });

  it('emits a `(root)` bucket for project-root files so the rollup reconciles with status', async () => {
    // Add a project-root file (no directory ancestor). Without the
    // root bucket the directory rollups would sum to N-1 instead of
    // N, which is the friction that originally surfaced this gap
    // (cartograph_files summary said 612 files vs cartograph_status's
    // 617 — the missing 5 were project-root files).
    fs.writeFileSync(path.join(tempDir, 'root-script.ts'), 'export function rootFn(): number { return 1; }\n');
    await cg.sync();
    const text = textOf(await handler.runHandler('cartograph_files', { format: 'summary' }));
    expect(text).toContain('`(root)`');
    // The (root) row has 1 file (root-script.ts).
    const rootRowRe = /\| `\(root\)` \| (\d+) \| (\d+) \|/;
    const match = rootRowRe.exec(text);
    expect(match).not.toBeNull();
    expect(Number(match![1])).toBe(1);
    // Header file count must equal directory rollups' depth=1 sum
    // plus the (root) row. Don't hard-code the symbol count since
    // tree-sitter emit varies, but DO check the file count.
    const headerRe = /## Project Summary \((\d+) files,/;
    const headerMatch = headerRe.exec(text);
    expect(headerMatch).not.toBeNull();
    // 3 existing files (src/dense/heavy, src/dense/medium, src/sparse/light) + 1 root = 4
    expect(Number(headerMatch![1])).toBe(4);
  });
});
