export type SessionAction =
  | 'create'
  | 'resume'
  | 'audit'
  | 'list'
  | 'delete'
  | 'macro_save'
  | 'macro_run'
  | 'macro_list'
  | 'macro_delete';

export type SessionMcpArgs = Record<string, unknown> & { action: SessionAction };

export type SessionArgResult = { ok: true; args: SessionMcpArgs } | { ok: false; error: string };

export interface SessionIdentityOptions {
  id?: string;
  label?: string;
}

export interface MacroSaveOptions {
  name?: string;
  steps?: string;
}

export interface MacroRunOptions {
  name?: string;
  args?: string;
}

export interface MacroDeleteOptions {
  name?: string;
}

export function buildCreateSessionArgs(options: { label?: string }): SessionArgResult {
  const args: SessionMcpArgs = { action: 'create' };
  if (options.label) args['label'] = options.label;
  return { ok: true, args };
}

export function buildResumeSessionArgs(idArg: string | undefined, options: SessionIdentityOptions): SessionArgResult {
  const id = options.id ?? idArg;
  const args: SessionMcpArgs = { action: 'resume' };
  if (id) args['id'] = id;
  if (options.label) args['label'] = options.label;
  if (!id && !options.label) {
    return { ok: false, error: 'session resume: pass a session id positionally, via --id, or a --label.' };
  }
  return { ok: true, args };
}

export function buildAuditSessionArgs(idArg: string | undefined, options: SessionIdentityOptions): SessionArgResult {
  const id = options.id ?? idArg;
  const args: SessionMcpArgs = { action: 'audit' };
  if (id) args['id'] = id;
  if (options.label) args['label'] = options.label;
  return { ok: true, args };
}

export function buildListSessionArgs(options: { limit?: number }): SessionArgResult {
  const args: SessionMcpArgs = { action: 'list' };
  if (options.limit !== undefined) args['limit'] = options.limit;
  return { ok: true, args };
}

export function buildDeleteSessionArgs(options: SessionIdentityOptions): SessionArgResult {
  const args: SessionMcpArgs = { action: 'delete' };
  if (options.id) args['id'] = options.id;
  if (options.label) args['label'] = options.label;
  return { ok: true, args };
}

export function buildMacroSaveArgs(options: MacroSaveOptions): SessionArgResult {
  if (!options.name) return { ok: false, error: 'macro_save: --name is required' };
  if (!options.steps) return { ok: false, error: 'macro_save: --steps <json> is required' };

  const parsed = parseJsonOption(options.steps, 'macro_save: --steps must be valid JSON');
  if (!parsed.ok) return parsed;
  return { ok: true, args: { action: 'macro_save', name: options.name, steps: parsed.value } };
}

export function buildMacroRunArgs(options: MacroRunOptions): SessionArgResult {
  if (!options.name) return { ok: false, error: 'macro_run: --name is required' };

  const args: SessionMcpArgs = { action: 'macro_run', name: options.name };
  if (options.args) {
    const parsed = parseJsonOption(options.args, 'macro_run: --args must be valid JSON');
    if (!parsed.ok) return parsed;
    args['args'] = parsed.value;
  }
  return { ok: true, args };
}

export function buildMacroListArgs(): SessionArgResult {
  return { ok: true, args: { action: 'macro_list' } };
}

export function buildMacroDeleteArgs(options: MacroDeleteOptions): SessionArgResult {
  if (!options.name) return { ok: false, error: 'macro_delete: --name is required' };
  return { ok: true, args: { action: 'macro_delete', name: options.name } };
}

function parseJsonOption(raw: string, error: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, error };
  }
}
