import { z } from 'zod';
import { projectPathField, nonEmptyString } from './_common-fields.js';
import { errMsg } from '../../errors.js';
import { getAskModel } from '../../llm/provider.js';
import { textResult, truncateOutput } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { buildAskOutput, groundCitations } from '../../features/ask/citations.js';
import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MAX, RETRIEVE_K_MIN } from '../../features/ask/constants.js';
import { handleLocalChat } from './local-chat.js';
export {
  buildAskOutput,
  buildCitationReport,
  formatCitationCounter,
  formatRerankTag,
  groundCitations,
  isDistributionPath,
  type CitationReport,
  type CitedIdentifier,
} from '../../features/ask/citations.js';
export { RETRIEVE_K_DEFAULT, RETRIEVE_K_MAX, RETRIEVE_K_MIN } from '../../features/ask/constants.js';

/**
 * Maximum length of the `question` string — mirrors `validateString`'s
 * default 4 KB cap so an over-long question is rejected with the same
 * "at most 4096 characters" contract the legacy handler advertised.
 */
const QUESTION_MAX_LENGTH = 4096;
const LOCAL_CHAT_MAX_PROMPT_CHARS = 64_000;

/**
 * Zod schema for `cartograph_ask`.
 *
 * `question` is `.min(1).max(4096)` plus a non-whitespace refinement —
 * mirroring the legacy `validateString` (which rejected both empty AND
 * whitespace-only input). `retrieveK` is `.int().min(4).max(30)`, so an
 * out-of-range or non-integer value is REJECTED at the dispatch
 * boundary (the locked reject-out-of-range decision); the handler's old
 * `clamp(numArg(...))` is dead code, removed.
 */
const askSchema = z.object({
  mode: z
    .enum(['code', 'local_chat'])
    .default('code')
    .describe(
      '`code` (default) asks a natural-language question about the indexed codebase. `local_chat` delegates bulk prose to the configured local/summarize LLM without reading the code index.',
    ),
  question: nonEmptyString
    .max(QUESTION_MAX_LENGTH)
    .optional()
    .describe('(mode=code) Natural-language question about the codebase.'),
  retrieveK: z
    .number()
    .int()
    .min(RETRIEVE_K_MIN)
    .max(RETRIEVE_K_MAX)
    .default(RETRIEVE_K_DEFAULT)
    .describe(
      `Candidate symbols fed to the model as context; integer in [${RETRIEVE_K_MIN}, ${RETRIEVE_K_MAX}] (default ${RETRIEVE_K_DEFAULT}).`,
    ),
  prompt: z
    .string()
    .min(1)
    .max(LOCAL_CHAT_MAX_PROMPT_CHARS)
    .optional()
    .describe('(mode=local_chat) User-side message to send to the local backend.'),
  system: z
    .string()
    .optional()
    .describe("(mode=local_chat) Optional system message shaping the local model's behavior."),
  maxTokens: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('(mode=local_chat) Optional positive-integer cap on output tokens.'),
  projectPath: projectPathField,
});

type AskToolArgs = z.infer<typeof askSchema>;

async function handleAsk(ctx: ToolCtx, args: AskToolArgs): Promise<ToolOutcome> {
  if (args.mode === 'local_chat') {
    if (!args.prompt) {
      return err('cartograph_ask mode=local_chat requires `prompt`.');
    }
    return handleLocalChat(ctx, {
      prompt: args.prompt,
      ...(args.system === undefined ? {} : { system: args.system }),
      ...(args.maxTokens === undefined ? {} : { maxTokens: args.maxTokens }),
      ...(args.projectPath === undefined ? {} : { projectPath: args.projectPath }),
    });
  }

  if (!args.question) {
    return err('cartograph_ask mode=code requires `question`.');
  }

  // `question` (non-empty, ≤4096 chars) and `retrieveK` (integer in
  // [4, 30]) were validated at the dispatch boundary by `safeParse` —
  // no defensive clamp / validateString pass needed here.
  const { question, retrieveK } = args;

  const cg = ctx.getCartograph(args.projectPath);
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  // ask uses the ask path (useAskModel: true), so check getAskModel
  // — covers split-provider configs where chat is e.g. a fast local
  // model and askChat is a more capable model for synthesis.
  const askModel = getAskModel(llmConfig);
  if (!askModel) {
    return err(
      'No LLM available for cartograph_ask. Configure config.llm.summarizeLlm (with optional askModel field) or config.llm.askLlm for a separate ask provider; legacy config.llm.chat / config.llm.askChat / flat config.llm.chatModel also work.',
    );
  }

  try {
    const result = await cg.llm.ask(question, { retrieveK });
    const cited = groundCitations(cg, result.answer);
    const output = buildAskOutput(result, cited, askModel);
    return ok(textResult(truncateOutput(output)));
  } catch (error_) {
    return err(errMsg(error_));
  }
}

export const ASK_TOOL = defineTool({
  name: 'cartograph_ask',
  description:
    "LLM family. `mode: 'code'` is natural-language Q&A grounded in retrieved code. `mode: 'local_chat'` delegates bulk prose to the configured local/summarize LLM without code retrieval. " +
    'Hybrid lexical + semantic retrieval feeds the configured ask model. ' +
    'Use code mode for "how does X work?" / "why is this designed this way?"; use local_chat for low-stakes summaries, drafts, or paraphrase checks.',
  schema: askSchema,
  handle: handleAsk,
  bypassFreshnessGate: (args) => args['mode'] === 'local_chat',
});
