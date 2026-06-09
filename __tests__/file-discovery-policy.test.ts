import { describe, expect, it } from 'vitest';
import { parseGitNulToPaths } from '../src/extraction/file-discovery-policy.js';

describe('file discovery policy', () => {
  it('parses NUL-delimited git paths without trimming valid filename characters', () => {
    const output = Buffer.from('src/with space.ts\0src/line\nbreak.ts\0src/trailing-space.ts \0');

    expect(parseGitNulToPaths(output)).toEqual(['src/with space.ts', 'src/line\nbreak.ts', 'src/trailing-space.ts ']);
  });
});
