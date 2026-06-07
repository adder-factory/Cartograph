import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSupportedLanguages } from '../src/extraction/grammars.js';
import { getLanguageDefs } from '../src/extraction/languages/registry.js';
import { ALL_TARGETS } from '../src/installer/targets/registry.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

const root = path.resolve(import.meta.dir, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const supportMatrix = fs.readFileSync(path.join(root, 'docs/SUPPORT-MATRIX.md'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as {
  files?: string[];
};

function topLevelCommandsFromHelp(): string[] {
  const help = execFileSync('bun', ['src/bin/cartograph.ts', '--help'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

  const commands = new Set<string>();
  for (const line of help.split('\n')) {
    const match = /^\s{2}([a-z][a-z-]*)\b/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    if (name !== 'help') commands.add(name);
  }
  return [...commands].sort((a, b) => a.localeCompare(b));
}

describe('README drift guard', () => {
  it('keeps live MCP and language counts in sync with the registry', () => {
    const toolCount = getToolModules().length;
    const languageCount = getSupportedLanguages().length;

    expect(readme).toContain(`exposes all ${toolCount} registered tools`);
    expect(readme).toContain(`full ${toolCount}-tool server`);
    expect(readme).toContain(`supports **${languageCount} language modes**`);
  });

  it('documents every top-level CLI command from --help', () => {
    const missing = topLevelCommandsFromHelp().filter((cmd) => !readme.includes(`cartograph ${cmd}`));

    expect(missing, `README is missing top-level CLI command(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('mentions every installer target exposed by the registry', () => {
    const haystack = readme.toLowerCase();
    const missing = ALL_TARGETS.filter((target) => {
      return !haystack.includes(target.id.toLowerCase()) && !haystack.includes(target.displayName.toLowerCase());
    }).map((target) => `${target.id} (${target.displayName})`);

    expect(missing, `README is missing installer target(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the support matrix split into languages, frameworks, and derived signals', () => {
    expect(readme).toContain('## Supported Languages & File Formats');
    expect(readme).toContain('<summary><strong>Show language matrix</strong></summary>');
    expect(readme).toContain('## Framework-Aware Signals');
    expect(readme).toContain('## Embedded DSLs & Derived Signals');
  });

  it('keeps the detailed support matrix in sync with language registry names', () => {
    const languageCount = getSupportedLanguages().length;
    expect(supportMatrix).toContain(`Cartograph supports ${languageCount} language modes`);

    const missing = getLanguageDefs()
      .filter((def) => !supportMatrix.includes(def.displayName))
      .map((def) => def.displayName);

    expect(missing, `docs/SUPPORT-MATRIX.md is missing language(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('ships README-linked docs and assets in the package allowlist', () => {
    const files = new Set(packageJson.files ?? []);
    for (const expected of ['docs', 'bench', 'ACKNOWLEDGEMENTS.md', 'install.sh', 'install.ps1']) {
      expect(files.has(expected), `package.json files is missing ${expected}`).toBe(true);
    }
  });
});
