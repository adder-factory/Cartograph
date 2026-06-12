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
const cliReference = fs.readFileSync(path.join(root, 'docs/CLI-REFERENCE.md'), 'utf8');
const mcpUsage = fs.readFileSync(path.join(root, 'docs/MCP-USAGE.md'), 'utf8');
const standaloneBuilder = fs.readFileSync(path.join(root, 'scripts/build-standalone.mjs'), 'utf8');
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

    expect(readme).toContain(`registers **${toolCount} MCP tools**`);
    expect(mcpUsage).toContain(`full ${toolCount}-tool profile`);
    expect(readme).toContain(`supports **${languageCount} language modes**`);
    // The hero badge carries the same count — keep it from rotting.
    expect(readme).toContain(`languages-${languageCount}_modes`);
  });

  it('documents every top-level CLI command from --help', () => {
    // The README intentionally shows a curated sample and delegates the
    // full command list to docs/CLI-REFERENCE.md — drift is checked
    // against the pair.
    const documented = `${readme}\n${cliReference}`;
    const missing = topLevelCommandsFromHelp().filter((cmd) => !documented.includes(`cartograph ${cmd}`));

    expect(missing, `README + CLI reference are missing top-level CLI command(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('mentions every installer target exposed by the registry', () => {
    const haystack = readme.toLowerCase();
    const missing = ALL_TARGETS.filter((target) => {
      return !haystack.includes(target.id.toLowerCase()) && !haystack.includes(target.displayName.toLowerCase());
    }).map((target) => `${target.id} (${target.displayName})`);

    expect(missing, `README is missing installer target(s): ${missing.join(', ')}`).toEqual([]);
  });

  it('keeps the support matrix split into languages, frameworks, and derived signals', () => {
    expect(supportMatrix).toContain('## Languages');
    expect(supportMatrix).toContain('## Framework-Aware Signals');
    expect(supportMatrix).toContain('## Embedded DSLs And Derived Signals');
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
    for (const expected of [
      'docs/assets/viewer.png',
      'docs/AGENT-INSTALL.md',
      'docs/ADDING-A-LANGUAGE.md',
      'docs/CLI-REFERENCE.md',
      'docs/CONFIGURATION.md',
      'docs/GRAMMAR-ASSETS.md',
      'docs/GRAPH-EXPORT-FORMATS.md',
      'docs/MCP-USAGE.md',
      'docs/STORAGE-BACKENDS.md',
      'docs/SUPPORT-MATRIX.md',
      'docs/TROUBLESHOOTING.md',
      'bench/README.md',
      'bench/storage-backends.mts',
      'ACKNOWLEDGEMENTS.md',
      'install.sh',
      'install.ps1',
    ]) {
      expect(files.has(expected), `package.json files is missing ${expected}`).toBe(true);
    }
    // Every image the README displays must ship, or the npm page renders
    // broken galleries — derived from the README so new shots can't be
    // forgotten (reviewer catch on the trace/live gallery additions).
    const readmeImages = [...readme.matchAll(/src="(docs\/assets\/[^"]+)"/g)].map((m) => m[1] ?? '');
    expect(readmeImages.length).toBeGreaterThan(0);
    for (const img of readmeImages) {
      expect(files.has(img), `package.json files is missing README-displayed image ${img}`).toBe(true);
    }
    expect(files.has('docs'), 'package.json files should not ship private docs wholesale').toBe(false);
    expect(files.has('AGENTS.md'), 'repo-local agent instructions are private project docs').toBe(false);
    expect(files.has('docs/ARCHITECTURE.md'), 'architecture rules are private project docs').toBe(false);
  });

  it('keeps standalone release docs public-facing', () => {
    expect(standaloneBuilder).toContain("copyFile('docs/AGENT-INSTALL.md', 'AGENT-INSTALL.md')");
    expect(standaloneBuilder).not.toContain("copyFile('AGENTS.md'");
  });
});
