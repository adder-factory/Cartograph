import { describe, expect, it } from 'vitest';
import { parseValueRefWorkerInit, parseValueRefWorkerReply } from '../src/index-hooks/value-ref-edges-contract.js';

describe('value-ref-edges worker IPC contract', () => {
  it('parses the worker init payload at the thread boundary', () => {
    const parsed = parseValueRefWorkerInit({
      dbPath: '/tmp/cartograph.db',
      projectRoot: '/repo',
      fileRecords: [{ path: 'src/a.ts', language: 'typescript' }],
    });

    expect(parsed).toEqual({
      dbPath: '/tmp/cartograph.db',
      projectRoot: '/repo',
      fileRecords: [{ path: 'src/a.ts', language: 'typescript' }],
    });
  });

  it('rejects malformed worker init payloads with a pathful error', () => {
    expect(() =>
      parseValueRefWorkerInit({
        dbPath: '/tmp/cartograph.db',
        projectRoot: '/repo',
        fileRecords: [{ path: 'src/a.ts' }],
      }),
    ).toThrow(/invalid value-ref worker init: fileRecords\.0\.language:/);
  });

  it('rejects malformed worker replies before the pool aggregates them', () => {
    expect(() => parseValueRefWorkerReply({ ok: true, durationMs: 1 })).toThrow(
      /invalid value-ref worker reply: edges:/,
    );
  });
});
