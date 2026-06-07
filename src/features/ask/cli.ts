import { errMsg } from '../../errors.js';
import { displayModelName } from '../../llm/display-model.js';
import { buildCitationReport, groundCitations } from './citations.js';
import { RETRIEVE_K_DEFAULT, RETRIEVE_K_MAX, RETRIEVE_K_MIN } from './constants.js';
import {
  type AskCitation,
  type AskOptions,
  parseRetrieveK,
  renderAskAnnotations,
  resolveAskProjectPath,
  validateAskQuestion,
} from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  argument(...args: unknown[]): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

interface AskCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
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
      `Ask a natural-language question about the codebase (requires LLM). The question is capped at 4096 characters.`,
    )
    .argument('<question>', 'Natural-language question about the codebase (capped at 4096 characters).')
    .argument(
      '[path]',
      'Path to a project with .cartograph/ (default: current directory). Equivalent to --project-path.',
    )
    .option('-p, --project-path <path>', 'Project path (alias of the [path] positional)')
    .option(
      '-k, --retrieve-k <n>',
      `Number of candidates to feed the model (default ${RETRIEVE_K_DEFAULT}, range ${RETRIEVE_K_MIN}-${RETRIEVE_K_MAX})`,
    )
    .option('-q, --quiet', 'Print only the answer (no sources block)')
    .action(async (question: string, pathArg: string | undefined, options: AskOptions) => {
      await handleAskCommand({ deps, question, pathArg, options });
    });
}

interface HandleAskCommandArgs {
  deps: AskCommandDeps;
  question: string;
  pathArg: string | undefined;
  options: AskOptions;
}

export async function handleAskCommand({ deps, question, pathArg, options }: HandleAskCommandArgs): Promise<void> {
  const validQuestion = validateAskQuestion(question);
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

      const result = (await cg.llm.ask(question, { retrieveK: retrieveK.value })) as AskResult;
      writeLine(deps, result.answer);
      if (!options.quiet) {
        const lines = await buildAskAnnotationLines({
          cg,
          result,
          askModel: askSetup.askModel,
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

type AskSetupResult = { ok: true; askModel: string } | { ok: false; error: string };

async function resolveAskSetup(cg: any): Promise<AskSetupResult> {
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  const { getChatModel, getAskModel } = await import('../../llm/provider.js');
  const chatModel = getChatModel(llmConfig);
  if (!chatModel) {
    return { ok: false, error: 'No LLM available. Configure config.llm.summarizeLlm in .cartograph/config.json.' };
  }
  return { ok: true, askModel: getAskModel(llmConfig) ?? chatModel };
}

interface BuildAskAnnotationLinesArgs {
  cg: any;
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
