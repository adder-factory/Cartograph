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
  daemon?: boolean;
  daemonChild?: boolean;
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
  loadMcpDaemon: () => Promise<{
    runSharedMcpDaemonProcess: (opts: unknown) => Promise<void>;
    runSharedMcpDaemonProxy: (opts: unknown) => Promise<'proxied' | 'fallback'>;
  }>;
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
    formatDoctorJson: (result: unknown) => string;
  }>;
  loadBackendRuntime: () => Promise<{
    backendStatus: (projectPath: string, options?: { bin?: string }) => Promise<any>;
    startBackends: (options: { projectPath: string; bin?: string; dryRun?: boolean }) => Promise<any>;
    stopBackends: (options: { projectPath: string; force?: boolean }) => Promise<any>;
    backendLogs: (options: { projectPath: string; tier?: string; lines?: number }) => Promise<any>;
    renderBackendStartCommand: (spec: any) => string;
  }>;
  loadLlmSmoke: () => Promise<{
    runLlmSmoke: (opts: { projectPath: string; timeoutMs?: number }) => Promise<any>;
    formatLlmSmokeReport: (result: any) => string;
    formatLlmSmokeJson: (result: any) => string;
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
  loadMcpDaemon: (() => import('../../mcp/daemon.js')) as LifecycleCommandDeps['loadMcpDaemon'],
  loadInstallerTargets: (() =>
    import('../../installer/targets/registry.js')) as LifecycleCommandDeps['loadInstallerTargets'],
  loadInstaller: (() => import('../../installer/index.js')) as LifecycleCommandDeps['loadInstaller'],
  loadLlmSetupCli: () => import('../../installer/llm-setup-cli.js'),
  loadToolHandler: () => import('../../mcp/tools.js'),
  loadMcpLoadBudget: () => import('../../mcp/load-budget.js'),
  loadViewerServer: () => import('../../viewer/server.js'),
  loadDoctor: (() => import('../../installer/doctor.js')) as unknown as LifecycleCommandDeps['loadDoctor'],
  loadBackendRuntime: () => import('../../installer/backend-runtime.js'),
  loadLlmSmoke: () => import('../../installer/llm-smoke.js'),
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
  const { program, resolveProjectPath, error, loadMcpServer, loadMcpDaemon } = deps;
  program
    .command('serve')
    .description('Start Cartograph as an MCP server for AI assistants')
    .option('-p, --project-path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
    .option('--mcp', 'Run as MCP server (stdio transport)')
    .option('--daemon', 'Use a shared per-project MCP daemon with this process acting as the stdio proxy')
    .option('--daemon-child', 'Internal: run the shared MCP daemon process')
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
          const serverOptions = {
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
          };
          if (options.daemonChild) {
            const { runSharedMcpDaemonProcess } = await loadMcpDaemon();
            await runSharedMcpDaemonProcess(serverOptions);
            return;
          }
          if (options.daemon) {
            const { runSharedMcpDaemonProxy } = await loadMcpDaemon();
            const outcome = await runSharedMcpDaemonProxy(serverOptions);
            if (outcome === 'proxied') return;
          }
          const { MCPServer } = await loadMcpServer();
          const server = new MCPServer(serverOptions);
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
  const { llmCmd, loadLlmSetupCli, loadLlmSmoke, resolveProjectPath, writeStdout, error } = deps;
  llmCmd
    .command('setup [path]')
    .description('Interactive LLM provider setup — picks chat + embeddings backends and writes them into config.json')
    .action(async (pathArg: string | undefined) => {
      const { runLlmSetupCli } = await loadLlmSetupCli();
      await runLlmSetupCli(pathArg);
    });

  llmCmd
    .command('smoke [path]')
    .description('Send tiny real requests to configured LLM tiers (embedding, summarize, ask/local, rerank)')
    .option('--timeout-ms <n>', 'Per-tier smoke timeout in milliseconds (default 60000)')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { timeoutMs?: string; json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const timeoutMs = parseOptionalPositiveInt(options.timeoutMs, '--timeout-ms', error);
      if (timeoutMs === null) return;
      const { runLlmSmoke, formatLlmSmokeReport, formatLlmSmokeJson } = await loadLlmSmoke();
      const result = await runLlmSmoke({ projectPath, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      writeStdout(options.json ? formatLlmSmokeJson(result) : formatLlmSmokeReport(result));
      if (result.overallStatus === 'fail') process.exit(1);
    });
}

function parseOptionalPositiveInt(
  raw: string | undefined,
  optionName: string,
  error: (message: string) => void,
): number | undefined | null {
  if (raw === undefined) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    error(`${optionName} must be a positive integer`);
    process.exitCode = 1;
    return null;
  }
  return n;
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

function registerBackendCommand(deps: LifecycleCommandDeps): void {
  const { program, resolveProjectPath, loadBackendRuntime, writeStdout } = deps;
  const backendCmd = program
    .command('backend')
    .description('Manage configured local llama-server backends for this project');

  backendCmd
    .command('status [path]')
    .description('Show configured local llama-server backend status')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const runtime = await loadBackendRuntime();
      const result = await runtime.backendStatus(projectPath);
      writeStdout(options.json ? JSON.stringify(result, null, 2) : formatBackendStatusReport(result, runtime));
    });

  backendCmd
    .command('start [path]')
    .description('Start configured local llama-server backend processes in the background')
    .option('--bin <path>', 'llama-server binary path (default: llama-server)')
    .option('--dry-run', 'Print what would be started without spawning processes')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { bin?: string; dryRun?: boolean; json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const runtime = await loadBackendRuntime();
      const result = await runtime.startBackends({
        projectPath,
        ...(options.bin ? { bin: options.bin } : {}),
        dryRun: options.dryRun === true,
      });
      writeStdout(
        options.json
          ? JSON.stringify(result, null, 2)
          : formatBackendStartReport(result, runtime, options.dryRun === true),
      );
      if (result.rows.length === 0 || result.rows.some((row: any) => row.state === 'missing-model')) process.exit(1);
    });

  backendCmd
    .command('stop [path]')
    .description('Stop local llama-server backend processes started by `cartograph backend start`')
    .option('--force', 'Send SIGKILL if a process does not exit after SIGTERM')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { force?: boolean; json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const runtime = await loadBackendRuntime();
      const result = await runtime.stopBackends({ projectPath, force: options.force === true });
      writeStdout(options.json ? JSON.stringify(result, null, 2) : formatBackendStopReport(result, runtime));
    });

  backendCmd
    .command('logs [path]')
    .description('Tail logs for configured local llama-server backend processes')
    .option('--tier <name>', 'Only show logs for one tier label (embed, summarize, local, ask, rerank)')
    .option('--lines <n>', 'Number of log lines per backend to show (default 80)')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { tier?: string; lines?: string; json?: boolean }) => {
      const projectPath = resolveProjectPath(pathArg);
      const lines = parseOptionalPositiveInt(options.lines, '--lines', deps.error);
      if (lines === null) return;
      const runtime = await loadBackendRuntime();
      const result = await runtime.backendLogs({
        projectPath,
        ...(options.tier ? { tier: options.tier } : {}),
        ...(lines === undefined ? {} : { lines }),
      });
      writeStdout(options.json ? JSON.stringify(result, null, 2) : formatBackendLogsReport(result));
      if (options.tier && result.logs.length === 0) process.exit(1);
    });
}

