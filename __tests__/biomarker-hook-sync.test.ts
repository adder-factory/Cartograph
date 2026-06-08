import { describe, expect, it } from 'vitest';
import { biomarkerSyncFilePaths } from '../src/index-hooks/biomarkers.js';

describe('biomarker sync hook file selection', () => {
  it('runs a full pass when the biomarker cache is cold', () => {
    expect(biomarkerSyncFilePaths({ changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never, true)).toBeUndefined();
  });

  it('runs a full pass for zero-change syncs so cross-file freshness can clear', () => {
    expect(biomarkerSyncFilePaths({ changedFilePaths: [], filesRemoved: 0 } as never, false)).toBeUndefined();
  });

  it('runs a full pass when sync cannot provide a changed-file list', () => {
    expect(biomarkerSyncFilePaths({ changedFilePaths: undefined, filesRemoved: 1 } as never, false)).toBeUndefined();
  });

  it('keeps ordinary changed-file syncs incremental', () => {
    expect(biomarkerSyncFilePaths({ changedFilePaths: ['src/a.ts'], filesRemoved: 0 } as never, false)).toEqual([
      'src/a.ts',
    ]);
  });
});
