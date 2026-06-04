/**
 * Lifecycle / utility CLI commands (serve / install / playbook /
 * trace-to-culprits / viewer / llm setup) — extracted from the
 * bin/cartograph.ts decomposition; side-effecting module: importing it
 * registers the commands.
 */
import { isInitialized as defaultIsInitialized } from '../../directory.js';
import { compact as defaultCompact } from '../../utils.js';
import { errMsg } from '../../errors.js';
import {
  program as cliProgram,
  llmCmd as cliLlmCmd,
  chalk as cliChalk,
  resolveProjectPath as cliResolveProjectPath,
  error as cliError,
  info as cliInfo,
  assignIntArg as cliAssignIntArg,
  runViaMCP as cliRunViaMCP,
  loadCartograph as cliLoadCartograph,
} from '../_cli-core.js';
import {
  DEFAULT_MCP_SERVER_PROFILE,
  MCP_SERVER_PROFILE_DESCRIPTION,
  MCP_SERVER_PROFILE_NAMES,
  isMcpServerProfile,
  type McpServerProfile,
} from '../../mcp/profiles.js';
import type { McpLoadBudgetReport, MeasureMcpLoadBudgetOptions } from '../../mcp/load-budget.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

interface SetupCartographModule {
  default: {
    init: (projectPath: string, options: { index: boolean }) => Promise<{ close: () => void }>;
  };
}

interface DoctorResult {
  overallStatus: string;
  afterFix?: { overallStatus: string };
}

interface ServeCommandOptions {
  projectPath?: string;
  mcp?: boolean;
  profile?: string;
  writeTools?: boolean; // commander auto-inverts `--no-write-tools` → writeTools=false
  allowStaleDefault?: boolean;
  lowTokensDefault?: boolean;
  disableTool?: string[];
  startupSync?: boolean; // commander auto-inverts `--no-startup-sync` → startupSync=false
}

interface McpBudgetCommandOptions {
  profile?: string;
  writeTools?: boolean; // commander auto-inverts `--no-write-tools` → writeTools=false
  disableTool?: string[];
  top?: string;
  json?: boolean;
}

