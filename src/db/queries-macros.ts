/**
 * Macros — saved tool-call recipes (#13).
 *
 * Lightweight CRUD over the `mcp_macros` table. The macro runner
 * lives in the MCP `session` tool module; this file is just storage.
 */
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

function zodFallback<T extends z.ZodType>(schema: T, value: z.output<T>): z.ZodCatch<T> {
  return schema['catch'](value);
}

export interface MacroStep {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * Zod v4 schema for ONE persisted macro step. `mcp_macros.steps_json`
 * is a hand-editable / corruptible DB column whose decoded contents
 * become MCP tool dispatches — genuinely untrusted on read-back, so a
 * bad `tool` must never reach the dispatcher.
 */
const MacroStepSchema = z.object({
  tool: z.string().min(1),
  args: zodFallback(z.record(z.string(), z.unknown()), {}),
});

/** A whole macro's step list. `.catch([])` degrades a corrupt or
 *  schema-drifted row to an empty macro rather than crashing a CRUD
 *  call mid-flight. */
const MacroStepsSchema = zodFallback(z.array(MacroStepSchema), []);

/** Decode + validate a `steps_json` column. A non-JSON string and a
 *  payload that fails the schema both yield `[]` — never a throw. */
function parseMacroSteps(stepsJson: string): MacroStep[] {
  let raw: unknown;
  try {
    raw = JSON.parse(stepsJson);
  } catch {
    return [];
  }
  return MacroStepsSchema.parse(raw);
}

interface MacroRow {
  name: string;
  steps: MacroStep[];
  createdTs: number;
  lastRunTs: number | null;
}

interface SaveMacroArgs {
  qb: QueryBuilder;
  name: string;
  steps: MacroStep[];
  ts: number;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const MacroDbRowSchema = z.object({
  name: z.string(),
  steps_json: z.string(),
  created_ts: z.number(),
  last_run_ts: z.number().nullable(),
});

type MacroDbRow = z.infer<typeof MacroDbRowSchema>;

const saveMacroQuery = defineQuery({
  sql: `INSERT INTO mcp_macros (name, steps_json, created_ts)
         VALUES (@name, @stepsJson, @createdTs)
         ON CONFLICT(name) DO UPDATE
           SET steps_json = excluded.steps_json`,
  params: z.object({
    name: z.string(),
    stepsJson: z.string(),
    createdTs: z.number(),
  }),
  row: z.never(),
});

const getMacroQuery = defineQuery({
  sql: `SELECT name, steps_json, created_ts, last_run_ts FROM mcp_macros WHERE name = @name`,
  params: z.object({ name: z.string() }),
  row: MacroDbRowSchema,
});

const listMacrosQuery = defineQuery({
  sql: `SELECT name, steps_json, created_ts, last_run_ts
         FROM mcp_macros
         ORDER BY created_ts DESC`,
  params: z.object({}),
  row: MacroDbRowSchema,
});

const bumpMacroRunQuery = defineQuery({
  sql: `UPDATE mcp_macros SET last_run_ts = @ts WHERE name = @name`,
  params: z.object({ name: z.string(), ts: z.number() }),
  row: z.never(),
});

const deleteMacroQuery = defineQuery({
  sql: `DELETE FROM mcp_macros WHERE name = @name`,
  params: z.object({ name: z.string() }),
  row: z.never(),
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    saveMacro?: TypedQuery<{ name: string; stepsJson: string; createdTs: number }, never>;
    getMacro?: TypedQuery<{ name: string }, MacroDbRow>;
    listMacros?: TypedQuery<Record<string, never>, MacroDbRow>;
    bumpMacroRun?: TypedQuery<{ name: string; ts: number }, never>;
    deleteMacro?: TypedQuery<{ name: string }, never>;
  }
}

/** Upsert a macro by name. Replaces steps when name exists. */
export function saveMacro(args: SaveMacroArgs): void {
  const { qb, name, steps, ts } = args;
  qb.queries.saveMacro ??= saveMacroQuery(qb.db);
  qb.queries.saveMacro.run({ name, stepsJson: JSON.stringify(steps), createdTs: ts });
}

export function getMacro(qb: QueryBuilder, name: string): MacroRow | null {
  qb.queries.getMacro ??= getMacroQuery(qb.db);
  const row = qb.queries.getMacro.get({ name });
  if (!row) return null;
  return {
    name: row.name,
    steps: parseMacroSteps(row.steps_json),
    createdTs: row.created_ts,
    lastRunTs: row.last_run_ts,
  };
}

export function listMacros(qb: QueryBuilder): MacroRow[] {
  qb.queries.listMacros ??= listMacrosQuery(qb.db);
  const rows = qb.queries.listMacros.all({});
  return rows.map((r) => ({
    name: r.name,
    steps: parseMacroSteps(r.steps_json),
    createdTs: r.created_ts,
    lastRunTs: r.last_run_ts,
  }));
}

export function bumpMacroRun(qb: QueryBuilder, name: string, ts: number): void {
  qb.queries.bumpMacroRun ??= bumpMacroRunQuery(qb.db);
  qb.queries.bumpMacroRun.run({ name, ts });
}

export function deleteMacro(qb: QueryBuilder, name: string): boolean {
  qb.queries.deleteMacro ??= deleteMacroQuery(qb.db);
  const res = qb.queries.deleteMacro.run({ name });
  return res.changes > 0;
}
