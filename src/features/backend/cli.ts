import type {
  BackendLogsReport,
  BackendRestartResult,
  BackendStartResult,
  BackendStatusReport,
  BackendStatusRow,
  BackendStopResult,
  renderBackendStartCommand,
} from './runtime.js';
import { parseOptionalPositiveInt } from '../shared/cli-args.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface BackendRuntimeModule {
  backendStatus: (projectPath: string, options?: { bin?: string }) => Promise<BackendStatusReport>;
  startBackends: (options: { projectPath: string; bin?: string; dryRun?: boolean }) => Promise<BackendStartResult>;
  stopBackends: (options: { projectPath: string; force?: boolean }) => Promise<BackendStopResult>;
  restartBackends: (options: {
    projectPath: string;
    bin?: string;
    tier?: string;
    force?: boolean;
    dryRun?: boolean;
  }) => Promise<BackendRestartResult>;
  backendLogs: (options: { projectPath: string; tier?: string; lines?: number }) => Promise<BackendLogsReport>;
  renderBackendStartCommand: typeof renderBackendStartCommand;
}

export interface BackendCommandDeps {
  program: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  error: (message: string) => void;
  writeStdout: (message?: string) => void;
  loadBackendRuntime: () => Promise<BackendRuntimeModule>;
}

/** Shared collaborators threaded to each subcommand registrar. */
interface BackendCommandContext {
  resolveProjectPath: (pathArg?: string) => string;
  loadBackendRuntime: () => Promise<BackendRuntimeModule>;
  writeStdout: (message?: string) => void;
  error: (message: string) => void;
}

export function registerBackendCommand(deps: BackendCommandDeps): void {
  const backendCmd = deps.program
    .command('backend')
    .description('Manage configured local llama-server backends for this project');
  const ctx: BackendCommandContext = {
    resolveProjectPath: deps.resolveProjectPath,
    loadBackendRuntime: deps.loadBackendRuntime,
    writeStdout: deps.writeStdout,
    error: deps.error,
  };
  registerStatusCommand(backendCmd, ctx);
  registerStartCommand(backendCmd, ctx);
  registerRestartCommand(backendCmd, ctx);
  registerStopCommand(backendCmd, ctx);
  registerLogsCommand(backendCmd, ctx);
}

/** Exit non-zero when there is nothing usable to (re)start — no managed
 *  tiers at all, or a configured model file is missing. Shared by `start`
 *  and `restart`. */
function exitIfNoUsableBackends(result: BackendStatusReport): void {
  if (result.rows.length === 0 || result.rows.some((row) => row.state === 'missing-model')) {
    process.exitCode = 1;
  }
}

function registerStatusCommand(backendCmd: CommandLike, ctx: BackendCommandContext): void {
  backendCmd
    .command('status [path]')
    .description('Show configured local llama-server backend status')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { json?: boolean }) => {
      const projectPath = ctx.resolveProjectPath(pathArg);
      const runtime = await ctx.loadBackendRuntime();
      const result = await runtime.backendStatus(projectPath);
      ctx.writeStdout(options.json ? JSON.stringify(result, null, 2) : formatBackendStatusReport(result, runtime));
    });
}

function registerStartCommand(backendCmd: CommandLike, ctx: BackendCommandContext): void {
  backendCmd
    .command('start [path]')
    .description('Start configured local llama-server backend processes in the background')
    .option('--bin <path>', 'llama-server binary path (default: llama-server)')
    .option('--dry-run', 'Print what would be started without spawning processes')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { bin?: string; dryRun?: boolean; json?: boolean }) => {
      const projectPath = ctx.resolveProjectPath(pathArg);
      const runtime = await ctx.loadBackendRuntime();
      const result = await runtime.startBackends({
        projectPath,
        ...(options.bin ? { bin: options.bin } : {}),
        dryRun: options.dryRun === true,
      });
      ctx.writeStdout(
        options.json
          ? JSON.stringify(result, null, 2)
          : formatBackendStartReport(result, runtime, options.dryRun === true),
      );
      exitIfNoUsableBackends(result);
    });
}

function registerRestartCommand(backendCmd: CommandLike, ctx: BackendCommandContext): void {
  backendCmd
    .command('restart [path]')
    .description(
      'Restart managed local llama-server backends so config changes (concurrency / llamaServerArgs) take effect',
    )
    .option('--bin <path>', 'llama-server binary path (default: llama-server)')
    .option('--tier <name>', 'Only restart one tier label (embed, summarize, local, ask, rerank)')
    .option('--force', 'SIGKILL a managed process that does not exit after SIGTERM before respawning')
    .option('--dry-run', 'Print what would be restarted without stopping or spawning processes')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(
      async (
        pathArg: string | undefined,
        options: { bin?: string; tier?: string; force?: boolean; dryRun?: boolean; json?: boolean },
      ) => {
        const projectPath = ctx.resolveProjectPath(pathArg);
        const runtime = await ctx.loadBackendRuntime();
        const result = await runtime.restartBackends({
          projectPath,
          ...(options.bin ? { bin: options.bin } : {}),
          ...(options.tier ? { tier: options.tier } : {}),
          force: options.force === true,
          dryRun: options.dryRun === true,
        });
        ctx.writeStdout(
          options.json
            ? JSON.stringify(result, null, 2)
            : formatBackendRestartReport(result, runtime, options.dryRun === true),
        );
        exitIfNoUsableBackends(result);
      },
    );
}

