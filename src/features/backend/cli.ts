import type {
  BackendLogsReport,
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

export function registerBackendCommand(deps: BackendCommandDeps): void {
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
      if (result.rows.length === 0 || result.rows.some((row) => row.state === 'missing-model')) process.exit(1);
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
