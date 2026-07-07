import { z } from 'zod';

export type SessionAction =
  | 'create'
  | 'resume'
  | 'audit'
  | 'list'
  | 'delete'
  | 'usage'
  | 'macro_save'
  | 'macro_run'
  | 'macro_list'
  | 'macro_delete';

export type SessionMcpArgs = Record<string, unknown> & { action: SessionAction };

export type SessionArgResult = { ok: true; args: SessionMcpArgs } | { ok: false; error: string };
type JsonParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

const macroStepsSchema = z.array(z.looseObject({}));
const macroStepContractSchema = z.object({
  tool: z.string().min(1),
  args: z.record(z.string(), z.unknown()).default({}),
});
export const macroStepContractsSchema = z.array(macroStepContractSchema);
const macroRunArgsSchema = z.array(z.unknown());

type MacroSteps = z.infer<typeof macroStepContractsSchema>;
type MacroRunArgs = z.infer<typeof macroRunArgsSchema>;

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

export function buildUsageSessionArgs(): SessionArgResult {
  return { ok: true, args: { action: 'usage' } };
}

export function buildMacroSaveArgs(options: MacroSaveOptions): SessionArgResult {
  if (!options.name) return { ok: false, error: 'macro_save: --name is required' };
  if (!options.steps) return { ok: false, error: 'macro_save: --steps <json> is required' };

  const parsed = parseMacroStepsOption(options.steps);
  if (!parsed.ok) return parsed;
  return { ok: true, args: { action: 'macro_save', name: options.name, steps: parsed.value } };
}

export function buildMacroRunArgs(options: MacroRunOptions): SessionArgResult {
  if (!options.name) return { ok: false, error: 'macro_run: --name is required' };

  const args: SessionMcpArgs = { action: 'macro_run', name: options.name };
  if (options.args) {
    const parsed = parseMacroRunArgsOption(options.args);
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

function parseMacroStepsOption(raw: string): JsonParseResult<MacroSteps> {
  const parsed = parseJsonOption(raw, 'macro_save: --steps must be valid JSON');
  if (!parsed.ok) return parsed;

  const result = macroStepsSchema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, error: 'macro_save: --steps must be an array of step objects' };
  }
  if (result.data.length === 0) {
    return { ok: false, error: 'macro_save: --steps must contain at least one {tool, args} step' };
  }
  const contract = macroStepContractsSchema.safeParse(result.data);
  if (!contract.success) {
    return { ok: false, error: 'macro_save: --steps must be an array of {tool, args} step objects' };
  }
  return { ok: true, value: contract.data };
}

function parseMacroRunArgsOption(raw: string): JsonParseResult<MacroRunArgs> {
  const parsed = parseJsonOption(raw, 'macro_run: --args must be valid JSON');
  if (!parsed.ok) return parsed;

  const result = macroRunArgsSchema.safeParse(parsed.value);
  if (!result.success) {
    return { ok: false, error: 'macro_run: --args must be an array' };
  }
  return { ok: true, value: result.data };
}

function parseJsonOption(raw: string, error: string): JsonParseResult<unknown> {
  try {
    const value: unknown = JSON.parse(raw);
    return { ok: true, value };
  } catch {
    return { ok: false, error };
  }
}
