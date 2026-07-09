import { getAskModel, getChatModel, getEmbeddingModel, resolveOpenAiCompatApiKey } from '../../llm/provider.js';
import type { LlmEndpointConfig } from '../../llm/client.js';
import type Cartograph from '../../index.js';

type FetchLike = typeof fetch;

interface ReachabilityEndpoint {
  readonly tier: string;
  readonly endpoint: string;
  readonly apiKey?: string;
}

/**
 * Surface LLM provider routing. Without this an agent has no way to
 * verify split-provider configs without reading config.json out of band.
 */
export async function appendLlmProviders(lines: string[], cg: Cartograph): Promise<void> {
  let llmCfg: Awaited<ReturnType<typeof cg.llm.config.getEffectiveLlmConfig>> | undefined;
  try {
    llmCfg = await cg.llm.config.getEffectiveLlmConfig();
  } catch {
    return;
  }
  if (!llmCfg) {
    lines.push(
      '',
      '### 🤖 LLM providers',
      `- _No LLM configured. Set \`config.llm\` in \`.cartograph/config.json\` (run \`cartograph admin llm-plan\` then \`cartograph admin llm-apply --preset <id>\`, or run \`cartograph llm setup\` for the interactive wizard). Required for \`cartograph_ask\`, \`cartograph_admin({action: "summarize"})\`, \`cartograph_find({by: "name", mode: "semantic"})\`._`,
    );
    return;
  }

  const llmLines: string[] = [];
  const chatModel = getChatModel(llmCfg);
  const askModel = getAskModel(llmCfg);
  const embModel = getEmbeddingModel(llmCfg);

  const chatLine = formatLlmLine({
    label: 'Summarize model',
    provider: llmCfg.summarizeLlm?.provider,
    model: chatModel,
  });
  if (chatLine) llmLines.push(chatLine);

  if (askModel && askModel !== chatModel) {
    const askLine = formatLlmLine({ label: 'Ask model', provider: llmCfg.askLlm?.provider, model: askModel });
    if (askLine) llmLines.push(askLine);
  }

  const embLine = formatLlmLine({ label: 'Embedding model', provider: llmCfg.embeddingLlm?.provider, model: embModel });
  if (embLine) llmLines.push(embLine);

  llmLines.push(
    ...collectMissingTierWarnings({
      summarizeWired: chatModel !== undefined && chatModel.length > 0,
      askWired: askModel !== undefined && askModel.length > 0,
      embeddingWired: embModel !== undefined && embModel.length > 0,
      rerankerWired:
        llmCfg.rerankerLlm != null &&
        typeof llmCfg.rerankerLlm.model === 'string' &&
        llmCfg.rerankerLlm.model.length > 0,
    }),
  );

  const reachLines = await renderReachabilitySection(llmCfg);
  llmLines.push(...renderTuningSection(llmCfg), ...reachLines);

  if (llmLines.length > 0) {
    lines.push('', '### 🤖 LLM providers', ...llmLines);
  }
}

