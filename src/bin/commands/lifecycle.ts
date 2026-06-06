/**
 * Lifecycle / utility CLI commands (serve / install / playbook /
 * trace-to-culprits / viewer / llm setup) — extracted from the
 * bin/cartograph.ts decomposition; side-effecting module: importing it
 * registers the commands.
 */
import { isInitialized as defaultIsInitialized } from '../../directory.js';
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
import type { McpLoadBudgetReport, MeasureMcpLoadBudgetOptions } from '../../mcp/load-budget.js';
import { registerBackendCommand, type BackendRuntimeModule } from '../../features/backend/index.js';
import { registerInstallCommand } from '../../features/install/index.js';
import { registerLlmSmokeCommand, type LlmSmokeRuntimeModule } from '../../features/llm-smoke/index.js';
import { registerMcpServerCommands } from '../../features/mcp-server/index.js';
import { registerPlaybookCommand } from '../../features/playbook/index.js';
import { registerSetupCommand, type SetupCartographModule } from '../../features/setup/index.js';
import { registerTraceToCulpritsCommand } from '../../features/trace-to-culprits/index.js';
import { registerViewerCommand, type ViewerServerModule } from '../../features/viewer/index.js';

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

interface DoctorResult {
  overallStatus: string;
  afterFix?: { overallStatus: string };
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
  loadViewerServer: () => Promise<ViewerServerModule>;
  loadDoctor: () => Promise<{
    runDoctor: (opts: Record<string, unknown>) => Promise<DoctorResult>;
    formatDoctorReport: (result: unknown) => string;
    formatDoctorJson: (result: unknown) => string;
  }>;
  loadBackendRuntime: () => Promise<BackendRuntimeModule>;
  loadLlmSmoke: () => Promise<LlmSmokeRuntimeModule>;
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
  loadBackendRuntime: () => import('../../features/backend/index.js'),
  loadLlmSmoke: () => import('../../features/llm-smoke/index.js'),
  loadInstallModels: (() => import('../../installer/install-models.js')) as LifecycleCommandDeps['loadInstallModels'],
  loadRecommendedModels: (() =>
    import('../../llm/recommended-models.js')) as LifecycleCommandDeps['loadRecommendedModels'],
  loadRecommendedConfig: (() =>
    import('../../installer/recommended-config.js')) as LifecycleCommandDeps['loadRecommendedConfig'],
};

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

  registerLlmSmokeCommand(deps);
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

export function registerLifecycleCommands(deps: LifecycleCommandDeps = defaultLifecycleCommandDeps): void {
  registerMcpServerCommands(deps);
  registerInstallCommand({
    program: deps.program,
    error: deps.error,
    writeStdout: (message) => {
      process.stdout.write(message);
    },
    loadInstallerTargets: deps.loadInstallerTargets,
    loadInstaller: deps.loadInstaller,
  });
  registerLlmSetupCommand(deps);
  registerTraceToCulpritsCommand(deps);
  registerPlaybookCommand(deps);
  registerViewerCommand(deps);
  registerBackendCommand(deps);
  registerDoctorCommand(deps);
  registerSetupCommand(deps);
}

registerLifecycleCommands();
