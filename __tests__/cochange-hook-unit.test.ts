import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IndexHookContext } from '../src/index-hooks/registry.js';
// Real-module namespaces captured BEFORE the vi.mock calls below (bun does
// not hoist vi.mock, so these bind the genuine implementations). Every mock
// spreads its real module and delegates to it whenever this suite is not
// actively running — bun caches modules per process, so a partial or
// state-backed mock would otherwise poison later test files (the
// module-leak canary runs this file before the MCP canaries).
import * as realCochange from '../src/cochange/index.js';
import * as realQueriesFiles from '../src/db/queries-files.js';
import * as realQueriesHistory from '../src/db/queries-history.js';
import * as realQueriesMetadata from '../src/db/queries-metadata.js';
import * as realCommitIntent from '../src/llm/commit-intent.js';
import * as realQueriesCommitIntents from '../src/db/queries-commit-intents.js';
import * as realGitUtils from '../src/git-utils.js';
import * as realErrors from '../src/errors.js';

/* Value snapshots taken NOW — before the vi.mock() calls below execute.
   Factory bodies must not read the live namespaces: bun rebinds existing
   namespace imports to the mock, so `realX.fn()` inside a factory would
   call the mock itself (infinite recursion, observed as "Maximum call
   stack size exceeded" in paired runs on Linux). */
const REAL_COCHANGE = { ...realCochange };
const REAL_QUERIES_FILES = { ...realQueriesFiles };
const REAL_QUERIES_HISTORY = { ...realQueriesHistory };
const REAL_QUERIES_METADATA = { ...realQueriesMetadata };
const REAL_COMMIT_INTENT = { ...realCommitIntent };
const REAL_QUERIES_COMMIT_INTENTS = { ...realQueriesCommitIntents };
const REAL_GIT_UTILS = { ...realGitUtils };
const REAL_ERRORS = { ...realErrors };

const state = {
  active: false,
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
  ...REAL_COCHANGE,
  mineCoChanges: vi.fn(async (...args: Parameters<typeof REAL_COCHANGE.mineCoChanges>) => {
    if (!state.active) return REAL_COCHANGE.mineCoChanges(...args);
    const [, indexedFiles, sinceSha] = args;
    state.calls.push({ name: 'mineCoChanges', value: { indexedFiles: [...indexedFiles], sinceSha } });
    const next = state.mineResults.shift();
    if (!next) throw new Error('missing mine result');
    return next;
  }),
}));

vi.mock('../src/db/queries-files.js', () => ({
  ...REAL_QUERIES_FILES,
  getAllFiles: vi.fn((...args: Parameters<typeof REAL_QUERIES_FILES.getAllFiles>) =>
    state.active ? (state.files as never) : REAL_QUERIES_FILES.getAllFiles(...args),
  ),
}));

vi.mock('../src/db/queries-history.js', () => ({
  ...REAL_QUERIES_HISTORY,
  applyCoChangeDeltas: vi.fn((...args: Parameters<typeof REAL_QUERIES_HISTORY.applyCoChangeDeltas>) => {
    if (!state.active) return REAL_QUERIES_HISTORY.applyCoChangeDeltas(...args);
    state.calls.push({ name: 'applyCoChangeDeltas', value: args[1] });
  }),
  clearCoChanges: vi.fn((...args: Parameters<typeof REAL_QUERIES_HISTORY.clearCoChanges>) => {
    if (!state.active) return REAL_QUERIES_HISTORY.clearCoChanges(...args);
    state.calls.push({ name: 'clearCoChanges' });
  }),
}));

vi.mock('../src/db/queries-metadata.js', () => ({
  ...REAL_QUERIES_METADATA,
  getMetadata: vi.fn((...args: Parameters<typeof REAL_QUERIES_METADATA.getMetadata>) =>
    state.active ? (state.metadata.get(args[1]) ?? null) : REAL_QUERIES_METADATA.getMetadata(...args),
  ),
  setMetadata: vi.fn((...args: Parameters<typeof REAL_QUERIES_METADATA.setMetadata>) => {
    if (!state.active) return REAL_QUERIES_METADATA.setMetadata(...args);
    const [, key, value] = args;
    state.calls.push({ name: 'setMetadata', value: { key, value } });
    state.metadata.set(key, value);
  }),
}));

vi.mock('../src/llm/commit-intent.js', () => ({
  ...REAL_COMMIT_INTENT,
  classifyCommitMessage: vi.fn((...args: Parameters<typeof REAL_COMMIT_INTENT.classifyCommitMessage>) => {
    if (!state.active) return REAL_COMMIT_INTENT.classifyCommitMessage(...args);
    const [subject] = args;
    return {
      intent: subject.includes('fix') ? 'bugfix' : 'feature',
      score: subject.includes('fix') ? 0.9 : 0.7,
    } as never;
  }),
}));

vi.mock('../src/db/queries-commit-intents.js', () => ({
  ...REAL_QUERIES_COMMIT_INTENTS,
  recordCommitIntents: vi.fn((...args: Parameters<typeof REAL_QUERIES_COMMIT_INTENTS.recordCommitIntents>) => {
    if (!state.active) return REAL_QUERIES_COMMIT_INTENTS.recordCommitIntents(...args);
    state.calls.push({ name: 'recordCommitIntents', value: args[1] });
  }),
  clearCommitIntents: vi.fn((...args: Parameters<typeof REAL_QUERIES_COMMIT_INTENTS.clearCommitIntents>) => {
    if (!state.active) return REAL_QUERIES_COMMIT_INTENTS.clearCommitIntents(...args);
    state.calls.push({ name: 'clearCommitIntents' });
  }),
}));

vi.mock('../src/git-utils.js', () => ({
  ...REAL_GIT_UTILS,
  gitCommitCount: vi.fn((...args: Parameters<typeof REAL_GIT_UTILS.gitCommitCount>) =>
    state.active ? state.commitCount : REAL_GIT_UTILS.gitCommitCount(...args),
  ),
}));

vi.mock('../src/errors.js', () => ({
  ...REAL_ERRORS,
  logDebug: vi.fn((...args: Parameters<typeof REAL_ERRORS.logDebug>) => {
    if (!state.active) return REAL_ERRORS.logDebug(...args);
    state.calls.push({ name: 'logDebug', value: args[0] });
  }),
}));

const { HOOK } = await import('../src/index-hooks/cochange.js');

function ctx(config: Record<string, unknown> = {}): IndexHookContext {
  return { projectRoot: '/repo', queries: {}, config } as IndexHookContext;
}

beforeEach(() => {
  state.active = true;
  state.commitCount = 3;
  state.files = [{ path: 'src/a.ts' }, { path: 'src/b.ts' }];
  state.metadata.clear();
  state.mineResults = [];
  state.calls = [];
  vi.clearAllMocks();
});

// Hand the mocked modules back to their real implementations once this
// suite finishes — a later test file in the same bun process must see
// genuine behavior (module-leak canary).
afterAll(() => {
  state.active = false;
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
