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
import { backendStatus, renderBackendStartCommands } from '../../features/backend/index.js';
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
  // Chat-family tiers get an auto-sized `-c = parallel × ctxPerSlot` so
  // every scheduler slot fits cartograph's own summary prompts (issue #27).
  const chatCtx = t.chat.llamaServerParallel * t.chat.ctxPerSlot;
  const askCtx = t.ask.llamaServerParallel * t.ask.ctxPerSlot;
  const lines = [
    `Detected: ${hw}.`,
    `Recommended \`llama-server\` flags per tier (cartograph applies these automatically on \`backend start\`):`,
    `  embed :8080     → --parallel ${t.embed.llamaServerParallel}  (cartograph drives ${t.embed.cartographConcurrency} concurrent batches)`,
    `  chat  :8081     → --parallel ${t.chat.llamaServerParallel} -c ${chatCtx}  (${t.chat.ctxPerSlot}/slot; cartograph drives ${t.chat.cartographConcurrency})`,
    `  ask   :8082     → --parallel ${t.ask.llamaServerParallel} -c ${askCtx}  (${t.ask.ctxPerSlot}/slot; cartograph drives ${t.ask.cartographConcurrency})`,
    `  rerank :8083 (with ${LLAMA_SERVER_RERANK_FLAG}) → --parallel ${t.reranker.llamaServerParallel}  (cartograph drives ${t.reranker.cartographConcurrency})`,
    "`cartograph backend start` sets these per machine; chat/ask also get an auto-sized `-c` so each slot fits cartograph's summary prompts " +
      '(llama.cpp splits `-c` across `--parallel` slots). If you launch llama-server yourself, mirror the `-c` above; override either via `llamaServerArgs`.',
  ].join('\n');
  return { id: 'recommended-tuning', name: 'Recommended tuning', status: 'ok', detail: lines };
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
