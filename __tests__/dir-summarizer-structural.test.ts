/**
 * Unit tests for the structural-pattern bypass added in F-I (2026-05-11).
 *
 * The granite-1b LLM summarizer was producing inaccurate directory
 * summaries for `src/mcp/tools/` — fixating on `_call-id-cache.ts` and
 * describing the dir as a "caching and querying system" when in fact it
 * hosts every MCP tool handler module. The fix bypasses the LLM when a
 * directory has a strong structural signature (>=40% `handle*` exports
 * + at least one `*_TOOL` constant export) and emits a deterministic
 * paragraph instead.
 *
 * These tests cover the two pure helpers (`detectDirectoryPattern`,
 * `buildStructuralDirectorySummary`) — the wiring inside
 * `summariseOneDir` is exercised indirectly by the existing
 * `dir-summarizer.test.ts` truncation tests + the cartograph_module
 * MCP smoke check on next sync.
 */

import { describe, it, expect } from 'vitest';
import {
  detectDirectoryPattern,
  buildStructuralDirectorySummary,
  STRUCTURAL_DIR_MODEL,
  type DirGroupItem,
} from '../src/llm/dir-summarizer.js';

/** Tiny factory so each test reads as a list of "what's in the dir". */
function item(name: string, kind: string, filePath: string): DirGroupItem {
  return { name, kind, summary: `Summary for ${name}.`, filePath };
}

