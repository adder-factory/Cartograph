/**
 * Naming-convention drift checker.
 *
 * Tier-3 enrichment: when a new symbol is added, compare its name
 * against siblings of the same kind and ask the LLM whether it
 * follows the established convention. Surfaces as an advisory — not
 * an enforcement — because conventions in real codebases are mushy.
 *
 * Designed to be cheap: pulls a small (~30-name) sample of siblings,
 * one LLM call per check, no caching at this layer.
 */

import { z } from 'zod';
import { type LlmClient, LlmEndpointError, type ResponseJsonSchema } from './client.js';
import type { QueryBuilder } from '../db/queries.js';
import { sampleSiblingNames } from '../db/queries-roles.js';
import { compact } from '../utils.js';

const MAX_SIBLING_SAMPLE = 30;

function zodFallback<T extends z.ZodType>(schema: T, value: z.output<T>): z.ZodCatch<T> {
  return schema['catch'](value);
}

/**
 * JSON-schema for the naming verdict. Passed as
 * `ChatOptions.responseSchema` — on the grammar-constrained backends
 * (openai-compat / anthropic-api) the reply is a valid
 * `{consistent, suggestion, reason}` object by construction;
 * {@link parseResponse} stays as a thin guard for the soft
 * (claude-bridge) path.
 */
const NAMING_SCHEMA: ResponseJsonSchema = {
  type: 'object',
  properties: {
    consistent: { type: 'boolean' },
    suggestion: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['consistent', 'suggestion', 'reason'],
};

interface NamingCheckOptions {
  signal?: AbortSignal;
}

export interface NamingCheckResult {
  consistent: boolean;
  /** Optional better-named suggestion. Empty when consistent. */
  suggestion: string;
  /** One-line explanation. */
  reason: string;
  /** The sample of sibling names the model was given. Useful for UI. */
  examples: string[];
  durationMs: number;
}

function buildPrompt(name: string, kind: string, examples: string[]): string {
  return [
    `You are a code reviewer checking that a newly added ${kind} follows the`,
    `naming conventions used by the rest of the codebase.`,
    '',
    'Existing names of the same kind in this codebase:',
    ...examples.map((n) => `  - ${n}`),
    '',
    `Newly added: ${name}`,
    '',
    'Reply with EXACTLY one JSON object on one line:',
    '{"consistent": true | false, "suggestion": "alternative name or empty string", "reason": "one short sentence"}',
    'No markdown, no prose outside the JSON. If unsure, prefer consistent=true.',
  ].join('\n');
}

/**
 * Zod v4 schema for the naming-judge reply. Per-field `.catch` arms
 * mirror the prior hand guards exactly: `consistent` resolves to
 * `true` for anything other than a literal `false` ("err on the side
 * of not flagging"); `suggestion` / `reason` collapse a non-string to
 * `''` before the length cap. The whole-object `.catch` absorbs a
 * non-object payload (a bare string / number / array) into the same
 * all-default verdict, so `.parse` never throws.
 */
const NamingJudgeSchema = zodFallback(
  z.object({
    consistent: zodFallback(z.boolean(), true),
    suggestion: zodFallback(z.string(), '').transform((s) => s.slice(0, 80)),
    reason: zodFallback(z.string(), '').transform((s) => s.slice(0, 200)),
  }),
  { consistent: true, suggestion: '', reason: '' },
);

function parseResponse(text: string, examples: string[]): NamingCheckResult {
  const cleaned = text
    .trim()
    .replaceAll(/```(?:json)?/g, '')
    .trim();
  let raw: unknown;
  try {
    raw = JSON.parse(cleaned);
  } catch {
    return {
      consistent: true, // err on the side of not flagging
      suggestion: '',
      reason: 'unparseable judge response — defaulting to consistent',
      examples,
      durationMs: 0,
    };
  }
  const verdict = NamingJudgeSchema.parse(raw);
  return {
    consistent: verdict.consistent,
    suggestion: verdict.suggestion,
    reason: verdict.reason,
    examples,
    durationMs: 0,
  };
}

/** Describe an LLM-side error caught by the naming-check pipeline.
 *  Recognises LlmEndpointError so the human-readable `.message` survives. */
function describeNamingError(err: unknown): string {
  if (err instanceof LlmEndpointError) return err.message;
  return String(err);
}

interface CheckNamingConventionArgs {
  queries: QueryBuilder;
  client: LlmClient;
  newSymbol: { name: string; kind: string; filePath: string };
  options?: NamingCheckOptions;
}

/**
 * Check a single name against the codebase's existing naming
 * conventions for the same kind. One LLM call.
 */
export async function checkNamingConvention(args: CheckNamingConventionArgs): Promise<NamingCheckResult> {
  const { queries, client, newSymbol, options = {} } = args;
  const t0 = Date.now();

  const examples = sampleSiblingNames({
    qb: queries,
    kind: newSymbol.kind,
    excludeName: newSymbol.name,
    excludeFile: newSymbol.filePath,
    limit: MAX_SIBLING_SAMPLE,
  });

  // Need at least a handful of siblings before "convention" is a
  // meaningful concept — otherwise everything looks fine.
  if (examples.length < 5) {
    return {
      consistent: true,
      suggestion: '',
      reason: 'not enough sibling symbols of this kind to infer a convention',
      examples,
      durationMs: Date.now() - t0,
    };
  }

  try {
    const result = await client.chat(
      [{ role: 'user', content: buildPrompt(newSymbol.name, newSymbol.kind, examples) }],
      compact({ temperature: 0, maxTokens: 120, responseSchema: NAMING_SCHEMA, signal: options.signal }),
    );
    const parsed = parseResponse(result.text, examples);
    parsed.durationMs = Date.now() - t0;
    return parsed;
  } catch (err) {
    // Naming check is advisory — never throw, just defer the verdict.
    return {
      consistent: true,
      suggestion: '',
      reason: `naming check failed: ${describeNamingError(err)}`,
      examples,
      durationMs: Date.now() - t0,
    };
  }
}
