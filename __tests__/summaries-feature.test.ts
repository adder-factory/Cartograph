import { describe, expect, it } from 'vitest';
import {
  buildPendingSummariesArgs,
  buildSaveSummariesArgs,
  readSummariesSaveInput,
} from '../src/features/summaries/runtime.js';

describe('summaries feature runtime', () => {
  it('builds pending args with CLI-specific model hint default', () => {
    expect(buildPendingSummariesArgs({ limit: 10 })).toEqual({
      ok: true,
      args: { action: 'pending', limit: 10, modelHint: 'agent-cli' },
    });
    expect(buildPendingSummariesArgs({ modelHint: 'custom' })).toEqual({
      ok: true,
      args: { action: 'pending', modelHint: 'custom' },
    });
  });

  it('accepts bare summary arrays and pending envelopes for save', () => {
    const item = { nodeId: 'n1', contentHash: 'h1', summary: 'Does work.' };
    expect(buildSaveSummariesArgs(JSON.stringify([item]), {})).toEqual({
      ok: true,
      args: { action: 'save', items: [item], model: 'agent-cli' },
    });
    expect(buildSaveSummariesArgs(JSON.stringify({ items: [item], remaining: 0 }), { model: 'custom' })).toEqual({
      ok: true,
      args: { action: 'save', items: [item], model: 'custom' },
    });
  });

  it('returns expected failures as values for invalid save JSON shape', () => {
    expect(buildSaveSummariesArgs('not json', {})).toEqual({
      ok: false,
      error: expect.stringContaining('Could not parse summaries JSON:'),
    });
    expect(buildSaveSummariesArgs('{"items":{}}', {})).toEqual({
      ok: false,
      error: 'Expected a JSON array of {nodeId, contentHash, summary} or {"items":[...]}.',
    });
  });

  it('reads save input from either file or stdin and reports read errors as values', async () => {
    await expect(
      readSummariesSaveInput('summaries.json', {
        readFile: (filePath) => `${filePath}:contents`,
        readStdin: async () => {
          throw new Error('stdin should not be read');
        },
      }),
    ).resolves.toEqual({ ok: true, raw: 'summaries.json:contents' });

    await expect(
      readSummariesSaveInput(undefined, {
        readFile: () => {
          throw new Error('file should not be read');
        },
        readStdin: async () => 'stdin contents',
      }),
    ).resolves.toEqual({ ok: true, raw: 'stdin contents' });

    await expect(
      readSummariesSaveInput('missing.json', {
        readFile: () => {
          throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        },
        readStdin: async () => '',
      }),
    ).resolves.toEqual({ ok: false, error: 'summaries save: file not found: missing.json' });
  });
});