describe('detectDirectoryPattern — mcp_tools', () => {
  it('returns "mcp_tools" when >=40% of functions are handle* and a *_TOOL export exists', () => {
    const items: DirGroupItem[] = [
      item('handleAdmin', 'function', 'src/mcp/tools/admin.ts'),
      item('handleInit', 'function', 'src/mcp/tools/admin.ts'),
      item('handleSync', 'function', 'src/mcp/tools/admin.ts'),
      item('ADMIN_TOOL', 'constant', 'src/mcp/tools/admin.ts'),
      item('handleFind', 'function', 'src/mcp/tools/find.ts'),
      item('FIND_TOOL', 'constant', 'src/mcp/tools/find.ts'),
      // A few random helpers — still satisfies the 40% ratio.
      item('formatRow', 'function', 'src/mcp/tools/_search.ts'),
      item('parseArgs', 'function', 'src/mcp/tools/_search.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBe('mcp_tools');
  });

  it('returns "mcp_tools" on >=3 *_TOOL exports even when the handle* ratio is diluted (FRICTION-M)', () => {
    // Large MCP-tools dir: 3 tool exports but the handle* share is far
    // below 0.40 because each tool was split into _helper.ts modules
    // full of formatX / parseX functions. The *_TOOL-count signal must
    // still fire — this is the exact src/mcp/tools/ regression.
    const items: DirGroupItem[] = [
      item('ADMIN_TOOL', 'constant', 'src/mcp/tools/admin.ts'),
      item('FIND_TOOL', 'constant', 'src/mcp/tools/find.ts'),
      item('GRAPH_TOOL', 'constant', 'src/mcp/tools/graph.ts'),
      item('handleAdmin', 'function', 'src/mcp/tools/admin.ts'),
      // A long tail of helper functions — handle* ratio is 1/9 ≈ 11%.
      item('formatRow', 'function', 'src/mcp/tools/_callers.ts'),
      item('parseArgs', 'function', 'src/mcp/tools/_callers.ts'),
      item('renderGroup', 'function', 'src/mcp/tools/_callees.ts'),
      item('mintUid', 'function', 'src/mcp/tools/_call-id-cache.ts'),
      item('resolveUid', 'function', 'src/mcp/tools/_call-id-cache.ts'),
      item('truncate', 'function', 'src/mcp/tools/shared.ts'),
      item('errorResult', 'function', 'src/mcp/tools/shared.ts'),
      item('textResult', 'function', 'src/mcp/tools/shared.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBe('mcp_tools');
  });

  it('returns "mcp_tools" via opts.toolExportCount when items carry no *_TOOL at all (FRICTION-M)', () => {
    // The realistic case: `*_TOOL` constants rarely have a summary or
    // docstring, so they never reach `group.items`. The caller supplies
    // the TRUE structural count instead — the detector must trust it
    // over the (empty) items-derived count.
    const items: DirGroupItem[] = [
      item('formatRow', 'function', 'src/mcp/tools/_callers.ts'),
      item('parseArgs', 'function', 'src/mcp/tools/_callers.ts'),
      item('renderGroup', 'function', 'src/mcp/tools/_callees.ts'),
      item('truncate', 'function', 'src/mcp/tools/shared.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBeNull();
    expect(detectDirectoryPattern(items, { toolExportCount: 36 })).toBe('mcp_tools');
  });

  it('opts.toolExportCount below the floor does not force the pattern', () => {
    const items: DirGroupItem[] = [
      item('parseArgs', 'function', 'src/util/args.ts'),
      item('formatRow', 'function', 'src/util/fmt.ts'),
    ];
    expect(detectDirectoryPattern(items, { toolExportCount: 2 })).toBeNull();
  });

  it('returns null on 2 *_TOOL exports with a diluted handle* ratio (below the count floor)', () => {
    // Two tool exports is under the >=3 floor; with a sub-40% handle*
    // ratio neither trigger fires.
    const items: DirGroupItem[] = [
      item('ADMIN_TOOL', 'constant', 'src/mcp/tools/admin.ts'),
      item('FIND_TOOL', 'constant', 'src/mcp/tools/find.ts'),
      item('parseArgs', 'function', 'src/mcp/tools/_callers.ts'),
      item('formatRow', 'function', 'src/mcp/tools/_callers.ts'),
      item('renderGroup', 'function', 'src/mcp/tools/_callees.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBeNull();
  });

  it('returns null when handle* prefix is below the 40% threshold', () => {
    // Only 1 out of 5 functions matches handle* → 20% < 40%.
    const items: DirGroupItem[] = [
      item('handleClick', 'function', 'src/ui/button.ts'),
      item('renderButton', 'function', 'src/ui/button.ts'),
      item('mountDom', 'function', 'src/ui/dom.ts'),
      item('teardownDom', 'function', 'src/ui/dom.ts'),
      item('focusElement', 'function', 'src/ui/dom.ts'),
      item('BUTTON_TOOL', 'constant', 'src/ui/button.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBeNull();
  });

  it('returns null when handle* ratio is high but no *_TOOL export exists', () => {
    // Common in routing layers — many handle* helpers, no MCP tool shape.
    const items: DirGroupItem[] = [
      item('handleRequest', 'function', 'src/router/index.ts'),
      item('handleError', 'function', 'src/router/index.ts'),
      item('handle404', 'function', 'src/router/index.ts'),
      item('handleRedirect', 'function', 'src/router/index.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBeNull();
  });

  it('returns null on a random mix of function names', () => {
    const items: DirGroupItem[] = [
      item('parseUrl', 'function', 'src/util/url.ts'),
      item('formatDate', 'function', 'src/util/date.ts'),
      item('hashString', 'function', 'src/util/hash.ts'),
      item('readFile', 'function', 'src/util/fs.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBeNull();
  });

  it('returns null on an empty input set', () => {
    expect(detectDirectoryPattern([])).toBeNull();
  });

  it('ignores non-function/method items when computing the ratio', () => {
    // Two methods, both handle* + a *_TOOL export — pattern matches even
    // though a third of the items are unrelated constants/types.
    const items: DirGroupItem[] = [
      item('handleA', 'method', 'src/mcp/tools/a.ts'),
      item('handleB', 'method', 'src/mcp/tools/b.ts'),
      item('A_TOOL', 'constant', 'src/mcp/tools/a.ts'),
      item('SomeType', 'type_alias', 'src/mcp/tools/types.ts'),
      item('OtherInterface', 'interface', 'src/mcp/tools/types.ts'),
    ];
    expect(detectDirectoryPattern(items)).toBe('mcp_tools');
  });
});

describe('buildStructuralDirectorySummary — mcp_tools', () => {
  const items: DirGroupItem[] = [
    item('handleAdmin', 'function', 'src/mcp/tools/admin.ts'),
    item('handleInit', 'function', 'src/mcp/tools/admin.ts'),
    item('handleSync', 'function', 'src/mcp/tools/admin.ts'),
    item('ADMIN_TOOL', 'constant', 'src/mcp/tools/admin.ts'),
    item('handleFind', 'function', 'src/mcp/tools/find.ts'),
    item('FIND_TOOL', 'constant', 'src/mcp/tools/find.ts'),
    item('handleContext', 'function', 'src/mcp/tools/context.ts'),
    item('CONTEXT_TOOL', 'constant', 'src/mcp/tools/context.ts'),
    // Private helper — should be excluded from the "top files" list.
    item('parseInputArgs', 'function', 'src/mcp/tools/_search.ts'),
  ];

  it('returns a paragraph mentioning "MCP tool handler" and the dirPath', () => {
    const out = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', items);
    expect(out).toContain('MCP tool handler');
    expect(out).toContain('src/mcp/tools');
  });

  it('references the *_TOOL export shape and the handle* entry-point shape', () => {
    const out = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', items);
    expect(out).toContain('*_TOOL');
    expect(out).toContain('handle*');
  });

  it('counts handler MODULES (distinct files), not raw handler functions', () => {
    // 5 handle* functions across 3 distinct files (admin.ts has 3, find.ts
    // and context.ts have 1 each) → "3 MCP tool handler modules".
    const out = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', items);
    expect(out).toMatch(/3 MCP tool handler modules/);
  });

  it('lists the top-3 files by symbol count and excludes private helpers', () => {
    const out = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', items);
    // admin.ts has 4 symbols → first; find.ts and context.ts tie at 2 →
    // alphabetical tie-break gives context.ts before find.ts.
    expect(out).toMatch(/Files: admin\.ts, context\.ts, find\.ts\./);
    expect(out).not.toContain('_search.ts');
  });

  it('is fully deterministic — same input produces byte-identical output', () => {
    const a = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', items);
    const b = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', items);
    expect(a).toBe(b);
  });

  it('handles the degenerate case where no handle* functions exist gracefully', () => {
    // detectDirectoryPattern would return null here, so this codepath is
    // defensive — exercised only if the caller bypasses the detector.
    const noHandlers: DirGroupItem[] = [item('FOO_TOOL', 'constant', 'src/mcp/tools/foo.ts')];
    const out = buildStructuralDirectorySummary('src/mcp/tools', 'mcp_tools', noHandlers);
    expect(out).toContain('0 MCP tool handler modules');
  });
});

describe('STRUCTURAL_DIR_MODEL', () => {
  it('is a versioned tag distinct from any LLM model id', () => {
    // The persistence layer keys cache validity on (dir_path, model);
    // a fresh tag here is what forces granite-1b's stored paragraph to
    // be overwritten on next sync.
    expect(STRUCTURAL_DIR_MODEL).toBe('structural-dir:v1');
    expect(STRUCTURAL_DIR_MODEL.startsWith('structural-dir:')).toBe(true);
  });
});