function formatBackendStatusReport(result: any, runtime: { renderBackendStartCommand: (spec: any) => string }): string {
  const lines = ['## cartograph backend status', ''];
  if (result.rows.length === 0) {
    lines.push(`_No managed backend processes._ ${result.unmanagedReason ?? ''}`.trim());
    return lines.join('\n');
  }
  appendBackendRows(lines, result.rows, runtime);
  return lines.join('\n');
}

function formatBackendStartReport(
  result: any,
  runtime: { renderBackendStartCommand: (spec: any) => string },
  dryRun: boolean,
): string {
  const lines = ['## cartograph backend start', ''];
  if (dryRun) lines.push('_Dry run: no processes were started._', '');
  if (result.started.length > 0) {
    lines.push(`Started ${result.started.length} backend process${result.started.length === 1 ? '' : 'es'}.`, '');
  }
  if (result.skipped.length > 0) {
    lines.push('Skipped:');
    for (const skipped of result.skipped) lines.push(`- ${skipped.row.spec.labels.join('/')} — ${skipped.reason}`);
    lines.push('');
  }
  if (result.rows.length === 0) lines.push(`_No managed backend processes._ ${result.unmanagedReason ?? ''}`.trim());
  else appendBackendRows(lines, result.rows, runtime);
  return lines.join('\n');
}

