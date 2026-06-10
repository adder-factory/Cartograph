/**
 * In-process unit tests for the pure daemon decision logic. daemon.ts's
 * own logic runs only inside spawned child processes (uninstrumentable by
 * per-file coverage), so the version-mismatch / lock-takeover-grace /
 * connect-failure branches were effectively untested — these cover them.
 */

import { describe, it, expect } from 'vitest';
import {
  DAEMON_PROTOCOL_VERSION,
  isAcceptableDaemonHello,
  isDaemonConnectFailure,
  isDaemonLockPastStartupGrace,
} from '../src/mcp/daemon-logic.js';

describe('isAcceptableDaemonHello', () => {
  it('accepts a matching version + protocol', () => {
    expect(isAcceptableDaemonHello('0.7.2', DAEMON_PROTOCOL_VERSION, '0.7.2')).toBe(true);
  });
  it('rejects a version mismatch', () => {
    expect(isAcceptableDaemonHello('0.7.1', DAEMON_PROTOCOL_VERSION, '0.7.2')).toBe(false);
  });
  it('rejects a protocol mismatch', () => {
    expect(isAcceptableDaemonHello('0.7.2', DAEMON_PROTOCOL_VERSION + 1, '0.7.2')).toBe(false);
  });
});

describe('isDaemonLockPastStartupGrace', () => {
  const grace = 5_000;
  it('treats an unstamped lock (startedAt <= 0) as past grace (self-heal)', () => {
    expect(isDaemonLockPastStartupGrace(0, grace, 10_000)).toBe(true);
    expect(isDaemonLockPastStartupGrace(-1, grace, 10_000)).toBe(true);
  });
  it('is within grace just after start', () => {
    expect(isDaemonLockPastStartupGrace(9_000, grace, 10_000)).toBe(false);
  });
  it('is past grace once the window elapses', () => {
    expect(isDaemonLockPastStartupGrace(1_000, grace, 10_000)).toBe(true);
  });
  it('boundary: exactly at the grace window is NOT past it', () => {
    expect(isDaemonLockPastStartupGrace(5_000, grace, 10_000)).toBe(false);
  });
});

describe('isDaemonConnectFailure', () => {
  it('returns false for a non-Error', () => {
    expect(isDaemonConnectFailure('nope')).toBe(false);
    expect(isDaemonConnectFailure(null)).toBe(false);
  });
  it('classifies ENOENT / ECONNREFUSED / EPIPE as connect failures', () => {
    for (const code of ['ENOENT', 'ECONNREFUSED', 'EPIPE']) {
      const err = Object.assign(new Error('x'), { code });
      expect(isDaemonConnectFailure(err)).toBe(true);
    }
  });
  it('classifies the "daemon socket is missing" sentinel', () => {
    expect(isDaemonConnectFailure(new Error('daemon socket is missing at /tmp/x.sock'))).toBe(true);
  });
  it('returns false for an unrelated error', () => {
    expect(isDaemonConnectFailure(Object.assign(new Error('boom'), { code: 'EACCES' }))).toBe(false);
  });
});
