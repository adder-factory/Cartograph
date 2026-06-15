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
import { z } from 'zod';
import { spawn, type ChildProcess } from 'node:child_process';
import { loadConfig } from '../../config.js';
import { isProcessAlive } from '../../utils-concurrency.js';
import { LLAMA_SERVER_RERANK_FLAG } from '../../installer/llm-setup-catalog.js';
import { recommendedTuning } from '../../installer/hardware-tuning.js';
import { normaliseEndpoint, scanForLlmBackends } from '../../installer/scan-backends.js';

export const LLM_TIER_KEYS = [
  'summarizeLlm',
  'localLlm',
  'askLlm',
  'classifyLlm',
  'embeddingLlm',
  'rerankerLlm',
] as const;
export type LlmTierKey = (typeof LLM_TIER_KEYS)[number];

export const LOCAL_BACKEND_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const BACKEND_STATE_DIR = 'backends';
const PID_FILE_SCHEMA_VERSION = 1;
const STOP_WAIT_MS = 3000;
const STOP_POLL_MS = 100;
const DEFAULT_LOG_TAIL_LINES = 80;
const SPAWN_CONFIRM_TIMEOUT_MS = 1000;
const LOG_TAIL_MAX_BYTES = 512 * 1024;

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
  /** True when a configured tier declared `externallyManaged: true` —
   *  cartograph never starts/stops/restarts it (issue #30). Absent on
   *  orphan specs (those ARE cartograph-tracked processes). */
  readonly externallyManaged?: boolean;
}

/** A divergence between the args a managed backend was actually started
 *  with and the args a fresh spawn would use under the CURRENT config —
 *  i.e. a config change (concurrency / llamaServerArgs / model) that the
 *  running process predates and has not picked up (issue #30). */
export interface BackendConfigDrift {
  /** Args the live process was launched with (from its pid file). */
  readonly current: readonly string[];
  /** Args a fresh `backend start` would use with the current config. */
  readonly requested: readonly string[];
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

/** On-disk pid file shape. Validated on read because the file can be
 *  stale or partially-written across crashes/restarts; the version
 *  literal makes a schema bump reject old files, and a positive-int pid
 *  is required before we treat any process as live. */
const BackendPidFileSchema = z.object({
  schemaVersion: z.literal(PID_FILE_SCHEMA_VERSION),
  pid: z.number().int().positive(),
  startedAt: z.string(),
  command: z.string(),
  args: z.array(z.string()),
  endpoint: z.string(),
  modelPath: z.string(),
  labels: z.array(z.string()),
  logPath: z.string(),
});

export type BackendRuntimeState = 'running' | 'starting' | 'external' | 'stopped' | 'missing-model';

export interface BackendStatusRow {
  readonly spec: BackendProcessSpec;
  /** `config` — derived from a currently-configured tier. `orphan` —
   *  a pid file left in the state dir whose endpoint is no longer in
   *  config (e.g. after a tier's endpoint changed); surfaced so `stop`
   *  can reclaim the still-running process instead of stranding it. */
  readonly origin: 'config' | 'orphan';
  readonly pidFilePath: string;
  readonly logPath: string;
  readonly pidRecord: BackendPidFile | null;
  readonly pidAlive: boolean;
  readonly endpointReachable: boolean;
  readonly modelExists: boolean;
  readonly state: BackendRuntimeState;
  /** Non-null when this is a live cartograph-managed process whose launch
   *  args diverge from current config (issue #30). Always null for dead /
   *  external / orphan rows. */
  readonly configDrift?: BackendConfigDrift | null;
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

export interface BackendRestartOptions {
  readonly projectPath: string;
  readonly bin?: string;
  /** Restrict the restart to one tier label (embed / summarize / local /
   *  ask / rerank); when absent, all configured managed tiers restart. */
  readonly tier?: string;
  /** SIGKILL a managed process that outlasts the SIGTERM grace period
   *  before respawning — otherwise the old process keeps the port and the
   *  fresh spawn fails with EADDRINUSE. Mirrors `backend stop --force`. */
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface BackendRestartResult extends BackendStatusReport {
  readonly restarted: readonly BackendStatusRow[];
  readonly skipped: readonly { row: BackendStatusRow; reason: string }[];
  /** Tiers cartograph cannot restart because the process is not ours
   *  (declared `externallyManaged`, or a reachable non-cartograph process):
   *  the operator must relaunch their own llama-server to apply config. */
  readonly external: readonly { row: BackendStatusRow; message: string }[];
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
    const built = buildTierBackendSpec(tier, llm[tier], { command, tuning });
    if (!built) continue;
    // A managed backend's identity (its dedup `key`) is its endpoint
    // PLUS the stable per-tier-kind mode flags — see `buildTierBackendSpec`.
    const existing = specs.get(built.key);
    if (existing) {
      existing.labels.push(built.label);
      // If ANY tier sharing this endpoint declares external, the merged
      // process is external (cartograph must not own a process a tier
      // explicitly disclaims).
      if (built.spec.externallyManaged) existing.externallyManaged = true;
      continue;
    }
    specs.set(built.key, built.spec);
  }