function formatBackendStopReport(result: any, runtime: { renderBackendStartCommand: (spec: any) => string }): string {
  const lines = ['## cartograph backend stop', ''];
  if (result.stopped.length > 0) {
    lines.push(`Stopped ${result.stopped.length} backend process${result.stopped.length === 1 ? '' : 'es'}.`, '');
  }
  if (result.skipped.length > 0) {
    lines.push('Skipped:');
    for (const skipped of result.skipped) lines.push(`- ${skipped.row.spec.labels.join('/')} — ${skipped.reason}`);
    lines.push('');
  }
  if (result.rows.length === 0) lines.push(`_No managed backend processes._ ${result.unmanagedReason ?? ''}`.trim());
  else appendBackendRows(lines, result.rows, runtime);
  return lines.join('\n');
}

function appendBackendRows(
  lines: string[],
  rows: readonly any[],
  runtime: { renderBackendStartCommand: (spec: any) => string },
): void {
  for (const row of rows) {
    const icon = row.state === 'running' || row.state === 'external' ? '✓' : row.state === 'missing-model' ? '✗' : '○';
    const pid = row.pidRecord?.pid ? ` pid=${row.pidRecord.pid}${row.pidAlive ? '' : ' stale'}` : '';
    lines.push(`${icon} **${row.spec.labels.join('/')}** — ${row.state} at ${row.spec.endpoint}${pid}`);
    lines.push(`  model: ${row.spec.modelPath}`);
    lines.push(`  log: ${row.logPath}`);
    lines.push(`  command: ${runtime.renderBackendStartCommand(row.spec)}`);
    if (row.pidRecord && !row.pidAlive) {
      lines.push(`  stale pid cleanup: cartograph backend stop ${resultProjectPathFromRow(row)}`);
    }
    if (row.state === 'starting') {
      lines.push(`  readiness: process is alive but endpoint is not reachable yet; inspect logs if it stays here.`);
    }
  }
}

function resultProjectPathFromRow(row: any): string {
  const marker = `${pathSeparator()}.cartograph${pathSeparator()}backends${pathSeparator()}`;
  const idx = typeof row.pidFilePath === 'string' ? row.pidFilePath.indexOf(marker) : -1;
  return idx >= 0 ? row.pidFilePath.slice(0, idx) : '<project>';
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function formatBackendLogsReport(result: any): string {
  const lines = ['## cartograph backend logs', ''];
  if (result.rows.length === 0) {
    lines.push(`_No managed backend processes._ ${result.unmanagedReason ?? ''}`.trim());
    return lines.join('\n');
  }
  if (result.logs.length === 0) {
    lines.push('_No backend matched the requested tier._');
    return lines.join('\n');
  }
  for (const entry of result.logs) {
    lines.push(`### ${entry.row.spec.labels.join('/')} — ${entry.row.logPath}`, '');
    if (entry.error) {
      lines.push(`_Could not read log: ${entry.error}_`, '');
    } else if (!entry.exists || entry.content.length === 0) {
      lines.push('_No log output yet._', '');
    } else {
      lines.push('```text', entry.content, '```', '');
    }
  }
  return lines.join('\n').trimEnd();
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
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(
      async (
        pathArg: string | undefined,
        options: { projectChecks?: boolean; skipProjectChecks?: boolean; fix?: boolean; json?: boolean },
      ) => {
        const { runDoctor, formatDoctorReport, formatDoctorJson } = await loadDoctor();
        const skip = options.projectChecks === false || options.skipProjectChecks === true;
        const result = await runDoctor({
          ...(pathArg ? { projectPath: pathArg } : {}),
          skipProjectChecks: skip,
          fix: options.fix === true,
        });
        writeStdout(options.json ? formatDoctorJson(result) : formatDoctorReport(result));
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
    info('  Then run `cartograph llm smoke <project>` and `cartograph doctor <project>` to verify real requests.');
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
  info(`  next: cartograph backend start ${projectPath}`);
  info(`        cartograph llm smoke ${projectPath}`);
}

export function registerLifecycleCommands(deps: LifecycleCommandDeps = defaultLifecycleCommandDeps): void {
  registerServeCommand(deps);
  registerInstallCommand(deps);
  registerLlmSetupCommand(deps);
  registerTraceToCulpritsCommand(deps);
  registerPlaybookCommand(deps);
  registerMcpBudgetCommand(deps);
  registerViewerCommand(deps);
  registerBackendCommand(deps);
  registerDoctorCommand(deps);
  registerSetupCommand(deps);
}

registerLifecycleCommands();
