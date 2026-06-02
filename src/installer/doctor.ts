/**
 * `cartograph doctor` — diagnose the install state and surface
 * actionable next steps for each gap. Designed to drop "I tried
 * installing and nothing works" support burden by giving users a
 * concrete punch list before they have to read source.
 *
 * Layers checked:
 *   1. Bun runtime — version meets engines.bun.
 *   2. Models — at least one GGUF present under ~/.cartograph/models/
 *      (used as a hint that the user has downloaded the curated set
 *      a llama-server can serve; HTTP-only stacks don't strictly need
 *      this directory).
 *   3. Project init — given path has a `.cartograph/` directory.
 *   4. Project config — `.cartograph/config.json` parses + carries an
 *      `llm` block if any LLM-driven feature will be used.
 *   5. Detected LLM backends — informational; lists every
 *      OpenAI-compat backend found on common ports (llama-server :8080,
 *      Ollama :11434, mlx_lm :8000, LM Studio :1234, LocalAI :5000).
 *   6. Embedding endpoint — when the project config carries an
 *      `embeddingLlm` block, probes its configured `endpoint` via
 *      `GET /v1/models`. Surfaces detected alternatives in the
 *      remediation line on failure.
 *
 * The pre-2026-05-24c "Native shim (libcgshim)" check was removed
 * when the in-process LLM pathway was deleted in step 4c of the
 * migration — see `project_llm_pivot_to_llama_server` in auto-memory.
 *
 * Each check returns a structured result; the consumer (MCP handler
 * or CLI) renders a human-readable report from the array. Keeping
 * the data shape stable lets future surfaces (CI-style JSON, viewer
 * panel, etc.) consume the same output without re-implementing the
 * checks.
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  backendInstallHint,
  backendLabel,
  normaliseEndpoint,
  scanForLlmBackends,
  type DetectedBackend,
} from './scan-backends.js';
import { describeHardware, recommendedTuning } from './hardware-tuning.js';
import { LLAMA_SERVER_DEFAULT_ENDPOINT } from './default-endpoints.js';

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface CheckResult {
  /** Short human-readable name shown in the report header line. */
  name: string;
  status: CheckStatus;
  /** One-line summary of what was found. */
  detail: string;
  /** Concrete next-step the user can run to remediate, when status
   *  is `warn` or `fail`. Omitted on `ok`. */
  remediation?: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  /** Worst status across all checks — `fail` if any failed, else
   *  `warn` if any warned, else `ok`. */
  overallStatus: CheckStatus;
}

const ENGINES_BUN_MIN = '1.3.0';

const SEMVER_COMPONENT_COUNT = 3;
const SEMVER_RADIX = 10;

function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map((n) => Number.parseInt(n, SEMVER_RADIX));
  const pb = b.split('.').map((n) => Number.parseInt(n, SEMVER_RADIX));
  for (let i = 0; i < SEMVER_COMPONENT_COUNT; i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai - bi;
  }
  return 0;
}

const BUN_DOWNLOAD_URL = 'https://bun.sh';

function checkBunRuntime(): CheckResult {
  // `Bun` is a global injected when running under bun. Under node the
  // value is undefined; cartograph requires Bun for bun:sqlite + bun:ffi.
  const bunGlobal = (globalThis as { Bun?: { version?: string } }).Bun;
  if (!bunGlobal) {
    return {
      name: 'Bun runtime',
      status: 'fail',
      detail: 'Not running under Bun (bun:sqlite + bun:ffi are required).',
      remediation: `Install Bun ≥ ${ENGINES_BUN_MIN} from ${BUN_DOWNLOAD_URL}, then re-run cartograph commands via bun (or via the cartograph binary which spawns bun internally).`,
    };
  }
  const version = bunGlobal.version ?? '0.0.0';
  if (compareSemver(version, ENGINES_BUN_MIN) < 0) {
    return {
      name: 'Bun runtime',
      status: 'fail',
      detail: `Bun ${version} is older than the required ${ENGINES_BUN_MIN}.`,
      remediation: `Upgrade Bun: \`bun upgrade\` (or reinstall from ${BUN_DOWNLOAD_URL}).`,
    };
  }
  return { name: 'Bun runtime', status: 'ok', detail: `Bun ${version}` };
}

const MODELS_DIR_DEFAULT = path.join(os.homedir(), '.cartograph', 'models');

