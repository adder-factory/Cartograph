/**
 * F#12 slice 2 — MCP tool integration tests.
 *
 *   1. `cartograph_find by:name mode:exact` falls through to a
 *      "Nested matches" section when the symbol exists only as a
 *      manifest row inside a mega-file (i.e. the agent's actual
 *      "I can't find getTypeOfSymbol" friction case).
 *   2. `cartograph_node deep:true` renders an ad-hoc deep view for
 *      the same manifest row — parent header + source slice — without
 *      promoting the row to a graph node (slice 3 owns promotion).
 *   3. `cartograph_node` WITHOUT `deep` returns the regular "not found"
 *      shape; default surface unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

const SAVED = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];

describe('F#12 slice 2 — MCP find + node integration', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-f12-slice2-mcp-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'checker.ts'),
      `
export function createTypeChecker() {
  function getTypeOfSymbol(s) {
    return s.type;
  }
  function checkSourceFile(f) {
    return f.path;
  }
  return getTypeOfSymbol(checkSourceFile({}));
}
`,
    );
    cg = await Cartograph.init(dir, {
      config: { llm: { endpoint: '' }, largeFunctionThreshold: 3 },
    });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    if (SAVED === undefined) delete process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
    else process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = SAVED;
  });

  it('cartograph_find returns a Nested matches section when the only hit is a manifest row', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'getTypeOfSymbol' });
    const text = result.content[0]?.text ?? '';
    expect(text).toContain('## Nested matches for `getTypeOfSymbol`');
    expect(text).toContain('inside `createTypeChecker`');
    expect(text).toContain('src/checker.ts:');
    expect(text).toContain('cartograph_node({symbol: "getTypeOfSymbol", deep: true})');
  });

  it("cartograph_node without deep returns the standard 'not found' shape", async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'getTypeOfSymbol' });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toContain('manifest');
    // Standard not-found message — exact wording owned by symbolNotFound.
    expect(text).toMatch(/not found|No (results|matches)|Did you mean/i);
  });

  it('cartograph_node with deep:true renders the manifest deep view', async () => {
    const result = await handler.execute('cartograph_node', {
      symbol: 'getTypeOfSymbol',
      deep: true,
      code: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## getTypeOfSymbol _\(manifest, hit \d+\)_/m);
    expect(text).toContain('inside `createTypeChecker`');
    expect(text).toContain('src/checker.ts:');
    // Body slice from disk — the original source line is verbatim.
    expect(text).toContain('return s.type');
    // Footer warns the agent about manifest-mode semantics.
    expect(text).toContain('Manifest-mode symbol');
  });

  it('cartograph_node with deep:true returns the manifest view WITHOUT code by default', async () => {
    // `code:false` is the default for cartograph_node — `deep:true` must
    // respect that, surfacing the header/parent/location only.
    const result = await handler.execute('cartograph_node', {
      symbol: 'getTypeOfSymbol',
      deep: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^## getTypeOfSymbol _\(manifest, hit \d+\)_/m);
    expect(text).not.toContain('return s.type');
  });
});
