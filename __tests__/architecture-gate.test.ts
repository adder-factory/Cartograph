import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(import.meta.dir, '..');
const scriptPath = path.join(repoRoot, 'scripts', 'check-architecture.mjs');

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function runGate(root: string): { code: number; output: string } {
  try {
    const output = execFileSync('node', [scriptPath, '--root', root], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, output };
  } catch (error) {
    const err = error as { status?: number; stdout?: string; stderr?: string };
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function writeCleanArchitectureFixture(root: string): void {
  writeFile(
    root,
    'package.json',
    JSON.stringify({
      scripts: {
        check: 'npm run check:architecture && npm run check:biome',
        'check:architecture': 'node scripts/check-architecture.mjs',
        'check:biome': 'biome check',
      },
    }),
  );
  writeFile(root, '.github/workflows/check.yml', 'steps:\n  - run: npm run check\n');
  writeFile(root, 'docs/ARCHITECTURE.md', 'check:architecture scripts/check-architecture.mjs file-discovery-policy.ts');
  writeFile(
    root,
    'src/extraction/index.ts',
    "import { findCartographIgnoredDirs } from './file-discovery-policy.js';\n",
  );
  writeFile(root, 'src/extraction/file-discovery-policy.ts', 'export const policy = true;\n');
  writeFile(root, 'src/resolution/name-matcher.ts', 'export const matcher = true;\n');
  writeFile(root, 'src/mcp/tools.ts', 'export const tools = true;\n');
  writeFile(root, 'src/db/queries-search.ts', 'export const search = true;\n');
  writeFile(root, 'src/context/index.ts', 'export const context = true;\n');
  writeFile(root, 'src/bin/_cli-core.ts', 'export const cli = true;\n');
  writeFile(root, 'src/db/queries.ts', 'export const queries = true;\n');
  writeFile(
    root,
    'src/resolution/frameworks/foo.ts',
    [
      "import type { FrameworkResolver } from '../types.js';",
      'export const fooResolver: FrameworkResolver = {',
      "  name: 'foo',",
      "  languages: ['typescript'],",
      '  detect() { return true; },',
      '  resolve() { return null; },',
      '};',
    ].join('\n'),
  );
  writeFile(
    root,
    'src/resolution/frameworks/index.ts',
    "import { fooResolver } from './foo.js';\nconst FRAMEWORK_RESOLVERS = [fooResolver];\n",
  );
}

describe('architecture gate', () => {
  it('passes for the checked-in repository', () => {
    const result = runGate(repoRoot);

    expect(result.output).toContain('architecture-gate OK');
    expect(result.code).toBe(0);
  });

  it('fails on broad buckets, ungated resolvers, and discovery-policy drift', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-arch-gate-'));
    try {
      writeCleanArchitectureFixture(dir);
      writeFile(dir, 'src/common/helpers.ts', 'export const drift = true;\n');
      fs.appendFileSync(path.join(dir, 'src/extraction/index.ts'), 'function findCartographIgnoredDirs() {}\n');
      writeFile(
        dir,
        'src/resolution/frameworks/bad.ts',
        [
          "import type { FrameworkResolver } from '../types.js';",
          'export const badResolver: FrameworkResolver = {',
          "  name: 'bad',",
          '  detect() { return true; },',
          '  resolve() { return null; },',
          '};',
        ].join('\n'),
      );

      const result = runGate(dir);

      expect(result.code).not.toBe(0);
      expect(result.output).toContain('forbidden broad bucket directory: src/common');
      expect(result.output).toContain('defines findCartographIgnoredDirs');
      expect(result.output).toContain('badResolver must declare `languages`');
      expect(result.output).toContain('badResolver must be registered');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
