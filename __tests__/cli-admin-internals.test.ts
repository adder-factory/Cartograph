import { afterEach, describe, expect, it } from 'vitest';
import { __adminCommandInternals as admin } from '../src/bin/commands/admin.js';
import type { IndexResult } from '../src/bin/_cli-core.js';

function fakeClack() {
  const calls: Array<[string, string, string?]> = [];
  return {
    calls,
    log: {
      success: (message: string) => calls.push(['success', message]),
      info: (message: string) => calls.push(['info', message]),
      warn: (message: string) => calls.push(['warn', message]),
      error: (message: string) => calls.push(['error', message]),
    },
    note: (message: string, title?: string) => calls.push(['note', message, title]),
  };
}

function indexResult(overrides: Partial<IndexResult> = {}): IndexResult {
  return {
    success: true,
    filesIndexed: 0,
    filesSkipped: 0,
    filesErrored: 0,
    nodesCreated: 0,
    edgesCreated: 0,
    errors: [],
    durationMs: 1000,
    ...overrides,
  };
}

describe('admin command internals', () => {
  afterEach(() => {
    process.exitCode = 0;
  });

  it('parses worker, eager-limit, and indexAll options with explicit bounds', () => {
    expect(admin.parseParseWorkers(undefined)).toBeUndefined();
    expect(admin.parseParseWorkers('3')).toBe(3);
    expect(admin.indexAllOptions({ force: true, profile: true }, 4)).toEqual({
      summarize: false,
      profile: true,
      clearStructural: true,
      parseWorkers: 4,
    });

    expect(admin.parseEagerLimit({})).toBeUndefined();
    expect(admin.parseEagerLimit({ limit: '0' })).toBe(0);
    expect(admin.parseEagerLimit({ all: true })).toBe(Number.POSITIVE_INFINITY);

  });

  it('renders phase timings including retry and post-hook breakdowns', () => {
    const lines = admin.phaseTimingLines(
      indexResult({
        durationMs: 1000,
        profile: {
          scanMs: 100,
          parseStoreMs: 200,
          retryMs: 50,
          resolveMs: 150,
          postHooksMs: 300,
          postHooksByHook: { biomarkers: 120, centrality: 60 },
          maintenanceMs: 25,
        },
      }),
    );

    expect(lines.join('\n')).toContain('scan');
    expect(lines.join('\n')).toContain('retry');
    expect(lines.join('\n')).toContain('biomarkers');
    expect(lines.join('\n')).toContain('total');
    expect(admin.phaseTimingLines(indexResult())).toEqual([]);
  });

  it('prints install, sync, summarize, and embed result details', () => {
    const clack = fakeClack();
    admin.printInstallModelResults({
      downloaded: [{ filename: 'embed.gguf', description: 'embedding model' }],
      skipped: [{ filename: 'chat.gguf' }],
    });
    admin.printSyncResult(clack as any, { filesAdded: 1, filesModified: 2, filesRemoved: 1, nodesUpdated: 5, durationMs: 1250 });
    admin.printSyncResult(clack as any, { filesAdded: 0, filesModified: 0, filesRemoved: 0, nodesUpdated: 0, durationMs: 1 });
    admin.printSummarizeDetails(clack as any, {
      candidates: 10,
      generated: 3,
      errors: 1,
      cacheHits: 2,
      deferred: 1,
      durationMs: 1500,
      embed: { generated: 2, errors: 1, skipped: 1, durationMs: 50 },
    });
    admin.printSummarizeEmbedDetails(clack as any, {
      failed: true,
      failureReason: 'endpoint down',
      generated: 0,
      errors: 0,
      skipped: 0,
      durationMs: 0,
    });

    const text = clack.calls.map((c) => c.join(':')).join('\n');
    expect(text).toContain('Synced 4 changed files');
    expect(text).toContain('Already up to date');
    expect(text).toContain('Summarised 3 new symbols');
    expect(text).toContain('Deferred 1 lower-priority symbols');
    expect(text).toContain('Embedded 2 new vectors');
    expect(text).toContain('Embed phase failed');
  });

  it('runs quiet indexing and closes the graph while preserving profile output', async () => {
    const calls: string[] = [];
    const cg = {
      indexAll: async (opts: unknown) => {
        calls.push(JSON.stringify(opts));
        return indexResult({ profile: { scanMs: 1 } as IndexResult['profile'] });
      },
      close: () => calls.push('close'),
    };

    await admin.runQuietIndex(cg as any, { force: true, profile: true }, 2);

    expect(calls[0]).toContain('"clearStructural":true');
    expect(calls[0]).toContain('"parseWorkers":2');
    expect(calls).toContain('close');
  });

  it('reports background summary status for no-LLM and ad-hoc-only configs', async () => {
    const noLlmClack = fakeClack();
    const noLlmCg = {
      llm: { config: { getEffectiveLlmConfig: async () => null } },
      config: { llm: {} },
      close: () => noLlmClack.calls.push(['close', 'no-llm']),
    };
    await admin.reportBackgroundSummaryStatus(noLlmCg as any, noLlmClack as any, '/repo');
    expect(noLlmClack.calls.map((c) => c.join(':')).join('\n')).toContain('symbol summaries skipped');
    expect(noLlmClack.calls.map((c) => c[0])).toContain('close');

    const adhocClack = fakeClack();
    const adhocCg = {
      llm: { config: { getEffectiveLlmConfig: async () => ({ summarizeLlm: { model: 'qwen' } }) } },
      config: { llm: { summarizeEagerLimit: 0 } },
      close: () => adhocClack.calls.push(['close', 'adhoc']),
    };
    await admin.reportBackgroundSummaryStatus(adhocCg as any, adhocClack as any, '/repo');
    expect(adhocClack.calls.map((c) => c.join(':')).join('\n')).toContain('ad-hoc only');
    expect(adhocClack.calls.map((c) => c[0])).toContain('close');
  });
});
