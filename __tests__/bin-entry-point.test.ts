/**
 * Entry-point detection for bun standalone executables.
 *
 * The windows-x64 release smoke caught the .exe exiting 0 with no
 * output: bun's Windows virtual root (`B:\~BUN\...`) wasn't recognized,
 * so the CLI never dispatched. The POSIX form and the
 * source-checkout negative cases pin the contract.
 */
import { describe, expect, it } from 'vitest';
import { isBunStandaloneModulePath } from '../src/bin/cartograph.js';

describe('isBunStandaloneModulePath', () => {
  it('recognizes the POSIX bunfs virtual root', () => {
    expect(isBunStandaloneModulePath('/$bunfs/root/cartograph-bin')).toBe(true);
  });

  it('recognizes the Windows ~BUN virtual drive in both separator styles', () => {
    expect(isBunStandaloneModulePath('B:\\~BUN\\root\\cartograph.exe')).toBe(true);
    expect(isBunStandaloneModulePath('b:/~BUN/root/cartograph.exe')).toBe(true);
  });

  it('rejects ordinary on-disk module paths', () => {
    expect(isBunStandaloneModulePath('/Users/dev/cartograph/src/bin/cartograph.ts')).toBe(false);
    expect(isBunStandaloneModulePath('C:\\Users\\dev\\cartograph\\src\\bin\\cartograph.ts')).toBe(false);
  });
});
