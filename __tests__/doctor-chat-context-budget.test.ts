/**
 * Doctor's `Chat context budget` verdict (issue #27). Unit-tests the pure
 * `assessChatContextBudget` threshold logic — the live `/props` probing half
 * (`chatContextBudgetCheck`) is exercised through the doctor end-to-end suite.
 */
import { describe, it, expect } from 'vitest';
import { assessChatContextBudget } from '../src/installer/doctor/backend-checks.js';

describe('assessChatContextBudget (issue #27)', () => {
  it('returns null when nothing assessable was reachable (no n_ctx)', () => {
    expect(
      assessChatContextBudget([{ endpoint: 'http://localhost:8081', tiers: ['summarize'], nCtx: null }]),
    ).toBeNull();
    expect(assessChatContextBudget([])).toBeNull();
  });

  it('reports ok when every reachable chat tier has >= the 4096-token floor', () => {
    const result = assessChatContextBudget([
      { endpoint: 'http://localhost:8081', tiers: ['summarize', 'local'], nCtx: 4096 },
      { endpoint: 'http://localhost:8082', tiers: ['ask'], nCtx: 65536 },
    ]);
    expect(result?.status).toBe('ok');
  });

  it('warns (raise -c / lower --parallel) when a slot is below the floor, naming only the offender', () => {
    const result = assessChatContextBudget([
      { endpoint: 'http://localhost:8081', tiers: ['summarize', 'local'], nCtx: 1024 },
      { endpoint: 'http://localhost:8082', tiers: ['ask'], nCtx: 65536 },
    ]);
    expect(result?.status).toBe('warn');
    expect(result?.id).toBe('chat-context-budget');
    expect(result?.detail).toContain('1024 tokens/slot');
    expect(result?.detail).toContain('summarize/local');
    // the healthy ask backend (65536/slot) is not flagged
    expect(result?.detail).not.toContain('8082');
    expect(result?.remediation ?? '').toMatch(/-c|--parallel/);
  });
});