async function checkModels(): Promise<CheckResult> {
  const modelsDirExists = await fsp
    .access(MODELS_DIR_DEFAULT)
    .then(() => true)
    .catch(() => false);
  if (!modelsDirExists) {
    return {
      name: 'LLM models',
      status: 'warn',
      detail: `${MODELS_DIR_DEFAULT} does not exist.`,
      remediation:
        '`cartograph admin install-models` to download the recommended GGUF set (~7 GB), ' +
        'or `cartograph admin install-models --minimal` for the smallest viable subset (embed + 3B chat, ~2.1 GB).',
    };
  }
  const entries = await fsp.readdir(MODELS_DIR_DEFAULT);
  const ggufs = entries.filter((f) => f.endsWith('.gguf'));
  if (ggufs.length === 0) {
    return {
      name: 'LLM models',
      status: 'warn',
      detail: `${MODELS_DIR_DEFAULT} exists but contains no .gguf files.`,
      remediation: '`cartograph admin install-models` to download the recommended set.',
    };
  }
  return {
    name: 'LLM models',
    status: 'ok',
    detail: `${ggufs.length} model${ggufs.length === 1 ? '' : 's'} present under ${MODELS_DIR_DEFAULT}`,
  };
}

async function checkProjectInit(projectPath: string): Promise<CheckResult> {
  const cgDir = path.join(projectPath, '.cartograph');
  const cgDirExists = await fsp
    .access(cgDir)
    .then(() => true)
    .catch(() => false);
  if (!cgDirExists) {
    return {
      name: 'Project init',
      status: 'fail',
      detail: `No \`.cartograph/\` directory at ${projectPath}.`,
      remediation: `\`cartograph admin init ${projectPath}\` to create one.`,
    };
  }
  return { name: 'Project init', status: 'ok', detail: `${cgDir} present` };
}

