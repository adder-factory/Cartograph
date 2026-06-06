/**
 * Local llama-server backend lifecycle helpers.
 *
 * Cartograph does not own arbitrary OpenAI-compatible backends. This
 * module manages only the recommended local llama-server shape: a
 * configured `openai-compat` tier whose `model` is an absolute GGUF
 * path and whose `endpoint` is bound to localhost. Ollama / cloud /
 * mlx_lm / LM Studio remain externally managed and are only reported
 * by doctor / smoke checks.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { loadConfig } from '../config.js';
import { isProcessAlive } from '../utils-concurrency.js';
import { LLAMA_SERVER_RERANK_FLAG } from './llm-setup-catalog.js';
import { recommendedTuning } from './hardware-tuning.js';
import { normaliseEndpoint, scanForLlmBackends } from './scan-backends.js';

export const LLM_TIER_KEYS = ['summarizeLlm', 'localLlm', 'askLlm', 'embeddingLlm', 'rerankerLlm'] as const;
export type LlmTierKey = (typeof LLM_TIER_KEYS)[number];

const LOCAL_BACKEND_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const BACKEND_STATE_DIR = 'backends';
const PID_FILE_SCHEMA_VERSION = 1;
const STOP_WAIT_MS = 3000;
const STOP_POLL_MS = 100;
const DEFAULT_LOG_TAIL_LINES = 80;

export interface ConfiguredModelFile {
  readonly tier: LlmTierKey;
  readonly modelPath: string;
}

export interface BackendProcessSpec {
  readonly id: string;
  readonly labels: readonly string[];
  readonly endpoint: string;
  readonly modelPath: string;
  readonly host: string;
  readonly port: string;
  readonly parallel: number;
  readonly extraArgs: readonly string[];
  readonly command: string;
  readonly args: readonly string[];
}

export interface BackendPidFile {
  readonly schemaVersion: number;
  readonly pid: number;
  readonly startedAt: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly endpoint: string;
  readonly modelPath: string;
  readonly labels: readonly string[];
  readonly logPath: string;
}

export type BackendRuntimeState = 'running' | 'starting' | 'external' | 'stopped' | 'missing-model';

export interface BackendStatusRow {
  readonly spec: BackendProcessSpec;
  readonly pidFilePath: string;
  readonly logPath: string;
  readonly pidRecord: BackendPidFile | null;
  readonly pidAlive: boolean;
  readonly endpointReachable: boolean;
  readonly modelExists: boolean;
  readonly state: BackendRuntimeState;
}

export interface BackendStatusReport {
  readonly projectPath: string;
  readonly stateDir: string;
  readonly rows: readonly BackendStatusRow[];
  readonly unmanagedReason?: string;
}

export interface BackendStartOptions {
  readonly projectPath: string;
  readonly bin?: string;
  readonly dryRun?: boolean;
}

export interface BackendStartResult extends BackendStatusReport {
  readonly started: readonly BackendStatusRow[];
  readonly skipped: readonly { row: BackendStatusRow; reason: string }[];
}

export interface BackendStopOptions {
  readonly projectPath: string;
  readonly force?: boolean;
}

export interface BackendStopResult extends BackendStatusReport {
  readonly stopped: readonly BackendStatusRow[];
  readonly skipped: readonly { row: BackendStatusRow; reason: string }[];
}

export interface BackendLogsOptions {
  readonly projectPath: string;
  readonly tier?: string;
  readonly lines?: number;
}

export interface BackendLogRow {
  readonly row: BackendStatusRow;
  readonly exists: boolean;
  readonly content: string;
  readonly error?: string;
}

export interface BackendLogsReport extends BackendStatusReport {
  readonly logs: readonly BackendLogRow[];
}

export function configuredModelFilesFromLlm(llm: Record<string, unknown> | null): ConfiguredModelFile[] {
  if (!llm) return [];
  const out: ConfiguredModelFile[] = [];
  for (const tier of LLM_TIER_KEYS) {
    const block = llm[tier];
    if (typeof block !== 'object' || block === null) continue;
    const cfg = block as Record<string, unknown>;
    if (cfg['provider'] !== 'openai-compat') continue;
    const model = cfg['model'];
    if (typeof model !== 'string' || model.length === 0) continue;
    if (!path.isAbsolute(model)) continue;
    out.push({ tier, modelPath: model });
  }
  return out;
}

export function configuredEndpointsFromLlm(llm: Record<string, unknown> | null): string[] {
  if (!llm) return [];
  const endpoints: string[] = [];
  for (const tier of LLM_TIER_KEYS) {
    const block = llm[tier];
    if (typeof block !== 'object' || block === null) continue;
    const endpoint = (block as Record<string, unknown>)['endpoint'];
    if (typeof endpoint === 'string' && endpoint.length > 0) endpoints.push(endpoint);
  }
  return [...new Set(endpoints)];
}

export function readProjectLlm(projectPath: string): Record<string, unknown> | null {
  try {
    const cfg = loadConfig(projectPath) as unknown as Record<string, unknown>;
    const llm = cfg['llm'];
    return typeof llm === 'object' && llm !== null ? (llm as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function buildBackendProcessSpecs(
  llm: Record<string, unknown> | null,
  options: { bin?: string } = {},
): BackendProcessSpec[] {
  if (!llm) return [];
  const tuning = recommendedTuning();
  const specs = new Map<string, MutableBackendProcessSpec>();
  const command = options.bin ?? 'llama-server';

  for (const tier of LLM_TIER_KEYS) {
    const block = llm[tier];
    if (typeof block !== 'object' || block === null) continue;
    const cfg = block as Record<string, unknown>;
    if (cfg['provider'] !== 'openai-compat') continue;
    const model = cfg['model'];
    const endpoint = cfg['endpoint'];
    if (typeof model !== 'string' || typeof endpoint !== 'string') continue;
    if (!path.isAbsolute(model)) continue;

    const parsed = parseLocalEndpoint(endpoint);
    if (!parsed) continue;
    const extraArgs = llamaServerExtraArgsForTier(tier);
    const key = `${normaliseEndpoint(endpoint)}\0${model}\0${extraArgs.join('\0')}`;
    const existing = specs.get(key);
    if (existing) {
      existing.labels.push(llmTierLabel(tier));
      continue;
    }
    const labels = [llmTierLabel(tier)];
    const parallel = llamaServerParallelForTier(tuning, tier);
    const args = [
      '-m',
      model,
      '--host',
      parsed.host,
      '--port',
      parsed.port,
      ...extraArgs,
      '--parallel',
      String(parallel),
    ];
    specs.set(key, {
      id: backendSpecId(endpoint, model, extraArgs),
      labels,
      endpoint: normaliseEndpoint(endpoint),
      modelPath: model,
      host: parsed.host,
      port: parsed.port,
      parallel,
      extraArgs,
      command,
      args,
    });
  }

  return [...specs.values()].map((spec) => ({ ...spec, labels: [...spec.labels] }));
}

interface MutableBackendProcessSpec extends Omit<BackendProcessSpec, 'labels'> {
  readonly labels: string[];
}

export function renderBackendStartCommand(spec: BackendProcessSpec): string {
  return `${spec.command} ${spec.args.map(shellQuote).join(' ')}`;
}

export function renderBackendStartCommands(llm: Record<string, unknown> | null): string[] {
  return buildBackendProcessSpecs(llm).map((spec) => {
    const label = spec.labels.join('/');
    return `# ${label} ${spec.endpoint}\n  ${renderBackendStartCommand(spec)}`;
  });
}

export async function backendStatus(projectPath: string, options: { bin?: string } = {}): Promise<BackendStatusReport> {
  const stateDir = backendStateDir(projectPath);
  const specs = buildBackendProcessSpecs(readProjectLlm(projectPath), options);
  if (specs.length === 0) {
    return {
      projectPath,
      stateDir,
      rows: [],
      unmanagedReason:
        'No configured local llama-server tiers found. `cartograph backend` only manages openai-compat tiers with localhost endpoints and absolute GGUF model paths.',
    };
  }

  const detected = await scanForLlmBackends(specs.map((spec) => spec.endpoint)).catch(() => []);
  const reachableEndpoints = new Set(detected.map((backend) => backend.endpoint));
  const rows: BackendStatusRow[] = [];
  for (const spec of specs) {
    const paths = backendPaths(projectPath, spec);
    const pidRecord = await readPidFile(paths.pidFilePath);
    const pidAlive = pidRecord ? isProcessAlive(pidRecord.pid) : false;
    const endpointReachable = reachableEndpoints.has(spec.endpoint);
    const modelExists = await pathExists(spec.modelPath);
    rows.push({
      spec,
      pidFilePath: paths.pidFilePath,
      logPath: paths.logPath,
      pidRecord,
      pidAlive,
      endpointReachable,
      modelExists,
      state: backendRuntimeState({ pidAlive, endpointReachable, modelExists, pidRecord }),
    });
  }
  return { projectPath, stateDir, rows };
}

export async function startBackends(options: BackendStartOptions): Promise<BackendStartResult> {
  const backendStatusOptions = options.bin === undefined ? {} : { bin: options.bin };
  const before = await backendStatus(options.projectPath, backendStatusOptions);
  const started: BackendStatusRow[] = [];
  const skipped: Array<{ row: BackendStatusRow; reason: string }> = [];
  if (before.rows.length === 0 || options.dryRun) return { ...before, started, skipped };

  await fsp.mkdir(before.stateDir, { recursive: true });
  for (const row of before.rows) {
    if (!row.modelExists) {
      skipped.push({ row, reason: `model file missing: ${row.spec.modelPath}` });
      continue;
    }
    if (row.pidAlive) {
      skipped.push({ row, reason: `already running as pid ${row.pidRecord?.pid}` });
      continue;
    }
    if (row.endpointReachable) {
      skipped.push({ row, reason: `endpoint already reachable at ${row.spec.endpoint}; assuming external process` });
      continue;
    }
    const child = spawnDetachedBackend(row);
    await writePidFile(row, child.pid ?? 0);
    started.push(row);
  }

  const after = await backendStatus(options.projectPath, backendStatusOptions);
  return { ...after, started, skipped };
}

export async function stopBackends(options: BackendStopOptions): Promise<BackendStopResult> {
  const before = await backendStatus(options.projectPath);
  const stopped: BackendStatusRow[] = [];
  const skipped: Array<{ row: BackendStatusRow; reason: string }> = [];
  for (const row of before.rows) {
    const pid = row.pidRecord?.pid;
    if (!pid) {
      skipped.push({
        row,
        reason: row.endpointReachable ? 'endpoint is external; no Cartograph pid file' : 'not running',
      });
      continue;
    }
    if (!row.pidAlive) {
      await removePidFile(row.pidFilePath);
      skipped.push({ row, reason: `stale pid file removed for pid ${pid}` });
      continue;
    }
    process.kill(pid, 'SIGTERM');
    const exited = await waitForExit(pid, STOP_WAIT_MS);
    if (!exited && options.force) {
      process.kill(pid, 'SIGKILL');
      await waitForExit(pid, STOP_WAIT_MS);
    }
    await removePidFile(row.pidFilePath);
    stopped.push(row);
  }
  const after = await backendStatus(options.projectPath);
  return { ...after, stopped, skipped };
}

export async function backendLogs(options: BackendLogsOptions): Promise<BackendLogsReport> {
  const status = await backendStatus(options.projectPath);
  const requestedTier = options.tier?.toLowerCase();
  const rows = requestedTier
    ? status.rows.filter((row) => row.spec.labels.some((label) => label.toLowerCase() === requestedTier))
    : status.rows;
  const lines = options.lines ?? DEFAULT_LOG_TAIL_LINES;
  const logs = await Promise.all(
    rows.map(async (row) => {
      try {
        const content = await tailTextFile(row.logPath, lines);
        return { row, exists: true, content } satisfies BackendLogRow;
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          return { row, exists: false, content: '' } satisfies BackendLogRow;
        }
        return {
          row,
          exists: false,
          content: '',
          error: err instanceof Error ? err.message : String(err),
        } satisfies BackendLogRow;
      }
    }),
  );
  return { ...status, logs };
}

function backendRuntimeState(input: {
  pidAlive: boolean;
  endpointReachable: boolean;
  modelExists: boolean;
  pidRecord: BackendPidFile | null;
}): BackendRuntimeState {
  if (!input.modelExists) return 'missing-model';
  if (input.pidAlive && input.endpointReachable) return 'running';
  if (input.pidAlive) return 'starting';
  if (input.endpointReachable && !input.pidRecord) return 'external';
  if (input.endpointReachable) return 'running';
  return 'stopped';
}

function backendStateDir(projectPath: string): string {
  return path.join(projectPath, '.cartograph', BACKEND_STATE_DIR);
}

function backendPaths(projectPath: string, spec: BackendProcessSpec): { pidFilePath: string; logPath: string } {
  const dir = backendStateDir(projectPath);
  return {
    pidFilePath: path.join(dir, `${spec.id}.json`),
    logPath: path.join(dir, `${spec.id}.log`),
  };
}

async function readPidFile(filePath: string): Promise<BackendPidFile | null> {
  try {
    const parsed = JSON.parse(await fsp.readFile(filePath, 'utf8')) as BackendPidFile;
    if (parsed.schemaVersion !== PID_FILE_SCHEMA_VERSION) return null;
    if (!Number.isInteger(parsed.pid) || parsed.pid <= 0) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writePidFile(row: BackendStatusRow, pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  await fsp.writeFile(
    row.pidFilePath,
    JSON.stringify(
      {
        schemaVersion: PID_FILE_SCHEMA_VERSION,
        pid,
        startedAt: new Date().toISOString(),
        command: row.spec.command,
        args: row.spec.args,
        endpoint: row.spec.endpoint,
        modelPath: row.spec.modelPath,
        labels: row.spec.labels,
        logPath: row.logPath,
      } satisfies BackendPidFile,
      null,
      2,
    ),
    'utf8',
  );
}

async function removePidFile(filePath: string): Promise<void> {
  await fsp.unlink(filePath).catch(() => undefined);
}

function openLogFd(logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return fs.openSync(logPath, 'a');
}

function spawnDetachedBackend(row: BackendStatusRow): ReturnType<typeof spawn> {
  const stdoutFd = openLogFd(row.logPath);
  const stderrFd = openLogFd(row.logPath);
  try {
    const child = spawn(row.spec.command, row.spec.args, {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return !isProcessAlive(pid);
}

function parseLocalEndpoint(endpoint: string): { host: string; port: string } | null {
  try {
    const url = new URL(normaliseEndpoint(endpoint));
    if (!LOCAL_BACKEND_HOSTS.has(url.hostname)) return null;
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    const port = url.port || (url.protocol === 'https:' ? '443' : '80');
    return { host, port };
  } catch {
    return null;
  }
}

function llamaServerExtraArgsForTier(tier: LlmTierKey): readonly string[] {
  if (tier === 'embeddingLlm') return ['--embeddings', '--batch-size', '512', '--ubatch-size', '512'];
  if (tier === 'rerankerLlm') return [LLAMA_SERVER_RERANK_FLAG];
  return [];
}

function llamaServerParallelForTier(tuning: ReturnType<typeof recommendedTuning>, tier: LlmTierKey): number {
  if (tier === 'embeddingLlm') return tuning.embed.llamaServerParallel;
  if (tier === 'askLlm') return tuning.ask.llamaServerParallel;
  if (tier === 'rerankerLlm') return tuning.reranker.llamaServerParallel;
  return tuning.chat.llamaServerParallel;
}

function llmTierLabel(tier: LlmTierKey): string {
  if (tier === 'summarizeLlm') return 'summarize';
  if (tier === 'localLlm') return 'local';
  if (tier === 'askLlm') return 'ask';
  if (tier === 'embeddingLlm') return 'embed';
  return 'rerank';
}

function backendSpecId(endpoint: string, modelPath: string, extraArgs: readonly string[]): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${normaliseEndpoint(endpoint)}\0${modelPath}\0${extraArgs.join('\0')}`)
    .digest('hex')
    .slice(0, 12);
  return `llama-${hash}`;
}

async function pathExists(filePath: string): Promise<boolean> {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function tailTextFile(filePath: string, maxLines: number): Promise<string> {
  const text = await fsp.readFile(filePath, 'utf8');
  const lines = text.split(/\r?\n/);
  return lines
    .slice(Math.max(0, lines.length - maxLines))
    .join('\n')
    .trimEnd();
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
