import { describe, it, expect, beforeAll } from 'vitest';
import { Cartograph } from '../src/index.js';
import { analyzeUnusedDeps } from '../src/deps/unused.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unused-deps-ws-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeJson(p: string, value: unknown): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(value, null, 2));
}

function writeSrc(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('unused deps — workspaces', () => {
  it('unions declared deps across workspaces (root + apps/*) so a workspace-declared dep is not flagged undeclared', async () => {
    const tmpDir = tempDir();
    try {
      // Root: workspaces field + only devDeps.
      writeJson(path.join(tmpDir, 'package.json'), {
        name: 'root',
        private: true,
        workspaces: ['apps/*', 'packages/*'],
        devDependencies: { typescript: '^5.0.0' },
      });
      // apps/cli — declares zod as a runtime dep.
      writeJson(path.join(tmpDir, 'apps/cli/package.json'), {
        name: '@x/cli',
        dependencies: { zod: '^4.0.0' },
      });
      writeSrc(path.join(tmpDir, 'apps/cli/index.ts'), `import { z } from 'zod';\nexport const s = z.string();\n`);
      // packages/shared — also imports zod.
      writeJson(path.join(tmpDir, 'packages/shared/package.json'), {
        name: '@x/shared',
        dependencies: { zod: '^4.0.0' },
      });
      writeSrc(path.join(tmpDir, 'packages/shared/lib.ts'), `import { z } from 'zod';\nexport const t = z.number();\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('zod');
      expect(result.used).toContain('zod');
      expect(result.undeclared).not.toContain('zod');
      expect(result.unusedRuntime).not.toContain('zod');
      expect(result.workspaceManifestPaths.length).toBe(3);
      expect(result.workspaceManifestPaths[0]).toBe(path.join(tmpDir, 'package.json'));
    } finally {
      cleanup(tmpDir);
    }
  });

  it('union of workspace scripts marks a bin invocation (tsc) as used so root-only devDep does not false-flag', async () => {
    const tmpDir = tempDir();
    try {
      writeJson(path.join(tmpDir, 'package.json'), {
        name: 'root',
        private: true,
        workspaces: ['apps/*'],
        devDependencies: { typescript: '^5.0.0' },
        // Crucially: the root's own scripts do NOT mention `tsc`. The
        // typecheck happens via `bun --filter` delegating to each
        // workspace's typecheck script. Without the workspace-scripts
        // union, `typescript` falsely flags as unused-dev.
        scripts: { check: "bun run --filter='*' typecheck" },
      });
      writeJson(path.join(tmpDir, 'apps/cli/package.json'), {
        name: '@x/cli',
        scripts: { typecheck: 'tsc --noEmit' },
      });
      writeSrc(path.join(tmpDir, 'apps/cli/index.ts'), `export const ok = true;\n`);
      // Synthesise a node_modules/typescript so binToPackage resolves
      // `tsc → typescript` for the script-token check.
      writeJson(path.join(tmpDir, 'node_modules/typescript/package.json'), {
        name: 'typescript',
        bin: { tsc: 'bin/tsc' },
      });

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('typescript');
      expect(result.used).toContain('typescript');
      expect(result.unusedDev).not.toContain('typescript');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('accepts the yarn-classic `workspaces: { packages: [...] }` object shape', async () => {
    const tmpDir = tempDir();
    try {
      writeJson(path.join(tmpDir, 'package.json'), {
        name: 'root',
        private: true,
        workspaces: { packages: ['libs/*'], nohoist: ['**/foo'] },
        devDependencies: {},
      });
      writeJson(path.join(tmpDir, 'libs/a/package.json'), {
        name: '@x/a',
        dependencies: { lodash: '^4.0.0' },
      });
      writeSrc(path.join(tmpDir, 'libs/a/index.ts'), `import _ from 'lodash';\nexport const x = _.identity(1);\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('lodash');
      expect(result.undeclared).not.toContain('lodash');
      expect(result.workspaceManifestPaths.length).toBe(2);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('back-compat: a repo without a `workspaces:` field still audits as a single-manifest project', async () => {
    const tmpDir = tempDir();
    try {
      writeJson(path.join(tmpDir, 'package.json'), {
        name: 'solo',
        dependencies: { lodash: '^4.0.0' },
      });
      writeSrc(path.join(tmpDir, 'index.ts'), `import _ from 'lodash';\nexport const x = _.identity(1);\n`);
      // Adversarial: a child package.json that is NOT a workspace —
      // should not be unioned because the root has no workspaces field.
      writeJson(path.join(tmpDir, 'apps/cli/package.json'), {
        name: '@x/cli',
        dependencies: { 'should-not-leak': '^1.0.0' },
      });

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.workspaceManifestPaths.length).toBe(1);
      expect(result.declaredRuntime).toContain('lodash');
      expect(result.declaredRuntime).not.toContain('should-not-leak');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('silently skips `!`-prefixed exclusion patterns rather than feeding them to Bun.Glob', async () => {
    const tmpDir = tempDir();
    try {
      // Reviewer-flagged edge: npm DOES support `!apps/excluded`
      // exclusion entries in `workspaces:`. Bun.Glob doesn't, so we
      // skip negation patterns in readWorkspaceManifests. The
      // positive `apps/*` pattern still includes every child — the
      // audit overcollects rather than failing on that rare construct.
      writeJson(path.join(tmpDir, 'package.json'), {
        name: 'root',
        private: true,
        workspaces: ['apps/*', '!apps/excluded'],
      });
      writeJson(path.join(tmpDir, 'apps/kept/package.json'), {
        name: '@x/kept',
        dependencies: { lodash: '^4.0.0' },
      });
      writeJson(path.join(tmpDir, 'apps/excluded/package.json'), {
        name: '@x/excluded',
        dependencies: { 'left-pad': '^1.0.0' },
      });
      writeSrc(path.join(tmpDir, 'apps/kept/index.ts'), `import _ from 'lodash';\nexport const x = _.identity(1);\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('lodash');
      // The exclusion pattern is silently skipped: both kept + excluded
      // workspace manifests are unioned (3 manifests including root).
      // `left-pad` is therefore in declaredRuntime (over-inclusion is
      // the documented trade-off).
      expect(result.declaredRuntime).toContain('left-pad');
      expect(result.workspaceManifestPaths.length).toBe(3);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('survives a malformed workspace package.json — the root manifest still contributes', async () => {
    const tmpDir = tempDir();
    try {
      writeJson(path.join(tmpDir, 'package.json'), {
        name: 'root',
        private: true,
        workspaces: ['apps/*'],
        devDependencies: { lodash: '^4.0.0' },
      });
      // Intentionally malformed JSON.
      fs.mkdirSync(path.join(tmpDir, 'apps/broken'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'apps/broken/package.json'), '{ not: valid json,,, }');
      writeSrc(path.join(tmpDir, 'apps/broken/index.ts'), `import _ from 'lodash';\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // Root contributes lodash; the broken manifest is silently skipped
      // so it never gets pushed to workspaceManifestPaths — the array
      // contains the root only.
      expect(result.declaredDev).toContain('lodash');
      expect(result.workspaceManifestPaths.length).toBe(1);
      expect(result.workspaceManifestPaths[0]).toBe(path.join(tmpDir, 'package.json'));
    } finally {
      cleanup(tmpDir);
    }
  });
});
