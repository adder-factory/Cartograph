import * as os from 'node:os';

/**
 * Resolve the user's home directory.
 *
 * Reads `$HOME` (POSIX) / `$USERPROFILE` (Windows) FIRST, then falls
 * back to `os.homedir()`. The fallback covers unusual setups where
 * neither env var is set; the env-var-first path is what lets tests
 * redirect HOME to a tmpdir without monkey-patching the `os` module.
 *
 * Why env-first: under bun (1.3.14, verified 2026-05-20) `os.homedir()`
 * is cached at first call, so env-var-only redirection after process
 * start silently falls through to the real user's home. Reading the
 * env var directly is dynamic and works on both Node and bun. The
 * env-first order is also the POSIX convention.
 */
export function getHomeDir(): string {
  return process.env['HOME'] ?? process.env['USERPROFILE'] ?? os.homedir();
}
