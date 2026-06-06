import { describe, expect, it } from 'vitest';
import {
  buildAuditSessionArgs,
  buildCreateSessionArgs,
  buildDeleteSessionArgs,
  buildListSessionArgs,
  buildMacroDeleteArgs,
  buildMacroListArgs,
  buildMacroRunArgs,
  buildMacroSaveArgs,
  buildResumeSessionArgs,
} from '../src/features/session/runtime.js';

describe('session feature runtime', () => {
  it('builds identity-based session actions without leaking undefined fields', () => {
    expect(buildCreateSessionArgs({ label: 'investigation' })).toEqual({
      ok: true,
      args: { action: 'create', label: 'investigation' },
    });
    expect(buildResumeSessionArgs('positional-id', { id: 'flag-id', label: 'named' })).toEqual({
      ok: true,
      args: { action: 'resume', id: 'flag-id', label: 'named' },
    });
    expect(buildAuditSessionArgs(undefined, { label: 'named' })).toEqual({
      ok: true,
      args: { action: 'audit', label: 'named' },
    });
    expect(buildDeleteSessionArgs({ id: 's1' })).toEqual({ ok: true, args: { action: 'delete', id: 's1' } });
    expect(buildListSessionArgs({ limit: 5 })).toEqual({ ok: true, args: { action: 'list', limit: 5 } });
  });

  it('returns expected failures as values for invalid session inputs', () => {
    expect(buildResumeSessionArgs(undefined, {})).toEqual({
      ok: false,
      error: 'session resume: pass a session id positionally, via --id, or a --label.',
    });
  });

  it('parses macro JSON arguments and reports invalid JSON as values', () => {
    expect(buildMacroSaveArgs({ name: 'triage', steps: '[{"tool":"cartograph_status","args":{}}]' })).toEqual({
      ok: true,
      args: {
        action: 'macro_save',
        name: 'triage',
        steps: [{ tool: 'cartograph_status', args: {} }],
      },
    });
    expect(buildMacroRunArgs({ name: 'triage', args: '["indexAll"]' })).toEqual({
      ok: true,
      args: { action: 'macro_run', name: 'triage', args: ['indexAll'] },
    });
    expect(buildMacroSaveArgs({ name: 'triage', steps: 'nope' })).toEqual({
      ok: false,
      error: 'macro_save: --steps must be valid JSON',
    });
    expect(buildMacroRunArgs({ name: 'triage', args: 'nope' })).toEqual({
      ok: false,
      error: 'macro_run: --args must be valid JSON',
    });
  });

  it('builds macro list/delete actions and validates required names', () => {
    expect(buildMacroListArgs()).toEqual({ ok: true, args: { action: 'macro_list' } });
    expect(buildMacroDeleteArgs({ name: 'triage' })).toEqual({
      ok: true,
      args: { action: 'macro_delete', name: 'triage' },
    });
    expect(buildMacroDeleteArgs({})).toEqual({ ok: false, error: 'macro_delete: --name is required' });
    expect(buildMacroSaveArgs({ steps: '[]' })).toEqual({ ok: false, error: 'macro_save: --name is required' });
    expect(buildMacroRunArgs({})).toEqual({ ok: false, error: 'macro_run: --name is required' });
  });
});