  return [...specs.values()].map((spec) => ({ ...spec, labels: [...spec.labels] }));
}

interface MutableBackendProcessSpec extends Omit<BackendProcessSpec, 'labels' | 'externallyManaged'> {
  labels: string[];
  externallyManaged?: boolean;
}

/**
 * Validate one LLM tier block and, if it describes a managed local
 * llama-server, build its process spec + dedup key.
 *
 * The dedup key / `backendSpecId` are the endpoint PLUS the stable
 * per-tier-kind mode flags (`--embeddings` / `--reranking`) — but NOT
 * the model, `llamaServerArgs`, or concurrency, all of which a user can
 * change. Excluding those mutable bits is what lets a later model/flag
 * change still resolve the same pid file (see `pidRecordMatchesSpec`)
 * instead of orphaning the live process; keeping the mode flags in
 * keeps an embed/rerank tier that shares a port with chat a distinct
 * process (different llama-server mode) rather than silently merging
 * into chat and dropping `--embeddings`.
 */
function buildTierBackendSpec(
  tier: LlmTierKey,
  block: unknown,
  ctx: { command: string; tuning: ReturnType<typeof recommendedTuning> },
): { key: string; label: string; spec: MutableBackendProcessSpec } | null {
  if (typeof block !== 'object' || block === null) return null;
  const cfg = block as Record<string, unknown>;
  if (cfg['provider'] !== 'openai-compat') return null;
  const model = cfg['model'];
  const endpoint = cfg['endpoint'];
  if (typeof model !== 'string' || typeof endpoint !== 'string') return null;
  if (!path.isAbsolute(model)) return null;
  const parsed = parseLocalEndpoint(endpoint);
  if (!parsed) return null;

  const extraArgs = llamaServerExtraArgsForTier(tier);
  const passthrough = llamaServerPassthroughArgs(cfg);
  const parallel = resolveTierParallel(ctx.tuning, tier, cfg);
  const args = [
    '-m',
    model,
    '--host',
    parsed.host,
    '--port',
    parsed.port,
    ...extraArgs,
    // A user-pinned `--parallel`/`-np` in `llamaServerArgs` wins — skip
    // the computed one so the passthrough stays authoritative.
    ...(passthroughHasParallelFlag(passthrough) ? [] : ['--parallel', String(parallel)]),
    ...passthrough,
  ];
  return {
    key: `${normaliseEndpoint(endpoint)}\0${extraArgs.join('\0')}`,
    label: llmTierLabel(tier),
    spec: {
      id: backendSpecId(endpoint, extraArgs),
      labels: [llmTierLabel(tier)],
      endpoint: normaliseEndpoint(endpoint),
      modelPath: model,
      host: parsed.host,
      port: parsed.port,
      parallel,
      extraArgs,
      command: ctx.command,
      args,
      externallyManaged: cfg['externallyManaged'] === true,
    },
  };
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
  const configSpecs = buildBackendProcessSpecs(readProjectLlm(projectPath), options);
  const knownIds = new Set(configSpecs.map((spec) => spec.id));
  const orphanSpecs = await discoverOrphanSpecs(stateDir, knownIds);
  if (configSpecs.length === 0 && orphanSpecs.length === 0) {
    return {
      projectPath,
      stateDir,
      rows: [],
      unmanagedReason:
        'No configured local llama-server tiers found. `cartograph backend` only manages openai-compat tiers with localhost endpoints and absolute GGUF model paths.',
    };
  }

  const allSpecs = [...configSpecs, ...orphanSpecs];
  const detected = await scanForLlmBackends(allSpecs.map((spec) => spec.endpoint)).catch(() => []);
  const reachableEndpoints = new Set(detected.map((backend) => backend.endpoint));
  const rows = await Promise.all(
    allSpecs.map((spec, index) =>
      buildBackendStatusRow({
        projectPath,
        spec,
        origin: index < configSpecs.length ? 'config' : 'orphan',
        reachableEndpoints,
      }),
    ),
  );
  return { projectPath, stateDir, rows };
}

interface BuildBackendStatusRowArgs {
  readonly projectPath: string;
  readonly spec: BackendProcessSpec;
  readonly origin: 'config' | 'orphan';
  readonly reachableEndpoints: ReadonlySet<string>;
}

async function buildBackendStatusRow(args: BuildBackendStatusRowArgs): Promise<BackendStatusRow> {
  const { projectPath, spec, origin, reachableEndpoints } = args;
  const paths = backendPaths(projectPath, spec);
  const pidRecord = await readPidFile(paths.pidFilePath);
  const pidAlive = pidRecord ? isProcessAlive(pidRecord.pid) : false;
  const endpointReachable = reachableEndpoints.has(spec.endpoint);
  const modelExists = await pathExists(spec.modelPath);
  return {
    spec,
    origin,
    pidFilePath: paths.pidFilePath,
    logPath: paths.logPath,
    pidRecord,
    pidAlive,
    endpointReachable,
    modelExists,
    state: backendRuntimeState({ pidAlive, endpointReachable, modelExists, pidRecord }),
    configDrift: detectBackendConfigDrift(pidRecord, pidAlive, spec),
  };
}

/** Detect a config-vs-running-args divergence for a live managed backend
 *  (issue #30). Returns null unless the process we launched is still alive
 *  AND its recorded launch args differ from what a fresh spawn would use
 *  under the current config. Orphan rows rebuild their spec FROM the pid
 *  record's own args, so they compare equal — no false drift. */
function detectBackendConfigDrift(
  pidRecord: BackendPidFile | null,
  pidAlive: boolean,
  spec: BackendProcessSpec,
): BackendConfigDrift | null {
  if (!pidRecord || !pidAlive) return null;
  if (argsEqual(pidRecord.args, spec.args)) return null;
  return { current: [...pidRecord.args], requested: [...spec.args] };
}

function argsEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Scan the backend state dir for pid files that no longer map to a
 * configured tier (id ∉ `knownIds`) — e.g. left behind when a tier's
 * endpoint changed in `config.json`, which the reporter previously
 * stranded as an unmanageable process bound to the old port. Each
 * orphan is rebuilt into a minimal spec from its own pid record so
 * `status` can show it and `stop` can reclaim it.
 */
async function discoverOrphanSpecs(stateDir: string, knownIds: ReadonlySet<string>): Promise<BackendProcessSpec[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(stateDir);
  } catch {
    return [];
  }
  const candidates = entries.filter(
    (entry) => entry.endsWith('.json') && !knownIds.has(entry.slice(0, -'.json'.length)),
  );
  const specs = await Promise.all(candidates.map((entry) => orphanSpecFromPidFile(stateDir, entry)));
  return specs.filter((spec): spec is BackendProcessSpec => spec !== null);
}

/** Rebuild a minimal {@link BackendProcessSpec} from a stray pid file
 *  so an orphaned backend can be shown and stopped. Returns null when
 *  the file is unreadable / fails schema validation (it is then left
 *  in place rather than acted on). */
async function orphanSpecFromPidFile(stateDir: string, entry: string): Promise<BackendProcessSpec | null> {
  const record = await readPidFile(path.join(stateDir, entry));
  if (!record) return null;
  const parsed = parseLocalEndpoint(record.endpoint);
  return {
    id: entry.slice(0, -'.json'.length),
    labels: record.labels.length > 0 ? [...record.labels] : ['orphaned'],
    endpoint: record.endpoint,
    modelPath: record.modelPath,
    host: parsed?.host ?? '',
    port: parsed?.port ?? '',
    parallel: 0,
    extraArgs: [],
    command: record.command,
    args: [...record.args],
  };
}

export async function startBackends(options: BackendStartOptions): Promise<BackendStartResult> {
  const backendStatusOptions = options.bin === undefined ? {} : { bin: options.bin };
  const before = await backendStatus(options.projectPath, backendStatusOptions);
  const started: BackendStatusRow[] = [];
  const skipped: Array<{ row: BackendStatusRow; reason: string }> = [];
  if (before.rows.length === 0 || options.dryRun) return { ...before, started, skipped };

  await fsp.mkdir(before.stateDir, { recursive: true });
  for (const row of before.rows) {
    const skipReason = backendStartSkipReason(row);
    if (skipReason !== null) {
      skipped.push({ row, reason: skipReason });
      continue;
    }
    try {
      await spawnRow(row);
      started.push(row);
    } catch (err) {
      skipped.push({ row, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const after = await backendStatus(options.projectPath, backendStatusOptions);
  return { ...after, started, skipped };
}

/** Spawn a row's backend and record its pid file. Shared by `start` and
 *  `restart`. */
async function spawnRow(row: BackendStatusRow): Promise<void> {
  const child = await spawnDetachedBackend(row);
  await writePidFile(row, child.pid);
}

/** Why `start` should NOT spawn a process for this row, or null when it
 *  is a fresh configured tier that should be launched. */
function backendStartSkipReason(row: BackendStatusRow): string | null {
  if (row.origin === 'orphan') {
    return 'orphaned backend on a port no longer in config; run `cartograph backend stop` to reclaim it';
  }
  // Declared external: never spawn — independent of whether the port is
  // live right now (so a self-managed backend that briefly drops isn't
  // replaced by a cartograph-owned copy). Issue #30.
  if (row.spec.externallyManaged) {
    return `declared externallyManaged in config — cartograph will not start it; (re)launch your own llama-server for ${row.spec.endpoint}`;
  }
  if (!row.modelExists) return `model file missing: ${row.spec.modelPath}`;
  if (row.pidAlive) return `already running as pid ${row.pidRecord?.pid}`;
  if (row.endpointReachable) return `endpoint already reachable at ${row.spec.endpoint}; assuming external process`;
  return null;
}

export async function stopBackends(options: BackendStopOptions): Promise<BackendStopResult> {
  const before = await backendStatus(options.projectPath);
  const stopped: BackendStatusRow[] = [];
  const skipped: Array<{ row: BackendStatusRow; reason: string }> = [];
  for (const row of before.rows) {
    if (row.spec.externallyManaged) {
      skipped.push({ row, reason: 'declared externallyManaged in config; cartograph does not stop it' });
      continue;
    }
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
    if (!pidRecordMatchesSpec(row)) {
      skipped.push({
        row,
        reason: `pid file does not match current backend spec; refusing to signal pid ${pid}`,
      });
      continue;
    }
    await signalAndRemoveRow(row, options.force === true);
    stopped.push(row);
  }
  const after = await backendStatus(options.projectPath);
  return { ...after, stopped, skipped };
}

/** SIGTERM a row's process, wait for exit (SIGKILL on `force` if it
 *  outlasts the grace period), then remove its pid file. Assumes the
 *  caller already confirmed the pid is alive and ours. Shared by `stop`
 *  and `restart`. */
async function signalAndRemoveRow(row: BackendStatusRow, force: boolean): Promise<void> {
  const pid = row.pidRecord?.pid;
  if (!pid) return;
  process.kill(pid, 'SIGTERM');
  const exited = await waitForExit(pid, STOP_WAIT_MS);
  if (!exited && force) {
    process.kill(pid, 'SIGKILL');
    await waitForExit(pid, STOP_WAIT_MS);
  }
  await removePidFile(row.pidFilePath);
}

/**
 * Restart cartograph-managed backends so a config change (concurrency /
 * llamaServerArgs / model) actually lands — the gap #30 names: `start`
 * skips a reachable port, so a managed backend never picks up the change
 * without an explicit stop+start. Optionally scoped to one `tier`.
 *
 * Processes that are NOT ours — declared `externallyManaged`, or a
 * reachable port with no cartograph pid file — cannot be restarted here;
 * they are returned in `external` with a relaunch hint instead of being
 * touched.
 */
export async function restartBackends(options: BackendRestartOptions): Promise<BackendRestartResult> {
  const statusOptions = options.bin === undefined ? {} : { bin: options.bin };
  const before = await backendStatus(options.projectPath, statusOptions);
  const buckets: RestartBuckets = { restarted: [], skipped: [], external: [] };

  const targets = before.rows.filter((row) => rowMatchesTierFilter(row, options.tier));
  if (targets.length === 0) return { ...before, ...buckets };
  await fsp.mkdir(before.stateDir, { recursive: true });

  for (const row of targets) await restartOneRow(row, options, buckets);

  const after = await backendStatus(options.projectPath, statusOptions);
  return { ...after, ...buckets };
}

interface RestartBuckets {
  restarted: BackendStatusRow[];
  skipped: Array<{ row: BackendStatusRow; reason: string }>;
  external: Array<{ row: BackendStatusRow; message: string }>;
}

/** Apply one row's restart disposition, routing it into the right bucket.
 *  Extracted from {@link restartBackends} to keep that function under the
 *  cognitive-complexity threshold. */
async function restartOneRow(
  row: BackendStatusRow,
  options: BackendRestartOptions,
  buckets: RestartBuckets,
): Promise<void> {
  const disposition = restartDisposition(row);
  if (disposition === 'skip-orphan') {
    buckets.skipped.push({
      row,
      reason: 'orphaned backend on a port no longer in config; run `cartograph backend stop` to reclaim it',
    });
    return;
  }
  if (disposition === 'skip-missing-model') {
    buckets.skipped.push({ row, reason: `model file missing: ${row.spec.modelPath}` });
    return;
  }
  if (disposition === 'external') {
    buckets.external.push({ row, message: backendExternalRelaunchMessage(row) });
    return;
  }
  if (options.dryRun) {
    buckets.restarted.push(row); // plan only — report what WOULD restart
    return;
  }
  if (disposition === 'managed-live') await signalAndRemoveRow(row, options.force === true);
  try {
    await spawnRow(row);
    buckets.restarted.push(row);
  } catch (err) {
    buckets.skipped.push({ row, reason: err instanceof Error ? err.message : String(err) });
  }
}

type RestartDisposition = 'skip-orphan' | 'skip-missing-model' | 'external' | 'managed-live' | 'managed-stopped';

/** Classify how `restart` should treat a row. `managed-live` = our process
 *  is running (stop then start); `managed-stopped` = ours but not running
 *  (just start); `external` = not ours (relaunch hint); the `skip-*` cases
 *  are orphans / missing models that restart leaves alone. */
function restartDisposition(row: BackendStatusRow): RestartDisposition {
  if (row.origin === 'orphan') return 'skip-orphan';
  if (row.spec.externallyManaged) return 'external';
  if (!row.modelExists) return 'skip-missing-model';
  const ours = row.pidRecord !== null && row.pidAlive && pidRecordMatchesSpec(row);
  if (ours) return 'managed-live';
  // Reachable but not ours (no/dead pid file) → an external process holds
  // the port; we can't restart it. A truly stopped tier (not reachable) is
  // ours to (re)start fresh.
  if (row.endpointReachable) return 'external';
  return 'managed-stopped';
}

/** True when a row should be included given an optional tier-label filter
 *  (case-insensitive). Orphans (which can carry a stale tier label) only
 *  match when no filter is given, so a tier-scoped restart never touches
 *  them. */
function rowMatchesTierFilter(row: BackendStatusRow, tier: string | undefined): boolean {
  if (tier === undefined) return true;
  if (row.origin === 'orphan') return false;
  const wanted = tier.toLowerCase();
  return row.spec.labels.some((label) => label.toLowerCase() === wanted);
}

/** Operator instruction for a tier cartograph can't restart: relaunch your
 *  own llama-server with the args current config implies. */
function backendExternalRelaunchMessage(row: BackendStatusRow): string {
  return `external process — cartograph can't restart it. Relaunch your own llama-server for ${row.spec.endpoint} with: ${renderBackendStartCommand(row.spec)}`;
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
    const parsed = BackendPidFileSchema.safeParse(JSON.parse(await fsp.readFile(filePath, 'utf8')));
    return parsed.success ? parsed.data : null;
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
    { encoding: 'utf8', mode: 0o600 },
  );
}

async function removePidFile(filePath: string): Promise<void> {
  await fsp.unlink(filePath).catch(() => undefined);
}

function openLogFd(logPath: string): number {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  return fs.openSync(logPath, 'a');
}

async function spawnDetachedBackend(row: BackendStatusRow): Promise<{ pid: number }> {
  const stdoutFd = openLogFd(row.logPath);
  const stderrFd = openLogFd(row.logPath);
  let child: ChildProcess;
  try {
    child = spawn(row.spec.command, row.spec.args, {
      detached: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } finally {
    fs.closeSync(stdoutFd);
    fs.closeSync(stderrFd);
  }
  await waitForSpawn(child, row.spec.command);
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) {
    throw new Error(`failed to start ${row.spec.command}: child process did not report a pid`);
  }
  child.unref();
  return { pid };
}

function waitForSpawn(child: ChildProcess, command: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(onTimeout, SPAWN_CONFIRM_TIMEOUT_MS);
    timer.unref?.();

    function detachListeners(): void {
      clearTimeout(timer);
      child.off('spawn', onSpawn);
      child.off('error', onError);
    }

    function onTimeout(): void {
      detachListeners();
      resolve();
    }

    function onSpawn(): void {
      detachListeners();
      resolve();
    }

    function onError(err: Error): void {
      detachListeners();
      reject(new Error(`failed to start ${command}: ${err.message}`));
    }

    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

/** A pid file is "ours to signal" when cartograph wrote it for the
 *  SAME endpoint (host:port). We deliberately no longer compare the
 *  model or the full arg list: a backend's identity is its port, so
 *  changing a tier's model or `llamaServerArgs` in config must not
 *  strand the running process as unmanageable (issue #24). The pid
 *  file is our own tracked record (schema-validated, mode 0600) and we
 *  only act on it after confirming the pid is still alive. */
function pidRecordMatchesSpec(row: BackendStatusRow): boolean {
  const record = row.pidRecord;
  if (!record) return false;
  return record.endpoint === row.spec.endpoint;
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

/** Resolve the `--parallel N` value for a tier. A manual `concurrency`
 *  override in config wins — so `cartograph_admin({action: 'llm-tune',
 *  concurrency})` actually reduces the backend's KV-slot count and
 *  decode-buffer memory (issue #24) — otherwise the hardware-aware
 *  recommendation from `recommendedTuning()` applies. */
function resolveTierParallel(
  tuning: ReturnType<typeof recommendedTuning>,
  tier: LlmTierKey,
  cfg: Record<string, unknown>,
): number {
  const override = cfg['concurrency'];
  if (typeof override === 'number' && Number.isInteger(override) && override > 0) return override;
  return llamaServerParallelForTier(tuning, tier);
}

/** User-pinned extra `llama-server` flags for this tier
 *  (`llamaServerArgs` in config), appended verbatim to the generated
 *  start command. Non-array configs and non-string entries are dropped
 *  so a malformed value can never break command construction. */
function llamaServerPassthroughArgs(cfg: Record<string, unknown>): string[] {
  const raw = cfg['llamaServerArgs'];
  if (!Array.isArray(raw)) return [];
  return raw.filter((value): value is string => typeof value === 'string');
}

/** True when the passthrough args already pin `--parallel` (or its
 *  `-np` short form, in either `flag value` or `flag=value` shape). */
function passthroughHasParallelFlag(passthrough: readonly string[]): boolean {
  return passthrough.some(
    (arg) => arg === '--parallel' || arg === '-np' || arg.startsWith('--parallel=') || arg.startsWith('-np='),
  );
}

function llmTierLabel(tier: LlmTierKey): string {
  if (tier === 'summarizeLlm') return 'summarize';
  if (tier === 'localLlm') return 'local';
  if (tier === 'askLlm') return 'ask';
  if (tier === 'classifyLlm') return 'classify';
  if (tier === 'embeddingLlm') return 'embed';
  return 'rerank';
}

/** Stable per-backend id derived from the endpoint + the per-tier-kind
 *  mode flags (`extraArgs`). The MODEL, `llamaServerArgs`, and
 *  concurrency are deliberately OUT of the hash — they are all
 *  user-mutable, and keeping them out is what makes the pid/log file
 *  path survive a model/flag change so `status`/`stop` keep managing
 *  the same running process instead of orphaning it (issue #24).
 *  `extraArgs` depends only on the tier KIND (never on user config),
 *  so it stays stable across such changes while still separating an
 *  embed/rerank backend from a chat backend on the same port. */
function backendSpecId(endpoint: string, extraArgs: readonly string[]): string {
  const hash = crypto
    .createHash('sha256')
    .update(`${normaliseEndpoint(endpoint)}\0${extraArgs.join('\0')}`)
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
  const safeMaxLines = Math.max(0, Math.floor(maxLines));
  if (safeMaxLines === 0) return '';
  const handle = await fsp.open(filePath, 'r');
  let text: string;
  try {
    const stat = await handle.stat();
    const start = Math.max(0, stat.size - LOG_TAIL_MAX_BYTES);
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    text = buffer.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      text = firstNewline >= 0 ? text.slice(firstNewline + 1) : '';
    }
  } finally {
    await handle.close();
  }
  const lines = text.split(/\r?\n/);
  return lines
    .slice(Math.max(0, lines.length - safeMaxLines))
    .join('\n')
    .trimEnd();
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return "'" + value.replaceAll("'", String.raw`'\''`) + "'";
}
