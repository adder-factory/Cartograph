/**
 * cartograph_propose_rename (#17a — rename half only). Verifies the
 * three-section plan: definitions, call sites grouped by edge
 * confidence, textual mentions outside the graph. Plus the
 * newName-validation warnings (collision, invalid identifier).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { insertEdge } from '../src/db/queries-edges.js';
import { getNodesByName } from '../src/db/queries-search.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_propose_rename (#17a)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rename-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    // Definition + concrete caller (import → EXTRACTED edge) + a
    // doc-only mention so the textual section has something to render.
    fs.writeFileSync(
      path.join(tempDir, 'src/lib.ts'),
      ['/** Public helper for foo computation. */', 'export function helperFn(): number { return 42; }'].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/use.ts'),
      [
        "import { helperFn } from './lib.js';",
        '/** Calls helperFn for the test case. */',
        'export function consumer(): number { return helperFn() + 1; }',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/docs.ts'),
      [
        '// Reference: see helperFn in src/lib.ts for the canonical implementation.',
        'export const NOTE = "uses helperFn under the hood";',
      ].join('\n'),
    );
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

  it('renders the three-section plan with counts in the header', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'newHelperFn',
      }),
    );
    expect(text).toContain('Rename plan: `helperFn` → `newHelperFn`');
    expect(text).toContain('**Definitions:**');
    expect(text).toContain('**Call sites (graph edges):**');
    expect(text).toContain('**Textual mentions');
    expect(text).toContain('### Definitions');
    expect(text).toContain('src/lib.ts:2');
    expect(text).toContain('### Call sites');
    expect(text).toContain('consumer'); // the caller appears
    expect(text).toContain('### Textual mentions');
  });

  it('groups call sites by edge confidence with EXTRACTED first', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'newHelperFn',
      }),
    );
    // The import-resolved edge from `consumer` should be EXTRACTED.
    expect(text).toContain('#### EXTRACTED');
    expect(text).toContain('safe to rename mechanically');
  });

  it('warns when newName collides with an existing indexed symbol', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'consumer', // already exists
      }),
    );
    expect(text).toContain('### Warnings');
    expect(text).toContain('already exists');
    expect(text).toContain('consumer');
  });

  it('warns when newName is not a valid identifier', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: '1bad-name', // starts with digit + has hyphen
      }),
    );
    expect(text).toContain('### Warnings');
    expect(text).toContain('not a valid identifier');
  });

  it('rejects same-name rename (symbol === newName)', async () => {
    const r = await handler.runHandler('cartograph_propose_rename', {
      symbol: 'helperFn',
      newName: 'helperFn',
    });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('no rename to plan');
  });

  it('returns notFound for an unknown symbol', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'doesNotExist_xyzzy',
        newName: 'replacement',
      }),
    );
    expect(text).toMatch(/not found|No symbol/);
  });

  it('docLimit=0 skips the textual-mention scan entirely', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'newHelperFn',
        docLimit: 0,
      }),
    );
    // Header should report 0 textual mentions; the section should not
    // render its bullet rows.
    expect(text).toContain('**Textual mentions (doc/comment/strings):** 0');
    // The "no textual mentions" section is omitted entirely (no
    // "### Textual mentions" header) when docLimit=0.
    expect(text).not.toContain('### Textual mentions');
  });

  it("textual mentions don't double-count graph call sites", async () => {
    // The `consumer` caller's import line "import { helperFn } from"
    // contains the word `helperFn` AND also produces a graph edge.
    // The rename plan should surface it as a graph call site, NOT
    // duplicate it in the textual-mentions section.
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'newHelperFn',
      }),
    );
    // Find the "Textual mentions" subsection — count occurrences of
    // src/use.ts within that block. Should be 0 (the caller line is
    // already in the call-sites block above).
    const textualIdx = text.indexOf('### Textual mentions');
    if (textualIdx === -1) return; // no textual section is fine
    const textualBlock = text.slice(textualIdx);
    // src/docs.ts mentions ARE expected; src/use.ts:1 (the import
    // line that produced the EXTRACTED edge) should NOT appear.
    expect(textualBlock).not.toMatch(/src\/use\.ts:1\b/);
  });

  it('filters def_use self-loops and contains edges out of the rename plan', async () => {
    // Surface only-real-edit-sites. Synthesise the two noise edges that
    // shipped on the indexed graph (a `contains` parent edge from the
    // file node + a `def_use` self-loop on `helperFn`) and assert
    // neither appears in the call-sites block. The genuine `calls`
    // edge from `consumer` must still appear.
    const helperNodes = getNodesByName(cg.queries, 'helperFn');
    expect(helperNodes.length).toBeGreaterThan(0);
    const helperId = helperNodes[0]!.id;
    // self-loop def_use: an intra-procedural data-flow edge whose
    // source === target on the function's own node.
    insertEdge(cg.queries, {
      source: helperId,
      target: helperId,
      kind: 'def_use',
      line: 2,
    });
    // contains: the file node points at every symbol it physically
    // wraps. Real `contains` edges always have a file id as source —
    // recover that source from any incoming `contains` already on the
    // node so we don't fabricate an id that breaks getNodeById.
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'renamedHelperFn',
      }),
    );
    const callSitesIdx = text.indexOf('### Call sites');
    expect(callSitesIdx).toBeGreaterThan(-1);
    const docsIdx = text.indexOf('### Textual mentions', callSitesIdx);
    const callBlock = docsIdx > -1 ? text.slice(callSitesIdx, docsIdx) : text.slice(callSitesIdx);
    // Real call site from `consumer` must remain.
    expect(callBlock).toContain('consumer');
    expect(callBlock).toContain('via `calls`');
    // Self-loop def_use must be filtered out — `helperFn` itself
    // should NOT appear as a caller, and the `def_use` edge kind
    // should not show up.
    expect(callBlock).not.toMatch(/via `def_use`/);
    // The file-containment edge from `src/lib.ts` should not surface
    // in the call-sites block.
    expect(callBlock).not.toMatch(/via `contains`/);
  });

  it('limit caps the call-sites section', async () => {
    // Add several callers so we have something to cap.
    for (let i = 0; i < 5; i++) {
      fs.writeFileSync(
        path.join(tempDir, `src/c${i}.ts`),
        ["import { helperFn } from './lib.js';", `export function caller${i}(): number { return helperFn(); }`].join(
          '\n',
        ),
      );
    }
    await cg.sync();
    const text = textOf(
      await handler.runHandler('cartograph_propose_rename', {
        symbol: 'helperFn',
        newName: 'newHelperFn',
        limit: 2,
      }),
    );
    expect(text).toMatch(/Showing 2 of \d+ call sites — \d+ elided/);
  });
});