interface LifecycleCommandDeps {
  program: CommandLike;
  llmCmd: CommandLike;
  chalk: {
    bold: (s: string) => string;
    blue: (s: string) => string;
    dim: (s: string) => string;
    cyan: (s: string) => string;
  };
  resolveProjectPath: (pathArg?: string) => string;
  error: (message: string) => void;
  info: (message: string) => void;
  writeStdout: (message?: string) => void;
  writeStderr: (message?: string) => void;
  assignIntArg: (args: AssignNumericArgInput) => boolean;
  runViaMCP: (tool: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
  loadCartograph: () => Promise<SetupCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  compact: typeof defaultCompact;
  loadMcpServer: () => Promise<{ MCPServer: new (opts: unknown) => { start: () => Promise<void> } }>;
  loadInstallerTargets: () => Promise<{
    getTarget: (id: string) => { printConfig: (location: string) => string } | null | undefined;
    listTargetIds: () => string[];
  }>;
  loadInstaller: () => Promise<{ runInstallerWithOptions: (opts: unknown) => Promise<void> }>;
  loadLlmSetupCli: () => Promise<{ runLlmSetupCli: (pathArg?: string) => Promise<void> }>;
  loadToolHandler: () => Promise<{
    ToolHandler: new (
      cg: null,
    ) => {
      execute: (
        tool: string,
        args: Record<string, unknown>,
      ) => Promise<{
        content: Array<{ text?: string }>;
        isError?: boolean;
      }>;
      closeAll: () => void;
    };
  }>;
  loadMcpLoadBudget: () => Promise<{
    measureMcpLoadBudget: (cg?: null, options?: MeasureMcpLoadBudgetOptions) => McpLoadBudgetReport;
    formatMcpLoadBudgetReport: (report: McpLoadBudgetReport) => string;
  }>;
  loadViewerServer: () => Promise<{
    startViewerServer: (
      projectPath: string,
      opts?: { port?: number },
    ) => Promise<{ url: string; close: () => Promise<void> }>;
    openInBrowser: (url: string) => void;
  }>;
  loadDoctor: () => Promise<{
    runDoctor: (opts: Record<string, unknown>) => Promise<DoctorResult>;
    formatDoctorReport: (result: unknown) => string;
  }>;
  loadInstallModels: () => Promise<{
    installRecommendedModels: (opts: {
      models: readonly unknown[];
      onProgress: (progress: { model: { filename: string }; downloaded: number; total: number }) => void;
    }) => Promise<{ downloaded: unknown[]; skipped: unknown[] }>;
  }>;
  loadRecommendedModels: () => Promise<{ RECOMMENDED_MODELS: readonly unknown[]; MINIMAL_MODELS: readonly unknown[] }>;
  loadRecommendedConfig: () => Promise<{
    writeRecommendedLlmConfig: (opts: {
      projectRoot: string;
      dir?: string;
      includeAsk?: boolean;
      includeReranker?: boolean;
    }) => {
      configPath: string;
      backupPath?: string | null;
    };
  }>;
}

const defaultLifecycleCommandDeps: LifecycleCommandDeps = {
  program: cliProgram,
  llmCmd: cliLlmCmd,
  chalk: cliChalk,
  resolveProjectPath: cliResolveProjectPath,
  error: cliError,
  info: cliInfo,
  writeStdout: (message = '') => {
    process.stdout.write(`${message}\n`);
  },
  writeStderr: (message = '') => {
    process.stderr.write(`${message}\n`);
  },
  assignIntArg: cliAssignIntArg,
  runViaMCP: cliRunViaMCP,
  loadCartograph: cliLoadCartograph as () => Promise<SetupCartographModule>,
  isInitialized: defaultIsInitialized,
  compact: defaultCompact,
  loadMcpServer: (() => import('../../mcp/index.js')) as LifecycleCommandDeps['loadMcpServer'],
  loadInstallerTargets: (() =>
    import('../../installer/targets/registry.js')) as LifecycleCommandDeps['loadInstallerTargets'],
  loadInstaller: (() => import('../../installer/index.js')) as LifecycleCommandDeps['loadInstaller'],
  loadLlmSetupCli: () => import('../../installer/llm-setup-cli.js'),
  loadToolHandler: () => import('../../mcp/tools.js'),
  loadMcpLoadBudget: () => import('../../mcp/load-budget.js'),
  loadViewerServer: () => import('../../viewer/server.js'),
  loadDoctor: (() => import('../../installer/doctor.js')) as unknown as LifecycleCommandDeps['loadDoctor'],
  loadInstallModels: (() => import('../../installer/install-models.js')) as LifecycleCommandDeps['loadInstallModels'],
  loadRecommendedModels: (() =>
    import('../../llm/recommended-models.js')) as LifecycleCommandDeps['loadRecommendedModels'],
  loadRecommendedConfig: (() =>
    import('../../installer/recommended-config.js')) as LifecycleCommandDeps['loadRecommendedConfig'],
};

function resolveServeProfile(raw: string | undefined, error: (message: string) => void): McpServerProfile | null {
  const profile = raw ?? DEFAULT_MCP_SERVER_PROFILE;
  if (isMcpServerProfile(profile)) return profile;
  error(`Invalid --profile "${profile}". Expected one of: ${MCP_SERVER_PROFILE_NAMES.join(', ')}`);
  process.exit(1);
  return null;
}

function writeServeMcpGuidance(deps: Pick<LifecycleCommandDeps, 'chalk' | 'writeStderr'>): void {
  const { chalk, writeStderr } = deps;
  writeStderr(chalk.bold('\nCartograph MCP Server\n'));
  writeStderr(chalk.blue('ℹ') + ' Use --mcp flag to start the MCP server');
  writeStderr(
    chalk.blue('ℹ') + ` Use --profile <${MCP_SERVER_PROFILE_NAMES.join('|')}> to narrow the advertised tools`,
  );
  writeStderr(chalk.blue('ℹ') + ' Use --low-tokens-default to compact supported high-volume tool results');
  writeStderr('\nTo use with Claude Code, add to your MCP configuration:');
  writeStderr(
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
  writeStderr('Available tools:');
  writeStderr(
    chalk.cyan('  cartograph_find') + '      - Find symbols / regex / env / sql in one tool (by=name|content|env|sql)',
  );
  writeStderr(
    chalk.cyan('  cartograph_context') + '   - Build context for a task; use format=plan for route-first guidance',
  );
  writeStderr(chalk.cyan('  cartograph_graph') + '     - Navigate the graph (callers / callees / impact / walk)');
  writeStderr(
    chalk.cyan('  cartograph_node') + '      - Get symbol details; liveSource handles intentional stale slices',
  );
  writeStderr(chalk.cyan('  cartograph_affected') + '  - Find affected tests; includeCommands suggests verification');
  writeStderr(chalk.cyan('  cartograph_session') + '   - Resume/audit sessions and manage macros');
  writeStderr(chalk.cyan('  cartograph_files') + '     - Get project file structure');
  writeStderr(chalk.cyan('  cartograph_status') + '    - Get index status');
}

/**
 * cartograph serve
 */
function registerServeCommand(deps: LifecycleCommandDeps): void {
  const { program, resolveProjectPath, error, loadMcpServer } = deps;
  program
    .command('serve')
    .description('Start Cartograph as an MCP server for AI assistants')
    .option('-p, --project-path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
    .option('--mcp', 'Run as MCP server (stdio transport)')
    .option('--profile <name>', MCP_SERVER_PROFILE_DESCRIPTION)
    .option(
      '--no-write-tools',
      'Disable write-class tools and mutating branches of mixed tools. Read-only branches stay available for sandboxed agents and smaller MCP load context.',
    )
    .option(
      '--allow-stale-default',
      'Default `allowStale: true` for tool calls that do not pass it explicitly. Useful in fast-iteration sessions.',
    )
    .option(
      '--low-tokens-default',
      'Default `lowTokens: true` for supported high-volume tool calls that do not pass it explicitly.',
    )
    .option(
      '--disable-tool <name...>',
      'Disable specific tools by name to narrow the advertised MCP surface. Repeatable: `--disable-tool cartograph_ask --disable-tool cartograph_dead_code`.',
    )
    .option(
      '--no-startup-sync',
      'Skip the catch-up sync that normally runs once when the server opens its default project. Use only when boot-time sync cost is unacceptable (very large repos with frequent restarts).',
    )
    .action(async (options: ServeCommandOptions) => {
      const projectPath = options.projectPath ? resolveProjectPath(options.projectPath) : undefined;

      try {
        if (options.mcp) {
          const profile = resolveServeProfile(options.profile, error);
          if (!profile) return;
          // Start MCP server - it handles initialization lazily based on rootUri from client
          const { MCPServer } = await loadMcpServer();
          const server = new MCPServer({
            projectPath,
            profile,
            // commander's `--no-write-tools` makes `writeTools` false when set;
            // omitted leaves it undefined which we treat as "writes enabled".
            disableWriteTools: options.writeTools === false,
            allowStaleDefault: options.allowStaleDefault === true,
            lowTokensDefault: options.lowTokensDefault === true,
            disabledTools:
              options.disableTool && options.disableTool.length > 0 ? new Set(options.disableTool) : undefined,
            disableStartupSync: options.startupSync === false,
          });
          await server.start();
          // Server will run until terminated
        } else {
          writeServeMcpGuidance(deps);
        }
      } catch (err) {
        error(`Failed to start server: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

/**
 * cartograph install
 */
function registerInstallCommand(deps: LifecycleCommandDeps): void {
  const { program, error, compact, loadInstallerTargets, loadInstaller } = deps;
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
          const { getTarget, listTargetIds } = await loadInstallerTargets();
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

        const { runInstallerWithOptions } = await loadInstaller();
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
}

// `llm setup` is the only remaining LLM provisioning command. Kept
// as a subcommand under `llm` so the surface stays extensible (e.g.
// future `llm test`, `llm list-models`) without renaming.
// `llmCmd` is the family-parent command — defined in `_cli-core.ts`.
function registerLlmSetupCommand(deps: LifecycleCommandDeps): void {
  const { llmCmd, loadLlmSetupCli } = deps;
  llmCmd
    .command('setup [path]')
    .description('Interactive LLM provider setup — picks chat + embeddings backends and writes them into config.json')
    .action(async (pathArg: string | undefined) => {
      const { runLlmSetupCli } = await loadLlmSetupCli();
      await runLlmSetupCli(pathArg);
    });
}

function registerTraceToCulpritsCommand(deps: LifecycleCommandDeps): void {
  const { program, assignIntArg, runViaMCP, writeStderr } = deps;
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
        writeStderr('No trace provided. Pipe a stack trace to stdin or pass --trace "<text>".');
        process.exit(2);
      }
      const args: Record<string, unknown> = { trace };
      if (!assignIntArg({ args, key: 'limit', raw: options.limit, optionName: '--limit', opts: { min: 1 } })) return;
      await runViaMCP('cartograph_trace_to_culprits', args, options.projectPath);
    });
}

function registerPlaybookCommand(deps: LifecycleCommandDeps): void {
  const { program, loadToolHandler, writeStdout } = deps;
  program
    .command('playbook')
    .description('Print the cartograph tool playbook (mirrors cartograph_playbook MCP tool)')
    .action(async () => {
      // Playbook is project-agnostic — bypass runViaMCP (which requires an
      // initialized project) and dispatch directly with a null cg, the
      // same way the MCP server treats `cartograph_playbook` calls before
      // any project is open.
      const { ToolHandler } = await loadToolHandler();
      const handler = new ToolHandler(null);
      const result = await handler.execute('cartograph_playbook', {});
      handler.closeAll();
      writeStdout(result.content[0]?.text ?? '');
      if (result.isError) process.exit(1);
    });
}

function registerMcpBudgetCommand(deps: LifecycleCommandDeps): void {
  const { program, assignIntArg, error, loadMcpLoadBudget, writeStdout } = deps;
  program
    .command('mcp-budget')
    .description('Measure MCP tools/list and initialize payload size, including top schema contributors')
    .option('--profile <name>', MCP_SERVER_PROFILE_DESCRIPTION)
    .option(
      '--no-write-tools',
      'Measure with write-class tools and mutating mixed-tool branches disabled, matching `cartograph serve --mcp --no-write-tools`.',
    )
    .option(
      '--disable-tool <name...>',
      'Measure with specific tools disabled by name. Repeatable: `--disable-tool cartograph_ask --disable-tool cartograph_dead_code`.',
    )
    .option('--top <n>', 'Number of largest tool schemas to list (default 10; pass 0 to suppress)', '10')
    .option('--json', 'Print structured JSON instead of a markdown report')
    .action(async (options: McpBudgetCommandOptions) => {
      const profile = resolveServeProfile(options.profile, error);
      if (!profile) return;

      const parsed: Record<string, unknown> = {};
      if (!assignIntArg({ args: parsed, key: 'top', raw: options.top, optionName: '--top', opts: { min: 0 } })) {
        return;
      }

      const handlerOptions: {
        profile: McpServerProfile;
        disableWriteTools?: boolean;
        disabledTools?: Set<string>;
      } = { profile };
      if (options.writeTools === false) handlerOptions.disableWriteTools = true;
      if (options.disableTool && options.disableTool.length > 0) {
        handlerOptions.disabledTools = new Set(options.disableTool);
      }

      const { measureMcpLoadBudget, formatMcpLoadBudgetReport } = await loadMcpLoadBudget();
      const report = measureMcpLoadBudget(null, {
        handlerOptions,
        topContributors: (parsed['top'] as number | undefined) ?? 10,
      });
      writeStdout(options.json ? JSON.stringify(report, null, 2) : formatMcpLoadBudgetReport(report));
    });
}

function registerViewerCommand(deps: LifecycleCommandDeps): void {
  const { program, resolveProjectPath, isInitialized, error, info, loadViewerServer } = deps;
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
        const { startViewerServer, openInBrowser } = await loadViewerServer();
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
}

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
function registerDoctorCommand(deps: LifecycleCommandDeps): void {
  const { program, loadDoctor, writeStdout } = deps;
  program
    .command('doctor [path]')
    .description(
      'Diagnose install state (Bun, models, project init/config, detected LLM backends, embedding endpoint reachability) with actionable next steps. Pass `--fix` to auto-apply remediations.',
    )
    .option('--no-project-checks', 'Skip the project-init + config checks (useful for fresh-install verification).')
    .option('--skip-project-checks', 'Skip the project-init + config checks (alias of --no-project-checks).')
    .option(
      '--fix',
      'Auto-apply remediations for fixable gaps (creates `.cartograph/`, downloads models, writes a recommended LLM config). Re-runs checks after applying. Backend-not-running gaps remain manual.',
    )
    .action(
      async (
        pathArg: string | undefined,
        options: { projectChecks?: boolean; skipProjectChecks?: boolean; fix?: boolean },
      ) => {
        const { runDoctor, formatDoctorReport } = await loadDoctor();
        const skip = options.projectChecks === false || options.skipProjectChecks === true;
        const result = await runDoctor({
          ...(pathArg ? { projectPath: pathArg } : {}),
          skipProjectChecks: skip,
          fix: options.fix === true,
        });
        writeStdout(formatDoctorReport(result));
        // When --fix ran, exit on the AFTER-fix status (the user cares
        // whether the system is healthy now, not whether it was broken
        // before the fix). Otherwise use the pre-fix status.
        const finalStatus = result.afterFix?.overallStatus ?? result.overallStatus;
        if (finalStatus === 'fail') process.exit(1);
      },
    );
}

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
function registerSetupCommand(deps: LifecycleCommandDeps): void {
  const { program, resolveProjectPath, info, writeStdout, loadDoctor } = deps;
  program
    .command('setup [path]')
    .description('One-shot bootstrap: admin init + install-models + doctor. Each step skips when already satisfied.')
    .option('--minimal', 'Install only the smallest viable model subset (embed + 3B chat) instead of the full set.')
    .option('--no-models', 'Skip the install-models step (use when models are already present).')
    .action(async (pathArg: string | undefined, options: { minimal?: boolean; models?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const { runDoctor, formatDoctorReport } = await loadDoctor();

      await runSetupInitStep(projectPath, deps);
      await runSetupModelStep(projectPath, options, deps);
      info('Step 3/3: running doctor verification');
      const result = await runDoctor({ projectPath });
      writeStdout('\n' + formatDoctorReport(result));
      if (result.overallStatus === 'fail') process.exit(1);
    });
}

async function runSetupInitStep(projectPath: string, deps: LifecycleCommandDeps): Promise<void> {
  const { isInitialized, info, loadCartograph } = deps;
  if (isInitialized(projectPath)) {
    info(`Step 1/3: ${projectPath} already initialized — skipping init`);
    return;
  }

  info(`Step 1/3: initialising Cartograph at ${projectPath}`);
  const { default: Cartograph } = await loadCartograph();
  const cg = await Cartograph.init(projectPath, { index: false });
  cg.close();
}

async function runSetupModelStep(
  projectPath: string,
  options: { minimal?: boolean; models?: boolean },
  deps: LifecycleCommandDeps,
): Promise<void> {
  const { info, error, loadInstallModels, loadRecommendedModels } = deps;
  if (options.models === false) {
    info('Step 2/3: --no-models → skipping models install');
    info(
      '  Next: configure an existing or backend-managed LLM with `cartograph admin llm-plan` then `cartograph admin llm-apply --preset <id> --project-path <project>`, or hand-edit `.cartograph/config.json`.',
    );
    return;
  }

  info(`Step 2/3: installing ${options.minimal ? 'minimal' : 'full'} GGUF set`);
  const { installRecommendedModels } = await loadInstallModels();
  const { RECOMMENDED_MODELS, MINIMAL_MODELS } = await loadRecommendedModels();
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
    await writeSetupRecommendedConfig(projectPath, deps, { minimal: options.minimal === true });
  } catch (error_) {
    error(`install-models failed: ${errMsg(error_)}`);
    // models are needed for LLM features, but the user might already
    // have a working subset from a prior run. doctor will catch a true gap.
  }
}

const BYTES_PER_MIB = 1024 * 1024;
const PERCENT_SCALE = 100;

async function writeSetupRecommendedConfig(
  projectPath: string,
  deps: LifecycleCommandDeps,
  options: { minimal: boolean },
): Promise<void> {
  const { info, loadRecommendedConfig } = deps;
  const { writeRecommendedLlmConfig } = await loadRecommendedConfig();
  const writeOpts: { projectRoot: string; dir?: string; includeAsk?: boolean; includeReranker?: boolean } = {
    projectRoot: projectPath,
  };
  if (options.minimal) {
    writeOpts.includeAsk = false;
    writeOpts.includeReranker = false;
  }
  const { configPath, backupPath } = writeRecommendedLlmConfig(writeOpts);
  info(`  wrote ${options.minimal ? 'minimal' : 'recommended'} LLM config: ${configPath}`);
  if (backupPath) info(`  backup written: ${backupPath}`);
}

export function registerLifecycleCommands(deps: LifecycleCommandDeps = defaultLifecycleCommandDeps): void {
  registerServeCommand(deps);
  registerInstallCommand(deps);
  registerLlmSetupCommand(deps);
  registerTraceToCulpritsCommand(deps);
  registerPlaybookCommand(deps);
  registerMcpBudgetCommand(deps);
  registerViewerCommand(deps);
  registerDoctorCommand(deps);
  registerSetupCommand(deps);
}

registerLifecycleCommands();
