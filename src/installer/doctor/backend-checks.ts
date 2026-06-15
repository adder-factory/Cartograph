import {
  backendInstallHint,
  backendLabel,
  normaliseEndpoint,
  scanForLlmBackends,
  type DetectedBackend,
} from '../scan-backends.js';
import { LLAMA_SERVER_DEFAULT_ENDPOINT } from '../default-endpoints.js';
import { describeHardware, recommendedTuning } from '../hardware-tuning.js';
import { LLAMA_SERVER_RERANK_FLAG } from '../llm-setup-catalog.js';
import { backendStatus, LOCAL_BACKEND_HOSTS, renderBackendStartCommands } from '../../features/backend/index.js';
import type { CheckResult } from './contract.js';

interface EmbeddingReachabilityCheckArgs {
  readonly embeddingLlm: Record<string, unknown> | null | undefined;
  readonly detected: readonly DetectedBackend[];
  readonly projectPath: string | null;
  readonly llm: Record<string, unknown> | null;
}

export async function detectBackends(configuredEndpoints: readonly string[] = []): Promise<DetectedBackend[]> {
  try {
    return await scanForLlmBackends(configuredEndpoints);
  } catch {
    return [];
  }
}

export function checkEmbeddingReachability({
  embeddingLlm,
  detected,
  projectPath,
  llm,
}: EmbeddingReachabilityCheckArgs): CheckResult | null {
  if (!embeddingLlm || typeof embeddingLlm !== 'object') return null;
  if (embeddingLlm['provider'] !== 'openai-compat') return null;

  const endpoint = typeof embeddingLlm['endpoint'] === 'string' ? embeddingLlm['endpoint'] : null;
  if (!endpoint) return checkEndpointlessOpenAiEmbedding(embeddingLlm);

  const base = normaliseEndpoint(endpoint);
  const match = detected.find((d) => d.endpoint === base);
  if (match) {
    return {
      id: 'embedding-endpoint',
      name: 'Embedding endpoint',
      status: 'ok',
      detail: `${backendLabel(match.kind)} reachable at ${base} (${loadedModelSummary(match)}).`,
    };
  }

  const localStartHint =
    projectPath && renderBackendStartCommands(llm).length > 0 ? localBackendStartHint(projectPath) : null;
  let alternatives = localStartHint
    ? `No OpenAI-compat backends detected on common ports (8080, 11434, 8000, 1234, 5000). ${localStartHint}`
    : 'No OpenAI-compat backends detected on common ports (8080, 11434, 8000, 1234, 5000). ' +
      backendInstallHint('llama-server');
  if (detected.length > 0) {
    alternatives = `Detected ${detected.length} other backend${detected.length === 1 ? '' : 's'} running: ${detected
      .map((d) => `${backendLabel(d.kind)} at ${d.endpoint}`)
      .join(', ')}. Point \`embeddingLlm.endpoint\` at one of those, or ${
      localStartHint ?? 'start the configured backend.'
    }`;
  }

  return {
    id: 'embedding-endpoint',
    name: 'Embedding endpoint',
    status: 'warn',
    detail: `embeddingLlm.endpoint=${endpoint} is not responding to GET /v1/models.`,
    remediation: alternatives,
  };
}

function localBackendStartHint(projectPath: string): string {
  return (
    `Start the configured local stack with \`cartograph backend start ${projectPath}\`, ` +
    `then run \`cartograph llm smoke ${projectPath}\`. ` +
    `If startup fails, inspect \`cartograph backend logs ${projectPath} --tier embed\`.`
  );
}

