import { describe, expect, it } from 'vitest';
import { isSameDirectoryPath, pathMatchesDirectoryPattern } from '../src/resolution/frameworks/resolve-by-name.js';

describe('framework resolver path-boundary helpers', () => {
  it('compares same-directory candidates by exact directory, not path prefix', () => {
    expect(isSameDirectoryPath('src/screens/Button.tsx', 'src/screens/App.tsx')).toBe(true);
    expect(isSameDirectoryPath('src/screens-extra/Button.tsx', 'src/screens/App.tsx')).toBe(false);
  });

  it('matches preferred directories only on directory boundaries', () => {
    expect(pathMatchesDirectoryPattern('src/components/Button.tsx', '/components/')).toBe(true);
    expect(pathMatchesDirectoryPattern('src/components-extra/Button.tsx', '/components/')).toBe(false);
  });
});
