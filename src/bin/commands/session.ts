/**
 * `cartograph session` family subcommands — extracted from the
 * bin/cartograph.ts decomposition; side-effecting module: importing it
 * registers the commands on `sessionCmd`.
 */
import { sessionCmd, attachUnknownActionHandler, error, assignIntArg, runViaMCP } from '../_cli-core.js';

sessionCmd
  .command('create')
  .description("Create a new labelled session (mirrors cartograph_session({action:'create'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('-l, --label <label>', 'Human-readable session label')
  .action(async (options: { projectPath?: string; label?: string }) => {
    const args: Record<string, unknown> = { action: 'create' };
    if (options.label) args['label'] = options.label;
    await runViaMCP('cartograph_session', args, options.projectPath);
  });

sessionCmd
  .command('resume [id]')
  .description(
    "Resume a prior session — render a compact summary of its tool calls (mirrors cartograph_session({action:'resume'}))",
  )
  .option('-p, --project-path <path>', 'Project path')
  .option('--id <id>', 'Session id to resume (alternative to the positional id)')
  .option('-l, --label <label>', 'Session label to resume (alternative to --id)')
  .action(async (idArg: string | undefined, options: { projectPath?: string; id?: string; label?: string }) => {
    // Positional `id` is sugar for --id (CLAUDE.md documents
    // `session resume <id>`); the explicit --id flag wins on conflict.
    const id = options.id ?? idArg;
    const args: Record<string, unknown> = { action: 'resume' };
    if (id) args['id'] = id;
    if (options.label) args['label'] = options.label;
    if (!id && !options.label) {
      error('session resume: pass a session id positionally, via --id, or a --label.');
      process.exitCode = 1;
      return;
    }
    await runViaMCP('cartograph_session', args, options.projectPath);
  });

sessionCmd
  .command('list')
  .description("List recent sessions, newest first (mirrors cartograph_session({action:'list'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('-l, --limit <n>', 'Max sessions to return (default 20)', '20')
  .action(async (options: { projectPath?: string; limit?: string }) => {
    const args: Record<string, unknown> = { action: 'list' };
    if (!assignIntArg({ args, key: 'limit', raw: options.limit, optionName: '--limit' })) return;
    await runViaMCP('cartograph_session', args, options.projectPath);
  });

sessionCmd
  .command('delete')
  .description("Delete a session row and its recorded tool calls (mirrors cartograph_session({action:'delete'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('--id <id>', 'Session id to delete')
  .option('-l, --label <label>', 'Session label to delete (alternative to --id)')
  .action(async (options: { projectPath?: string; id?: string; label?: string }) => {
    const args: Record<string, unknown> = { action: 'delete' };
    if (options.id) args['id'] = options.id;
    if (options.label) args['label'] = options.label;
    await runViaMCP('cartograph_session', args, options.projectPath);
  });

sessionCmd
  .command('macro_save')
  .alias('macro-save')
  .description("Save a named macro recipe of tool steps (mirrors cartograph_session({action:'macro_save'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('-n, --name <name>', 'Macro name')
  .option('-s, --steps <json>', 'JSON array of {tool, args} steps')
  .action(async (options: { projectPath?: string; name?: string; steps?: string }) => {
    if (!options.name) {
      error('macro_save: --name is required');
      process.exit(1);
    }
    if (!options.steps) {
      error('macro_save: --steps <json> is required');
      process.exit(1);
    }
    let steps: unknown;
    try {
      steps = JSON.parse(options.steps);
    } catch {
      error('macro_save: --steps must be valid JSON');
      process.exit(1);
    }
    await runViaMCP('cartograph_session', { action: 'macro_save', name: options.name, steps }, options.projectPath);
  });

sessionCmd
  .command('macro_run')
  .alias('macro-run')
  .description("Replay a saved macro recipe (mirrors cartograph_session({action:'macro_run'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('-n, --name <name>', 'Macro name to run')
  .option('-a, --args <json>', 'JSON array of positional substitution values (replaces ${0}, ${1}, … in step args)')
  .action(async (options: { projectPath?: string; name?: string; args?: string }) => {
    if (!options.name) {
      error('macro_run: --name is required');
      process.exit(1);
    }
    const mcpArgs: Record<string, unknown> = { action: 'macro_run', name: options.name };
    if (options.args) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(options.args);
      } catch {
        error('macro_run: --args must be valid JSON');
        process.exit(1);
      }
      mcpArgs['args'] = parsedArgs;
    }
    await runViaMCP('cartograph_session', mcpArgs, options.projectPath);
  });

sessionCmd
  .command('macro_list')
  .alias('macro-list')
  .description("List saved macro recipes (mirrors cartograph_session({action:'macro_list'}))")
  .option('-p, --project-path <path>', 'Project path')
  .action(async (options: { projectPath?: string }) => {
    await runViaMCP('cartograph_session', { action: 'macro_list' }, options.projectPath);
  });

sessionCmd
  .command('macro_delete')
  .alias('macro-delete')
  .description("Delete a saved macro recipe (mirrors cartograph_session({action:'macro_delete'}))")
  .option('-p, --project-path <path>', 'Project path')
  .option('-n, --name <name>', 'Macro name to delete')
  .action(async (options: { projectPath?: string; name?: string }) => {
    if (!options.name) {
      error('macro_delete: --name is required');
      process.exit(1);
    }
    await runViaMCP('cartograph_session', { action: 'macro_delete', name: options.name }, options.projectPath);
  });

attachUnknownActionHandler(sessionCmd, 'session');