async function checkProjectConfig(projectPath: string): Promise<CheckResult> {
  const configPath = path.join(projectPath, '.cartograph', 'config.json');
  const configExists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) {
    // The init flow creates a config; missing it after init is
    // recoverable but warrants flagging.
    return {
      name: 'Project config',
      status: 'warn',
      detail: `No config.json at ${configPath}.`,
      remediation: '`cartograph admin init` to regenerate, or hand-author `.cartograph/config.json`.',
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(await fsp.readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    return {
      name: 'Project config',
      status: 'fail',
      detail: `${configPath} is not valid JSON: ${(e as Error).message}`,
      remediation: 'Hand-fix the JSON, or delete and re-run `cartograph admin init`.',
    };
  }
  const llm = parsed['llm'] as Record<string, unknown> | undefined;
  if (!llm || Object.keys(llm).length === 0) {
    return {
      name: 'Project config',
      status: 'warn',
      detail: `${configPath} present but no \`llm\` block configured.`,
      remediation:
        'LLM-driven features (semantic search, dead-code judge, ask) need at least an embedding model. ' +
        'Run `cartograph admin install-models --write-config` to install + wire the recommended GGUF set in one go.',
    };
  }
  return { name: 'Project config', status: 'ok', detail: `${configPath} valid` };
}

/**
 * Probe what HTTP LLM backends are running on the machine, plus
 * (optionally) the user's configured `embeddingLlm.endpoint` if it
 * isn't already on the well-known-port list. Result feeds two
 * downstream checks: the "configured endpoint reachable?" status,
 * and the informational "detected backends" line.
 */
async function detectBackends(configuredEndpoint?: string): Promise<DetectedBackend[]> {
  const extra = configuredEndpoint ? [configuredEndpoint] : [];
  try {
    return await scanForLlmBackends(extra);
  } catch {
    // The scanner swallows per-probe errors; a top-level throw here
    // would only happen on truly broken globalThis.fetch. Treat as
    // "no backends detected" rather than failing the whole doctor run.
    return [];
  }
}

/**
 * Check that the project's configured embedding backend is reachable.
 * Only `'openai-compat'` is supported post-2026-05-24c; configs with
 * any other provider value skip cleanly with a null return.
 *
 * Status semantics:
 *   - `ok`: endpoint configured AND responded to `/v1/models`.
 *   - `warn`: endpoint configured but not responding. Remediation
 *     lists any backends the scanner DID find as alternatives.
 *   - skipped (returns null): no openai-compat config present.
 */
function checkEmbeddingReachability(
  embeddingLlm: Record<string, unknown> | null | undefined,
  detected: readonly DetectedBackend[],
): CheckResult | null {
  if (!embeddingLlm || typeof embeddingLlm !== 'object') return null;
  if (embeddingLlm['provider'] !== 'openai-compat') return null;
  const endpoint = typeof embeddingLlm['endpoint'] === 'string' ? embeddingLlm['endpoint'] : null;
  if (!endpoint) {
    return {
      name: 'Embedding endpoint',
      status: 'warn',
      detail: 'embeddingLlm.endpoint is not set.',
      remediation: `Add an \`endpoint\` field to \`embeddingLlm\` (e.g. \`"${LLAMA_SERVER_DEFAULT_ENDPOINT}"\` for llama-server). Run \`cartograph admin install-models --write-config\` to auto-wire the recommended stack.`,
    };
  }

  // Normalise to the bare base-URL shape the scanner returns. Shared
  // `normaliseEndpoint` keeps the two sides from drifting.
  const base = normaliseEndpoint(endpoint);
  const match = detected.find((d) => d.endpoint === base);
  if (match) {
    let modelInfo = 'no models loaded';
    if (match.models.length > 0) {
      modelInfo = `${match.models.length} model${match.models.length === 1 ? '' : 's'} loaded`;
    }
    return {
      name: 'Embedding endpoint',
      status: 'ok',
      detail: `${backendLabel(match.kind)} reachable at ${base} (${modelInfo}).`,
    };
  }

  // Endpoint set but unreachable. Surface what IS running on the
  // machine as alternatives.
  let alternatives =
    'No OpenAI-compat backends detected on common ports (8080, 11434, 8000, 1234, 5000). ' +
    backendInstallHint('llama-server');
  if (detected.length > 0) {
    alternatives = `Detected ${detected.length} other backend${detected.length === 1 ? '' : 's'} running: ${detected
      .map((d) => `${backendLabel(d.kind)} at ${d.endpoint}`)
      .join(', ')}. Point \`embeddingLlm.endpoint\` at one of those, or start the configured backend.`;
  }
  return {
    name: 'Embedding endpoint',
    status: 'warn',
    detail: `embeddingLlm.endpoint=${endpoint} is not responding to GET /v1/models.`,
    remediation: alternatives,
  };
}

/** Informational check listing every OpenAI-compat backend the
 *  scanner found. Always succeeds (status 'ok' or 'warn' if nothing
 *  was found AND the user has no embedding config). Useful for
 *  diagnostics + the future interactive install picker. */
function detectedBackendsCheck(detected: readonly DetectedBackend[]): CheckResult {
  if (detected.length === 0) {
    return {
      name: 'Detected LLM backends',
      status: 'ok',
      detail: 'No OpenAI-compat backends running on common ports.',
    };
  }
  const summary = detected
    .map(
      (d) => `${backendLabel(d.kind)} at ${d.endpoint} (${d.models.length} model${d.models.length === 1 ? '' : 's'})`,
    )
    .join(', ');
  return {
    name: 'Detected LLM backends',
    status: 'ok',
    detail: summary,
  };
}

/** Hardware-aware tuning recommendation. Informational only — names
 *  the detected machine specs + the recommended `llama-server
 *  --parallel N` per tier so the user can self-tune their backend
 *  invocations. Doesn't probe the backend's actual `--parallel`
 *  setting (llama-server doesn't expose it via /v1/*); the user
 *  cross-references against their startup command. */
function recommendedTuningCheck(): CheckResult {
  const hw = describeHardware();
  const t = recommendedTuning();
  const lines = [
    `Detected: ${hw}.`,
    `Recommended \`llama-server --parallel N\` per tier:`,
    `  embed :8080     → --parallel ${t.embed.llamaServerParallel}  (cartograph drives ${t.embed.cartographConcurrency} concurrent batches)`,
    `  chat  :8081     → --parallel ${t.chat.llamaServerParallel}  (cartograph drives ${t.chat.cartographConcurrency})`,
    `  ask   :8082     → --parallel ${t.ask.llamaServerParallel}  (cartograph drives ${t.ask.cartographConcurrency})`,
    `  rerank :8083 (with --reranking) → --parallel ${t.reranker.llamaServerParallel}  (cartograph drives ${t.reranker.cartographConcurrency})`,
    'Increase `--parallel N` on your llama-server startup to saturate every slot; cartograph auto-matches outbound concurrency.',
  ].join('\n');
  return { name: 'Recommended tuning', status: 'ok', detail: lines };
}

export interface RunDoctorOptions {
  /** Project directory to run init / config checks against. Pass the
   *  cwd when invoked without an explicit path. */
  projectPath?: string;
  /** Skip the project-init + config checks when no project context
   *  applies (e.g. fresh-install doctor before `cartograph admin init`). */
  skipProjectChecks?: boolean;
  /** Auto-apply remediations for fixable gaps after running the
   *  checks. Currently handles:
   *    - Missing project init → `createDirectory(projectPath)`
   *    - Missing project config OR no `llm` block → run the LLM
   *      setup planner + apply its `recommendedPresetId`
   *    - Missing GGUF models → `installRecommendedModels`
   *  Returns a `RemediationReport` listing what was auto-fixed.
   *  Backend-not-running gaps are NOT auto-fixed (cartograph doesn't
   *  manage backend processes) but the report includes the
   *  next-steps the user must run. */
  fix?: boolean;
}

/** Per-gap remediation outcome. */
export interface RemediationStep {
  readonly check: string;
  readonly action: 'ran-init' | 'ran-llm-apply' | 'ran-install-models' | 'skipped' | 'failed';
  readonly detail: string;
}

export interface DoctorResultWithFix extends DoctorResult {
  /** Set only when `runDoctor({fix: true})`. Per-gap outcome of the
   *  auto-fix pass. */
  readonly remediations?: ReadonlyArray<RemediationStep>;
  /** When the auto-fix re-ran the checks after applying remediations,
   *  this is the post-fix DoctorResult (reflects the LAST re-check
   *  after the cascade-aware fix loop terminates — see
   *  `MAX_FIX_ITERATIONS`). The top-level `checks` / `overallStatus`
   *  of the enclosing object stay the PRE-fix values so the caller
   *  can show before/after.
   *
   *  Edge case: when `runDoctor({fix: true})` is called but the
   *  initial check pass had no auto-fixable gaps (e.g. install
   *  already healthy), the loop breaks immediately and `afterFix`
   *  carries a copy of the initial check set — `formatDoctorReport`
   *  then renders identical content under "Re-check after fix",
   *  which is a no-op cosmetically but harmless. */
  readonly afterFix?: DoctorResult;
}

/** Max fix iterations. Each pass re-checks then re-remediates,
 *  so one cascade step (init creating .cartograph → config check
 *  fires → llm-apply runs → config check passes) consumes 2 passes.
 *  3 is enough headroom for any reasonable chain without risking an
 *  infinite loop if a remediation fails to fix the gap it targets. */
const MAX_FIX_ITERATIONS = 3;

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorResultWithFix> {
  const initial = await runDoctorChecks(opts);
  if (!opts.fix) return initial;

  // Cascade-aware fix loop: some remediations (project init →
  // .cartograph/) unmask gaps the initial check pass couldn't see
  // because the prior gap short-circuited it. Re-check after each
  // round and re-apply if new fixable gaps surfaced. Stops at
  // MAX_FIX_ITERATIONS to bound worst-case work.
  const allRemediations: RemediationStep[] = [];
  let lastChecks = initial.checks;
  for (let i = 0; i < MAX_FIX_ITERATIONS; i++) {
    const round = await applyRemediations(lastChecks, opts);
    if (round.length === 0) break;
    allRemediations.push(...round);
    // Re-check to see what's still broken AND what newly-fixable
    // gaps surfaced from this round's fixes.
    const recheck = await runDoctorChecks(opts);
    // Stop if nothing changed (every round-N remediation either
    // succeeded into ok or got skipped).
    const stillFixable = recheck.checks.some((c) => isAutoFixable(c.name, c.status));
    lastChecks = recheck.checks;
    if (!stillFixable) break;
  }
  return {
    ...initial,
    remediations: allRemediations,
    afterFix: { checks: lastChecks, overallStatus: worstStatus(lastChecks) },
  };
}

function worstStatus(checks: readonly CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}

/** Which checks `applyRemediations` knows how to address. Used by
 *  the fix loop to decide whether another pass would do anything. */
function isAutoFixable(name: string, status: CheckStatus): boolean {
  if (status === 'ok') return false;
  return name === 'Project init' || name === 'LLM models' || name === 'Project config';
}

/** Pure-check pass — the body of `runDoctor` minus the `fix` branch.
 *  Returns the same shape callers depended on before `--fix` was
 *  added. */
async function runDoctorChecks(opts: RunDoctorOptions): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  checks.push(checkBunRuntime(), await checkModels());

  // Read the project's embeddingLlm.endpoint (if any) so the scanner
  // can also probe a non-default port the user has configured.
  let embeddingLlm: Record<string, unknown> | null = null;
  if (!opts.skipProjectChecks) {
    const projectPath = path.resolve(opts.projectPath ?? process.cwd());
    const initCheck = await checkProjectInit(projectPath);
    checks.push(initCheck);
    if (initCheck.status === 'ok') {
      const configCheck = await checkProjectConfig(projectPath);
      checks.push(configCheck);
      embeddingLlm = await readEmbeddingLlmFromConfig(projectPath);
    }
  }

  // Scan + emit the informational "detected backends" line + the
  // configured-endpoint reachability check. Scanner is async and
  // probes 5+ ports in parallel with a 1s per-port timeout, so this
  // adds ~1s to the doctor run worst-case.
  const configuredEndpoint = typeof embeddingLlm?.['endpoint'] === 'string' ? embeddingLlm['endpoint'] : undefined;
  const detected = await detectBackends(configuredEndpoint);
  checks.push(detectedBackendsCheck(detected));
  const reachability = checkEmbeddingReachability(embeddingLlm, detected);
  if (reachability) checks.push(reachability);
  // Informational tuning row — surfaces the hardware-aware
  // `--parallel N` recommendation per tier so users can self-tune
  // their llama-server invocations even without running the wizard.
  // Honours `*Llm.concurrency` overrides in the project config when
  // present (those win over the hardware default).
  checks.push(recommendedTuningCheck());

  return { checks, overallStatus: worstStatus(checks) };
}

