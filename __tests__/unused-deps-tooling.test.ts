import { describe, it, expect, beforeAll } from 'vitest';
import { Cartograph } from '../src/index.js';
import { analyzeUnusedDeps } from '../src/deps/unused.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { saveConfig } from '../src/config.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unused-deps-tooling-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('unused deps analyzer - tooling deps', () => {
  it('detects bin lookup hits from node_modules', async () => {
    const tmpDir = tempDir();
    try {
      // Create a mock node_modules structure
      const nmDir = path.join(tmpDir, 'node_modules', 'tooling-pkg');
      fs.mkdirSync(nmDir, { recursive: true });

      fs.writeFileSync(
        path.join(nmDir, 'package.json'),
        JSON.stringify({
          name: 'tooling-pkg',
          bin: { tcommand: './bin.js' },
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { 'tooling-pkg': '^1.0.0' },
          scripts: { build: 'tcommand' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('tooling-pkg');
      expect(result.used).toContain('tooling-pkg');
      expect(result.unusedDev).not.toContain('tooling-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('detects direct package name match in scripts', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { vitest: '^1.0.0' },
          scripts: { test: 'vitest run' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('vitest');
      expect(result.used).toContain('vitest');
      expect(result.unusedDev).not.toContain('vitest');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('handles bin as string form', async () => {
    const tmpDir = tempDir();
    try {
      // Create a mock node_modules structure with bin as string
      const nmDir = path.join(tmpDir, 'node_modules', 'foo');
      fs.mkdirSync(nmDir, { recursive: true });

      fs.writeFileSync(
        path.join(nmDir, 'package.json'),
        JSON.stringify({
          name: 'foo',
          bin: './bin.js',
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { foo: '^1.0.0' },
          scripts: { build: 'foo --help' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('foo');
      expect(result.used).toContain('foo');
      expect(result.unusedDev).not.toContain('foo');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('suppresses dep via allowlist', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      // Add allowlist to config
      const config = cg.config;
      config.dependenciesAllowlist = ['lodash'];
      saveConfig(tmpDir, config);

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('lodash');
      expect(result.used).toContain('lodash');
      expect(result.unusedRuntime).not.toContain('lodash');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('still flags genuinely unused deps', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'unused-pkg': '^1.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('unused-pkg');
      expect(result.used).not.toContain('unused-pkg');
      expect(result.unusedRuntime).toContain('unused-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('gracefully handles missing node_modules', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { vitest: '^1.0.0' },
          scripts: { test: 'vitest run' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // vitest should still be marked as used via direct package-name match in scripts
      expect(result.declaredDev).toContain('vitest');
      expect(result.used).toContain('vitest');
      expect(result.unusedDev).not.toContain('vitest');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('treats a vitest coverage provider declared in vitest.config as used', async () => {
    const tmpDir = tempDir();
    try {
      // @vitest/coverage-v8 is loaded by vitest from `test.coverage.provider`
      // in vitest.config.ts — never `import`ed in source. Without provider
      // detection it false-flags as an unused devDependency.
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { '@vitest/coverage-v8': '^4.0.0', vitest: '^4.0.0' },
          scripts: { test: 'vitest run' },
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, 'vitest.config.ts'),
        `import { defineConfig } from 'vitest/config';\n` +
          `export default defineConfig({\n` +
          `  test: { coverage: { provider: 'v8', reporter: ['text'] } },\n` +
          `});\n`,
      );
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('@vitest/coverage-v8');
      expect(result.used).toContain('@vitest/coverage-v8');
      expect(result.unusedDev).not.toContain('@vitest/coverage-v8');
      // Provider package detected from config never enters `undeclared`.
      expect(result.undeclared).not.toContain('@vitest/coverage-v8');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('maps the istanbul provider to @vitest/coverage-istanbul', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { '@vitest/coverage-istanbul': '^4.0.0' },
        }),
      );
      fs.writeFileSync(
        path.join(tmpDir, 'vite.config.ts'),
        `export default { test: { coverage: { provider: "istanbul" } } };\n`,
      );
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('@vitest/coverage-istanbul');
      expect(result.unusedDev).not.toContain('@vitest/coverage-istanbul');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does NOT mark a coverage provider used when no config declares it', async () => {
    const tmpDir = tempDir();
    try {
      // No vitest.config — the provider package is genuinely unused.
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { '@vitest/coverage-v8': '^4.0.0' },
        }),
      );
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).not.toContain('@vitest/coverage-v8');
      expect(result.unusedDev).toContain('@vitest/coverage-v8');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('handles multiple bins in object form', async () => {
    const tmpDir = tempDir();
    try {
      // Create a mock node_modules with multiple bin entries
      const nmDir = path.join(tmpDir, 'node_modules', 'multi-bin');
      fs.mkdirSync(nmDir, { recursive: true });

      fs.writeFileSync(
        path.join(nmDir, 'package.json'),
        JSON.stringify({
          name: 'multi-bin',
          bin: {
            cmd1: './bin/cmd1.js',
            cmd2: './bin/cmd2.js',
          },
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { 'multi-bin': '^1.0.0' },
          scripts: { build: 'cmd1 && cmd2' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('multi-bin');
      expect(result.used).toContain('multi-bin');
      expect(result.unusedDev).not.toContain('multi-bin');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('ignores malformed object-form bin entries instead of marking the package used', async () => {
    const tmpDir = tempDir();
    try {
      const nmDir = path.join(tmpDir, 'node_modules', 'bad-bin-pkg');
      fs.mkdirSync(nmDir, { recursive: true });

      fs.writeFileSync(
        path.join(nmDir, 'package.json'),
        JSON.stringify({
          name: 'bad-bin-pkg',
          bin: {
            'bad-bin': 1,
          },
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { 'bad-bin-pkg': '^1.0.0' },
          scripts: { build: 'bad-bin' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('bad-bin-pkg');
      expect(result.used).not.toContain('bad-bin-pkg');
      expect(result.unusedDev).toContain('bad-bin-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });
});
