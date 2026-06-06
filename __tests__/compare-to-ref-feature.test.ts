import { describe, expect, it } from 'vitest';
import {
  isEmptyCompareToRefText,
  makeCompareToRefMcpRunner,
  renderCompareToRefCapture,
} from '../src/features/compare-to-ref/index.js';

describe('compare-to-ref feature runtime', () => {
  it('detects empty compare output and appends changed-since hints only when useful', () => {
    expect(isEmptyCompareToRefText('No files differ from `HEAD`.')).toBe(true);
    expect(isEmptyCompareToRefText('## Structural delta vs `HEAD`')).toBe(false);

    expect(
      renderCompareToRefCapture({
        text: 'No files differ from `HEAD`.',
        exitCode: 0,
        contentDriftedFiles: 2,
      }),
    ).toEqual({
      stream: 'stdout',
      exitCode: 0,
      text: 'No files differ from `HEAD`.\n\n_Note: `cartograph changed-since` reports 2 files content-drifted on disk vs the index — compare-to-ref uses `git diff` only; for the drifted set see `cartograph changed-since`._\n',
    });

    expect(
      renderCompareToRefCapture({
        text: 'failed',
        exitCode: 1,
        contentDriftedFiles: null,
      }),
    ).toEqual({ stream: 'stderr', text: 'failed\n', exitCode: 1 });
  });
});

describe('compare-to-ref feature CLI', () => {
  it('writes captured output and exits on MCP errors through injected dependencies', async () => {
    const calls: string[] = [];
    const runner = makeCompareToRefMcpRunner({
      runViaMCPCapture: async (toolName, args, projectPath) => {
        calls.push(`capture:${toolName}:${JSON.stringify(args)}:${projectPath ?? ''}`);
        return { text: 'failed', exitCode: 2, contentDriftedFiles: null };
      },
      writeStdout: (message) => calls.push(`stdout:${message}`),
      writeStderr: (message) => calls.push(`stderr:${message}`),
      exit: (code) => calls.push(`exit:${code}`),
    });

    await runner('cartograph_compare_to_ref', { ref: 'HEAD' }, '/repo');

    expect(calls).toEqual(['capture:cartograph_compare_to_ref:{"ref":"HEAD"}:/repo', 'stderr:failed\n', 'exit:2']);
  });
});
