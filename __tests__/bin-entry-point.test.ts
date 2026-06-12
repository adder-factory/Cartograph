/**
 * Standalone-path detection for bun compiled executables.
 *
 * The windows-x64 release smoke caught the .exe exiting 0 with no
 * output: bun's Windows virtual root (`B:\~BUN\...`) wasn't recognized,
 * so the CLI never dispatched — and three more POSIX-only copies
 * (daemon self-spawn, install-method detection, installer command
 * pinning) carried the same bug before the fold into bun-standalone.ts.
 */
import { describe, expect, it } from 'vitest';
import { isBunStandalonePath } from '../src/bun-standalone.js';

describe('isBunStandalonePath', () => {
  it('recognizes the POSIX bunfs virtual root', () => {
    expect(isBunStandalonePath('/$bunfs/root/cartograph-bin')).toBe(true);
  });

  it('recognizes the Windows ~BUN virtual drive in both separator styles', () => {
    expect(isBunStandalonePath('B:\\~BUN\\root\\cartograph.exe')).toBe(true);
    expect(isBunStandalonePath('b:/~BUN/root/cartograph.exe')).toBe(true);
  });

  it('rejects ordinary on-disk module paths and undefined argv slots', () => {
    expect(isBunStandalonePath('/Users/dev/cartograph/src/bin/cartograph.ts')).toBe(false);
    expect(isBunStandalonePath('C:\\Users\\dev\\cartograph\\src\\bin\\cartograph.ts')).toBe(false);
    expect(isBunStandalonePath(undefined)).toBe(false);
  });
});
