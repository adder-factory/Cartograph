/**
 * MCP server-level configuration: profiles, disable write tools,
 * disable named tools, default `allowStale`. Covers the surface added
 * so server operators can scope what an agent is allowed to do.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('MCP server-level options', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-opts-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function alpha(){return 1;}\n`);
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(testDir, { config: {} });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  describe('profiles', () => {
    it('defaults to the compressed core tool surface', () => {
      const handler = new ToolHandler(cg);
      const explicitCoreHandler = new ToolHandler(cg, { profile: 'core' });
      const names = handler.getTools().map((t) => t.name);
      const explicitCoreNames = explicitCoreHandler.getTools().map((t) => t.name);
      expect(names.sort()).toEqual(explicitCoreNames.sort());
      expect(names).toHaveLength(15);
      expect(names).toContain('cartograph_find');
      expect(names).toContain('cartograph_graph');
      expect(names).toContain('cartograph_context');
      expect(names).toContain('cartograph_compare_to_ref');
      expect(names).toContain('cartograph_admin');
      expect(names).toContain('cartograph_verify');
      expect(names).not.toContain('cartograph_explore');
      expect(names).not.toContain('cartograph_host');
      expect(names).not.toContain('cartograph_session');
      expect(names).not.toContain('cartograph_ask');
      expect(names).not.toContain('cartograph_note');
      handler.closeAll();
      explicitCoreHandler.closeAll();
    });

    it('coding exposes the nine-tool task-to-verification surface', () => {
      const handler = new ToolHandler(cg, { profile: 'coding' });
      const names = handler
        .getTools()
        .map((tool) => tool.name)
        .sort();
      expect(names).toEqual(
        [
          'cartograph_at_range',
          'cartograph_context',
          'cartograph_files',
          'cartograph_find',
          'cartograph_graph',
          'cartograph_node',
          'cartograph_status',
          'cartograph_tests_for',
          'cartograph_verify',
        ].sort(),
      );
      handler.closeAll();
    });

    it('full profile exposes the complete registered tool surface', () => {
      const handler = new ToolHandler(cg, { profile: 'full' });
      const names = handler.getTools().map((t) => t.name);
      const registered = getToolModules().map((m) => m.definition.name);
      expect(names.sort()).toEqual(registered.sort());
      handler.closeAll();
    });

    it('core keeps common coding-agent tools and hides non-core tools', async () => {
      const handler = new ToolHandler(cg, { profile: 'core' });
      const names = handler.getTools().map((t) => t.name);
      expect(names).toContain('cartograph_find');
      expect(names).toContain('cartograph_graph');
      expect(names).toContain('cartograph_context');
      expect(names).toContain('cartograph_compare_to_ref');
      expect(names).toContain('cartograph_admin');
      expect(names).toContain('cartograph_verify');
      expect(names).not.toContain('cartograph_explore');
      expect(names).not.toContain('cartograph_host');
      expect(names).not.toContain('cartograph_session');
      expect(names).not.toContain('cartograph_ask');
      expect(names).not.toContain('cartograph_note');

      const result = await handler.execute('cartograph_ask', { mode: 'local_chat', prompt: 'summarize' });
      expect(result.content[0]?.text ?? '').toMatch(/profile `core`/);
      handler.closeAll();
    });

    it('read-only profile matches full profile with --no-write-tools', () => {
      const profileHandler = new ToolHandler(cg, { profile: 'read-only' });
      const noWriteHandler = new ToolHandler(cg, { profile: 'full', disableWriteTools: true });
      const profileNames = profileHandler
        .getTools()
        .map((t) => t.name)
        .sort();
      const noWriteNames = noWriteHandler
        .getTools()
        .map((t) => t.name)
        .sort();
      expect(profileNames).toEqual(noWriteNames);
      expect(profileNames).not.toContain('cartograph_admin');
      expect(profileNames).toContain('cartograph_coverage');
      expect(profileNames).toContain('cartograph_note');
      expect(profileNames).toContain('cartograph_role');
      expect(profileNames).toContain('cartograph_session');
      expect(profileNames).toContain('cartograph_summaries');
      profileHandler.closeAll();
      noWriteHandler.closeAll();
    });

    it('read-only profile enforces the write gate for mixed tools it advertises', async () => {
      const handler = new ToolHandler(cg, { profile: 'read-only' });
      const readResult = await handler.execute('cartograph_role', {});
      expect(readResult.content[0]?.text ?? '').not.toMatch(/disabled by this MCP server/);

      const writeResult = await handler.execute('cartograph_role', { symbol: 'alpha' });
      const text = writeResult.content[0]?.text ?? '';
      expect(text).toMatch(/read-only write gate/);
      expect(text).toMatch(/role.*list-by-role|list-by-role.*role/);
      handler.closeAll();
    });

    it('review focuses diff, risk, test, and change-impact tools', () => {
      const handler = new ToolHandler(cg, { profile: 'review' });
      const names = handler.getTools().map((t) => t.name);
      expect(names).toContain('cartograph_review');
      expect(names).toContain('cartograph_affected');
      expect(names).toContain('cartograph_tests_for');
      expect(names).toContain('cartograph_compare_to_ref');
      expect(names).toContain('cartograph_biomarkers');
      expect(names).toContain('cartograph_graph');
      expect(names).not.toContain('cartograph_explore');
      expect(names).not.toContain('cartograph_ask');
      handler.closeAll();
    });

    it('composes with disabledTools and disableWriteTools', () => {
      const handler = new ToolHandler(cg, {
        profile: 'core',
        disableWriteTools: true,
        disabledTools: new Set(['cartograph_find']),
      });
      const names = handler.getTools().map((t) => t.name);
      expect(names).not.toContain('cartograph_find'); // explicit disable
      expect(names).not.toContain('cartograph_admin'); // write-class filter
      expect(names).not.toContain('cartograph_ask'); // profile filter
      expect(names).toContain('cartograph_graph');
      handler.closeAll();
    });
  });

  describe('disableWriteTools', () => {
    it('hides pure write tools but keeps mixed tools with read-only branches in tools/list', () => {
      const handler = new ToolHandler(cg, { profile: 'full', disableWriteTools: true });
      const names = handler.getTools().map((t) => t.name);
      expect(names).not.toContain('cartograph_admin');
      expect(names).toContain('cartograph_coverage');
      expect(names).toContain('cartograph_note');
      expect(names).toContain('cartograph_role');
      expect(names).toContain('cartograph_session');
      expect(names).toContain('cartograph_summaries');
      // Read-class tools still listed.
      expect(names).toContain('cartograph_find');
      expect(names).toContain('cartograph_status');
      handler.closeAll();
    });

    it('hides cartograph_admin under --no-write-tools (every action mutates state)', () => {
      const handler = new ToolHandler(cg, { profile: 'full', disableWriteTools: true });
      const names = handler.getTools().map((t) => t.name);
      // cartograph_admin has no readOnlyActions carve-out — every action
      // mutates state, so the whole tool is hidden under --no-write-tools.
      // (The carve-out infrastructure remains in place for future tools
      // that mix read- and write-only actions; cartograph_admin used to
      // expose pool-recommend / pool-status as read-only carve-outs.)
      expect(names).not.toContain('cartograph_admin');
      handler.closeAll();
    });

    it('rejects all admin actions with a clean error under --no-write-tools', async () => {
      const handler = new ToolHandler(cg, { profile: 'full', disableWriteTools: true });
      const result = await handler.execute('cartograph_admin', { action: 'sync' });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/disabled by this MCP server/);
      handler.closeAll();
    });

    it('allows read-only branches of mixed write tools and blocks their write branches', async () => {
      const handler = new ToolHandler(cg, { profile: 'full', disableWriteTools: true });

      const noteList = await handler.execute('cartograph_note', { action: 'list' });
      expect(noteList.content[0]?.text ?? '').not.toMatch(/disabled by this MCP server/);

      const noteAdd = await handler.execute('cartograph_note', { action: 'add', text: 'remember this' });
      expect(noteAdd.content[0]?.text ?? '').toMatch(/read-only write gate/);
      expect(noteAdd.content[0]?.text ?? '').toMatch(/actions: list/);

      const coverageRead = await handler.execute('cartograph_coverage', { mode: 'ranked' });
      expect(coverageRead.content[0]?.text ?? '').not.toMatch(/disabled by this MCP server/);

      const coverageWrite = await handler.execute('cartograph_coverage', { mode: 'refresh' });
      expect(coverageWrite.content[0]?.text ?? '').toMatch(/read-only write gate/);

      const roleRead = await handler.execute('cartograph_role', { role: 'util' });
      expect(roleRead.content[0]?.text ?? '').not.toMatch(/disabled by this MCP server/);

      const roleWrite = await handler.execute('cartograph_role', { symbol: 'alpha' });
      expect(roleWrite.content[0]?.text ?? '').toMatch(/read-only write gate/);
      handler.closeAll();
    });

    it('leaves read-tool calls untouched', async () => {
      const handler = new ToolHandler(cg, { disableWriteTools: true });
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      const text = result.content[0]?.text ?? '';
      expect(text).not.toMatch(/disabled by this MCP server/);
      handler.closeAll();
    });
  });

  describe('disabledTools (per-name)', () => {
    it('disables a specific named tool', async () => {
      const handler = new ToolHandler(cg, {
        profile: 'full',
        disabledTools: new Set(['cartograph_dead_code']),
      });
      expect(handler.getTools().map((t) => t.name)).not.toContain('cartograph_dead_code');
      // Other tools unaffected.
      expect(handler.getTools().map((t) => t.name)).toContain('cartograph_find');
      const result = await handler.execute('cartograph_dead_code', {});
      expect(result.content[0]?.text ?? '').toMatch(/disabled by this MCP server/);
      handler.closeAll();
    });

    it('composes cleanly when disabledTools also covers an admin-style tool', async () => {
      // Edge case: disabledTools and disableWriteTools both block
      // cartograph_admin. The carve-out advertisement would be misleading
      // (no action is actually reachable), so the gate falls back to the
      // plain "disabled by this MCP server" message.
      const handler = new ToolHandler(cg, {
        disableWriteTools: true,
        disabledTools: new Set(['cartograph_admin']),
      });
      const result = await handler.execute('cartograph_admin', { action: 'sync' });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/disabled by this MCP server/);
      expect(text).not.toMatch(/Read-only actions still reachable/);
      handler.closeAll();
    });

    it('composes with disableWriteTools (either rule disables)', () => {
      const handler = new ToolHandler(cg, {
        profile: 'full',
        disableWriteTools: true,
        disabledTools: new Set(['cartograph_explore']),
      });
      const names = handler.getTools().map((t) => t.name);
      expect(names).toContain('cartograph_summaries'); // pending action is read-only
      expect(names).not.toContain('cartograph_explore'); // disabled by name
      expect(names).toContain('cartograph_find'); // neither rule applies
      handler.closeAll();
    });
  });

  describe('Server config section in status', () => {
    it('shows the default core profile when no narrowing options are set', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_status', {});
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/### .*Server config/);
      expect(text).toMatch(/Profile.*`core`/);
      handler.closeAll();
    });

    it('shows the active profile when a narrower profile is set', async () => {
      const handler = new ToolHandler(cg, { profile: 'review' });
      const text = (await handler.execute('cartograph_status', {})).content[0]?.text ?? '';
      expect(text).toMatch(/Server config/);
      expect(text).toMatch(/Profile.*`review`/);
      handler.closeAll();
    });

    it('shows write-tools-disabled when disableWriteTools is set', async () => {
      const handler = new ToolHandler(cg, { disableWriteTools: true });
      const text = (await handler.execute('cartograph_status', {})).content[0]?.text ?? '';
      expect(text).toMatch(/Server config/);
      expect(text).toMatch(/Write tools.*disabled|no-write-tools/);
      handler.closeAll();
    });

    it('lists disabled tools when disabledTools is non-empty', async () => {
      const handler = new ToolHandler(cg, {
        disabledTools: new Set(['cartograph_dead_code', 'cartograph_explore']),
      });
      const text = (await handler.execute('cartograph_status', {})).content[0]?.text ?? '';
      expect(text).toMatch(/Server config/);
      expect(text).toMatch(/cartograph_dead_code/);
      expect(text).toMatch(/cartograph_explore/);
      handler.closeAll();
    });

    it('shows allowStale default when set', async () => {
      const handler = new ToolHandler(cg, { allowStaleDefault: true });
      const text = (await handler.execute('cartograph_status', {})).content[0]?.text ?? '';
      expect(text).toMatch(/Server config/);
      expect(text).toMatch(/allowStale.*true/);
      handler.closeAll();
    });

    it('shows lowTokens default when set', async () => {
      const handler = new ToolHandler(cg, { lowTokensDefault: true });
      const text = (await handler.execute('cartograph_status', {})).content[0]?.text ?? '';
      expect(text).toMatch(/Server config/);
      expect(text).toMatch(/lowTokens.*true/);
      handler.closeAll();
    });

    it('shows startup-sync-disabled when disableStartupSync is set', async () => {
      const handler = new ToolHandler(cg, { disableStartupSync: true });
      const text = (await handler.execute('cartograph_status', {})).content[0]?.text ?? '';
      expect(text).toMatch(/Server config/);
      expect(text).toMatch(/Startup sync.*disabled|no-startup-sync/);
      handler.closeAll();
    });
  });

  describe('allowStaleDefault', () => {
    it('lets calls through heavy drift when caller omits allowStale', async () => {
      // Induce heavy drift first so the gate would block a default call.
      for (let i = 0; i < 250; i++) {
        fs.writeFileSync(path.join(testDir, 'src', `g${i}.ts`), `export const v${i}=${i};\n`);
      }
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'drift');

      const handler = new ToolHandler(cg, { allowStaleDefault: true });
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      expect(result.content[0]?.text ?? '').not.toMatch(/too stale to safely query/i);
      handler.closeAll();
    });

    it('still blocks when caller explicitly passes allowStale: false', async () => {
      // Same heavy-drift setup as above.
      for (let i = 0; i < 250; i++) {
        fs.writeFileSync(path.join(testDir, 'src', `h${i}.ts`), `export const w${i}=${i};\n`);
      }
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'drift');

      const handler = new ToolHandler(cg, { allowStaleDefault: true });
      // Explicit false overrides the server default.
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha', allowStale: false });
      expect(result.content[0]?.text ?? '').toMatch(/too stale to safely query/i);
      handler.closeAll();
    });
  });
});