function registerStopCommand(backendCmd: CommandLike, ctx: BackendCommandContext): void {
  backendCmd
    .command('stop [path]')
    .description('Stop local llama-server backend processes started by `cartograph backend start`')
    .option('--force', 'Send SIGKILL if a process does not exit after SIGTERM')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { force?: boolean; json?: boolean }) => {
      const projectPath = ctx.resolveProjectPath(pathArg);
      const runtime = await ctx.loadBackendRuntime();
      const result = await runtime.stopBackends({ projectPath, force: options.force === true });
      ctx.writeStdout(options.json ? JSON.stringify(result, null, 2) : formatBackendStopReport(result, runtime));
    });
}

function registerLogsCommand(backendCmd: CommandLike, ctx: BackendCommandContext): void {
  backendCmd
    .command('logs [path]')
    .description('Tail logs for configured local llama-server backend processes')
    .option('--tier <name>', 'Only show logs for one tier label (embed, summarize, local, ask, rerank)')
    .option('--lines <n>', 'Number of log lines per backend to show (default 80)')
    .option('--json', 'Print structured JSON instead of Markdown')
    .action(async (pathArg: string | undefined, options: { tier?: string; lines?: string; json?: boolean }) => {
      const projectPath = ctx.resolveProjectPath(pathArg);
      const lines = parseOptionalPositiveInt(options.lines, '--lines', ctx.error);
      if (lines === null) return;
      const runtime = await ctx.loadBackendRuntime();
      const result = await runtime.backendLogs({
        projectPath,
        ...(options.tier ? { tier: options.tier } : {}),
        ...(lines === undefined ? {} : { lines }),
      });
      ctx.writeStdout(options.json ? JSON.stringify(result, null, 2) : formatBackendLogsReport(result));
      if (options.tier && result.logs.length === 0) process.exitCode = 1;
    });
}

function formatBackendStatusReport(result: BackendStatusReport, runtime: BackendRuntimeModule): string {
  const lines = ['## cartograph backend status', ''];
  if (result.rows.length === 0) {
    lines.push(`_No managed backend processes._ ${result.unmanagedReason ?? ''}`.trim());
    return lines.join('\n');
  }
  appendBackendRows(lines, result.rows, runtime);
  return lines.join('\n');
}

function formatBackendStartReport(result: BackendStartResult, runtime: BackendRuntimeModule, dryRun: boolean): string {
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

function formatBackendRestartReport(
  result: BackendRestartResult,
  runtime: BackendRuntimeModule,
  dryRun: boolean,
): string {
  const lines = ['## cartograph backend restart', ''];
  if (dryRun) lines.push('_Dry run: no processes were stopped or started._', '');
  if (result.restarted.length > 0) {
    const verb = dryRun ? 'Would restart' : 'Restarted';
    lines.push(`${verb} ${result.restarted.length} backend process${result.restarted.length === 1 ? '' : 'es'}.`, '');
  }
  if (result.external.length > 0) {
    lines.push('External (cartograph cannot restart these — relaunch your own process):');
    for (const ext of result.external) lines.push(`- ${ext.row.spec.labels.join('/')} — ${ext.message}`);
    lines.push('');
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

function formatBackendStopReport(result: BackendStopResult, runtime: BackendRuntimeModule): string {
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

function appendBackendRows(lines: string[], rows: readonly BackendStatusRow[], runtime: BackendRuntimeModule): void {
  for (const row of rows) {
    lines.push(...formatBackendRow(row, runtime));
  }
}

function formatBackendRow(row: BackendStatusRow, runtime: BackendRuntimeModule): string[] {
  const icon = backendStateIcon(row.state);
  const pid = backendPidLabel(row);
  const lines = [
    `${icon} **${row.spec.labels.join('/')}** — ${row.state} at ${row.spec.endpoint}${pid}`,
    `  model: ${row.spec.modelPath}`,
    `  log: ${row.logPath}`,
    `  command: ${runtime.renderBackendStartCommand(row.spec)}`,
  ];
  if (row.origin === 'orphan') {
    lines.push(
      `  ⚠ orphaned: this endpoint is no longer in config (model/port changed?); run \`cartograph backend stop ${resultProjectPathFromRow(row)}\` to stop it and free its memory.`,
    );
  }
  if (row.pidRecord && !row.pidAlive) {
    lines.push(`  stale pid cleanup: cartograph backend stop ${resultProjectPathFromRow(row)}`);
  }
  if (row.state === 'starting') {
    lines.push(`  readiness: process is alive but endpoint is not reachable yet; inspect logs if it stays here.`);
  }
  if (row.spec.externallyManaged) {
    lines.push(`  externally managed: cartograph reports this tier but never starts/stops/restarts it.`);
  }
  if (row.configDrift) {
    lines.push(
      `  ⚠ config drift: the running process was started with different llama-server args than current config would use.`,
      `    running: ${row.configDrift.current.join(' ')}`,
      `    config:  ${row.configDrift.requested.join(' ')}`,
      `    apply:   cartograph backend restart ${resultProjectPathFromRow(row)}`,
    );
  }
  return lines;
}

function backendPidLabel(row: BackendStatusRow): string {
  if (!row.pidRecord?.pid) return '';
  const stale = row.pidAlive ? '' : ' stale';
  return ` pid=${row.pidRecord.pid}${stale}`;
}

function backendStateIcon(state: BackendStatusRow['state']): string {
  if (state === 'running' || state === 'external') return '✓';
  if (state === 'missing-model') return '✗';
  return '○';
}

function resultProjectPathFromRow(row: BackendStatusRow): string {
  const marker = `${pathSeparator()}.cartograph${pathSeparator()}backends${pathSeparator()}`;
  const idx = row.pidFilePath.indexOf(marker);
  return idx >= 0 ? row.pidFilePath.slice(0, idx) : '<project>';
}

function pathSeparator(): string {
  return process.platform === 'win32' ? '\\' : '/';
}

function formatBackendLogsReport(result: BackendLogsReport): string {
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
