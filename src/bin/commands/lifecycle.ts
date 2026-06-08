/**
 * Lifecycle / utility CLI commands (serve / install / playbook /
 * trace-to-culprits / viewer / llm setup) — extracted from the
 * bin/cartograph.ts decomposition.
 */
import { isInitialized as defaultIsInitialized } from '../../directory.js';
import { hasUncommittedChanges as defaultHasUncommittedChanges } from '../../git-utils.js';
import type { CliOptionCommand } from '../../features/shared/cli-command.js';
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
import { registerDoctorCommand, type DoctorResult, type DoctorRunOptions } from '../../features/doctor/index.js';
import { registerInstallCommand } from '../../features/install/index.js';
import { registerLlmSetupCommand } from '../../features/llm-setup/index.js';
import { registerLlmSmokeCommand, type LlmSmokeRuntimeModule } from '../../features/llm-smoke/index.js';
import { registerMcpServerCommands } from '../../features/mcp-server/index.js';
import { registerPlaybookCommand } from '../../features/playbook/index.js';
import { registerSetupCommand, type SetupCartographModule } from '../../features/setup/index.js';
import { registerSyncIfDirtyCommand, type SyncIfDirtyCommandDeps } from '../../features/sync-if-dirty/index.js';
import { registerTraceToCulpritsCommand } from '../../features/trace-to-culprits/index.js';
import { registerViewerCommand, type ViewerServerModule } from '../../features/viewer/index.js';

type CommandLike = CliOptionCommand;
type SyncIfDirtyCartographModule = Awaited<ReturnType<SyncIfDirtyCommandDeps['loadCartograph']>>;
type LifecycleCartographModule = SetupCartographModule & SyncIfDirtyCartographModule;

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

export interface LifecycleCommandDeps {
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
  loadCartograph: () => Promise<LifecycleCartographModule>;
  isInitialized: (projectPath: string) => boolean;
  hasUncommittedChanges: (projectPath: string) => boolean;
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
    runDoctor: (opts: DoctorRunOptions | { projectPath: string }) => Promise<DoctorResult>;
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
  loadCartograph: cliLoadCartograph as () => Promise<LifecycleCartographModule>,
  isInitialized: defaultIsInitialized,
  hasUncommittedChanges: defaultHasUncommittedChanges,
  loadMcpServer: (() => import('../../mcp/index.js')) as LifecycleCommandDeps['loadMcpServer'],
  loadMcpDaemon: (() => import('../../mcp/daemon.js')) as LifecycleCommandDeps['loadMcpDaemon'],
  loadInstallerTargets: (() =>
    import('../../installer/targets/registry.js')) as LifecycleCommandDeps['loadInstallerTargets'],
  loadInstaller: (() => import('../../installer/index.js')) as LifecycleCommandDeps['loadInstaller'],
  loadLlmSetupCli: () => import('../../installer/llm-setup-cli.js'),
  loadToolHandler: () => import('../../mcp/tools.js'),
  loadMcpLoadBudget: () => import('../../mcp/load-budget.js'),
  loadViewerServer: () => import('../../features/viewer/server/index.js'),
  loadDoctor: (() => import('../../installer/doctor.js')) as unknown as LifecycleCommandDeps['loadDoctor'],
  loadBackendRuntime: () => import('../../features/backend/index.js'),
  loadLlmSmoke: () => import('../../features/llm-smoke/index.js'),
  loadInstallModels: (() => import('../../installer/install-models.js')) as LifecycleCommandDeps['loadInstallModels'],
  loadRecommendedModels: (() =>
    import('../../llm/recommended-models.js')) as LifecycleCommandDeps['loadRecommendedModels'],
  loadRecommendedConfig: (() =>
    import('../../installer/recommended-config.js')) as LifecycleCommandDeps['loadRecommendedConfig'],
};

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
  registerLlmSmokeCommand(deps);
  registerTraceToCulpritsCommand(deps);
  registerSyncIfDirtyCommand({
    program: deps.program,
    resolveProjectPath: deps.resolveProjectPath,
    isInitialized: deps.isInitialized,
    hasUncommittedChanges: deps.hasUncommittedChanges,
    loadCartograph: deps.loadCartograph,
    info: deps.info,
    error: deps.error,
    writeStderr: deps.writeStderr,
  });
  registerPlaybookCommand(deps);
  registerViewerCommand(deps);
  registerBackendCommand(deps);
  registerDoctorCommand(deps);
  registerSetupCommand(deps);
}
