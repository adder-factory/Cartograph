/**
 * Pure daemon decision logic, split out of `daemon.ts` so the error
 * branches (version mismatch, lock-takeover grace, connect-failure
 * classification) can be unit-tested IN-PROCESS. `daemon.ts`'s own logic
 * otherwise runs only inside spawned child processes, which per-file
 * coverage can't instrument (daemon.ts was the least-covered large
 * module). These take primitives (not net.Socket / fs) so they have no
 * I/O and no import cycle with daemon.ts.
 */

/** The shared-daemon wire protocol version advertised in the hello frame. */
export const DAEMON_PROTOCOL_VERSION = 1;

/**
 * Whether a daemon's hello matches our package version and protocol, so we
 * can reuse its socket. A mismatch means a different cartograph build owns
 * the daemon; the caller falls back to direct (non-shared) mode.
 */
export function isAcceptableDaemonHello(helloVersion: string, helloProtocol: number, localVersion: string): boolean {
  return helloVersion === localVersion && helloProtocol === DAEMON_PROTOCOL_VERSION;
}

/**
 * Whether a daemon lock is past its startup-grace window, so a contender
 * may take it over. `startedAt <= 0` (unstamped / malformed) is treated as
 * past-grace so a broken lock self-heals rather than blocking forever.
 */
export function isDaemonLockPastStartupGrace(startedAt: number, graceMs: number, now: number): boolean {
  if (startedAt <= 0) return true;
  return now - startedAt > graceMs;
}

/**
 * Whether an error means "couldn't connect to the daemon" (so the caller
 * falls back to direct mode), vs a real failure worth surfacing. Covers the
 * socket-absent / refused / broken-pipe codes plus our own
 * "daemon socket is missing" sentinel.
 */
export function isDaemonConnectFailure(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EPIPE') return true;
  return err.message.startsWith('daemon socket is missing');
}
