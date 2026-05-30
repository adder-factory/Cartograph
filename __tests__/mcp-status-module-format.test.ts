/**
 * Tooling-gaps item #3 (doc gap #7): Module format in `cartograph_status`.
 *
 * Today: status shows backend, file/node/edge counts, freshness, LLM
 * config. It does NOT show module format (CJS / ESM) or TypeScript
 * target. For migrations specifically, "this project compiles to
 * CommonJS" upfront would set expectations for the agent.
 *
 * Expected: status reads `package.json#type` and `tsconfig.json#module`/
 * `compilerOptions.target` and surfaces them as a "Build target" or
 * "Module format" line. ESM, CJS, or "mixed" if both shapes detected.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function build(dir: string, packageJson: object, tsconfig: object | null = null): Promise<Cartograph> {
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function a(){return 1;}\n`);
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(packageJson));
  if (tsconfig) {
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify(tsconfig));
  }
  const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
  await cg.indexAll({ summarize: false });
  return cg;
}

describe('Tooling-gaps #3: module-format in cartograph_status', () => {
  let dirs: string[];
  let cgs: Cartograph[];
  let handler: ToolHandler | null;

  beforeEach(() => {
    dirs = [];
    cgs = [];
    handler = null;
  });
  afterEach(() => {
    handler?.closeAll();
    for (const cg of cgs) {
      try {
        cg.close();
      } catch {}
    }
    for (const d of dirs) if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
  });

  it('reports ESM when package.json type is "module"', async () => {
    const dir = tempDir('cg-modfmt-esm-');
    dirs.push(dir);
    const cg = await build(
      dir,
      { name: 'x', version: '0.0.0', type: 'module' },
      { compilerOptions: { module: 'NodeNext', target: 'ES2022' } },
    );
    cgs.push(cg);
    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Module format[^\n]*ESM/);
  });

  it('reports CJS when package.json type is missing or "commonjs"', async () => {
    const dir = tempDir('cg-modfmt-cjs-');
    dirs.push(dir);
    const cg = await build(
      dir,
      { name: 'x', version: '0.0.0' },
      { compilerOptions: { module: 'CommonJS', target: 'ES2020' } },
    );
    cgs.push(cg);
    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Module format[^\n]*(CJS|CommonJS)/);
  });

  it('surfaces the TypeScript target when tsconfig is present', async () => {
    const dir = tempDir('cg-modfmt-target-');
    dirs.push(dir);
    const cg = await build(
      dir,
      { name: 'x', version: '0.0.0', type: 'module' },
      { compilerOptions: { module: 'NodeNext', target: 'ES2022' } },
    );
    cgs.push(cg);
    handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_status', {});
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/ES2022|NodeNext/);
  });
});