/** Auto-apply fixes for gaps the doctor knows how to handle. Returns
 *  one `RemediationStep` per gap addressed (or skipped). Cartograph
 *  doesn't manage backend processes, so backend-unreachable warnings
 *  are flagged as 'skipped' with the next-step hint instead of
 *  attempted automatically. */
async function applyRemediations(checks: CheckResult[], opts: RunDoctorOptions): Promise<RemediationStep[]> {
  const steps: RemediationStep[] = [];
  const projectPath = path.resolve(opts.projectPath ?? process.cwd());

  // 1. Project init missing → create `.cartograph/`.
  const initCheck = checks.find((c) => c.name === 'Project init' && c.status !== 'ok');
  if (initCheck) {
    steps.push(await applyProjectInitRemediation(projectPath));
  }

  // 2. Missing GGUF models → install the curated set.
  const modelsCheck = checks.find((c) => c.name === 'LLM models' && c.status !== 'ok');
  if (modelsCheck) {
    steps.push(await applyModelInstallRemediation());
  }

  // 3. Project config missing OR no llm block → apply the planner's
  //    recommended preset (no user input — the agent / fix flag is
  //    saying "just pick the best path automatically").
  const configCheck = checks.find((c) => c.name === 'Project config' && c.status !== 'ok');
  if (configCheck) {
    steps.push(await applyProjectConfigRemediation(projectPath));
  }

  // 4. Embedding endpoint unreachable → can't auto-fix (cartograph
  //    doesn't manage backend processes). Surface the next-step
  //    so the report's `--fix` output names the gap.
  const embCheck = checks.find((c) => c.name === 'Embedding endpoint' && c.status !== 'ok');
  if (embCheck) {
    steps.push({
      check: 'Embedding endpoint',
      action: 'skipped',
      detail: `Cannot auto-start a backend. ${embCheck.remediation ?? embCheck.detail}`,
    });
  }

  return steps;
}

