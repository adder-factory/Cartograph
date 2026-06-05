import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { hashContent } from '../src/extraction/index.js';
import {
  applyConfigFingerprintInvalidationPlan,
  computeConfigFingerprintInvalidationPlan,
  configFingerprint,
  type ConfigFingerprintPolicy,
} from '../src/extraction/config-fingerprints.js';
import type { SyncState } from '../src/extraction/index.js';

function syncState(): SyncState {
  return {
    filesChecked: 0,
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    filesToIndex: [],
    changedFilePaths: [],
    nodesUpdated: 0,
  };
}

describe('extraction config fingerprint invalidation', () => {
  let tempDir: string;
  let cg: Cartograph | null = null;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-config-fingerprint-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function a(): number { return 1; }\n');
    fs.writeFileSync(path.join(tempDir, 'src/b.py'), 'def b():\n    return 1\n');
  });

  afterEach(() => {
    cg?.close();
    cg = null;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('fingerprints watched config files and records missing files explicitly', () => {
    fs.writeFileSync(path.join(tempDir, 'tooling.json'), 'configured\n');
    const policy: ConfigFingerprintPolicy = {
      metadataKey: 'source_set_config_signature',
      watchedFiles: ['tooling.json', 'missing.json'],
      action: { kind: 'force-full-scan' },
    };

    const fingerprint = configFingerprint({
      rootDir: tempDir,
      config: {},
      policy,
      hashContent: (content) => `hash:${content.trim()}`,
    });

    expect(fingerprint).toBe('tooling.json:hash:configured|missing.json:missing');
  });

  it('queues JS-family files when nested-function extraction knobs change', async () => {
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    expect(
      computeConfigFingerprintInvalidationPlan({
        qb: cg.queries,
        rootDir: tempDir,
        config: cg.config,
        hashContent,
      }).changedPolicies,
    ).toHaveLength(0);

    cg.config.largeFunctionThreshold = 0;
    const plan = computeConfigFingerprintInvalidationPlan({
      qb: cg.queries,
      rootDir: tempDir,
      config: cg.config,
      hashContent,
    });
    expect(plan.forceFullScan).toBe(false);
    expect(plan.clearParseCacheLanguages).toContain('typescript');
    expect(plan.changedPolicies.map((policy) => policy.metadataKey)).toContain(
      'nested_function_extraction_config_signature',
    );

    const state = syncState();
    applyConfigFingerprintInvalidationPlan({ qb: cg.queries, rootDir: tempDir, state, plan });
    expect(state.filesToIndex).toEqual(['src/a.ts']);
    expect(state.changedFilePaths).toEqual(['src/a.ts']);
    expect(state.filesModified).toBe(1);

    const flags = cg.queries.db.prepare(`SELECT path, needs_reextract FROM files ORDER BY path`).all() as Array<{
      path: string;
      needs_reextract: number;
    }>;
    expect(flags).toEqual([
      { path: 'src/a.ts', needs_reextract: 1 },
      { path: 'src/b.py', needs_reextract: 0 },
    ]);
  });

  it('forces a full scan when source-set config changes', async () => {
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    cg.config.include = ['**/*.ts'];
    const plan = computeConfigFingerprintInvalidationPlan({
      qb: cg.queries,
      rootDir: tempDir,
      config: cg.config,
      hashContent,
    });

    expect(plan.forceFullScan).toBe(true);
    expect(plan.changedPolicies.map((policy) => policy.metadataKey)).toContain('source_set_config_signature');
  });

  it('removes stale indexed rows when maxFileSize shrinks below unchanged files', async () => {
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    expect((cg.queries.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c).toBe(2);

    cg.updateConfig({ maxFileSize: 1 });
    const result = await cg.sync();

    expect(result.filesRemoved).toBe(2);
    expect((cg.queries.db.prepare('SELECT COUNT(*) AS c FROM files').get() as { c: number }).c).toBe(0);
  });

  it('queues JS-family files durably and clears only matched JS parse cache when path aliases change', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": {
            "@/*": ["*"]
          }
        }
      }`,
    );
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    const cacheBefore = cg.queries.db
      .prepare(`SELECT COUNT(*) AS c FROM parse_cache WHERE language = 'typescript'`)
      .get() as { c: number };
    expect(cacheBefore.c).toBeGreaterThan(0);
    cg.queries.db
      .prepare(
        `INSERT INTO parse_cache (content_hash, language, file_path, payload, generated_at, struct_hash)
         VALUES ('manual-unmatched', 'typescript', 'src/unmatched.ts', '{}', ?, '')`,
      )
      .run(Date.now());

    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": {
            "#/*": ["*"]
          }
        }
      }`,
    );

    const plan = computeConfigFingerprintInvalidationPlan({
      qb: cg.queries,
      rootDir: tempDir,
      config: cg.config,
      hashContent,
    });
    expect(plan.forceFullScan).toBe(false);
    expect(plan.changedPolicies.map((policy) => policy.metadataKey)).toContain('path_alias_config_signature');

    const state = syncState();
    applyConfigFingerprintInvalidationPlan({ qb: cg.queries, rootDir: tempDir, state, plan });

    expect(state.filesToIndex).toEqual(['src/a.ts']);
    expect(state.filesModified).toBe(1);
    expect(cg.queries.db.prepare(`SELECT COUNT(*) AS c FROM parse_cache WHERE file_path = 'src/a.ts'`).get()).toEqual({
      c: 0,
    });
    expect(
      cg.queries.db.prepare(`SELECT COUNT(*) AS c FROM parse_cache WHERE file_path = 'src/unmatched.ts'`).get(),
    ).toEqual({ c: 1 });
    expect(cg.queries.db.prepare(`SELECT path, needs_reextract FROM files ORDER BY path`).all()).toEqual([
      { path: 'src/a.ts', needs_reextract: 1 },
      { path: 'src/b.py', needs_reextract: 0 },
    ]);
  });

  it('treats a missing stored path-alias fingerprint as stale once', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": {
            "@/*": ["*"]
          }
        }
      }`,
    );
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    cg.queries.db.prepare(`DELETE FROM project_metadata WHERE key = 'path_alias_config_signature'`).run();

    const plan = computeConfigFingerprintInvalidationPlan({
      qb: cg.queries,
      rootDir: tempDir,
      config: cg.config,
      hashContent,
    });
    expect(plan.changedPolicies.map((policy) => policy.metadataKey)).toContain('path_alias_config_signature');
  });

  it('invalidates path aliases when an extended tsconfig alias map changes', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.base.json'),
      `{
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": {
            "@/*": ["*"]
          }
        }
      }`,
    );
    fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), `{ "extends": "./tsconfig.base.json" }`);
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.base.json'),
      `{
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": {
            "#/*": ["*"]
          }
        }
      }`,
    );

    const plan = computeConfigFingerprintInvalidationPlan({
      qb: cg.queries,
      rootDir: tempDir,
      config: cg.config,
      hashContent,
    });
    expect(plan.changedPolicies.map((policy) => policy.metadataKey)).toContain('path_alias_config_signature');
  });

  it('does not invalidate path aliases for JSONC comments or unrelated compiler options', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      `{
        // Initial alias map.
        "compilerOptions": {
          "baseUrl": "./src",
          "paths": {
            "@/*": ["./*"]
          }
        }
      }`,
    );
    cg = Cartograph.initSync(tempDir, { config: { include: ['**/*.ts', '**/*.py'], exclude: [] } });
    await cg.indexAll({ summarize: false });

    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "strict": true,
          "paths": {
            "@/*": ["*"],
          },
          "baseUrl": "src",
        }
      }`,
    );

    const plan = computeConfigFingerprintInvalidationPlan({
      qb: cg.queries,
      rootDir: tempDir,
      config: cg.config,
      hashContent,
    });
    expect(plan.changedPolicies.map((policy) => policy.metadataKey)).not.toContain('path_alias_config_signature');
  });
});
