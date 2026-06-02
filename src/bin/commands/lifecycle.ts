/**
 * Lifecycle / utility CLI commands (serve / install / playbook /
 * trace-to-culprits / viewer / llm setup) — extracted from the
 * bin/cartograph.ts decomposition; side-effecting module: importing it
 * registers the commands.
 */
import { isInitialized } from '../../directory.js';
import { compact } from '../../utils.js';
import { errMsg } from '../../errors.js';
import {
  program,
  llmCmd,
  chalk,
  resolveProjectPath,
  error,
  info,
  assignIntArg,
  runViaMCP,
  loadCartograph,
} from '../_cli-core.js';

/**
 * cartograph serve
 */
program
  .command('serve')
  .description('Start Cartograph as an MCP server for AI assistants')
  .option('-p, --project-path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
  .option('--mcp', 'Run as MCP server (stdio transport)')
  .option(
    '--no-write-tools',
    'Disable write-class tools (cartograph_admin / _summaries / _coverage / _session / _note). Use for sandboxed read-only agents.',
  )
  .option(
    '--allow-stale-default',
    'Default `allowStale: true` for tool calls that do not pass it explicitly. Useful in fast-iteration sessions.',
  )
  .option(
    '--disable-tool <name...>',
    'Disable specific tools by name. Repeatable: `--disable-tool cartograph_ask --disable-tool cartograph_dead_code`.',
  )
  .option(
    '--no-startup-sync',
    'Skip the catch-up sync that normally runs once when the server opens its default project. Use only when boot-time sync cost is unacceptable (very large repos with frequent restarts).',
  )
  .action(
    async (options: {
      projectPath?: string;
      mcp?: boolean;
      writeTools?: boolean; // commander auto-inverts `--no-write-tools` → writeTools=false
      allowStaleDefault?: boolean;
      disableTool?: string[];
      startupSync?: boolean; // commander auto-inverts `--no-startup-sync` → startupSync=false
    }) => {
      const projectPath = options.projectPath ? resolveProjectPath(options.projectPath) : undefined;

      try {
        if (options.mcp) {
          // Start MCP server - it handles initialization lazily based on rootUri from client
          const { MCPServer } = await import('../../mcp/index.js');
          const server = new MCPServer({
            projectPath,
            // commander's `--no-write-tools` makes `writeTools` false when set;
            // omitted leaves it undefined which we treat as "writes enabled".
            disableWriteTools: options.writeTools === false,
            allowStaleDefault: options.allowStaleDefault === true,
            disabledTools:
              options.disableTool && options.disableTool.length > 0 ? new Set(options.disableTool) : undefined,
            disableStartupSync: options.startupSync === false,
          });
          await server.start();
          // Server will run until terminated
        } else {
          // Default: show info about MCP mode.
          // Use stderr so stdout stays clean for any piped/stdio usage.
          console.error(chalk.bold('\nCartograph MCP Server\n'));
          console.error(chalk.blue('ℹ') + ' Use --mcp flag to start the MCP server');
          console.error('\nTo use with Claude Code, add to your MCP configuration:');
          console.error(
            chalk.dim(`
{
  "mcpServers": {
    "cartograph": {
      "command": "cartograph",
      "args": ["serve", "--mcp"]
    }
  }
}
`),
          );
          console.error('Available tools:');
          console.error(
            chalk.cyan('  cartograph_find') +
              '      - Find symbols / regex / env / sql in one tool (by=name|content|env|sql)',
          );
          console.error(chalk.cyan('  cartograph_context') + '   - Build context for a task');
          console.error(
            chalk.cyan('  cartograph_graph') + '     - Navigate the graph (callers / callees / impact / walk)',
          );
          console.error(chalk.cyan('  cartograph_node') + '      - Get symbol details');
          console.error(chalk.cyan('  cartograph_files') + '     - Get project file structure');
          console.error(chalk.cyan('  cartograph_status') + '    - Get index status');
        }
      } catch (err) {
        error(`Failed to start server: ${errMsg(err)}`);
        process.exit(1);
      }
    },
  );

/**
 * cartograph install
 */
program
  .command('install')
  .description(
    'Install cartograph MCP server into one or more agents (Claude Code, Cursor, Codex CLI, opencode, Hermes, Gemini CLI, Antigravity, Kiro)',
  )
  .option('-t, --target <ids>', 'Target agent(s): comma-separated ids, or "auto"|"all"|"none". Default: prompt')
  .option('-l, --location <where>', 'Install location: "global" or "local". Default: prompt')
  .option('-y, --yes', 'Non-interactive: defaults to --location=global --target=auto, auto-allow on')
  .option('--no-permissions', 'Skip writing the auto-allow permissions list (Claude Code only)')
  .option('--print-config <id>', 'Print MCP config snippet for the named agent and exit (no file writes)')
  .action(
    async (opts: {
      target?: string;
      location?: string;
      yes?: boolean;
      permissions?: boolean;
      printConfig?: string;
    }) => {
      if (opts.printConfig) {
        const { getTarget, listTargetIds } = await import('../../installer/targets/registry.js');
        const target = getTarget(opts.printConfig);
        if (!target) {
          const known = listTargetIds().join(', ');
          error(`Unknown target "${opts.printConfig}". Known: ${known}.`);
          process.exit(1);
        }
        const loc = opts.location === 'local' ? 'local' : 'global';
        process.stdout.write(target.printConfig(loc));
        return;
      }

      const { runInstallerWithOptions } = await import('../../installer/index.js');
      if (opts.location && opts.location !== 'global' && opts.location !== 'local') {
        error(`--location must be "global" or "local" (got "${opts.location}").`);
        process.exit(1);
      }
      try {
        // Commander's `--no-permissions` makes `opts.permissions === false`;
        // omitting the flag leaves it `true` (the positive-form default).
        // We MUST treat the default-true as "user did not override — let
        // the orchestrator prompt" and only forward an explicit `false`
        // (or `true` when --yes implies it). Otherwise the auto-allow
        // prompt is silently skipped on every interactive run.
        const explicitNoPermissions = opts.permissions === false;
        let autoAllow: boolean | undefined;
        if (explicitNoPermissions) {
          autoAllow = false;
        } else if (opts.yes) {
          autoAllow = true;
        }

        await runInstallerWithOptions(
          compact({
            target: opts.target,
            location: opts.location as 'global' | 'local' | undefined,
            autoAllow,
            yes: opts.yes,
          }),
        );
      } catch (err) {
        error(errMsg(err));
        process.exit(1);
      }
    },
  );

// `llm setup` is the only remaining LLM provisioning command. Kept
// as a subcommand under `llm` so the surface stays extensible (e.g.
// future `llm test`, `llm list-models`) without renaming.
// `llmCmd` is the family-parent command — defined in `_cli-core.ts`.
llmCmd
  .command('setup [path]')
  .description('Interactive LLM provider setup — picks chat + embeddings backends and writes them into config.json')
  .action(async (pathArg: string | undefined) => {
    const { runLlmSetupCli } = await import('../../installer/llm-setup-cli.js');
    await runLlmSetupCli(pathArg);
  });

program
  .command('trace-to-culprits')
  .description(
    'Pipe a stack trace into cartograph and get a ranked list of likely fix-site candidates (mirrors cartograph_trace_to_culprits MCP tool). Reads the trace from stdin (or pass --trace).',
  )
  .option('-p, --project-path <path>', 'Project path')
  .option('-l, --limit <n>', 'Maximum culprits to return (default 10, max 50)')
  .option('-t, --trace <text>', 'Trace text inline (default: read from stdin)')
  .action(async (options: { projectPath?: string; limit?: string; trace?: string }) => {
    let trace = options.trace;
    if (!trace) {
      // stdin slurp — typical usage `cat error.log | cartograph trace-to-culprits`.
      const chunks: Buffer[] = [];
      for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
      trace = Buffer.concat(chunks).toString('utf8');
    }
    if (!trace.trim()) {
      console.error('No trace provided. Pipe a stack trace to stdin or pass --trace "<text>".');
      process.exit(2);
    }
    const args: Record<string, unknown> = { trace };
    if (!assignIntArg({ args, key: 'limit', raw: options.limit, optionName: '--limit', opts: { min: 1 } })) return;
    await runViaMCP('cartograph_trace_to_culprits', args, options.projectPath);
  });

program
  .command('playbook')
  .description('Print the cartograph tool playbook (mirrors cartograph_playbook MCP tool)')
  .action(async () => {
    // Playbook is project-agnostic — bypass runViaMCP (which requires an
    // initialized project) and dispatch directly with a null cg, the
    // same way the MCP server treats `cartograph_playbook` calls before
    // any project is open.
    const { ToolHandler } = await import('../../mcp/tools.js');
    const handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_playbook', {});
    handler.closeAll();
    console.log(result.content[0]?.text ?? '');
    if (result.isError) process.exit(1);
  });

program
  .command('viewer [path]')
  .description('Open the local web viewer for the indexed graph')
  .option('-p, --port <n>', `HTTP port (default 8765; pass 0 for an OS-picked port)`)
  .option('--no-open', 'Do not auto-open the URL in a browser')
  .action(async (pathArg: string | undefined, options: { port?: string; open?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);
    if (!isInitialized(projectPath)) {
      error(
        `No Cartograph index at ${projectPath}. Run \`cartograph admin init\` and \`cartograph admin index\` first.`,
      );
      process.exit(1);
    }
    const { startViewerServer, openInBrowser } = await import('../../viewer/server.js');
    let port: number | undefined;
    if (options.port !== undefined) {
      port = Number.parseInt(options.port, 10);
      if (!Number.isFinite(port)) {
        error(`Invalid value for --port: "${options.port}" is not a number`);
        process.exitCode = 1;
        return;
      }
    }
    try {
      const handle = await startViewerServer(projectPath, port === undefined ? {} : { port });
      info(`Viewer running at ${handle.url}`);
      info(`  project: ${projectPath}`);
      info(`  press Ctrl+C to stop`);
      // commander auto-inverts `--no-open` → options.open === false
      if (options.open !== false) openInBrowser(handle.url);
      // Park forever — keep the process alive until the user kills it.
      process.on('SIGINT', () => {
        handle.close().finally(() => process.exit(0));
      });
    } catch (err) {
      error(`Failed to start viewer: ${errMsg(err)}`);
      process.exit(1);
    }
  });

/**
 * cartograph doctor [path]
 *
 * Diagnose the install state: Bun runtime, native shim, models,
 * project init, project config. Each gap prints a concrete next-step.
 * The first thing a user should run when something doesn't work.
 *
 * Direct implementation rather than runViaMCP because the checks are
 * filesystem + process state, no live MCP server needed (and you'd
 * want doctor to work BEFORE the MCP can serve).
 */
program
  .command('doctor [path]')
  .description(
    'Diagnose install state (Bun, models, project init/config, detected LLM backends, embedding endpoint reachability) with actionable next steps. Pass `--fix` to auto-apply remediations.',
  )
  .option('--no-project-checks', 'Skip the project-init + config checks (useful for fresh-install verification).')
  .option(
    '--fix',
    'Auto-apply remediations for fixable gaps (creates `.cartograph/`, downloads models, writes a recommended LLM config). Re-runs checks after applying. Backend-not-running gaps remain manual.',
  )
  .action(async (pathArg: string | undefined, options: { projectChecks?: boolean; fix?: boolean }) => {
    const { runDoctor, formatDoctorReport } = await import('../../installer/doctor.js');
    const skip = options.projectChecks === false;
    const result = await runDoctor({
      ...(pathArg ? { projectPath: pathArg } : {}),
      skipProjectChecks: skip,
      fix: options.fix === true,
    });
    console.log(formatDoctorReport(result));
    // When --fix ran, exit on the AFTER-fix status (the user cares
    // whether the system is healthy now, not whether it was broken
    // before the fix). Otherwise use the pre-fix status.
    const finalStatus = result.afterFix?.overallStatus ?? result.overallStatus;
    if (finalStatus === 'fail') process.exit(1);
  });

/**
 * cartograph setup [path]
 *
 * One-shot bootstrap for first-time users. Runs:
 *   1. admin init (if .cartograph/ missing)
 *   2. install-models (if no GGUFs present; honors --minimal — used
 *      with a llama-server pointing at the downloaded GGUFs)
 *   3. doctor (final verification — surfaces missing HTTP backend)
 *
 * Idempotent — each step skips when its precondition is already met,
 * so re-running setup on a partially-installed environment is safe.
 *
 * Pre-2026-05-24c this also ran an `install-shim` step for the
 * in-process libcgshim pathway; that pathway was deleted in step 4c
 * of the LLM HTTP migration. Setup now assumes the user runs
 * `llama-server` (or another OpenAI-compat backend) themselves — the
 * doctor step prints a remediation line with the exact command if
 * not detected.
 *
 * Direct implementation rather than runViaMCP because setup runs
 * BEFORE the MCP server is reachable.
 */
program
  .command('setup [path]')
  .description('One-shot bootstrap: admin init + install-models + doctor. Each step skips when already satisfied.')
  .option('--minimal', 'Install only the smallest viable model subset (embed + 3B chat) instead of the full set.')
  .option('--no-models', 'Skip the install-models step (use when models are already present).')
  .action(async (pathArg: string | undefined, options: { minimal?: boolean; models?: boolean }) => {
    const projectPath = resolveProjectPath(pathArg);
    const { runDoctor, formatDoctorReport } = await import('../../installer/doctor.js');

    await runSetupInitStep(projectPath);
    await runSetupModelStep(projectPath, options);
    info('Step 3/3: running doctor verification');
    const result = await runDoctor({ projectPath });
    console.log('\n' + formatDoctorReport(result));
    if (result.overallStatus === 'fail') process.exit(1);
  });

async function runSetupInitStep(projectPath: string): Promise<void> {
  if (isInitialized(projectPath)) {
    info(`Step 1/3: ${projectPath} already initialized — skipping init`);
    return;
  }

  info(`Step 1/3: initialising Cartograph at ${projectPath}`);
  const { default: Cartograph } = await loadCartograph();
  const cg = await Cartograph.init(projectPath, { index: false });
  cg.close();
}

async function runSetupModelStep(projectPath: string, options: { minimal?: boolean; models?: boolean }): Promise<void> {
  if (options.models === false) {
    info('Step 2/3: --no-models → skipping models install');
    return;
  }

  info(`Step 2/3: installing ${options.minimal ? 'minimal' : 'full'} GGUF set`);
  const { installRecommendedModels } = await import('../../installer/install-models.js');
  const { RECOMMENDED_MODELS, MINIMAL_MODELS } = await import('../../llm/recommended-models.js');
  const modelSet = options.minimal ? MINIMAL_MODELS : RECOMMENDED_MODELS;
  try {
    const result = await installRecommendedModels({
      models: modelSet,
      onProgress: ({ model, downloaded, total }) => {
        const mb = (n: number): string => (n / BYTES_PER_MIB).toFixed(0);
        const pct = total > 0 ? ((downloaded / total) * PERCENT_SCALE).toFixed(0) : '?';
        process.stderr.write(`\r  ${model.filename}: ${mb(downloaded)}/${total > 0 ? mb(total) : '?'} MB (${pct}%)   `);
      },
    });
    process.stderr.write('\n');
    if (result.downloaded.length > 0) info(`  downloaded ${result.downloaded.length} GGUF(s)`);
    if (result.skipped.length > 0) info(`  ${result.skipped.length} already present (skipped)`);
    await writeSetupRecommendedConfig(projectPath);
  } catch (error_) {
    error(`install-models failed: ${errMsg(error_)}`);
    // models are needed for LLM features, but the user might already
    // have a working subset from a prior run. doctor will catch a true gap.
  }
}

const BYTES_PER_MIB = 1024 * 1024;
const PERCENT_SCALE = 100;

async function writeSetupRecommendedConfig(projectPath: string): Promise<void> {
  const { writeRecommendedLlmConfig } = await import('../../installer/recommended-config.js');
  const writeOpts: { projectRoot: string; dir?: string } = { projectRoot: projectPath };
  const { configPath, backupPath } = writeRecommendedLlmConfig(writeOpts);
  info(`  wrote recommended LLM config: ${configPath}`);
  if (backupPath) info(`  backup written: ${backupPath}`);
}
