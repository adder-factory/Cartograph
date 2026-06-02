import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ADMIN_TOOL, __adminToolInternals as admin } from '../src/mcp/tools/admin.js';
import { buildNoLlmFooter } from '../src/mcp/tools/admin.js';

function textOf(result: Awaited<ReturnType<typeof ADMIN_TOOL.handle>>): string {
  return result.content[0]?.text ?? '';
}

function fakeCtx(cg: unknown, progress: string[] = []) {
  return {
    getCartograph: () => cg,
    reportProgress: (current: number, total?: number, message?: string) =>
      progress.push(`${current}/${total}:${message}`),
    closeProjectsMatching: () => {},
    evictCachedProject: () => {},
    options: {},
    defaultCg: null,
    projectCache: new Map(),
  } as any;
}

describe('MCP admin formatter contracts', () => {
  it('creates missing project directories and reports mkdir failures', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-admin-tool-'));
    const nested = path.join(dir, 'a', 'b');
    try {
      expect(admin.ensureProjectDirExists(fs, nested)).toBeNull();
      expect(fs.existsSync(nested)).toBe(true);
      expect(
        admin.ensureProjectDirExists(
          {
            existsSync: () => false,
            mkdirSync: () => {
              throw new Error('denied');
            },
          } as unknown as typeof fs,
          '/blocked',
        ),
      ).toContain('Could not create project directory /blocked');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('formats progress, sync results, and index result tags', () => {
    expect(admin.formatProgressMsg({ phase: 'parse', current: 1, total: 2, currentFile: 'src/a.ts' })).toBe(
      'parse: src/a.ts',
    );
    expect(admin.formatProgressMsg({ phase: 'resolve', current: 2, total: 2 })).toBe('resolve');

    expect(
      admin.formatSyncResult({
        filesChecked: 7,
        filesAdded: 1,
        filesModified: 2,
        filesRemoved: 1,
        nodesUpdated: 9,
        durationMs: 1250,
      }),
    ).toContain('Delta since last sync: +1 added, ~2 modified, -1 removed');
    expect(
      admin.formatSyncResult({
        filesChecked: 1,
        filesAdded: 0,
        filesModified: 0,
        filesRemoved: 0,
        nodesUpdated: 0,
        durationMs: 10,
      }),
    ).toContain('No content changes');

    expect(admin.buildIndexTagStr(true, true, 'typescript')).toBe(' (force, parse-cache cleared (typescript))');
    const failed = admin.formatIndexResult({
      result: {
        filesIndexed: 1,
        durationMs: 1000,
        nodesCreated: 2,
        edgesCreated: 1,
        filesSkipped: 1,
        filesErrored: 1,
        success: false,
      },
      force: true,
      parseCacheCleared: true,
    });
    expect(failed).toContain('Re-indexed 1 file');
    expect(failed).toContain('Skipped: 1');
    expect(failed).toContain('Errored: 1');
    expect(failed).toContain('Some files failed to index');
  });

  it('forwards index progress only when the context supplies a reporter', () => {
    expect(admin.buildIndexProgressOpts({} as any)).toEqual({});
    const calls: string[] = [];
    const opts = admin.buildIndexProgressOpts({
      reportProgress: (current: number, total: number, message: string) => calls.push(`${current}/${total}:${message}`),
    } as any);
    opts.onProgress?.({ phase: 'scan', current: 3, total: 9, currentFile: 'src/a.ts' });
    expect(calls).toEqual(['3/9:scan: src/a.ts']);
  });

  it('formats embed phase and LLM setup reports', async () => {
    expect(admin.formatEmbedPhaseLine(null)).toBeNull();
    expect(admin.formatEmbedPhaseLine({ candidates: 3, generated: 0, errors: 0, durationMs: 1 })).toBeNull();
    expect(admin.formatEmbedPhaseLine({ candidates: 3, generated: 2, errors: 1, durationMs: 1500 })).toContain(
      'Embedded',
    );
    expect(
      admin.formatEmbedPhaseLine({
        candidates: 3,
        generated: 0,
        errors: 0,
        durationMs: 1,
        failed: true,
        failureReason: 'endpoint down',
      }),
    ).toContain('Embed phase failed');

    const emptyPlanLines: string[] = [];
    admin.appendDetectedBackends(emptyPlanLines, { detectedBackends: [] } as any);
    expect(emptyPlanLines.join('\n')).toContain('No backends detected');

    const detectedLines: string[] = [];
    admin.appendDetectedBackends(detectedLines, {
      detectedBackends: [{ label: 'Ollama', endpoint: 'http://localhost:11434', models: ['qwen'] }],
    } as any);
    admin.appendCloudChatAvailability(detectedLines, { claudeBin: '/bin/claude', anthropicApiKey: true });
    expect(detectedLines.join('\n')).toContain('Ollama');
    expect(detectedLines.join('\n')).toContain('claude');
    expect(detectedLines.join('\n')).toContain('ANTHROPIC_API_KEY');

    await expect(buildNoLlmFooter(async () => [])).resolves.toContain('No LLM configured');
    await expect(
      buildNoLlmFooter(async () => [{ kind: 'ollama', endpoint: 'http://localhost:11434' }]),
    ).resolves.toContain('1 OpenAI-compat backend detected');
  });

  it('formats apply and tuning override reports', () => {
    expect(admin.formatAppliedPresetLine({ applied: false, configPath: null, backupPath: null })).toBe(
      'No config written.',
    );
    expect(
      admin.formatAppliedPresetLine({
        applied: true,
        configPath: '/repo/.cartograph/config.json',
        backupPath: '/repo/.cartograph/config.json.bak',
      }),
    ).toContain('backup at');

    const report = admin.buildOverrideAppliedReport({
      tier: 'chat',
      configKey: 'summarizeLlm',
      previous: null,
      concurrency: 4,
      configPath: '/repo/.cartograph/config.json',
      backupPath: '/repo/.cartograph/config.json.bak',
    });
    expect(report).toContain('Applied tuning override');
    expect(report).toContain('(unset) → **4**');
    expect(report).toContain('--parallel 4');
  });

  it('dispatches sync, index, and embed-only actions against the Cartograph API', async () => {
    const progress: string[] = [];
    const indexResult = {
      filesIndexed: 2,
      durationMs: 2500,
      nodesCreated: 7,
      edgesCreated: 3,
      filesSkipped: 1,
      filesErrored: 0,
      success: true,
      errors: [],
    };
    const calls: string[] = [];
    const cg = {
      config: { llm: { summarizeLlm: {}, summarizeEagerLimit: 0 } },
      sync: async (opts: any) => {
        calls.push(`sync:${opts.summarize}`);
        opts.onProgress?.({ phase: 'sync', current: 1, total: 1, currentFile: 'src/a.ts' });
        return {
          filesChecked: 3,
          filesAdded: 1,
          filesModified: 1,
          filesRemoved: 0,
          nodesUpdated: 4,
          durationMs: 1000,
        };
      },
      indexAll: async (opts: any) => {
        calls.push(`index:${Boolean(opts.clearStructural)}:${Boolean(opts.embedOnly)}:${opts.summarize}`);
        opts.onProgress?.({ phase: 'index', current: 2, total: 4 });
        return indexResult;
      },
      llm: {
        embed: {
          embedAll: async () => ({ generated: 5, candidates: 6, errors: 1, skipped: 0, durationMs: 800 }),
        },
      },
    };

    const sync = await ADMIN_TOOL.handle(fakeCtx(cg, progress), { action: 'sync' } as any);
    expect(textOf(sync)).toContain('Scanned 3 files');

    const index = await ADMIN_TOOL.handle(fakeCtx(cg, progress), { action: 'index', force: true } as any);
    expect(textOf(index)).toContain('Re-indexed 2 files');
    expect(textOf(index)).toContain('ad-hoc only');

    const embedOnly = await ADMIN_TOOL.handle(fakeCtx(cg, progress), { action: 'embed-only' } as any);
    expect(textOf(embedOnly)).toContain('Embedded 5/6 symbols');

    expect(calls).toEqual(['sync:false', 'index:true:false:false', 'index:false:true:false']);
    expect(progress).toContain('1/1:sync: src/a.ts');
    expect(progress).toContain('2/4:index');
  });

  it('dispatches migrate and LLM phase actions with progress and detail lines', async () => {
    const progress: string[] = [];
    const cg = {
      db: {
        getSchemaVersion: () => ({ version: 999, description: 'current schema' }),
      },
      llm: {
        summarizeAll: async (opts: any) => {
          opts.onProgress?.(1, 3);
          return {
            generated: 2,
            candidates: 5,
            cacheHits: 1,
            errors: 1,
            deferred: 1,
            durationMs: 1200,
            embed: { candidates: 2, generated: 1, errors: 0, durationMs: 300 },
          };
        },
        embed: {
          embedAll: async (opts: any) => {
            opts.onProgress?.(2, 4);
            return { generated: 1, candidates: 4, errors: 1, skipped: 1, durationMs: 900 };
          },
        },
        classifyAll: async (opts: any) => {
          opts.onProgress?.(3, 3);
          return { classified: 1, candidates: 4, errors: 1, durationMs: 700 };
        },
      },
    };

    const migrate = await ADMIN_TOOL.handle(fakeCtx(cg, progress), { action: 'migrate' } as any);
    expect(textOf(migrate)).toContain('Schema at v999');
    expect(textOf(migrate)).toContain('Already current');

    const summarize = await ADMIN_TOOL.handle(fakeCtx(cg, progress), {
      action: 'summarize',
      concurrency: 2,
      summarizeLimit: 10,
    } as any);
    expect(textOf(summarize)).toContain('Summarised 2 new symbols');
    expect(textOf(summarize)).toContain('Cache hits: 1');
    expect(textOf(summarize)).toContain('Deferred 1 lower-priority symbols');
    expect(textOf(summarize)).toContain('Embedded');

    const embed = await ADMIN_TOOL.handle(fakeCtx(cg, progress), { action: 'embed', concurrency: 2 } as any);
    expect(textOf(embed)).toContain('Embedded 1 new vector');
    expect(textOf(embed)).toContain('Skipped: 1');

    const classify = await ADMIN_TOOL.handle(fakeCtx(cg, progress), { action: 'classify', concurrency: 2 } as any);
    expect(textOf(classify)).toContain('Classified 1 symbol');
    expect(textOf(classify)).toContain('Errors: 1');

    expect(progress).toContain('1/3:summarising symbol 1/3');
    expect(progress).toContain('2/4:embedding symbol 2/4');
    expect(progress).toContain('3/3:classifying role 3/3');
  });
});
