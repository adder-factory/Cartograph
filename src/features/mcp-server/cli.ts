import { errMsg } from '../../errors.js';
import type { McpLoadBudgetReport, MeasureMcpLoadBudgetOptions } from '../../mcp/load-budget.js';
import {
  DEFAULT_MCP_SERVER_PROFILE,
  MCP_SERVER_PROFILE_DESCRIPTION,
  MCP_SERVER_PROFILE_NAMES,
  isMcpServerProfile,
  type McpServerProfile,
} from '../../mcp/profiles.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

interface ServeCommandOptions {
  projectPath?: string;
  mcp?: boolean;
  daemon?: boolean;
  daemonChild?: boolean;
  profile?: string;
  writeTools?: boolean;
  allowStaleDefault?: boolean;
  lowTokensDefault?: boolean;
  disableTool?: string[];
  startupSync?: boolean;
}

interface McpBudgetCommandOptions {
  profile?: string;
  writeTools?: boolean;
  disableTool?: string[];
  top?: string;
  json?: boolean;
}

interface ServeServerOptions {
  projectPath: string | undefined;
  profile: McpServerProfile;
  disableWriteTools: boolean;
  allowStaleDefault: boolean;
  lowTokensDefault: boolean;
  disabledTools: Set<string> | undefined;
  disableStartupSync: boolean;
}

export interface McpServerCommandDeps {
  program: CommandLike;
  chalk: {
    bold: (s: string) => string;
    blue: (s: string) => string;
    dim: (s: string) => string;
    cyan: (s: string) => string;
  };
  resolveProjectPath: (pathArg?: string) => string;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
  writeStderr: (message?: string) => void;
  assignIntArg: (args: AssignNumericArgInput) => boolean;
  loadMcpServer: () => Promise<{ MCPServer: new (opts: unknown) => { start: () => Promise<void> } }>;
  loadMcpDaemon: () => Promise<{
    runSharedMcpDaemonProcess: (opts: unknown) => Promise<void>;
    runSharedMcpDaemonProxy: (opts: unknown) => Promise<'proxied' | 'fallback'>;
  }>;
  loadMcpLoadBudget: () => Promise<{
    measureMcpLoadBudget: (cg?: null, options?: MeasureMcpLoadBudgetOptions) => McpLoadBudgetReport;
    formatMcpLoadBudgetReport: (report: McpLoadBudgetReport) => string;
  }>;
}

export function registerMcpServerCommands(deps: McpServerCommandDeps): void {
  registerServeCommand(deps);
  registerMcpBudgetCommand(deps);
}

export function resolveServeProfile(
  raw: string | undefined,
  error: (message: string) => void,
): McpServerProfile | null {
  const profile = raw ?? DEFAULT_MCP_SERVER_PROFILE;
  if (isMcpServerProfile(profile)) return profile;
  error(`Invalid --profile "${profile}". Expected one of: ${MCP_SERVER_PROFILE_NAMES.join(', ')}`);
  process.exit(1);
  return null;
}

export function writeServeMcpGuidance(deps: Pick<McpServerCommandDeps, 'chalk' | 'writeStderr'>): void {
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
  writeStderr(chalk.cyan('  cartograph_files') + '     - Get project file structure');
  writeStderr(chalk.cyan('  cartograph_status') + '    - Get index status');
  writeStderr(
    chalk.cyan('  --profile full') + '      - Add advanced tools such as explore, imports, sessions, and diagnostics',
  );
}

function registerServeCommand(deps: McpServerCommandDeps): void {
  const { program } = deps;
  program
    .command('serve')
    .description('Start Cartograph as an MCP server for AI assistants')
    .option('-p, --project-path <path>', 'Project path (optional for MCP mode, uses rootUri from client)')
    .option('--mcp', 'Run as MCP server (stdio transport)')
    .option('--daemon', 'Use the shared per-project MCP daemon (default; this process acts as the stdio proxy)')
    .option(
      '--no-daemon',
      'Run a standalone MCP server in this process instead of the shared per-project daemon (one writer per project)',
    )
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
    .action((options: ServeCommandOptions) => runServeCommand(deps, options));
}

async function runServeCommand(deps: McpServerCommandDeps, options: ServeCommandOptions): Promise<void> {
  const { resolveProjectPath, error } = deps;
  const projectPath = options.projectPath ? resolveProjectPath(options.projectPath) : undefined;

  try {
    if (!options.mcp) {
      writeServeMcpGuidance(deps);
      return;
    }
    const profile = resolveServeProfile(options.profile, error);
    if (!profile) return;
    await startMcpServeMode(deps, options, buildServeServerOptions(options, projectPath, profile));
  } catch (error_) {
    error(`Failed to start server: ${errMsg(error_)}`);
    process.exit(1);
  }
}

function buildServeServerOptions(
  options: ServeCommandOptions,
  projectPath: string | undefined,
  profile: McpServerProfile,
): ServeServerOptions {
  return {
    projectPath,
    profile,
    disableWriteTools: options.writeTools === false,
    allowStaleDefault: options.allowStaleDefault === true,
    lowTokensDefault: options.lowTokensDefault === true,
    disabledTools: options.disableTool && options.disableTool.length > 0 ? new Set(options.disableTool) : undefined,
    disableStartupSync: options.startupSync === false,
  };
}

async function startMcpServeMode(
  deps: McpServerCommandDeps,
  options: ServeCommandOptions,
  serverOptions: ServeServerOptions,
): Promise<void> {
  const { loadMcpServer, loadMcpDaemon } = deps;
  if (options.daemonChild) {
    const { runSharedMcpDaemonProcess } = await loadMcpDaemon();
    await runSharedMcpDaemonProcess(serverOptions);
    return;
  }
  // Daemon mode is the default (one shared writer per project, so multiple
  // agents don't re-index concurrently and clobber each other). `--no-daemon`
  // sets `daemon: false` for a standalone server (test isolation, one-shot/CI).
  // If the proxy can't reach/start the daemon it falls through to standalone.
  if (options.daemon !== false) {
    const { runSharedMcpDaemonProxy } = await loadMcpDaemon();
    const outcome = await runSharedMcpDaemonProxy(serverOptions);
    if (outcome === 'proxied') return;
  }
  const { MCPServer } = await loadMcpServer();
  const server = new MCPServer(serverOptions);
  await server.start();
}

function registerMcpBudgetCommand(deps: McpServerCommandDeps): void {
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
