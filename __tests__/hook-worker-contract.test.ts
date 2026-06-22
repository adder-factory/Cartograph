import { describe, expect, it } from 'vitest';
import { parseHookWorkerCommand, parseHookWorkerReply } from '../src/index-hooks/hook-worker-contract.js';
import { DEFAULT_CONFIG } from '../src/types.js';

const validConfig = { ...DEFAULT_CONFIG, rootDir: '/tmp/cartograph-hook-worker-contract' };

const validSyncResult = {
  filesChecked: 1,
  filesAdded: 0,
  filesModified: 1,
  filesRemoved: 0,
  nodesUpdated: 2,
  durationMs: 3,
  changedFilePaths: ['src/a.ts'],
};

describe('hook worker IPC contract', () => {
  it('parses a valid sync command with a required sync result', () => {
    const parsed = parseHookWorkerCommand({
      type: 'run-hooks',
      id: 7,
      phase: 'sync',
      projectRoot: '/tmp/project',
      dbPath: '/tmp/project/.cartograph/cartograph.db',
      config: validConfig,
      syncResult: validSyncResult,
    });

    expect(parsed.phase).toBe('sync');
    expect(parsed.syncResult.changedFilePaths).toEqual(['src/a.ts']);
  });

  it('rejects a sync command without syncResult instead of falling back to a full hook pass', () => {
    expect(() =>
      parseHookWorkerCommand({
        type: 'run-hooks',
        id: 7,
        phase: 'sync',
        projectRoot: '/tmp/project',
        dbPath: '/tmp/project/.cartograph/cartograph.db',
        config: validConfig,
      }),
    ).toThrow(/syncResult/);
  });

  it('rejects commands whose config is not a valid CartographConfig', () => {
    expect(() =>
      parseHookWorkerCommand({
        type: 'run-hooks',
        id: 7,
        phase: 'indexAll',
        projectRoot: '/tmp/project',
        dbPath: '/tmp/project/.cartograph/cartograph.db',
        config: { database: { provider: 'sqlite' } },
      }),
    ).toThrow(/config/);
  });

  it('parses valid child replies and rejects malformed outcome rows', () => {
    expect(parseHookWorkerReply({ type: 'ready' }).type).toBe('ready');
    expect(parseHookWorkerReply({ type: 'hooks-error', id: 9, message: 'boom' }).message).toBe('boom');

    const done = parseHookWorkerReply({
      type: 'hooks-done',
      id: 9,
      outcomes: [{ name: 'centrality', phase: 'sync', durationMs: 12 }],
    });
    expect(done.type).toBe('hooks-done');
    expect(done.outcomes[0]?.name).toBe('centrality');

    expect(() =>
      parseHookWorkerReply({
        type: 'hooks-done',
        id: 9,
        outcomes: [{ name: 'centrality', phase: 'sync' }],
      }),
    ).toThrow(/durationMs/);
  });
});
