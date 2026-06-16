import { errMsg } from '../../errors.js';
import { displayModelName } from '../../llm/display-model.js';
import { llmLocalChat } from '../../cartograph-llm-service.js';
import { buildCitationReport, groundCitations } from './citations.js';
import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MAX, RETRIEVE_K_MIN } from './constants.js';
import {
  type AskCitation,
  type AskOptions,
  parseAskMode,
  parseMaxTokens,
  parseRetrieveK,
  renderAskAnnotations,
  resolveAskProjectPath,
  resolveLocalChatPrompt,
  validateLocalChatPrompt,
  validateAskQuestion,
} from './runtime.js';
import { chatOverrideFromOptions } from '../shared/cli-args.js';
import type { CliArgumentOptionCommand } from '../shared/cli-command.js';
import type Cartograph from '../../index.js';

type CommandLike = CliArgumentOptionCommand;

interface AskCartographModule {
  default: {
    open: (projectPath: string) => Promise<Cartograph>;
  };
}

interface AskResult {
  answer: string;
  citations: AskCitation[];
  retrieveMs: number;
  chatMs: number;
}

export interface AskCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<AskCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  writeLine?: (message?: string) => void;
  dim?: (line: string) => string;
}

export function registerAskCommand(deps: AskCommandDeps): void {
  deps.program
    .command('ask')
    .description(
      `Ask with an LLM. Default code mode answers codebase questions; local_chat mode delegates bulk prose without code retrieval.`,
    )
    .argument(
      '[question]',
      'Natural-language question about the codebase (capped at 4096 characters). In local_chat mode, used as the prompt when --prompt is omitted.',
    )
    .argument(
      '[path]',
      'Path to a project with .cartograph/ (default: current directory). Equivalent to --project-path.',
    )
    .option('--mode <mode>', '`code` (default) or `local_chat` (bulk prose without code retrieval)', 'code')
    .option('--prompt <prompt>', '(mode=local_chat) Prompt to send to the local/summarize backend')
    .option('-p, --project-path <path>', 'Project path (alias of the [path] positional)')
    .option(
      '-k, --retrieve-k <n>',
      `Number of candidates to feed the model (default ${RETRIEVE_K_DEFAULT}, range ${RETRIEVE_K_MIN}-${RETRIEVE_K_MAX})`,
    )
    .option('-s, --system <message>', "(mode=local_chat) Optional system message shaping the local model's behavior")
    .option('--max-tokens <n>', '(mode=local_chat) Positive-integer cap on output tokens')
    .option(
      '--model <path>',
      '(mode=code) Override the ask model for THIS call only — A/B-test models without editing config or restarting the backend.',
    )
    .option(
      '--endpoint <url>',
      '(mode=code) Override the ask endpoint for THIS call only (implies an openai-compat HTTP backend).',
    )
    .option('-q, --quiet', 'Code mode: print only the answer. Local-chat mode: suppress the model/timing trailer')
    .action(async (question: string | undefined, pathArg: string | undefined, options: AskOptions) => {
      await handleAskCommand({ deps, question, pathArg, options });
    });
}

interface HandleAskCommandArgs {
  deps: AskCommandDeps;
  question: string | undefined;
  pathArg: string | undefined;
  options: AskOptions;
}