async function applyProjectInitRemediation(projectPath: string): Promise<RemediationStep> {
  try {
    const { createDirectory } = await import('../directory.js');
    createDirectory(projectPath);
    return { check: 'Project init', action: 'ran-init', detail: `Created ${projectPath}/.cartograph/` };
  } catch (err) {
    return {
      check: 'Project init',
      action: 'failed',
      detail: `createDirectory failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function applyModelInstallRemediation(): Promise<RemediationStep> {
  try {
    const { installRecommendedModels } = await import('./install-models.js');
    const { RECOMMENDED_MODELS } = await import('../llm/recommended-models.js');
    const result = await installRecommendedModels({ models: RECOMMENDED_MODELS });
    return {
      check: 'LLM models',
      action: 'ran-install-models',
      detail: `Downloaded ${result.downloaded.length} model(s); ${result.skipped.length} already present.`,
    };
  } catch (err) {
    return {
      check: 'LLM models',
      action: 'failed',
      detail: `install-models failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function applyProjectConfigRemediation(projectPath: string): Promise<RemediationStep> {
  try {
    const { planLlmSetup, applyLlmSetupChoice } = await import('./llm-setup-plan.js');
    const plan = await planLlmSetup();
    const result = await applyLlmSetupChoice({ projectRoot: projectPath, preset: plan.recommendedPresetId });
    const next = result.nextSteps.length > 0 ? ` Next: ${result.nextSteps.join(' ; ')}` : '';
    return {
      check: 'Project config',
      action: 'ran-llm-apply',
      detail: `Applied preset \`${result.preset}\` → ${result.configPath ?? '(no write)'}.${next}`,
    };
  } catch (err) {
    return {
      check: 'Project config',
      action: 'failed',
      detail: `llm-plan/apply failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Pull the parsed `embeddingLlm` block out of a project's config,
 *  returning null on missing / invalid JSON / missing block. The
 *  doctor's `checkProjectConfig` already reports parse failures; we
 *  silently no-op here so the embedding-reachability check skips
 *  cleanly in those cases. */
async function readEmbeddingLlmFromConfig(projectPath: string): Promise<Record<string, unknown> | null> {
  const configPath = path.join(projectPath, '.cartograph', 'config.json');
  const configExists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!configExists) return null;
  try {
    const parsed = JSON.parse(await fsp.readFile(configPath, 'utf8')) as Record<string, unknown>;
    const llm = parsed['llm'] as Record<string, unknown> | undefined;
    if (!llm || typeof llm !== 'object') return null;
    const embedding = llm['embeddingLlm'] as Record<string, unknown> | undefined;
    return embedding && typeof embedding === 'object' ? embedding : null;
  } catch {
    return null;
  }
}

const CHECK_STATUS_ICON: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };
const REMEDIATION_ACTION_ICON: Record<RemediationStep['action'], string> = {
  'ran-init': '✓',
  'ran-llm-apply': '✓',
  'ran-install-models': '✓',
  skipped: '⏭',
  failed: '✗',
};
const OVERALL_STATUS_BLURB: Record<DoctorResult['overallStatus'], string> = {
  ok: '_All checks passed. cartograph is ready to use._',
  warn: '_Doctor found non-blocking gaps. The checks above suggest next steps._',
  fail: '_Doctor found blocking gaps. Fix the `✗` items above before using LLM-backed features._',
};

/** Render a DoctorResult as a Markdown report suitable for CLI + MCP
 *  output. Single source of truth for the user-facing wording.
 *  When `result.remediations` is set (i.e. `runDoctor({fix: true})`
 *  was called), the report includes a "## Auto-fix outcome" section
 *  + the post-fix re-check status. */
export function formatDoctorReport(result: DoctorResultWithFix): string {
  const lines: string[] = ['## cartograph doctor', ''];
  appendCheckLines(lines, result.checks);
  lines.push('', OVERALL_STATUS_BLURB[result.overallStatus]);
  if (result.remediations !== undefined) appendFixOutcome(lines, result);
  return lines.join('\n');
}

function appendCheckLines(lines: string[], checks: ReadonlyArray<DoctorResult['checks'][number]>): void {
  for (const c of checks) {
    lines.push(`${CHECK_STATUS_ICON[c.status]} **${c.name}** — ${c.detail}`);
    if (c.remediation) lines.push(`  → ${c.remediation}`);
  }
}

function appendFixOutcome(lines: string[], result: DoctorResultWithFix): void {
  lines.push('', '## Auto-fix outcome', '');
  const remediations = result.remediations ?? [];
  if (remediations.length === 0) {
    lines.push('_No fixable gaps. Run without `--fix` to see the diagnostic report only._');
  } else {
    for (const r of remediations) {
      lines.push(`${REMEDIATION_ACTION_ICON[r.action]} **${r.check}** (${r.action}) — ${r.detail}`);
    }
  }
  if (result.afterFix) {
    lines.push('', '## Re-check after fix', '');
    for (const c of result.afterFix.checks) {
      lines.push(`${CHECK_STATUS_ICON[c.status]} **${c.name}** — ${c.detail}`);
    }
  }
}
