/**
 * MCP `cartograph_admin` (action='init'/'uninit'/'unlock') and
 * `cartograph_affected` — alignment with their CLI counterparts.
 * Each handler is a thin wrapper; tests verify dispatch +
 * side-effects.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('MCP write tools (init / uninit / unlock / affected / coverage_load)', () => {
  let parentDir: string;

  beforeEach(() => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-write-'));
  });

  afterEach(() => {
    if (fs.existsSync(parentDir)) fs.rmSync(parentDir, { recursive: true, force: true });
  });

  describe("cartograph_admin({action: 'init'})", () => {
    it('creates .cartograph/ in a fresh directory', async () => {
      const projectDir = path.join(parentDir, 'fresh-proj');
      fs.mkdirSync(projectDir);
      const handler = new ToolHandler(null);
      const result = await handler.execute('cartograph_admin', { action: 'init', path: projectDir });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Initialized/);
      expect(fs.existsSync(path.join(projectDir, '.cartograph'))).toBe(true);
      handler.closeAll();
    });

    it('errors when path is missing', async () => {
      const handler = new ToolHandler(null);
      const result = await handler.execute('cartograph_admin', { action: 'init' });
      expect(result.content[0]?.text ?? '').toMatch(/`path` must be/);
      handler.closeAll();
    });

    it('auto-creates the target directory if it does not exist (mirrors CLI ergonomics)', async () => {
      const handler = new ToolHandler(null);
      const targetDir = path.join(parentDir, 'created-by-init');
      const result = await handler.execute('cartograph_admin', { action: 'init', path: targetDir });
      expect(result.content[0]?.text ?? '').toMatch(/Initialized/);
      // The dir was created, .cartograph subdir lives inside it.
      expect(fs.existsSync(path.join(targetDir, '.cartograph'))).toBe(true);
      handler.closeAll();
    });
  });

  describe("cartograph_admin({action: 'uninit'})", () => {
    it('refuses without confirm:true', async () => {
      const projectDir = path.join(parentDir, 'p1');
      fs.mkdirSync(projectDir);
      const cg = await Cartograph.init(projectDir, { config: { llm: { endpoint: '' } } });
      cg.close();
      const handler = new ToolHandler(null);
      const result = await handler.execute('cartograph_admin', { action: 'uninit', path: projectDir });
      // refuses without confirm:true; .cartograph stays.
      expect(result.content[0]?.text ?? '').toMatch(/confirm: true.*required/);
      // .cartograph/ still exists.
      expect(fs.existsSync(path.join(projectDir, '.cartograph'))).toBe(true);
      handler.closeAll();
    });

    it('removes .cartograph/ when confirm:true', async () => {
      const projectDir = path.join(parentDir, 'p2');
      fs.mkdirSync(projectDir);
      const cg = await Cartograph.init(projectDir, { config: { llm: { endpoint: '' } } });
      cg.close();
      const handler = new ToolHandler(null);
      const result = await handler.execute('cartograph_admin', { action: 'uninit', path: projectDir, confirm: true });
      expect(result.content[0]?.text ?? '').toMatch(/Uninitialized/);
      expect(fs.existsSync(path.join(projectDir, '.cartograph'))).toBe(false);
      handler.closeAll();
    });
  });

  describe("cartograph_admin({action: 'unlock'})", () => {
    it('removes a stale lock file', async () => {
      const projectDir = path.join(parentDir, 'p3');
      fs.mkdirSync(projectDir);
      const cg = await Cartograph.init(projectDir, { config: { llm: { endpoint: '' } } });
      const lockPath = path.join(projectDir, '.cartograph', 'cartograph.lock');
      fs.writeFileSync(lockPath, '99999');

      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_admin', { action: 'unlock', projectPath: projectDir });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Lock cleared/);
      // The "Removed:" path is relative to the project root (not
      // absolute) so the response stays compact.
      expect(text).toContain('.cartograph/cartograph.lock');
      expect(text).not.toContain(projectDir);
      expect(fs.existsSync(lockPath)).toBe(false);
      handler.closeAll();
      cg.close();
    });

    it('reports no-op when no lock file exists', async () => {
      const projectDir = path.join(parentDir, 'p4');
      fs.mkdirSync(projectDir);
      const cg = await Cartograph.init(projectDir, { config: { llm: { endpoint: '' } } });
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_admin', { action: 'unlock', projectPath: projectDir });
      expect(result.content[0]?.text ?? '').toMatch(/No lock file/);
      handler.closeAll();
      cg.close();
    });
  });

  describe('cartograph_tests_for (files mode — merged from former cartograph_affected)', () => {
    it('returns a well-formed Affected-test-files response', async () => {
      // Verifies dispatch + output shape. The BFS logic itself is the
      // same code path the CLI `cartograph affected` already uses;
      // we don't re-test the dependency-graph traversal here.
      const projectDir = path.join(parentDir, 'p5');
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(projectDir, 'src', 'lib.ts'), `export function foo(){return 1;}\n`);
      fs.writeFileSync(
        path.join(projectDir, 'src', 'lib.test.ts'),
        `import { foo } from './lib';\nexport const t = foo();\n`,
      );
      const cg = await Cartograph.init(projectDir, {
        config: { include: ['**/*.ts'], exclude: [], llm: { endpoint: '' } },
      });
      await cg.indexAll({ summarize: false });

      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_tests_for', {
        files: ['src/lib.ts'],
        projectPath: projectDir,
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/Affected test files \(\d+\)/);
      expect(text).toMatch(/Traversed \d+ dependent/);
      handler.closeAll();
      cg.close();
    });

    it('errors when neither symbol nor files is supplied', async () => {
      const projectDir = path.join(parentDir, 'p6');
      fs.mkdirSync(projectDir);
      const cg = await Cartograph.init(projectDir, { config: { llm: { endpoint: '' } } });
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_tests_for', {
        projectPath: projectDir,
      });
      expect(result.content[0]?.text ?? '').toMatch(/Missing input/);
      handler.closeAll();
      cg.close();
    });

    it('errors when both symbol and files are supplied (mutually exclusive)', async () => {
      const projectDir = path.join(parentDir, 'p7');
      fs.mkdirSync(projectDir);
      const cg = await Cartograph.init(projectDir, { config: { llm: { endpoint: '' } } });
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_tests_for', {
        symbol: 'foo',
        files: ['src/lib.ts'],
        projectPath: projectDir,
      });
      expect(result.content[0]?.text ?? '').toMatch(/not both/);
      handler.closeAll();
      cg.close();
    });
  });
});