export async function handleAskCommand({ deps, question, pathArg, options }: HandleAskCommandArgs): Promise<void> {
  const mode = parseAskMode(options.mode);
  if (!mode.ok) {
    deps.error(mode.error);
    process.exitCode = 1;
    return;
  }

  if (mode.value === 'local_chat') {
    await handleLocalChatAskCommand({ deps, promptArg: question, pathArg, options });
    return;
  }

  const validQuestion = validateAskQuestion(question ?? '');
  if (!validQuestion.ok) {
    deps.error(validQuestion.error);
    process.exitCode = 1;
    return;
  }

  const projectPath = deps.resolveProjectPath(resolveAskProjectPath(pathArg, options));
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const askSetup = await resolveAskSetup(cg);
      if (!askSetup.ok) {
        deps.error(askSetup.error);
        process.exitCode = 1;
        return;
      }
      const retrieveK = parseRetrieveK(options.retrieveK);
      if (!retrieveK.ok) {
        deps.error(retrieveK.error);
        process.exitCode = 1;
        return;
      }

      const chatOverride = chatOverrideFromOptions(options);
      const result = (await cg.llm.ask(question ?? '', {
        retrieveK: retrieveK.value,
        ...(chatOverride ? { chatOverride } : {}),
      })) as AskResult;
      writeLine(deps, result.answer);
      if (!options.quiet) {
        const lines = await buildAskAnnotationLines({
          cg,
          result,
          // Reflect the per-call override in the trailer so A/B results
          // are labelled with the model that actually answered.
          askModel: chatOverride?.model ?? askSetup.askModel,
          ...(deps.dim ? { dim: deps.dim } : {}),
        });
        for (const line of lines) writeLine(deps, line);
      }
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to answer: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

interface HandleLocalChatAskCommandArgs {
  deps: AskCommandDeps;
  promptArg: string | undefined;
  pathArg: string | undefined;
  options: AskOptions;
}

async function handleLocalChatAskCommand({
  deps,
  promptArg,
  pathArg,
  options,
}: HandleLocalChatAskCommandArgs): Promise<void> {
  if (options.model !== undefined || options.endpoint !== undefined) {
    deps.error('Note: --model / --endpoint apply to code mode only and are ignored in --mode local_chat.');
  }
  const prompt = resolveLocalChatPrompt(promptArg, options);
  const validPrompt = validateLocalChatPrompt(prompt ?? '');
  if (!validPrompt.ok) {
    deps.error(validPrompt.error);
    process.exitCode = 1;
    return;
  }
  const maxTokens = parseMaxTokens(options.maxTokens);
  if (!maxTokens.ok) {
    deps.error(maxTokens.error);
    process.exitCode = 1;
    return;
  }

  const projectPath = deps.resolveProjectPath(resolveAskProjectPath(pathArg, options));
  try {
    if (!deps.isInitialized(projectPath)) {
      deps.error(`Cartograph not initialized in ${projectPath}`);
      process.exitCode = 1;
      return;
    }

    const { default: Cartograph } = await deps.loadCartograph();
    const cg = await Cartograph.open(projectPath);
    try {
      const result = await llmLocalChat(cg.llm, {
        prompt: prompt ?? '',
        ...(options.system ? { system: options.system } : {}),
        ...(maxTokens.value === undefined ? {} : { maxTokens: maxTokens.value }),
      });
      writeLine(deps, result.text);
      if (!options.quiet) {
        writeLine(deps);
        writeLine(deps, `local-chat: ${displayModelName(result.model)} · ${Math.round(result.durationMs)}ms`);
      }
    } finally {
      cg.close();
    }
  } catch (err) {
    deps.error(`Failed to answer: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

type AskSetupResult = { ok: true; askModel: string } | { ok: false; error: string };

async function resolveAskSetup(cg: Cartograph): Promise<AskSetupResult> {
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  const { getChatModel, getAskModel } = await import('../../llm/provider.js');
  const chatModel = getChatModel(llmConfig);
  if (!chatModel) {
    return { ok: false, error: 'No LLM available. Configure config.llm.summarizeLlm in .cartograph/config.json.' };
  }
  return { ok: true, askModel: getAskModel(llmConfig) ?? chatModel };
}

interface BuildAskAnnotationLinesArgs {
  cg: Cartograph;
  result: AskResult;
  askModel: string;
  dim?: (line: string) => string;
}

async function buildAskAnnotationLines({ cg, result, askModel, dim }: BuildAskAnnotationLinesArgs): Promise<string[]> {
  const cited = groundCitations(cg, result.answer);
  const report = buildCitationReport(cited);
  return renderAskAnnotations({
    citationSections: report.sections,
    citations: result.citations,
    retrieveMs: result.retrieveMs,
    chatMs: result.chatMs,
    modelDisplayName: displayModelName(askModel),
    counter: report.counter,
    ...(dim ? { dim } : {}),
  });
}

function writeLine(deps: Pick<AskCommandDeps, 'writeLine'>, message = ''): void {
  if (deps.writeLine) {
    deps.writeLine(message);
    return;
  }
  process.stdout.write(`${message}\n`);
}
