/**
 * Multi-target installer tests.
 *
 * Each `AgentTarget` is exercised against the same contract:
 *   - `install` writes the expected files
 *   - re-running `install` is byte-identical (idempotent)
 *   - sibling MCP servers / unrelated config is preserved
 *   - `uninstall` reverses `install`
 *   - `printConfig` returns parseable, non-empty content
 *
 * For agent-config destinations we redirect HOME to a tmpdir via
 * `os.homedir` spying, and CWD via `process.chdir` — same pattern as
 * the legacy `installer.test.ts`. No real `~/.claude/` etc. ever
 * touched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ALL_TARGETS, getTarget, resolveTargetFlag } from '../src/installer/targets/registry.js';
import { atomicWriteFileSync, getCartographPermissions, removeMarkedSection } from '../src/installer/targets/shared.js';
import { upsertTomlTable, removeTomlTable, buildTomlTable } from '../src/installer/targets/toml.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cg-targets-${label}-`));
}

// Redirect HOME / USERPROFILE via env vars. The installer targets
// resolve the user's home via the env-first `getHomeDir()` helper in
// `shared.ts`, not `os.homedir()` directly (which bun caches at first
// call — verified 2026-05-20 on bun 1.3.14). So a simple env-var
// override does what the test needs on both Node and bun.
function setHome(dir: string): { restore: () => void } {
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  return {
    restore() {
      if (prev.HOME === undefined) delete process.env.HOME;
      else process.env.HOME = prev.HOME;
      if (prev.USERPROFILE === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prev.USERPROFILE;
    },
  };
}

describe('Installer targets — contract', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  for (const target of ALL_TARGETS) {
    describe(target.id, () => {
      const supportedLocations = (['global', 'local'] as const).filter((l) => target.supportsLocation(l));

      for (const location of supportedLocations) {
        describe(`location=${location}`, () => {
          it('install writes files; detect.alreadyConfigured becomes true', () => {
            expect(target.detect(location).alreadyConfigured).toBe(false);

            const result = target.install(location, { autoAllow: true });
            expect(result.files.length).toBeGreaterThan(0);
            for (const file of result.files) {
              if (file.action !== 'unchanged') {
                expect(fs.existsSync(file.path)).toBe(true);
              }
            }

            expect(target.detect(location).alreadyConfigured).toBe(true);
          });

          it('re-running install is idempotent (no actions other than unchanged)', () => {
            target.install(location, { autoAllow: true });
            const second = target.install(location, { autoAllow: true });
            for (const file of second.files) {
              expect(file.action).toBe('unchanged');
            }
          });

          it('install preserves a pre-existing sibling MCP server (where applicable)', () => {
            // Plant a sibling entry in the same JSON config, install,
            // and verify the sibling survives. Skip for Codex (TOML)
            // and any target with no JSON config — they get covered
            // by their own dedicated tests below.
            const paths = target.describePaths(location);
            const jsonPath = paths.find((p) => p.endsWith('.json'));
            if (!jsonPath) return;

            // Seed pre-existing config.
            fs.mkdirSync(path.dirname(jsonPath), { recursive: true });
            const seed: Record<string, any> = { mcpServers: { other: { command: 'x' } } };
            // opencode uses `mcp` not `mcpServers`. Match its shape too.
            if (target.id === 'claude' && location === 'local') {
              delete seed.mcpServers;
              seed.projects = { [path.resolve(process.cwd())]: { mcpServers: { other: { command: 'x' } } } };
            } else if (target.id === 'opencode') {
              delete seed.mcpServers;
              seed.mcp = { other: { type: 'local', command: ['x'], enabled: true } };
            } else if (target.id === 'zed') {
              delete seed.mcpServers;
              seed.context_servers = { other: { command: 'x' } };
            }
            fs.writeFileSync(jsonPath, JSON.stringify(seed, null, 2) + '\n');

            target.install(location, { autoAllow: true });

            const after = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
            if (target.id === 'claude' && location === 'local') {
              const projectConfig = after.projects[path.resolve(process.cwd())];
              expect(projectConfig.mcpServers.other).toBeDefined();
              expect(projectConfig.mcpServers.cartograph).toBeDefined();
            } else if (target.id === 'opencode') {
              expect(after.mcp.other).toBeDefined();
              expect(after.mcp.cartograph).toBeDefined();
            } else if (target.id === 'zed') {
              expect(after.context_servers.other).toBeDefined();
              expect(after.context_servers.cartograph).toBeDefined();
            } else {
              expect(after.mcpServers.other).toBeDefined();
              expect(after.mcpServers.cartograph).toBeDefined();
            }
          });

          it('uninstall reverses install (alreadyConfigured returns to false)', () => {
            target.install(location, { autoAllow: true });
            expect(target.detect(location).alreadyConfigured).toBe(true);

            target.uninstall(location);
            expect(target.detect(location).alreadyConfigured).toBe(false);
          });

          it('printConfig returns non-empty output without writing anything', () => {
            const before = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
            const out = target.printConfig(location);
            expect(out.length).toBeGreaterThan(0);
            const after = listAllFiles(tmpHome).concat(listAllFiles(tmpCwd));
            const sortedAfter = [...after];
            sortedAfter.sort(byString);
            const sortedBefore = [...before];
            sortedBefore.sort(byString);
            expect(sortedAfter).toEqual(sortedBefore);
          });
        });
      }
    });
  }
});

describe('Installer permissions', () => {
  it('auto-allow includes every core read helper including cartograph_files', () => {
    expect(getCartographPermissions()).toEqual(
      expect.arrayContaining([
        'mcp__cartograph__cartograph_find',
        'mcp__cartograph__cartograph_context',
        'mcp__cartograph__cartograph_graph',
        'mcp__cartograph__cartograph_node',
        'mcp__cartograph__cartograph_files',
        'mcp__cartograph__cartograph_at_range',
        'mcp__cartograph__cartograph_status',
      ]),
    );
  });
});

describe('Installer shared writer symlink handling', () => {
  it('writes through an existing symlink instead of replacing it', () => {
    const dir = mkTmpDir('symlink');
    try {
      const target = path.join(dir, 'shared.md');
      const link = path.join(dir, 'AGENTS.md');
      fs.writeFileSync(target, 'old\n');
      if (!trySymlink(target, link)) return;

      atomicWriteFileSync(link, 'new\n');

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf-8')).toBe('new\n');
      expect(fs.readFileSync(link, 'utf-8')).toBe('new\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes through a dangling relative symlink by creating the target', () => {
    const dir = mkTmpDir('dangling-symlink');
    try {
      const target = path.join(dir, 'shared', 'AGENTS.md');
      const link = path.join(dir, 'AGENTS.md');
      if (!trySymlink(path.join('shared', 'AGENTS.md'), link)) return;

      atomicWriteFileSync(link, 'created\n');

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf-8')).toBe('created\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('removes marked content through a symlink without deleting the symlink', () => {
    const dir = mkTmpDir('symlink-remove');
    try {
      const target = path.join(dir, 'shared.md');
      const link = path.join(dir, 'AGENTS.md');
      fs.writeFileSync(target, 'before\n<!-- START -->\nmanaged\n<!-- END -->\nafter\n');
      if (!trySymlink(target, link)) return;

      expect(removeMarkedSection(link, '<!-- START -->', '<!-- END -->')).toBe('removed');

      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
      expect(fs.readFileSync(target, 'utf-8')).toBe('before\n\nafter\n');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

function trySymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

describe('Installer targets — partial-state idempotency', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('codex: install after only config.toml exists — second pass is fully unchanged', () => {
    const codex = getTarget('codex')!;
    // First install creates both files.
    codex.install('global', { autoAllow: false });
    // Delete the AGENTS.md to simulate partial state (user wiped one file).
    const agentsMd = path.join(tmpHome, '.codex', 'AGENTS.md');
    expect(fs.existsSync(agentsMd)).toBe(true);
    fs.unlinkSync(agentsMd);
    // Reinstall — TOML stays unchanged, AGENTS.md is recreated.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    const mdEntry = second.files.find((f) => f.path.endsWith('AGENTS.md'))!;
    expect(tomlEntry.action).toBe('unchanged');
    expect(mdEntry.action).toBe('created');
    // Third install — both unchanged (full idempotency restored).
    const third = codex.install('global', { autoAllow: false });
    for (const f of third.files) expect(f.action).toBe('unchanged');
  });

  it('codex: user-added key inside [mcp_servers.cartograph] survives idempotent re-install', () => {
    const codex = getTarget('codex')!;
    codex.install('global', { autoAllow: false });
    const tomlPath = path.join(tmpHome, '.codex', 'config.toml');
    const original = fs.readFileSync(tomlPath, 'utf-8');
    // User edits the block to add a custom key.
    const edited = original.replace('args = ["serve", "--mcp"]', 'args = ["serve", "--mcp"]\nenabled = true');
    fs.writeFileSync(tomlPath, edited);
    // Re-install: our serializer doesn't know `enabled = true`, so
    // the block no longer matches the canonical form — we'll
    // overwrite it. This is the documented contract: we own the
    // cartograph block exclusively.
    const second = codex.install('global', { autoAllow: false });
    const tomlEntry = second.files.find((f) => f.path.endsWith('config.toml'))!;
    expect(tomlEntry.action).toBe('updated');
    const after = fs.readFileSync(tomlPath, 'utf-8');
    expect(after).not.toContain('enabled = true');
  });
});

describe('Installer targets — registry', () => {
  it('getTarget returns the right target for each id', () => {
    expect(getTarget('claude')?.id).toBe('claude');
    expect(getTarget('cursor')?.id).toBe('cursor');
    expect(getTarget('codex')?.id).toBe('codex');
    expect(getTarget('copilot')?.id).toBe('copilot');
    expect(getTarget('zed')?.id).toBe('zed');
    expect(getTarget('opencode')?.id).toBe('opencode');
    // F#61 — multi-target installer additions.
    expect(getTarget('hermes')?.id).toBe('hermes');
    expect(getTarget('gemini')?.id).toBe('gemini');
    expect(getTarget('antigravity')?.id).toBe('antigravity');
    expect(getTarget('kiro')?.id).toBe('kiro');
    expect(getTarget('factory')?.id).toBe('factory');
    expect(getTarget('rovo')?.id).toBe('rovo');
    expect(getTarget('qoder')?.id).toBe('qoder');
    expect(getTarget('bob')?.id).toBe('bob');
    expect(getTarget('kimi')?.id).toBe('kimi');
    expect(getTarget('reasonix')?.id).toBe('reasonix');
    expect(getTarget('not-a-real-target')).toBeUndefined();
  });

  it('resolveTargetFlag handles auto/all/none/csv', () => {
    expect(resolveTargetFlag('none', 'global')).toEqual([]);
    expect(resolveTargetFlag('all', 'global').length).toBe(ALL_TARGETS.length);
    const csv = resolveTargetFlag('claude,cursor', 'global');
    expect(csv.map((t) => t.id)).toEqual(['claude', 'cursor']);
  });

  it('resolveTargetFlag throws on unknown id', () => {
    expect(() => resolveTargetFlag('claude,bogus', 'global')).toThrow(/Unknown --target/);
  });
});

describe('Installer targets — Claude specifics', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('uses current Claude Code paths for user and private local scopes', () => {
    const claude = getTarget('claude')!;
    const cwd = process.cwd();

    expect(claude.describePaths('global')).toEqual([
      path.join(tmpHome, '.claude.json'),
      path.join(tmpHome, '.claude', 'settings.json'),
      path.join(tmpHome, '.claude', 'CLAUDE.md'),
    ]);
    expect(claude.describePaths('local')).toEqual([
      path.join(tmpHome, '.claude.json'),
      path.join(cwd, '.claude', 'settings.local.json'),
      path.join(cwd, 'CLAUDE.local.md'),
      path.join(cwd, '.gitignore'),
    ]);
  });

  it('writes Claude local MCP under the current project entry in ~/.claude.json', () => {
    const claude = getTarget('claude')!;

    claude.install('local', { autoAllow: true });

    const config = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
    expect(config.mcpServers).toBeUndefined();
    expect(config.projects[path.resolve(process.cwd())].mcpServers.cartograph).toEqual({
      type: 'stdio',
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });
    expect(fs.existsSync(path.join(tmpCwd, '.claude.json'))).toBe(false);
  });

  it('writes Claude local permissions, instructions, and ignore entries as private project files', () => {
    const claude = getTarget('claude')!;

    claude.install('local', { autoAllow: true });

    const settings = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.claude', 'settings.local.json'), 'utf-8'));
    expect(settings.permissions.allow).toContain('mcp__cartograph__cartograph_find');
    const instructions = fs.readFileSync(path.join(tmpCwd, 'CLAUDE.local.md'), 'utf-8');
    expect(instructions).toContain('<!-- CARTOGRAPH_START -->');
    const gitignore = fs.readFileSync(path.join(tmpCwd, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('CLAUDE.local.md');
    expect(gitignore).toContain('.claude/settings.local.json');
  });
});

describe('Installer targets — JSON MCP target specifics', () => {
  let tmpHome: string;
  let tmpCwd: string;
  let origCwd: string;
  let homeRestore: { restore: () => void };

  beforeEach(() => {
    tmpHome = mkTmpDir('home');
    tmpCwd = mkTmpDir('cwd');
    origCwd = process.cwd();
    process.chdir(tmpCwd);
    homeRestore = setHome(tmpHome);
  });

  afterEach(() => {
    homeRestore.restore();
    process.chdir(origCwd);
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpCwd, { recursive: true, force: true });
  });

  it('uses documented paths for Copilot, Zed, and opencode', () => {
    const copilot = getTarget('copilot')!;
    const zed = getTarget('zed')!;
    const opencode = getTarget('opencode')!;

    expect(copilot.describePaths('global')).toEqual([path.join(tmpHome, '.copilot', 'mcp-config.json')]);
    expect(copilot.describePaths('local')).toEqual([path.join(process.cwd(), '.mcp.json')]);
    expect(zed.describePaths('global')).toEqual([path.join(tmpHome, '.config', 'zed', 'settings.json')]);
    expect(zed.describePaths('local')).toEqual([path.join(process.cwd(), '.zed', 'settings.json')]);
    expect(opencode.describePaths('global')).toEqual([path.join(tmpHome, '.config', 'opencode', 'opencode.json')]);

    fs.mkdirSync(path.join(process.cwd(), '.github'), { recursive: true });
    fs.writeFileSync(path.join(process.cwd(), '.github', 'mcp.json'), '{}\n');
    expect(copilot.describePaths('local')).toEqual([path.join(process.cwd(), '.github', 'mcp.json')]);
  });

  it('honors COPILOT_HOME for the Copilot global config directory', () => {
    const copilot = getTarget('copilot')!;
    const prev = process.env['COPILOT_HOME'];
    const copilotHome = mkTmpDir('copilot-home');
    process.env['COPILOT_HOME'] = copilotHome;
    try {
      expect(copilot.describePaths('global')).toEqual([path.join(copilotHome, 'mcp-config.json')]);
      copilot.install('global', { autoAllow: false });
      expect(fs.existsSync(path.join(copilotHome, 'mcp-config.json'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['COPILOT_HOME'];
      else process.env['COPILOT_HOME'] = prev;
      fs.rmSync(copilotHome, { recursive: true, force: true });
    }
  });

  it('writes the Copilot MCP entry with an explicit all-tools allowlist', () => {
    const copilot = getTarget('copilot')!;

    copilot.install('local', { autoAllow: false });

    const config = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(config.mcpServers.cartograph).toEqual({
      type: 'stdio',
      command: 'cartograph',
      args: ['serve', '--mcp'],
      tools: ['*'],
    });
  });

  it('writes the Zed context_servers entry shape', () => {
    const zed = getTarget('zed')!;

    zed.install('local', { autoAllow: false });

    const config = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.zed', 'settings.json'), 'utf-8'));
    expect(config.context_servers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });
    expect(config.mcpServers).toBeUndefined();
  });

  it('honors XDG_CONFIG_HOME for the Zed global settings directory', () => {
    const zed = getTarget('zed')!;
    const prev = process.env['XDG_CONFIG_HOME'];
    const xdgHome = mkTmpDir('xdg-home');
    process.env['XDG_CONFIG_HOME'] = xdgHome;
    try {
      expect(zed.describePaths('global')).toEqual([path.join(xdgHome, 'zed', 'settings.json')]);
      zed.install('global', { autoAllow: false });
      expect(fs.existsSync(path.join(xdgHome, 'zed', 'settings.json'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['XDG_CONFIG_HOME'];
      else process.env['XDG_CONFIG_HOME'] = prev;
      fs.rmSync(xdgHome, { recursive: true, force: true });
    }
  });

  it('uses disjoint default paths for Factory, Rovo, Qoder, CodeWhale, Bob, Kimi, and Reasonix targets', () => {
    const factory = getTarget('factory')!;
    const rovo = getTarget('rovo')!;
    const qoder = getTarget('qoder')!;
    const codewhale = getTarget('codewhale')!;
    const bob = getTarget('bob')!;
    const kimi = getTarget('kimi')!;
    const reasonix = getTarget('reasonix')!;

    const paths = [
      ...factory.describePaths('global'),
      ...factory.describePaths('local'),
      ...rovo.describePaths('global'),
      ...rovo.describePaths('local'),
      ...qoder.describePaths('global'),
      ...qoder.describePaths('local'),
      ...codewhale.describePaths('global'),
      ...codewhale.describePaths('local'),
      ...bob.describePaths('global'),
      ...bob.describePaths('local'),
      ...kimi.describePaths('global'),
      ...kimi.describePaths('local'),
      ...reasonix.describePaths('global'),
    ];

    expect(new Set(paths).size).toBe(paths.length);
    expect(factory.describePaths('global')).toEqual([path.join(tmpHome, '.factory', 'mcp.json')]);
    expect(rovo.describePaths('local')).toEqual([path.join(process.cwd(), '.rovodev', 'mcp.json')]);
    expect(qoder.describePaths('local')).toEqual([path.join(process.cwd(), '.qoder', 'settings.local.json')]);
    expect(codewhale.describePaths('global')).toEqual([path.join(tmpHome, '.codewhale', 'mcp.json')]);
    expect(codewhale.describePaths('local')).toEqual([path.join(process.cwd(), '.codewhale', 'mcp.json')]);
    expect(bob.describePaths('global')).toEqual([path.join(tmpHome, '.bob', 'mcp_settings.json')]);
    expect(bob.describePaths('local')).toEqual([path.join(process.cwd(), '.bob', 'mcp.json')]);
    expect(kimi.describePaths('global')).toEqual([path.join(tmpHome, '.kimi-code', 'mcp.json')]);
    expect(kimi.describePaths('local')).toEqual([path.join(process.cwd(), '.kimi-code', 'mcp.json')]);
    expect(reasonix.describePaths('global')).toEqual([path.join(tmpHome, '.reasonix', 'config.json')]);
    expect(reasonix.supportsLocation('local')).toBe(false);
  });

  it('reasonix is detected only for the supported global install location', () => {
    const reasonix = getTarget('reasonix')!;
    fs.mkdirSync(path.join(tmpHome, '.reasonix'), { recursive: true });

    expect(reasonix.detect('global').installed).toBe(true);
    expect(reasonix.detect('local').installed).toBe(false);
    expect(reasonix.supportsLocation('local')).toBe(false);
  });

  it('writes each target-specific MCP entry shape', () => {
    const factory = getTarget('factory')!;
    const rovo = getTarget('rovo')!;
    const qoder = getTarget('qoder')!;
    const codewhale = getTarget('codewhale')!;
    const bob = getTarget('bob')!;
    const kimi = getTarget('kimi')!;
    const reasonix = getTarget('reasonix')!;

    factory.install('local', { autoAllow: false });
    rovo.install('local', { autoAllow: false });
    qoder.install('local', { autoAllow: false });
    codewhale.install('local', { autoAllow: false });
    bob.install('local', { autoAllow: false });
    kimi.install('local', { autoAllow: false });
    reasonix.install('global', { autoAllow: false });

    const factoryConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.factory', 'mcp.json'), 'utf-8'));
    expect(factoryConfig.mcpServers.cartograph).toEqual({
      type: 'stdio',
      command: 'cartograph',
      args: ['serve', '--mcp'],
      disabled: false,
    });

    const rovoConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.rovodev', 'mcp.json'), 'utf-8'));
    expect(rovoConfig.mcpServers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
      transport: 'stdio',
    });

    const qoderConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.qoder', 'settings.local.json'), 'utf-8'));
    expect(qoderConfig.mcpServers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });

    const codewhaleConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.codewhale', 'mcp.json'), 'utf-8'));
    expect(codewhaleConfig.mcpServers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });

    const bobConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.bob', 'mcp.json'), 'utf-8'));
    expect(bobConfig.mcpServers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
      disabled: false,
    });

    const kimiConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.kimi-code', 'mcp.json'), 'utf-8'));
    expect(kimiConfig.mcpServers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });

    const reasonixConfig = JSON.parse(fs.readFileSync(path.join(tmpHome, '.reasonix', 'config.json'), 'utf-8'));
    expect(reasonixConfig.mcpServers.cartograph).toEqual({
      command: 'cartograph',
      args: ['serve', '--mcp'],
      disabled: false,
    });
  });

  it('writes a custom command path across target-specific MCP config shapes', () => {
    const command = '/opt/cartograph/bin/cartograph';

    getTarget('claude')!.install('local', { autoAllow: false, command });
    getTarget('copilot')!.install('local', { autoAllow: false, command });
    getTarget('zed')!.install('local', { autoAllow: false, command });
    getTarget('opencode')!.install('local', { autoAllow: false, command });
    getTarget('factory')!.install('local', { autoAllow: false, command });
    getTarget('rovo')!.install('local', { autoAllow: false, command });
    getTarget('qoder')!.install('local', { autoAllow: false, command });
    getTarget('codewhale')!.install('local', { autoAllow: false, command });
    getTarget('bob')!.install('local', { autoAllow: false, command });
    getTarget('kimi')!.install('local', { autoAllow: false, command });
    getTarget('gemini')!.install('local', { autoAllow: false, command });
    getTarget('kiro')!.install('local', { autoAllow: false, command });
    getTarget('codex')!.install('global', { autoAllow: false, command });
    getTarget('hermes')!.install('global', { autoAllow: false, command });
    getTarget('antigravity')!.install('global', { autoAllow: false, command });
    getTarget('reasonix')!.install('global', { autoAllow: false, command });

    const claudeConfig = JSON.parse(fs.readFileSync(path.join(tmpHome, '.claude.json'), 'utf-8'));
    expect(claudeConfig.projects[path.resolve(process.cwd())].mcpServers.cartograph.command).toBe(command);
    const copilotConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.mcp.json'), 'utf-8'));
    expect(copilotConfig.mcpServers.cartograph.command).toBe(command);
    const zedConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.zed', 'settings.json'), 'utf-8'));
    expect(zedConfig.context_servers.cartograph.command).toBe(command);
    const opencodeConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, 'opencode.json'), 'utf-8'));
    expect(opencodeConfig.mcp.cartograph.command[0]).toBe(command);
    const factoryConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.factory', 'mcp.json'), 'utf-8'));
    expect(factoryConfig.mcpServers.cartograph.command).toBe(command);
    const rovoConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.rovodev', 'mcp.json'), 'utf-8'));
    expect(rovoConfig.mcpServers.cartograph.command).toBe(command);
    const qoderConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.qoder', 'settings.local.json'), 'utf-8'));
    expect(qoderConfig.mcpServers.cartograph.command).toBe(command);
    const codewhaleConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.codewhale', 'mcp.json'), 'utf-8'));
    expect(codewhaleConfig.mcpServers.cartograph.command).toBe(command);
    const bobConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.bob', 'mcp.json'), 'utf-8'));
    expect(bobConfig.mcpServers.cartograph.command).toBe(command);
    const kimiConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.kimi-code', 'mcp.json'), 'utf-8'));
    expect(kimiConfig.mcpServers.cartograph.command).toBe(command);
    const geminiConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.gemini', 'settings.json'), 'utf-8'));
    expect(geminiConfig.mcpServers.cartograph.command).toBe(command);
    const kiroConfig = JSON.parse(fs.readFileSync(path.join(tmpCwd, '.kiro', 'settings', 'mcp.json'), 'utf-8'));
    expect(kiroConfig.mcpServers.cartograph.command).toBe(command);
    const codexToml = fs.readFileSync(path.join(tmpHome, '.codex', 'config.toml'), 'utf-8');
    expect(codexToml).toContain(`command = "${command}"`);
    const hermesYaml = fs.readFileSync(path.join(tmpHome, '.hermes', 'config.yaml'), 'utf-8');
    expect(hermesYaml).toContain(`command: ${command}`);
    const antigravityConfig = JSON.parse(
      fs.readFileSync(path.join(tmpHome, '.gemini', 'antigravity', 'mcp_config.json'), 'utf-8'),
    );
    expect(antigravityConfig.mcpServers.cartograph.command).toBe(command);
    const reasonixConfig = JSON.parse(fs.readFileSync(path.join(tmpHome, '.reasonix', 'config.json'), 'utf-8'));
    expect(reasonixConfig.mcpServers.cartograph.command).toBe(command);
    expect(getTarget('copilot')!.printConfig('local', { command })).toContain(`"command": "${command}"`);
  });

  it('kimi honors KIMI_CODE_HOME for the global MCP config directory', () => {
    const kimi = getTarget('kimi')!;
    const prev = process.env['KIMI_CODE_HOME'];
    const kimiHome = mkTmpDir('kimi-home');
    process.env['KIMI_CODE_HOME'] = kimiHome;
    try {
      expect(kimi.describePaths('global')).toEqual([path.join(kimiHome, 'mcp.json')]);
      kimi.install('global', { autoAllow: false });
      expect(fs.existsSync(path.join(kimiHome, 'mcp.json'))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env['KIMI_CODE_HOME'];
      else process.env['KIMI_CODE_HOME'] = prev;
      fs.rmSync(kimiHome, { recursive: true, force: true });
    }
  });

  it('qoder writes and removes auto-allow permissions when requested', () => {
    const qoder = getTarget('qoder')!;
    qoder.install('local', { autoAllow: true });

    const settingsPath = path.join(tmpCwd, '.qoder', 'settings.local.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(settings.permissions.allow).toContain('mcp__cartograph__cartograph_find');
    expect(settings.permissions.allow).toContain('mcp__cartograph__cartograph_status');

    const second = qoder.install('local', { autoAllow: true });
    for (const file of second.files) expect(file.action).toBe('unchanged');

    qoder.uninstall('local');
    const after = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'));
    expect(after.mcpServers?.cartograph).toBeUndefined();
    expect(after.permissions?.allow).toBeUndefined();
  });

  it('rovo honors an existing mcpConfigPath override', () => {
    const rovo = getTarget('rovo')!;
    const rovoDir = path.join(tmpCwd, '.rovodev');
    fs.mkdirSync(rovoDir, { recursive: true });
    fs.writeFileSync(
      path.join(rovoDir, 'config.yml'),
      ['mcp:', '  mcpConfigPath: .rovodev/custom-mcp.json', ''].join('\n'),
    );

    const expected = path.join(process.cwd(), '.rovodev', 'custom-mcp.json');
    expect(rovo.describePaths('local')).toEqual([expected]);

    rovo.install('local', { autoAllow: false });
    const config = JSON.parse(fs.readFileSync(expected, 'utf-8'));
    expect(config.mcpServers.cartograph.transport).toBe('stdio');
  });
});

describe('Installer targets — TOML serializer (Codex backbone)', () => {
  it('builds a [mcp_servers.cartograph] block with command + args', () => {
    const block = buildTomlTable('mcp_servers.cartograph', {
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });
    expect(block).toContain('[mcp_servers.cartograph]');
    expect(block).toContain('command = "cartograph"');
    expect(block).toContain('args = ["serve", "--mcp"]');
  });

  it('upsert inserts into empty content', () => {
    const block = buildTomlTable('mcp_servers.cartograph', { command: 'cartograph', args: ['serve'] });
    const { content, action } = upsertTomlTable('', 'mcp_servers.cartograph', block);
    expect(action).toBe('inserted');
    expect(content.startsWith('[mcp_servers.cartograph]')).toBe(true);
  });

  it('upsert is idempotent — second call returns unchanged', () => {
    const block = buildTomlTable('mcp_servers.cartograph', { command: 'cartograph', args: ['serve'] });
    const first = upsertTomlTable('', 'mcp_servers.cartograph', block);
    const second = upsertTomlTable(first.content, 'mcp_servers.cartograph', block);
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  it('upsert replaces an existing block in place, preserving sibling tables', () => {
    const existing = [
      '[other_table]',
      'foo = "bar"',
      '',
      '[mcp_servers.cartograph]',
      'command = "old-cartograph"',
      'args = ["old"]',
      '',
      '[zzz]',
      'baz = "qux"',
      '',
    ].join('\n');
    const newBlock = buildTomlTable('mcp_servers.cartograph', {
      command: 'cartograph',
      args: ['serve', '--mcp'],
    });
    const { content, action } = upsertTomlTable(existing, 'mcp_servers.cartograph', newBlock);
    expect(action).toBe('replaced');
    expect(content).toContain('[other_table]');
    expect(content).toContain('foo = "bar"');
    expect(content).toContain('[zzz]');
    expect(content).toContain('baz = "qux"');
    expect(content).toContain('command = "cartograph"');
    expect(content).not.toContain('old-cartograph');
  });

  it('removeTomlTable strips the block and preserves siblings', () => {
    const existing = [
      '[other_table]',
      'foo = "bar"',
      '',
      '[mcp_servers.cartograph]',
      'command = "cartograph"',
      'args = ["serve"]',
    ].join('\n');
    const { content, action } = removeTomlTable(existing, 'mcp_servers.cartograph');
    expect(action).toBe('removed');
    expect(content).toContain('[other_table]');
    expect(content).toContain('foo = "bar"');
    expect(content).not.toContain('mcp_servers.cartograph');
  });

  it('removeTomlTable on missing table returns not-found, no content change', () => {
    const existing = '[other]\nfoo = "bar"\n';
    const { content, action } = removeTomlTable(existing, 'mcp_servers.cartograph');
    expect(action).toBe('not-found');
    expect(content).toBe(existing);
  });

  it('upsert preserves an array-of-tables sibling [[foo]]', () => {
    const existing = ['[[foo]]', 'name = "a"', '', '[[foo]]', 'name = "b"', ''].join('\n');
    const block = buildTomlTable('mcp_servers.cartograph', { command: 'cartograph', args: ['serve'] });
    const { content } = upsertTomlTable(existing, 'mcp_servers.cartograph', block);
    expect(content.match(/\[\[foo\]\]/g)?.length).toBe(2);
    expect(content).toContain('[mcp_servers.cartograph]');
  });
});

function listAllFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listAllFiles(full));
    else out.push(full);
  }
  return out;
}
