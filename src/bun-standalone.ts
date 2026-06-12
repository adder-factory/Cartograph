/**
 * Bun standalone executables mount bundled modules under a virtual
 * root: `/$bunfs/...` on POSIX, a `<drive>:\~BUN\...` virtual drive on
 * Windows. Every "am I running from a compiled binary?" check must
 * recognize BOTH forms — the windows-x64 release smoke caught a
 * POSIX-only copy making the .exe exit without dispatching the CLI,
 * and three more copies (daemon self-spawn, install-method detection,
 * installer command pinning) carried the same bug. One definition.
 */
export function isBunStandalonePath(p: string | undefined): boolean {
  if (!p) return false;
  return p.startsWith('/$bunfs/') || /^[A-Za-z]:[\\/]~BUN[\\/]/.test(p);
}