export async function renderReachabilitySection(
  llmCfg: LlmEndpointConfig,
  fetchImpl: FetchLike = fetch,
): Promise<string[]> {
  const endpoints = collectReachabilityEndpoints(llmCfg);
  if (endpoints.length === 0) return [];

  const distinctEndpoints = collectDistinctEndpointProbes(endpoints);
  const probes = await Promise.all(
    distinctEndpoints.map(async ({ endpoint, apiKey }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1500);
      try {
        const probeUrl = `${endpoint.replace(/\/$/, '').replace(/\/v1$/, '')}/v1/models`;
        const init: RequestInit = { signal: controller.signal };
        if (apiKey) {
          init.headers = { Authorization: `Bearer ${apiKey}` };
        }
        const res = await fetchImpl(probeUrl, init);
        return { url: endpoint, ok: res.ok };
      } catch {
        return { url: endpoint, ok: false };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
  const reachMap = new Map<string, boolean>(probes.map((p) => [p.url, p.ok]));

  const unavailable: string[] = [];
  const out: string[] = ['', '**Backend reachability** _(probed now)_:'];
  for (const { tier, endpoint } of endpoints) {
    const ok = reachMap.get(endpoint) ?? false;
    if (!ok) unavailable.push(tier);
    out.push(
      `- ${ok ? '✓' : '✗'} **${tier}** → \`${endpoint}\` ${ok ? 'reachable' : '**NOT reachable** — start the backend or fix the endpoint URL'}`,
    );
  }
  if (unavailable.length > 0) {
    out.push(
      '',
      `_LLM features are partially offline (${unavailable.join(', ')}). Run \`cartograph_admin({action: "llm-plan"})\` to inspect detected backends, \`cartograph_admin({action: "doctor", fix: true})\` to re-check setup, or start the configured backend processes and retry._`,
    );
  }
  return out;
}

function collectDistinctEndpointProbes(endpoints: readonly ReachabilityEndpoint[]): ReachabilityEndpoint[] {
  const probes = new Map<string, ReachabilityEndpoint>();
  for (const endpoint of endpoints) {
    const existing = probes.get(endpoint.endpoint);
    if (!existing || (!existing.apiKey && endpoint.apiKey)) {
      probes.set(endpoint.endpoint, endpoint);
    }
  }
  return [...probes.values()];
}

function collectReachabilityEndpoints(llmCfg: LlmEndpointConfig): ReachabilityEndpoint[] {
  const endpoints: ReachabilityEndpoint[] = [];
  const collect = (
    tier: string,
    block: { provider?: string; endpoint?: string; apiKey?: string } | null | undefined,
  ): void => {
    if (block?.provider === 'openai-compat' && typeof block.endpoint === 'string' && block.endpoint.length > 0) {
      const apiKey = resolveOpenAiCompatApiKey(block.apiKey, block.endpoint);
      endpoints.push(apiKey ? { tier, endpoint: block.endpoint, apiKey } : { tier, endpoint: block.endpoint });
    }
  };
  collect('embed', llmCfg.embeddingLlm);
  collect('chat', llmCfg.summarizeLlm);
  collect('ask', llmCfg.askLlm);
  collect('reranker', llmCfg.rerankerLlm);
  return endpoints;
}

function renderTuningSection(llmCfg: LlmEndpointConfig): string[] {
  const { describeHardware, recommendedTuning } =
    require('../../installer/hardware-tuning.js') as typeof import('../../installer/hardware-tuning.js');
  const hw = describeHardware();
  const t = recommendedTuning();
  const readConc = (block: { concurrency?: number } | null | undefined): number | null =>
    typeof block?.concurrency === 'number' ? block.concurrency : null;
  const overrides = {
    embed: readConc(llmCfg.embeddingLlm),
    chat: readConc(llmCfg.summarizeLlm),
    ask: readConc(llmCfg.askLlm),
    reranker: readConc(llmCfg.rerankerLlm),
  };
  const fmt = (rec: number, override: number | null): string =>
    override === null ? `${rec} (auto)` : `**${override}** (manual override; auto would be ${rec})`;
  return [
    '',
    `**Tuning** _(detected ${hw}; override per tier via \`cartograph_admin({action: "llm-tune", tier, concurrency})\` or hand-edit \`*Llm.concurrency\` in config.json)_`,
    `- embed:    ${fmt(t.embed.cartographConcurrency, overrides.embed)}`,
    `- chat:     ${fmt(t.chat.cartographConcurrency, overrides.chat)}`,
    `- ask:      ${fmt(t.ask.cartographConcurrency, overrides.ask)}`,
    `- reranker: ${fmt(t.reranker.cartographConcurrency, overrides.reranker)}`,
  ];
}

interface TierImpact {
  readonly label: string;
  readonly missingDisables: ReadonlyArray<string>;
}

const TIER_FEATURE_IMPACT: Record<'summarize' | 'ask' | 'embedding' | 'reranker', TierImpact> = {
  summarize: {
    label: 'Summarize chat',
    missingDisables: [
      "`cartograph_admin({action: 'summarize'})` — bulk symbol summarisation pass",
      "`cartograph_admin({action: 'classify'})` — LLM role classification (structural fallback still runs)",
      "`cartograph_dead_code({via: 'llm' | 'auto'})` — LLM judge over dead-code candidates (graph-only `via: 'rule'` still works)",
      "`cartograph_find({by: 'name', mode: 'intent'})` — when summaries are absent, intent search falls back to docstrings + test descriptions only",
    ],
  },
  ask: {
    label: 'Ask chat',
    missingDisables: ['`cartograph_ask` — RAG Q&A over the indexed codebase (falls back to `summarizeLlm` if unset)'],
  },
  embedding: {
    label: 'Embedding',
    missingDisables: [
      "`cartograph_find({by: 'name', mode: 'semantic'})` — semantic peer / concept search (falls back to FTS-only via `mode: 'exact'`)",
      "`cartograph_graph({direction: 'similar'})` — embedding-cosine peers",
      "`cartograph_admin({action: 'embed' | 'embed-only'})` — vec0 population",
      "`cartograph_admin({action: 'build-similarity-edges'})` — `similar_to` edge population",
    ],
  },
  reranker: {
    label: 'Reranker',
    missingDisables: [
      'Cross-encoder rescore on semantic search top-K (semantic search still returns cosine top-K, just without the precision boost on disambiguation-heavy queries)',
    ],
  },
};

export function collectMissingTierWarnings(opts: {
  summarizeWired: boolean;
  askWired: boolean;
  embeddingWired: boolean;
  rerankerWired: boolean;
}): string[] {
  const out: string[] = [];
  const missing: Array<keyof typeof TIER_FEATURE_IMPACT> = [];
  if (!opts.summarizeWired) missing.push('summarize');
  if (!opts.askWired && !opts.summarizeWired) missing.push('ask');
  if (!opts.embeddingWired) missing.push('embedding');
  if (!opts.rerankerWired) missing.push('reranker');
  if (missing.length === 0) return out;
  out.push('', '**Feature impact of unwired tiers:**');
  for (const tier of missing) {
    const impact = TIER_FEATURE_IMPACT[tier];
    out.push(`- ✗ **${impact.label}** unwired — these features are unavailable:`);
    for (const f of impact.missingDisables) {
      out.push(`  - ${f}`);
    }
  }
  out.push(
    '',
    '_Run `cartograph_admin({action: "llm-plan"})` to see setup presets; then `cartograph_admin({action: "llm-apply", preset: "<id>"})` to wire any missing tier._',
  );
  return out;
}

interface FormatLlmLineArgs {
  label: string;
  provider: string | undefined;
  model: string | undefined;
}

function formatLlmLine(args: FormatLlmLineArgs): string | null {
  const { label, provider, model } = args;
  if (!model) return null;
  const parts: string[] = [`\`${model}\``];
  if (provider) parts.push(`provider \`${provider}\``);
  return `- **${label}:** ${parts.join(' ')}`;
}
