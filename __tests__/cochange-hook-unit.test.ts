import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexHookContext } from '../src/index-hooks/registry.js';

const state = {
  commitCount: 3 as number | null,
  files: [] as Array<{ path: string }>,
  metadata: new Map<string, string>(),
  mineResults: [] as Array<{
    pairs: Map<string, number>;
    fileCommits: Map<string, number>;
    subjects?: Map<string, string>;
    currentHead?: string | null;
    needsFullRescan?: boolean;
  }>,
  calls: [] as Array<{ name: string; value?: unknown }>,
};

vi.mock('../src/cochange/index.js', () => ({
  LAST_MINED_HEAD_KEY: 'last_mined_cochange_head',
  mineCoChanges: vi.fn(async (_root: string, indexedFiles: Set<string>, sinceSha: string | null) => {
    state.calls.push({ name: 'mineCoChanges', value: { indexedFiles: [...indexedFiles], sinceSha } });
    const next = state.mineResults.shift();
    if (!next) throw new Error('missing mine result');
    return next;
  }),
}));

vi.mock('../src/db/queries-files.js', () => ({
  getAllFiles: vi.fn(() => state.files),
}));

vi.mock('../src/db/queries-history.js', () => ({
  applyCoChangeDeltas: vi.fn((_queries: unknown, deltas: unknown) =>
    state.calls.push({ name: 'applyCoChangeDeltas', value: deltas }),
  ),
  clearCoChanges: vi.fn(() => state.calls.push({ name: 'clearCoChanges' })),
}));

vi.mock('../src/db/queries-metadata.js', () => ({
  getMetadata: vi.fn((_queries: unknown, key: string) => state.metadata.get(key) ?? null),
  setMetadata: vi.fn((_queries: unknown, key: string, value: string) => {
    state.calls.push({ name: 'setMetadata', value: { key, value } });
    state.metadata.set(key, value);
  }),
}));

vi.mock('../src/llm/commit-intent.js', () => ({
  classifyCommitMessage: vi.fn((subject: string) => ({
    intent: subject.includes('fix') ? 'bugfix' : 'feature',
    score: subject.includes('fix') ? 0.9 : 0.7,
  })),
}));

vi.mock('../src/db/queries-commit-intents.js', () => ({
  recordCommitIntents: vi.fn((_queries: unknown, rows: unknown) =>
    state.calls.push({ name: 'recordCommitIntents', value: rows }),
  ),
  clearCommitIntents: vi.fn(() => state.calls.push({ name: 'clearCommitIntents' })),
}));

vi.mock('../src/git-utils.js', () => ({
  gitCommitCount: vi.fn(() => state.commitCount),
}));

vi.mock('../src/errors.js', () => ({
  errMsg: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  logDebug: vi.fn((message: string) => state.calls.push({ name: 'logDebug', value: message })),
}));

const { HOOK } = await import('../src/index-hooks/cochange.js');

function ctx(config: Record<string, unknown> = {}): IndexHookContext {
  return { projectRoot: '/repo', queries: {}, config } as IndexHookContext;
}

beforeEach(() => {
  state.commitCount = 3;
  state.files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
  state.metadata.clear();
  state.mineResults = [];
  state.calls = [];
  vi.clearAllMocks();
});

describe('cochange hook', () => {
  it('skips disabled projects, shallow histories, and empty indexes', async () => {
    await HOOK.afterIndexAll(ctx({ enableCoChange: false }));
    expect(state.calls).toEqual([]);

    state.commitCount = 1;
    await HOOK.afterIndexAll(ctx());
    expect(state.calls).toEqual([]);

    state.commitCount = 3;
    state.files = [];
    await HOOK.afterIndexAll(ctx());
    expect(state.calls).toEqual([]);
  });

  it('applies full-rescan deltas, classifies commit subjects, and stamps the head', async () => {
    state.mineResults.push({
      currentHead: 'head-1',
      pairs: new Map([['src/a.ts\0src/b.ts', 2]]),
      fileCommits: new Map([['src/a.ts', 2]]),
      subjects: new Map([
        ['sha1', 'fix broken parser'],
        ['sha2', 'add feature'],
      ]),
    });

    await HOOK.afterIndexAll(ctx());

    expect(state.calls).toEqual([
      { name: 'mineCoChanges', value: { indexedFiles: ['src/a.ts', 'src/b.ts'], sinceSha: null } },
      { name: 'clearCoChanges' },
      { name: 'applyCoChangeDeltas', value: [['src/a.ts', 'src/b.ts', 2]] },
      {
        name: 'recordCommitIntents',
        value: [
          { sha: 'sha1', intent: 'bugfix', score: 0.9 },
          { sha: 'sha2', intent: 'feature', score: 0.7 },
        ],
      },
      { name: 'setMetadata', value: { key: 'last_mined_cochange_head', value: 'head-1' } },
    ]);
  });

  it('runs incremental mining from the stored head and preserves existing rows', async () => {
    state.metadata.set('last_mined_cochange_head', 'old-head');
    state.mineResults.push({
      currentHead: 'head-2',
      pairs: new Map(),
      fileCommits: new Map(),
    });

    await HOOK.afterSync(ctx());

    expect(state.calls).toEqual([
      { name: 'mineCoChanges', value: { indexedFiles: ['src/a.ts', 'src/b.ts'], sinceSha: 'old-head' } },
      { name: 'setMetadata', value: { key: 'last_mined_cochange_head', value: 'head-2' } },
    ]);
  });

  it('performs a full rescan when the miner detects history divergence', async () => {
    state.mineResults.push(
      {
        currentHead: 'diverged',
        needsFullRescan: true,
        pairs: new Map(),
        fileCommits: new Map(),
      },
      {
        currentHead: 'fresh-head',
        pairs: new Map([['src/a.ts\0src/b.ts', 1]]),
        fileCommits: new Map([['src/b.ts', 1]]),
      },
    );

    await HOOK.afterSync(ctx());

    expect(state.calls.map((call) => call.name)).toEqual([
      'mineCoChanges',
      'clearCoChanges',
      'clearCommitIntents',
      'mineCoChanges',
      'applyCoChangeDeltas',
      'setMetadata',
    ]);
    expect(state.calls[3]!.value).toEqual({ indexedFiles: ['src/a.ts', 'src/b.ts'], sinceSha: null });
  });

  it('returns quietly when the miner cannot determine a current head and logs thrown failures', async () => {
    state.mineResults.push({
      currentHead: null,
      pairs: new Map([['src/a.ts\0src/b.ts', 1]]),
      fileCommits: new Map([['src/a.ts', 1]]),
    });
    await HOOK.afterSync(ctx());
    expect(state.calls).toEqual([
      { name: 'mineCoChanges', value: { indexedFiles: ['src/a.ts', 'src/b.ts'], sinceSha: null } },
    ]);

    state.calls = [];
    state.mineResults = [];
    await HOOK.afterSync(ctx());
    expect(state.calls.at(-1)).toEqual({ name: 'logDebug', value: 'cochange hook failed: missing mine result' });
  });
});