function checkEndpointlessOpenAiEmbedding(embeddingLlm: Record<string, unknown>): CheckResult {
  const configuredApiKey = typeof embeddingLlm['apiKey'] === 'string' && embeddingLlm['apiKey'].length > 0;
  const envApiKey = typeof process.env['OPENAI_API_KEY'] === 'string' && process.env['OPENAI_API_KEY'].length > 0;
  if (configuredApiKey || envApiKey) {
    return {
      id: 'embedding-endpoint',
      name: 'Embedding endpoint',
      status: 'ok',
      detail: `No embeddingLlm.endpoint set; OpenAI SDK default endpoint will be used with ${
        configuredApiKey ? 'configured apiKey' : 'OPENAI_API_KEY'
      }.`,
    };
  }

  return {
    id: 'embedding-endpoint',
    name: 'Embedding endpoint',
    status: 'warn',
    detail: 'embeddingLlm.endpoint is not set.',
    remediation: `Add an \`endpoint\` field to \`embeddingLlm\` (e.g. \`"${LLAMA_SERVER_DEFAULT_ENDPOINT}"\` for llama-server), or set \`OPENAI_API_KEY\` to use the OpenAI SDK default endpoint. Run \`cartograph admin install-models --write-config\` to auto-wire the recommended stack.`,
  };
}

function loadedModelSummary(match: DetectedBackend): string {
  if (match.models.length === 0) return 'no models loaded';
  return `${match.models.length} model${match.models.length === 1 ? '' : 's'} loaded`;
}

