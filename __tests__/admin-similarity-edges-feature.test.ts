import { describe, expect, it } from 'vitest';
import { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from '../src/embeddings/similarity-defaults.js';
import {
  registerAdminSimilarityEdgesCommand,
  resolveSimilarityEdgeBuildOptions,
} from '../src/features/admin-similarity-edges/index.js';

describe('admin similarity edges feature runtime', () => {
  it('applies default build options after CLI validation', () => {
    expect(resolveSimilarityEdgeBuildOptions({})).toEqual({
      k: DEFAULT_SIMILAR_K,
      minScore: DEFAULT_SIMILAR_MIN_SCORE,
    });
    expect(resolveSimilarityEdgeBuildOptions({ k: 5, minScore: 0.8 })).toEqual({ k: 5, minScore: 0.8 });
  });
});

describe('admin similarity edges feature CLI', () => {
  it('builds similar_to edges with validated options and closes the graph', async () => {
    let action: ((pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) | undefined;
    const calls: string[] = [];

    registerAdminSimilarityEdgesCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      loadCartograph: async () => ({
        default: {
          open: async (projectPath) => {
            calls.push(`open:${projectPath}`);
            return { close: () => calls.push('close') };
          },
        },
      }),
      loadSimilarEdges: async () => ({
        buildSimilarToEdges: async (_cg, options) => {
          calls.push(`build:${JSON.stringify(options)}`);
          return { written: 5, processed: 2, reason: 'some skipped' };
        },
      }),
      assignIntArg: ({ args, key, raw }) => {
        if (raw !== undefined) args[key] = Number(raw);
        return true;
      },
      assignFloatArg: ({ args, key, raw }) => {
        if (raw !== undefined) args[key] = Number(raw);
        return true;
      },
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
    });

    expect(action).toBeDefined();
    await action!('/repo', { k: '5', minScore: '0.8' });

    expect(calls).toEqual([
      'open:/repo',
      'build:{"k":5,"minScore":0.8}',
      'success:Built similarity edges: 5 edges from 2 nodes.',
      'info:Note: some skipped',
      'close',
    ]);
  });

  it('closes the graph when validation rejects an option', async () => {
    let action: ((pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) | undefined;
    const calls: string[] = [];

    registerAdminSimilarityEdgesCommand({
      adminCmd: fakeCommand((fn) => {
        action = fn;
      }),
      resolveProjectPath: (pathArg) => pathArg ?? '/repo',
      isInitialized: () => true,
      loadCartograph: async () => ({
        default: {
          open: async () => ({ close: () => calls.push('close') }),
        },
      }),
      loadSimilarEdges: async () => ({
        buildSimilarToEdges: async () => {
          calls.push('build');
          return { written: 0, processed: 0 };
        },
      }),
      assignIntArg: () => false,
      assignFloatArg: () => true,
      success: (message) => calls.push(`success:${message}`),
      info: (message) => calls.push(`info:${message}`),
      error: (message) => calls.push(`error:${message}`),
    });

    await action!('/repo', { k: '0' });

    expect(calls).toEqual(['close']);
  });
});

function fakeCommand(
  setAction: (fn: (pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) => void,
) {
  return {
    command() {
      return this;
    },
    description() {
      return this;
    },
    option() {
      return this;
    },
    action(fn: (pathArg: string | undefined, opts: Record<string, string | undefined>) => Promise<void>) {
      setAction(fn);
      return this;
    },
  };
}
