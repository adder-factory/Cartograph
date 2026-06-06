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
  type SessionArgResult,
} from './runtime.js';
import type { Command } from 'commander';

export interface AssignIntArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

export interface SessionCommandDeps {
  sessionCmd: Command;
  attachUnknownActionHandler: (group: Command, family: string) => void;
  assignIntArg: (input: AssignIntArgInput) => boolean;
  error: (message: string) => void;
  runViaMCP: (toolName: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
}

async function runSessionCall(
  result: SessionArgResult,
  projectPath: string | undefined,
  deps: SessionCommandDeps,
): Promise<void> {
  if (!result.ok) {
    deps.error(result.error);
    process.exitCode = 1;
    return;
  }
  await deps.runViaMCP('cartograph_session', result.args, projectPath);
}

export function registerSessionCommand(deps: SessionCommandDeps): void {
  registerCreateCommand(deps);
  registerResumeCommand(deps);
  registerAuditCommand(deps);
  registerListCommand(deps);
  registerDeleteCommand(deps);
  registerMacroSaveCommand(deps);
  registerMacroRunCommand(deps);
  registerMacroListCommand(deps);
  registerMacroDeleteCommand(deps);
  deps.attachUnknownActionHandler(deps.sessionCmd, 'session');
}

function registerCreateCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('create')
    .description("Create a new labelled session (mirrors cartograph_session({action:'create'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('-l, --label <label>', 'Human-readable session label')
    .action(async (options: { projectPath?: string; label?: string }) => {
      await runSessionCall(buildCreateSessionArgs(options), options.projectPath, deps);
    });
}

function registerResumeCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('resume [id]')
    .description(
      "Resume a prior session — render a compact summary of its tool calls (mirrors cartograph_session({action:'resume'}))",
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('--id <id>', 'Session id to resume (alternative to the positional id)')
    .option('-l, --label <label>', 'Session label to resume (alternative to --id)')
    .action(async (idArg: string | undefined, options: { projectPath?: string; id?: string; label?: string }) => {
      await runSessionCall(buildResumeSessionArgs(idArg, options), options.projectPath, deps);
    });
}

function registerAuditCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('audit [id]')
    .description(
      "Audit a prior session's tool-use pattern, repeated calls, and missed close-out steps (mirrors cartograph_session({action:'audit'}))",
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('--id <id>', 'Session id to audit (alternative to the positional id)')
    .option('-l, --label <label>', 'Session label to audit (alternative to --id)')
    .action(async (idArg: string | undefined, options: { projectPath?: string; id?: string; label?: string }) => {
      await runSessionCall(buildAuditSessionArgs(idArg, options), options.projectPath, deps);
    });
}

function registerListCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('list')
    .description("List recent sessions, newest first (mirrors cartograph_session({action:'list'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('-l, --limit <n>', 'Max sessions to return (default 20)', '20')
    .action(async (options: { projectPath?: string; limit?: string }) => {
      const parsed: Record<string, unknown> = {};
      if (!deps.assignIntArg({ args: parsed, key: 'limit', raw: options.limit, optionName: '--limit' })) return;
      const listOptions: { limit?: number } = {};
      if (typeof parsed['limit'] === 'number') listOptions.limit = parsed['limit'];
      await runSessionCall(buildListSessionArgs(listOptions), options.projectPath, deps);
    });
}

function registerDeleteCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('delete')
    .description("Delete a session row and its recorded tool calls (mirrors cartograph_session({action:'delete'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('--id <id>', 'Session id to delete')
    .option('-l, --label <label>', 'Session label to delete (alternative to --id)')
    .action(async (options: { projectPath?: string; id?: string; label?: string }) => {
      await runSessionCall(buildDeleteSessionArgs(options), options.projectPath, deps);
    });
}

function registerMacroSaveCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('macro_save')
    .alias('macro-save')
    .description("Save a named macro recipe of tool steps (mirrors cartograph_session({action:'macro_save'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('-n, --name <name>', 'Macro name')
    .option('-s, --steps <json>', 'JSON array of {tool, args} steps')
    .action(async (options: { projectPath?: string; name?: string; steps?: string }) => {
      await runSessionCall(buildMacroSaveArgs(options), options.projectPath, deps);
    });
}

function registerMacroRunCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('macro_run')
    .alias('macro-run')
    .description("Replay a saved macro recipe (mirrors cartograph_session({action:'macro_run'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('-n, --name <name>', 'Macro name to run')
    .option('-a, --args <json>', 'JSON array of positional substitution values (replaces ${0}, ${1}, … in step args)')
    .action(async (options: { projectPath?: string; name?: string; args?: string }) => {
      await runSessionCall(buildMacroRunArgs(options), options.projectPath, deps);
    });
}

function registerMacroListCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('macro_list')
    .alias('macro-list')
    .description("List saved macro recipes (mirrors cartograph_session({action:'macro_list'}))")
    .option('-p, --project-path <path>', 'Project path')
    .action(async (options: { projectPath?: string }) => {
      await runSessionCall(buildMacroListArgs(), options.projectPath, deps);
    });
}

function registerMacroDeleteCommand(deps: SessionCommandDeps): void {
  const { sessionCmd } = deps;

  sessionCmd
    .command('macro_delete')
    .alias('macro-delete')
    .description("Delete a saved macro recipe (mirrors cartograph_session({action:'macro_delete'}))")
    .option('-p, --project-path <path>', 'Project path')
    .option('-n, --name <name>', 'Macro name to delete')
    .action(async (options: { projectPath?: string; name?: string }) => {
      await runSessionCall(buildMacroDeleteArgs(options), options.projectPath, deps);
    });
}