export function detectedBackendsCheck(detected: readonly DetectedBackend[]): CheckResult {
  if (detected.length === 0) {
    return {
      id: 'detected-llm-backends',
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
    id: 'detected-llm-backends',
    name: 'Detected LLM backends',
    status: 'ok',
    detail: summary,
  };
}

export function recommendedTuningCheck(): CheckResult {
  const hw = describeHardware();
  const t = recommendedTuning();
  const lines = [
    `Detected: ${hw}.`,
    `Recommended \`llama-server --parallel N\` per tier:`,
    `  embed :8080     → --parallel ${t.embed.llamaServerParallel}  (cartograph drives ${t.embed.cartographConcurrency} concurrent batches)`,
    `  chat  :8081     → --parallel ${t.chat.llamaServerParallel}  (cartograph drives ${t.chat.cartographConcurrency})`,
    `  ask   :8082     → --parallel ${t.ask.llamaServerParallel}  (cartograph drives ${t.ask.cartographConcurrency})`,
    `  rerank :8083 (with ${LLAMA_SERVER_RERANK_FLAG}) → --parallel ${t.reranker.llamaServerParallel}  (cartograph drives ${t.reranker.cartographConcurrency})`,
    'Increase `--parallel N` on your llama-server startup to saturate every slot; cartograph auto-matches outbound concurrency.',
  ].join('\n');
  return { id: 'recommended-tuning', name: 'Recommended tuning', status: 'ok', detail: lines };
}

// ─── Chat-family per-slot context budget (issue #27) ────────────────────────

/** Minimum per-slot context (tokens) cartograph's chat-family prompts need.
 *  Summary prompts run up to ~3.3k tokens (file summaries); 4096 covers them
 *  with headroom. llama.cpp divides a server's total `-c` across its
 *  `--parallel` slots (per-slot = `-c` ÷ parallel), so a small `-c` paired
 *  with high `--parallel` — or a model whose native context ÷ parallel is
 *  small — leaves each slot under this floor and large symbols fail with an
 *  HTTP 400 "exceeds the available context size". */
const MIN_CHAT_CTX_PER_SLOT = 4096;

/** Per-endpoint `/props` probe budget. Matches the scan-backends probe — a
 *  loopback GET that normally answers in <50 ms. */
const PROPS_PROBE_TIMEOUT_MS = 1000;

/** Config tiers whose backend serves cartograph's summary / ask prompts,
 *  paired with the label shown to the user. embed/reranker are excluded —
 *  they take no chat `-c` (sized by `--batch-size` / encoder-only). */
const CHAT_FAMILY_TIER_LABELS: ReadonlyArray<readonly [string, string]> = [
  ['summarizeLlm', 'summarize'],
  ['localLlm', 'local'],
  ['classifyLlm', 'classify'],
  ['askLlm', 'ask'],
];

/** True when the endpoint points at a local host — the only place a per-slot
 *  `-c`/`--parallel` budget is something the operator controls. Cloud
 *  OpenAI-compat endpoints have no `/props` and no slot model. Reuses
 *  {@link LOCAL_BACKEND_HOSTS} (the same set `backend start` treats as local,
 *  incl. the `0.0.0.0` bind address) so the two never drift. */
function isLocalEndpoint(endpoint: string): boolean {
  try {
    return LOCAL_BACKEND_HOSTS.has(new URL(endpoint).hostname);
  } catch {
    return false;
  }
}

/** Probe a llama.cpp server's effective PER-SLOT context via `/props`
 *  (`n_ctx` there is already per-sequence). Returns null when unreachable or
 *  the field is absent (non-llama.cpp servers). */
async function fetchPerSlotCtx(endpoint: string): Promise<number | null> {
  try {
    const res = await fetch(`${normaliseEndpoint(endpoint)}/props`, {
      method: 'GET',
      signal: AbortSignal.timeout(PROPS_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { n_ctx?: unknown; default_generation_settings?: { n_ctx?: unknown } };
    const raw = body.default_generation_settings?.n_ctx ?? body.n_ctx;
    return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : null;
  } catch {
    return null;
  }
}

/** One probed chat-family endpoint and its effective per-slot context. */
export interface ChatCtxProbe {
  readonly endpoint: string;
  readonly tiers: readonly string[];
  readonly nCtx: number | null;
}

/** Pure verdict from the probed per-slot contexts. Null when nothing
 *  assessable was reachable (no signal → no check row). Extracted from
 *  {@link chatContextBudgetCheck} so the threshold logic is unit-testable
 *  without a live backend. */
export function assessChatContextBudget(probes: readonly ChatCtxProbe[]): CheckResult | null {
  const reachable = probes.filter((p) => p.nCtx !== null);
  if (reachable.length === 0) return null;
  const undersized = reachable.filter((p) => (p.nCtx as number) < MIN_CHAT_CTX_PER_SLOT);
  if (undersized.length === 0) {
    return {
      id: 'chat-context-budget',
      name: 'Chat context budget',
      status: 'ok',
      detail: `All reachable chat tiers have >= ${MIN_CHAT_CTX_PER_SLOT} tokens/slot.`,
    };
  }
  const summary = undersized.map((p) => `${p.tiers.join('/')} @ ${p.endpoint}: ${p.nCtx} tokens/slot`).join('; ');
  return {
    id: 'chat-context-budget',
    name: 'Chat context budget',
    status: 'warn',
    detail:
      `${summary} — below the ${MIN_CHAT_CTX_PER_SLOT}-token/slot floor cartograph's summary prompts need. ` +
      'llama.cpp splits a server\'s total `-c` across its `--parallel` slots, so large symbols fail with an HTTP 400 "exceeds context".',
    remediation:
      `Raise the backend's \`-c\` or lower \`--parallel\` so \`-c\` ÷ \`--parallel\` >= ${MIN_CHAT_CTX_PER_SLOT} per slot ` +
      '(via `llamaServerArgs`/`concurrency` in .cartograph/config.json, or the flags on your own launch command).',
  };
}

/** Warn when a reachable local chat/ask backend's per-slot context is
 *  below the floor cartograph's prompts need (issue #27). Probes `/props` on
 *  each unique local chat-family endpoint; null when none are
 *  configured/reachable so cloud-only or LLM-less setups stay quiet. */
export async function chatContextBudgetCheck(llm: Record<string, unknown> | null): Promise<CheckResult | null> {
  if (!llm) return null;
  const byEndpoint = new Map<string, string[]>();
  for (const [tierKey, label] of CHAT_FAMILY_TIER_LABELS) {
    const block = llm[tierKey] as Record<string, unknown> | undefined;
    if (!block || block['provider'] !== 'openai-compat') continue;
    const endpoint = block['endpoint'];
    if (typeof endpoint !== 'string' || !isLocalEndpoint(endpoint)) continue;
    const base = normaliseEndpoint(endpoint);
    const labels = byEndpoint.get(base) ?? [];
    labels.push(label);
    byEndpoint.set(base, labels);
  }
  if (byEndpoint.size === 0) return null;
  const probes = await Promise.all(
    [...byEndpoint.entries()].map(async ([endpoint, tiers]) => ({
      endpoint,
      tiers,
      nCtx: await fetchPerSlotCtx(endpoint),
    })),
  );
  return assessChatContextBudget(probes);
}

export function backendStartCommandsCheck(llm: Record<string, unknown> | null): CheckResult | null {
  const commands = renderBackendStartCommands(llm);
  if (commands.length === 0) return null;
  return {
    id: 'backend-start-commands',
    name: 'Backend start commands',
    status: 'ok',
    detail: [
      'Managed start command: `cartograph backend start <project>`.',
      'Log command: `cartograph backend logs <project> --tier <embed|summarize|local|ask|rerank>`.',
      'Configured local llama-server commands (one process per unique local endpoint):',
      ...commands.map((cmd) => `  ${cmd}`),
    ].join('\n'),
  };
}

export async function backendLifecycleCheck(
  projectPath: string,
  llm: Record<string, unknown> | null,
): Promise<CheckResult | null> {
  if (renderBackendStartCommands(llm).length === 0) return null;
  const status = await backendStatus(projectPath);
  if (status.rows.length === 0) return null;

  // Orphan rows describe processes on endpoints no longer in config, so
  // the missing-model / stale / starting checks below — which speak to
  // CURRENTLY-configured tiers — must ignore them (an orphan's old GGUF
  // path being gone is not a "configured model missing" problem). They
  // get their own check instead.
  const configRows = status.rows.filter((row) => row.origin === 'config');
  const orphans = status.rows.filter((row) => row.origin === 'orphan' && row.pidAlive);
  if (orphans.length > 0) {
    return {
      id: 'backend-lifecycle',
      name: 'Backend lifecycle',
      status: 'warn',
      detail: `${orphans.length} orphaned backend process${orphans.length === 1 ? '' : 'es'} bound to a port no longer in config.`,
      remediation: `Run \`cartograph backend stop ${projectPath}\` to stop them and free their (GPU) memory.`,
    };
  }

  const missing = configRows.filter((row) => !row.modelExists);
  if (missing.length > 0) {
    return {
      id: 'backend-lifecycle',
      name: 'Backend lifecycle',
      status: 'warn',
      detail: `${missing.length} managed backend model file${missing.length === 1 ? '' : 's'} missing.`,
      remediation: `Install the missing GGUFs or run \`cartograph admin install-models --write-config --project-path ${projectPath}\`.`,
    };
  }

  const stale = configRows.filter((row) => row.pidRecord !== null && !row.pidAlive);
  if (stale.length > 0) {
    return {
      id: 'backend-lifecycle',
      name: 'Backend lifecycle',
      status: 'warn',
      detail: `${stale.length} stale backend pid file${stale.length === 1 ? '' : 's'} found.`,
      remediation: `Run \`cartograph backend stop ${projectPath}\` to remove stale pid files, then \`cartograph backend start ${projectPath}\` if you need local LLMs.`,
    };
  }

  const starting = configRows.filter((row) => row.state === 'starting');
  if (starting.length > 0) {
    return {
      id: 'backend-lifecycle',
      name: 'Backend lifecycle',
      status: 'warn',
      detail: `${starting.length} managed backend process${starting.length === 1 ? '' : 'es'} alive but not reachable yet.`,
      remediation: `Wait for model load, run \`cartograph llm smoke ${projectPath}\`, or inspect \`cartograph backend logs ${projectPath}\`.`,
    };
  }

  const counts = new Map<string, number>();
  for (const row of configRows) counts.set(row.state, (counts.get(row.state) ?? 0) + 1);
  const summary = [...counts].map(([state, count]) => `${count} ${state}`).join(', ');
  return {
    id: 'backend-lifecycle',
    name: 'Backend lifecycle',
    status: 'ok',
    detail:
      `Managed backend states: ${summary}. ` +
      `Use \`cartograph backend start ${projectPath}\`, \`cartograph llm smoke ${projectPath}\`, and \`cartograph backend stop ${projectPath}\` for the local stack.`,
  };
}
