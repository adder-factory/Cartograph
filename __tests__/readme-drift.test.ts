import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getSupportedLanguages } from '../src/extraction/grammars.js';
import { ALL_TARGETS } from '../src/installer/targets/registry.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

const root = path.resolve(import.meta.dir, '..');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

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
});
