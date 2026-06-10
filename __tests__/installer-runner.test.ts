import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runInstallerWithOptions } from '../src/installer/index.js';

function mkTmpDir(label: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cartograph-installer-runner-${label}-`));
}

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

function listFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(path.relative(root, full));
    }
  };
  walk(root);
  out.sort();
  return out;
}

describe('runInstallerWithOptions', () => {
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

  it('honors target=none without writing agent configuration', async () => {
    await runInstallerWithOptions({ yes: true, location: 'global', target: 'none' });

    expect(listFiles(tmpHome)).toEqual([]);
    expect(listFiles(tmpCwd)).toEqual([]);
  });

  it('initializes local projects in yes mode without interactive LLM config', async () => {
    await runInstallerWithOptions({ yes: true, location: 'local', target: 'none' });

    const configPath = path.join(tmpCwd, '.cartograph', 'config.json');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).not.toContain('"llm"');
    expect(listFiles(tmpHome)).toEqual([]);
  });

  it('writes selected global target configuration under redirected HOME', async () => {
    await runInstallerWithOptions({
      yes: true,
      location: 'global',
      target: 'codex',
      autoAllow: false,
    });

    const configPath = path.join(tmpHome, '.codex', 'config.toml');
    const agentsPath = path.join(tmpHome, '.codex', 'AGENTS.md');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.existsSync(agentsPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain('[mcp_servers.cartograph]');
    expect(fs.readFileSync(agentsPath, 'utf-8')).toContain('Cartograph');
  });

  it('writes selected Codex target configuration locally under the project', async () => {
    await runInstallerWithOptions({
      yes: true,
      location: 'local',
      target: 'codex',
      autoAllow: false,
    });

    const configPath = path.join(tmpCwd, '.codex', 'config.toml');
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, 'utf-8')).toContain(
      `args = ["serve", "--mcp", "--project-path", "${path.resolve(process.cwd())}"]`,
    );
    expect(fs.readFileSync(path.join(tmpCwd, '.gitignore'), 'utf-8')).toContain('.codex/config.toml');
    expect(listFiles(tmpHome)).toEqual([]);
  });

  it('rejects unknown target ids before writing files', async () => {
    await expect(
      runInstallerWithOptions({ yes: true, location: 'global', target: 'codex,missing-agent' }),
    ).rejects.toThrow(/Unknown --target id\(s\): missing-agent/);

    expect(listFiles(tmpHome)).toEqual([]);
    expect(listFiles(tmpCwd)).toEqual([]);
  });
});
