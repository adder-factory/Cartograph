/**
 * `cartograph_local_chat` — one-shot chat against the user's configured
 * local LLM (or whatever summarize backend `config.llm.summarizeLlm` points at).
 *
 * Why this exists: the parent agent (Claude in Claude Code) can
 * delegate verification / mechanical work to Anthropic-side cheaper
 * models via the Agent tool's `model: haiku|sonnet` selector. There
 * is no equivalent path to the LOCAL model the user is already
 * running at `localhost:8081/v1` (or wherever) — even though
 * cartograph itself uses that local model for summaries, embeddings,
 * role classification, and ask. This tool exposes the same engine,
 * same configured endpoint, same code-context to the agent for
 * ad-hoc bulk-prose subtasks. Closes the third tier of the
 * model-allocation triangle (opus / sonnet-haiku / local).
 *
 * Discipline lives in the tool description — the agent picker has
 * to read it. Hard limits live in the service method (prompt-length
 * cap, reachability check, fail-loud on backend errors).
 */
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { errMsg } from '../../errors.js';
import { displayModelName, textResult, truncateOutput } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { llmLocalChat } from '../../cartograph-llm-service.js';

/**
 * Caller-facing prompt-length cap. Mirrors the service-side
 * `LOCAL_CHAT_MAX_PROMPT_CHARS` (64k) so an over-long prompt is
 * rejected at the dispatch boundary rather than after a round-trip.
 */
const MAX_PROMPT_CHARS = 64_000;

/**
 * Output cap for `local_chat` — deliberately higher than `ask`'s
 * 15k `MAX_OUTPUT_LENGTH` because this tool exists for bulk prose
 * (file summaries, draft paragraphs). It still caps a runaway local
 * model that drifts far past the requested length (friction audit-4
 * #8), but with enough headroom that a legitimate bulk reply survives.
 */
const LOCAL_CHAT_MAX_OUTPUT_LENGTH = 32_000;

/**
 * Zod schema for `cartograph_local_chat`. `prompt` is
 * `.min(1).max(64000)` — an empty or over-long prompt is REJECTED at
 * the dispatch boundary, mirroring the service-side prompt cap.
 * `maxTokens` is `.int().min(1)` — a zero / negative / non-integer
 * value is REJECTED (the locked reject-out-of-range decision; the
 * legacy handler hand-rejected `<= 0`), so the handler no longer
 * carries a defensive `maxTokens` guard.
 */
const localChatSchema = z.object({
  prompt: z.string().min(1).max(MAX_PROMPT_CHARS).describe('User-side message to send to the local backend.'),
  system: z
    .string()
    .optional()
    .describe("Optional system message shaping the local model's behavior. Empty string is treated as omitted."),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Optional positive-integer cap on output tokens. Defaults to the backend default when omitted.'),
  projectPath: projectPathField,
});

type LocalChatArgs = z.infer<typeof localChatSchema>;

async function handleLocalChat(ctx: ToolCtx, args: LocalChatArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);

  // `prompt` is already a non-empty string ≤ 64k chars — Zod's
  // `.min(1).max(64000)` rejected anything else at the dispatch
  // boundary.
  const prompt = args.prompt;

  // An empty `system` string is treated as omitted.
  const system = args.system && args.system.length > 0 ? args.system : undefined;

  // `maxTokens` is already a positive integer when present — Zod's
  // `.int().min(1)` rejected a zero / negative / non-integer value at
  // the dispatch boundary.
  const maxTokens = args.maxTokens;

  try {
    const result = await llmLocalChat(cg.llm, {
      prompt,
      ...(system ? { system } : {}),
      ...(maxTokens === undefined ? {} : { maxTokens }),
    });
    // displayModelName collapses an absolute GGUF path to its basename
    // so the trailer doesn't leak the operator's home directory (#42).
    const trailer = `\n\n---\n_local-chat: ${displayModelName(result.model)} • ${Math.round(result.durationMs)}ms_`;
    // Cap a runaway local model's output (friction audit-4 group-5 #8).
    // The cap is higher than `ask`'s 15k since local_chat is meant for
    // bulk prose; `truncateOutput` cuts on a line boundary so the body
    // never ends mid-sentence, and the model/timing trailer is appended
    // after the cut so it always survives.
    const body = truncateOutput(result.text, LOCAL_CHAT_MAX_OUTPUT_LENGTH);
    return ok(textResult(body + trailer));
  } catch (caught) {
    return err(`local_chat failed: ${errMsg(caught)}`);
  }
}

export const LOCAL_CHAT_TOOL = defineTool({
  name: 'cartograph_local_chat',
  description:
    "Delegate bulk prose to the user's local LLM. " +
    'Good for summarisation, draft prose, paraphrase check, snippet classification. ' +
    'NOT for hard reasoning, executed-verbatim code, or user-visible output without review. ' +
    '64k char prompt cap; fails loud when the backend is unreachable.',
  schema: localChatSchema,
  handle: handleLocalChat,
  // local_chat relays a prompt straight to the configured LLM — it
  // never reads the code index, so index staleness is irrelevant.
  // Without this, a heavily-drifted index would block an LLM relay
  // call that has nothing to do with the graph.
  bypassFreshnessGate: true,
});
