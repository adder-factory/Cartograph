/**
 * Agent-friendly LLM setup planner.
 *
 * Where `llm-setup.ts` runs an interactive @clack/prompts wizard
 * (TTY-only), this module exposes the same decision tree as a pure
 * function returning structured data. Any agent that speaks MCP
 * (Claude Code, Cursor, Windsurf, Codex CLI, opencode, LangChain,
 * OpenAI Agent SDK, …) can call `planLlmSetup()`, render the
 * options in its own chat UI, take the user's choice, and apply it
 * via `applyLlmSetupChoice()`.
 *
 * Two surfaces consume this module:
 *   1. `cartograph_admin({action: 'llm-plan'})` MCP tool — returns the
 *      plan as JSON for an agent to walk a user through.
 *   2. `cartograph_admin({action: 'llm-apply', preset: '<name>'})` MCP
 *      tool — applies the chosen preset non-interactively, writes
 *      `.cartograph/config.json`, returns a status report.
 *
 * The same plan presets the interactive wizard offers are exposed
 * here so the agent and the CLI flow stay in lockstep. Adding a
 * preset means adding one entry to {@link AVAILABLE_PRESETS} +
 * extending {@link applyLlmSetupChoice}'s switch.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { findOnPath } from '../llm/claude-bridge.js';
import { DEFAULT_CLAUDE_ASK_MODEL } from '../llm/provider.js';
import {
  MODELS_DIR_DEFAULT,
  RECOMMENDED_CHAT_ASK,
  RECOMMENDED_CHAT_SUMMARIZE,
  RECOMMENDED_EMBED,
  RECOMMENDED_RERANKER,
  resolveRecommendedModelPath,
} from '../llm/recommended-models.js';
import { buildRecommendedLlmConfig } from './recommended-config.js';
import { buildSingleEndpointConfig } from './build-endpoint-config.js';
import { errMsg } from '../errors.js';
import {
  backendInstallHint,
  backendLabel,
  scanForLlmBackends,
  type DetectedBackend,
  type DetectedBackendKind,
} from './scan-backends.js';
import {
  OLLAMA_DEFAULT_ENDPOINT,
  MLX_DEFAULT_ENDPOINT,
  LLAMA_SERVER_EMBED_ENDPOINT,
  LLAMA_SERVER_SUMMARIZE_ENDPOINT,
  LLAMA_SERVER_ASK_ENDPOINT,
  LLAMA_SERVER_RERANKER_ENDPOINT,
  CLOUD_OPENAI_PUBLIC_ENDPOINT,
  CLOUD_OPENAI_KEYS_URL,
  CLOUD_OPENROUTER_PUBLIC_ENDPOINT,
  CLOUD_OPENROUTER_KEYS_URL,
  OPENAI_COMPAT_PLACEHOLDER_ENDPOINT,
} from './default-endpoints.js';
import type { CartographConfig } from '../types.js';
import { MLX_RECOMMENDED_MODELS, OLLAMA_RECOMMENDED_MODELS } from './llm-setup-catalog.js';
export { OLLAMA_RECOMMENDED_MODELS } from './llm-setup-catalog.js';

/** Each preset the agent can apply. `description` is rendered to the
 *  user; `nextSteps` is what they (or their agent) must run AFTER
 *  applying the preset so the configured endpoints are actually
 *  reachable. */
export interface SetupPreset {
  /** Stable identifier used by `applyLlmSetupChoice` + the CLI. */
  readonly id: SetupPresetId;
  /** Short label suitable for an option picker. */
  readonly label: string;
  /** Why this preset and when to pick it. */
  readonly description: string;
  /** Tier→endpoint summary the agent can show before the user picks. */
  readonly summary: string;
  /** Commands the user must run AFTER applying this preset for the
   *  endpoints to actually serve traffic (install + start + model
   *  pull / download). */
  readonly nextSteps: readonly string[];
  /** Whether the preset assumes a backend is ALREADY running on the
   *  user's machine. `requiresInstall: false` (e.g. 'use-detected-*')
   *  means doctor will go ✓ immediately after apply. */
  readonly requiresInstall: boolean;
  /** For `use-detected-*` presets: the structurally-extracted endpoint
   *  + kind the applier rebuilds the config from. Carried on the
   *  preset object directly (rather than recovered via regex on
   *  `summary`) so a future summary-wording edit doesn't silently
   *  break config generation. Omitted for static presets. */
  readonly detectedBackend?: {
    readonly kind: DetectedBackendKind;
    readonly endpoint: string;
    readonly models: ReadonlyArray<string>;
  };
}

export type SetupPresetId =
  | `use-detected-${string}`
  | 'install-ollama'
  | 'install-llama-cpp'
  | 'install-mlx'
  | 'cloud-openai'
  | 'cloud-openrouter'
  | 'cloud-openai-compat'
  | 'hybrid-claude-bridge'
  | 'hybrid-anthropic-api'
  | 'skip';

/** Recommended cloud OpenAI models per tier. Picked for the
 *  cost/quality tradeoff cartograph's workload tolerates well —
 *  embed runs over every indexed symbol so the small embedding tier
 *  is right for bulk; chat is the small bulk-summary tier; ask is
 *  the higher-stakes RAG-style tier. Override per-tier in the
 *  written config if the user wants something else. */
const CLOUD_OPENAI_MODELS = {
  embed: 'text-embedding-3-small',
  summarize: 'gpt-4o-mini',
  ask: 'gpt-4o',
} as const;

/** Recommended OpenRouter models per tier — same cost/quality framing
 *  as {@link CLOUD_OPENAI_MODELS}: summarize is the cheap bulk tier,
 *  ask the higher-stakes tier. OpenRouter ids are `vendor/model`; any
 *  of its hundreds of hosted models can be swapped in per tier in the
 *  written config. No embed entry — OpenRouter's surface is
 *  chat-first, so the preset leaves the embedding tier unset. */
const CLOUD_OPENROUTER_MODELS = {
  summarize: 'google/gemini-2.5-flash-lite',
  ask: 'anthropic/claude-haiku-4.5',
} as const;

/** What the planner observed + what it recommends. Returned by
 *  {@link planLlmSetup}. Stable JSON shape — agent code can rely on
 *  field names + types. */
export interface SetupPlan {
  /** Backends scanned + found on the common localhost ports. */
  readonly detectedBackends: ReadonlyArray<{
    readonly kind: DetectedBackendKind;
    readonly label: string;
    readonly endpoint: string;
    readonly models: ReadonlyArray<string>;
  }>;
  /** Optional cloud-chat tooling detected in env. */
  readonly cloudChatAvailable: {
    readonly claudeBin: string | null;
    readonly anthropicApiKey: boolean;
  };
  /** Per-recommended-model presence under `~/.cartograph/models/`. */
  readonly localGgufPresence: ReadonlyArray<{
    readonly filename: string;
    readonly sizeMb: number;
    readonly present: boolean;
  }>;
  /** Presets the agent can offer the user. Ordered by recommendedness —
   *  pick the first one when no further user input is available. */
  readonly presets: ReadonlyArray<SetupPreset>;
  /** Which preset id the planner would auto-pick (no user input). */
  readonly recommendedPresetId: SetupPresetId;
}

/** Top-level: scan, probe, build the plan. Pure-data return — no
 *  side effects on the project's config.json (use
 *  {@link applyLlmSetupChoice} for that). */
export async function planLlmSetup(opts: { modelsDir?: string } = {}): Promise<SetupPlan> {
  const modelsDir = opts.modelsDir ?? MODELS_DIR_DEFAULT;
  const [claudeBin, detectedBackends] = await Promise.all([findOnPath('claude'), scanForLlmBackends()]);
  const anthropicApiKey = typeof process.env['ANTHROPIC_API_KEY'] === 'string';

  const localGgufPresence = await Promise.all(
    [RECOMMENDED_EMBED, RECOMMENDED_CHAT_SUMMARIZE, RECOMMENDED_CHAT_ASK, RECOMMENDED_RERANKER].map(async (m) => ({
      filename: m.filename,
      sizeMb: m.sizeMb,
      present: await fsp
        .access(resolveRecommendedModelPath(m, modelsDir))
        .then(() => true)
        .catch(() => false),
    })),
  );

  const presets = buildPresets({ detectedBackends, claudeBin, anthropicApiKey, localGgufPresence });
  const recommendedPresetId = chooseRecommendedPresetId(detectedBackends, presets);

  return {
    detectedBackends: detectedBackends.map((b) => ({
      kind: b.kind,
      label: backendLabel(b.kind),
      endpoint: b.endpoint,
      models: b.models,
    })),
    cloudChatAvailable: { claudeBin, anthropicApiKey },
    localGgufPresence,
    presets,
    recommendedPresetId,
  };
}

function hasDetectedEndpoint(backends: readonly DetectedBackend[], endpoint: string): boolean {
  return backends.some((b) => b.kind === 'llama-server' && b.endpoint === endpoint);
}

function hasStandardLlamaCppStack(backends: readonly DetectedBackend[]): boolean {
  return (
    hasDetectedEndpoint(backends, LLAMA_SERVER_EMBED_ENDPOINT) &&
    hasDetectedEndpoint(backends, LLAMA_SERVER_SUMMARIZE_ENDPOINT) &&
    hasDetectedEndpoint(backends, LLAMA_SERVER_ASK_ENDPOINT) &&
    hasDetectedEndpoint(backends, LLAMA_SERVER_RERANKER_ENDPOINT)
  );
}

export function chooseRecommendedPresetId(
  detectedBackends: readonly DetectedBackend[],
  presets: readonly SetupPreset[],
): SetupPresetId {
  if (hasStandardLlamaCppStack(detectedBackends)) return 'install-llama-cpp';
  const firstDetected = presets.find((p) => p.id.startsWith('use-detected-'));
  if (firstDetected) return firstDetected.id;
  return 'install-ollama';
}

interface BuildPresetsArgs {
  detectedBackends: readonly DetectedBackend[];
  claudeBin: string | null;
  anthropicApiKey: boolean;
  localGgufPresence: ReadonlyArray<{ filename: string; sizeMb: number; present: boolean }>;
}

function buildPresets(args: BuildPresetsArgs): SetupPreset[] {
  const { detectedBackends, claudeBin, anthropicApiKey, localGgufPresence } = args;
  const presets: SetupPreset[] = [];

  // One use-detected preset per running backend.
  for (const b of detectedBackends) {
    presets.push(buildUseDetectedPreset(b));
  }

  // Install paths — always available; pushed below detected when
  // anything's running.
  presets.push(
    buildInstallOllamaPreset(),
    buildInstallLlamaCppPreset(localGgufPresence),
    buildInstallMlxPreset(),
    buildCloudOpenAiPreset(),
    buildCloudOpenRouterPreset(),
    buildCloudOpenAiCompatPreset(),
  );

  // Cloud presets — always available. Most accessible when local
  // hardware can't host the recommended model sizes (limited
  // VRAM/RAM, slow disk, no GPU).

  // Hybrid: cloud Claude for ask. Only when cloud auth is present.
  if (claudeBin !== null) presets.push(buildHybridPreset('hybrid-claude-bridge', claudeBin));
  if (anthropicApiKey) presets.push(buildHybridPreset('hybrid-anthropic-api', null));

  presets.push({
    id: 'skip',
    label: 'Skip — configure later',
    description: 'Write nothing. Re-run `cartograph admin llm-plan` or `cartograph llm setup` when ready.',
    summary: 'No config change.',
    nextSteps: [],
    requiresInstall: false,
  });

  return presets;
}

function buildUseDetectedPreset(b: DetectedBackend): SetupPreset {
  const id: SetupPresetId = `use-detected-${b.kind}-${b.endpoint.replaceAll(/[^a-z0-9]/gi, '-')}`;
  const isOllama = b.kind === 'ollama';
  const llamaTier = b.kind === 'llama-server' ? llamaServerTierForEndpoint(b.endpoint) : null;
  const nextSteps: string[] = [];
  if (isOllama) {
    // Detect which recommended models the running Ollama is missing.
    const needed = [
      OLLAMA_RECOMMENDED_MODELS.embed,
      OLLAMA_RECOMMENDED_MODELS.summarize,
      OLLAMA_RECOMMENDED_MODELS.ask,
    ];
    const loadedNames = new Set(b.models.map((m) => m.split(':')[0]!));
    const missing = needed.filter((m) => !loadedNames.has(m.split(':')[0]!));
    for (const m of missing) {
      nextSteps.push(`ollama pull ${m}`);
    }
  }
  nextSteps.push('cartograph doctor   # verify');
  return {
    id,
    label: `Use detected ${backendLabel(b.kind)} at ${b.endpoint}`,
    description: detectedPresetDescription(b.kind),
    summary: detectedPresetSummary(b, llamaTier),
    nextSteps,
    requiresInstall: nextSteps.length > 1,
    detectedBackend: { kind: b.kind, endpoint: b.endpoint, models: b.models },
  };
}

function detectedPresetDescription(kind: DetectedBackendKind): string {
  switch (kind) {
    case 'ollama':
      return 'Single endpoint, model auto-swap. Easiest path when Ollama is already installed.';
    case 'llama-server':
      return 'llama-server serves one loaded model per process. This preset wires only the tier matching the detected port.';
    default:
      return 'Single endpoint. Ensure the backend has the relevant model(s) loaded for each tier you want to use.';
  }
}

function detectedPresetSummary(b: DetectedBackend, llamaTier: LlamaServerTierInfo | null): string {
  const modelCount = `${b.models.length} model${b.models.length === 1 ? '' : 's'} loaded`;
  if (b.kind === 'ollama') return `All tiers → ${b.endpoint} (${modelCount})`;
  if (llamaTier) {
    return `${llamaTier.summaryTier} → ${b.endpoint} (${modelCount}); other tiers stay unconfigured/fallback`;
  }
  return `Single detected endpoint → ${b.endpoint} (${modelCount}); configure only the tier this backend serves`;
}

type LlamaServerDetectedTier = 'embeddingLlm' | 'summarizeLlm' | 'askLlm' | 'rerankerLlm';

interface LlamaServerTierInfo {
  readonly configTier: LlamaServerDetectedTier;
  readonly summaryTier: string;
}

function llamaServerTierForEndpoint(endpoint: string): LlamaServerTierInfo | null {
  switch (endpoint) {
    case LLAMA_SERVER_EMBED_ENDPOINT:
      return { configTier: 'embeddingLlm', summaryTier: 'embeddingLlm' };
    case LLAMA_SERVER_SUMMARIZE_ENDPOINT:
      return { configTier: 'summarizeLlm', summaryTier: 'summarizeLlm + localLlm' };
    case LLAMA_SERVER_ASK_ENDPOINT:
      return { configTier: 'askLlm', summaryTier: 'askLlm' };
    case LLAMA_SERVER_RERANKER_ENDPOINT:
      return { configTier: 'rerankerLlm', summaryTier: 'rerankerLlm' };
    default:
      return null;
  }
}

function buildDetectedLlamaServerConfig(
  endpoint: string,
  models: ReadonlyArray<string>,
): NonNullable<CartographConfig['llm']> | null {
  const tier = llamaServerTierForEndpoint(endpoint);
  if (!tier) return null;
  const fallbackModel = models[0] ?? '<set model in config.json>';
  const cfg: NonNullable<CartographConfig['llm']> = {};
  switch (tier.configTier) {
    case 'embeddingLlm':
      cfg.embeddingLlm = { provider: 'openai-compat', endpoint, model: fallbackModel };
      break;
    case 'summarizeLlm':
      cfg.summarizeLlm = { provider: 'openai-compat', endpoint, model: fallbackModel };
      cfg.localLlm = { provider: 'openai-compat', endpoint, model: fallbackModel };
      break;
    case 'askLlm':
      cfg.askLlm = { provider: 'openai-compat', endpoint, model: fallbackModel };
      break;
    case 'rerankerLlm':
      cfg.rerankerLlm = { provider: 'openai-compat', endpoint, model: fallbackModel };
      break;
  }
  return cfg;
}

function buildCloudOpenAiConfig(): NonNullable<CartographConfig['llm']> {
  // Omit `endpoint` so the SDK defaults to api.openai.com.
  // Omit `apiKey` so the SDK reads OPENAI_API_KEY from env (the
  // standard OpenAI client convention — keeps the secret out of the
  // committed config file).
  return {
    summarizeLlm: { provider: 'openai-compat', model: CLOUD_OPENAI_MODELS.summarize },
    localLlm: { provider: 'openai-compat', model: CLOUD_OPENAI_MODELS.summarize },
    askLlm: { provider: 'openai-compat', model: CLOUD_OPENAI_MODELS.ask },
    embeddingLlm: { provider: 'openai-compat', model: CLOUD_OPENAI_MODELS.embed },
  };
}

function buildCloudOpenRouterConfig(): NonNullable<CartographConfig['llm']> {
  // Endpoint is explicit (the OpenAI SDK has no OpenRouter default);
  // `apiKey` is omitted so the provider resolver reads
  // OPENROUTER_API_KEY from env — keeps the secret out of the
  // committed config file. Embedding/reranker tiers are left unset:
  // OpenRouter's surface is chat-first, so semantic search stays off
  // unless the user pairs a local or cloud embedding provider.
  return {
    summarizeLlm: {
      provider: 'openai-compat',
      endpoint: CLOUD_OPENROUTER_PUBLIC_ENDPOINT,
      model: CLOUD_OPENROUTER_MODELS.summarize,
    },
    localLlm: {
      provider: 'openai-compat',
      endpoint: CLOUD_OPENROUTER_PUBLIC_ENDPOINT,
      model: CLOUD_OPENROUTER_MODELS.summarize,
    },
    askLlm: {
      provider: 'openai-compat',
      endpoint: CLOUD_OPENROUTER_PUBLIC_ENDPOINT,
      model: CLOUD_OPENROUTER_MODELS.ask,
    },
  };
}

function buildCloudOpenAiCompatTemplateConfig(): NonNullable<CartographConfig['llm']> {
  // Placeholder values are sentinels doctor will flag as unreachable
  // so the user sees a concrete remediation instead of silent breakage.
  return {
    summarizeLlm: {
      provider: 'openai-compat',
      endpoint: OPENAI_COMPAT_PLACEHOLDER_ENDPOINT,
      apiKey: 'YOUR-KEY',
      model: 'YOUR-CHAT-MODEL',
    },
    localLlm: {
      provider: 'openai-compat',
      endpoint: OPENAI_COMPAT_PLACEHOLDER_ENDPOINT,
      apiKey: 'YOUR-KEY',
      model: 'YOUR-CHAT-MODEL',
    },
    askLlm: {
      provider: 'openai-compat',
      endpoint: OPENAI_COMPAT_PLACEHOLDER_ENDPOINT,
      apiKey: 'YOUR-KEY',
      model: 'YOUR-ASK-MODEL',
    },
    embeddingLlm: {
      provider: 'openai-compat',
      endpoint: OPENAI_COMPAT_PLACEHOLDER_ENDPOINT,
      apiKey: 'YOUR-KEY',
      model: 'YOUR-EMBED-MODEL',
    },
  };
}

function buildInstallOllamaPreset(): SetupPreset {
  return {
    id: 'install-ollama',
    label: 'Install Ollama (simplest — auto-manages models)',
    description: 'One process on :11434 serves every tier. Models auto-load on demand. Recommended for new users.',
    summary: `All tiers → ${OLLAMA_DEFAULT_ENDPOINT} (model auto-swap)`,
    nextSteps: [
      backendInstallHint('ollama'),
      `ollama pull ${OLLAMA_RECOMMENDED_MODELS.embed}`,
      `ollama pull ${OLLAMA_RECOMMENDED_MODELS.summarize}`,
      `ollama pull ${OLLAMA_RECOMMENDED_MODELS.ask}`,
      'cartograph doctor   # verify',
    ],
    requiresInstall: true,
  };
}

function buildInstallLlamaCppPreset(
  localGgufPresence: ReadonlyArray<{ filename: string; sizeMb: number; present: boolean }>,
): SetupPreset {
  const missingMb = localGgufPresence.filter((m) => !m.present).reduce((sum, m) => sum + m.sizeMb, 0);
  const downloadHint = missingMb > 0 ? `~${missingMb} MB GGUFs need download` : 'all GGUFs already present';
  return {
    id: 'install-llama-cpp',
    label: 'Install llama-cpp + download recommended GGUFs',
    description:
      'One llama-server per tier (4 processes on consecutive ports). Closest model quality to the curated GGUF set.',
    summary: `Embed :8080 / chat :8081 / ask :8082 / reranker :8083 (${downloadHint})`,
    nextSteps: [
      backendInstallHint('llama-server'),
      'cartograph admin install-models   # if not already downloaded',
      'cartograph backend start   # launches configured local llama-server processes',
      'cartograph llm smoke       # exercise real chat/embed/rerank requests',
      'cartograph doctor   # verify',
    ],
    requiresInstall: true,
  };
}

function buildCloudOpenAiPreset(): SetupPreset {
  const hasKey = typeof process.env['OPENAI_API_KEY'] === 'string';
  return {
    id: 'cloud-openai',
    label: hasKey
      ? '☁️ Cloud OpenAI (OPENAI_API_KEY detected — ready to use)'
      : '☁️ Cloud OpenAI (set OPENAI_API_KEY first)',
    description:
      `Direct OpenAI API. Embed via ${CLOUD_OPENAI_MODELS.embed}, chat via ` +
      `${CLOUD_OPENAI_MODELS.summarize}, ask via ${CLOUD_OPENAI_MODELS.ask}. ` +
      `Best for users without local GPU / disk for GGUFs. Pay-per-token.`,
    summary: `All tiers → ${CLOUD_OPENAI_PUBLIC_ENDPOINT} (${CLOUD_OPENAI_MODELS.embed} / ${CLOUD_OPENAI_MODELS.summarize} / ${CLOUD_OPENAI_MODELS.ask})`,
    nextSteps: hasKey
      ? ['cartograph doctor   # verify (OPENAI_API_KEY already set in env)']
      : [`export OPENAI_API_KEY=sk-...   # get one at ${CLOUD_OPENAI_KEYS_URL}`, 'cartograph doctor   # verify'],
    requiresInstall: !hasKey,
  };
}

function buildCloudOpenRouterPreset(): SetupPreset {
  const hasKey = typeof process.env['OPENROUTER_API_KEY'] === 'string';
  return {
    id: 'cloud-openrouter',
    label: hasKey
      ? '☁️ Cloud OpenRouter (OPENROUTER_API_KEY detected — ready to use)'
      : '☁️ Cloud OpenRouter (set OPENROUTER_API_KEY first)',
    description:
      `One Bearer key in front of hundreds of hosted models (OpenAI, Anthropic, Google, Qwen, DeepSeek, ...). ` +
      `Chat tiers only — summarize via ${CLOUD_OPENROUTER_MODELS.summarize}, ask via ` +
      `${CLOUD_OPENROUTER_MODELS.ask}; pair a local or cloud embedding provider for semantic search. ` +
      `Best for trying cloud models without per-vendor accounts. Pay-per-token.`,
    summary: `Chat tiers → ${CLOUD_OPENROUTER_PUBLIC_ENDPOINT} (${CLOUD_OPENROUTER_MODELS.summarize} / ${CLOUD_OPENROUTER_MODELS.ask})`,
    nextSteps: hasKey
      ? ['cartograph doctor   # verify (OPENROUTER_API_KEY already set in env)']
      : [
          `export OPENROUTER_API_KEY=sk-or-...   # get one at ${CLOUD_OPENROUTER_KEYS_URL}`,
          'cartograph doctor   # verify',
        ],
    requiresInstall: !hasKey,
  };
}

function buildCloudOpenAiCompatPreset(): SetupPreset {
  return {
    id: 'cloud-openai-compat',
    label: '☁️ Cloud OpenAI-compat provider (together.ai / fireworks.ai / groq / Cohere / ...)',
    description:
      `Generic OpenAI-compat cloud — any provider that accepts a Bearer token + serves /v1/chat/completions + ` +
      `/v1/embeddings. Wizard writes a template config; user fills in endpoint / model / apiKey per provider.`,
    summary: 'All tiers → <user-supplied endpoint> (config template — hand-edit before doctor)',
    nextSteps: [
      'Edit .cartograph/config.json — set each *Llm.endpoint to the provider base URL,',
      '  each *Llm.apiKey to your provider API key (or set provider-specific env var),',
      '  and each *Llm.model to a model the provider serves.',
      'cartograph doctor   # verify',
    ],
    requiresInstall: true,
  };
}

function buildInstallMlxPreset(): SetupPreset {
  return {
    id: 'install-mlx',
    label: 'Install Apple MLX (Apple Silicon only)',
    description: 'Native Metal-optimised. mlx_lm.server provides the OpenAI-compat surface. One model per process.',
    summary: `All tiers → ${MLX_DEFAULT_ENDPOINT} (one mlx_lm.server per tier — hand-edit endpoints for separate ports)`,
    nextSteps: [
      backendInstallHint('mlx_lm'),
      `python -m mlx_lm.server --model ${MLX_RECOMMENDED_MODELS.embed} --port 8000 &`,
      '# Edit .cartograph/config.json to point each tier at the port serving its model.',
      'cartograph doctor   # verify',
    ],
    requiresInstall: true,
  };
}

function buildHybridPreset(id: 'hybrid-claude-bridge' | 'hybrid-anthropic-api', claudeBin: string | null): SetupPreset {
  const provider = id === 'hybrid-claude-bridge' ? 'claude-bridge' : 'anthropic-api';
  const cloudHint =
    id === 'hybrid-claude-bridge' ? `\`claude\` CLI at ${claudeBin ?? '(on PATH)'}` : 'ANTHROPIC_API_KEY from env';
  return {
    id,
    label: `Hybrid — Claude for ask (via ${provider})`,
    description: `Combines a local stack (llama-cpp) for embed/chat with ${cloudHint} for higher-stakes Q&A on \`cartograph_ask\`.`,
    summary: `Embed/chat → llama-server (local), askLlm → ${provider}`,
    nextSteps: [
      'Follow the llama-cpp install steps for embed/chat tiers, then re-run apply.',
      'cartograph doctor   # verify',
    ],
    requiresInstall: true,
  };
}

/**
 * Returns the localhost endpoint URLs that a given local `install-*`
 * preset writes to config. Used by {@link applyLlmSetupChoice} to
 * re-probe running backends before emitting install instructions.
 *
 * Returns an empty array for cloud / hybrid / compat presets whose
 * backends are not local — the caller falls back to the generic
 * "assumes not yet running" note for those.
 */
function installPresetTargetEndpoints(presetId: SetupPresetId): string[] {
  switch (presetId) {
    case 'install-llama-cpp':
      return [
        LLAMA_SERVER_EMBED_ENDPOINT,
        LLAMA_SERVER_SUMMARIZE_ENDPOINT,
        LLAMA_SERVER_ASK_ENDPOINT,
        LLAMA_SERVER_RERANKER_ENDPOINT,
      ];
    case 'install-ollama':
      return [OLLAMA_DEFAULT_ENDPOINT];
    case 'install-mlx':
      return [MLX_DEFAULT_ENDPOINT];
    default:
      // Cloud / hybrid / compat / use-detected-* — not locally probed.
      return [];
  }
}

/**
 * Apply a chosen preset non-interactively. Writes
 * `.cartograph/config.json` (with a `.bak.<ts>` backup if one
 * existed). Returns a structured report so the calling agent can
 * relay status to the user.
 */
export interface ApplyResult {
  readonly applied: boolean;
  readonly preset: SetupPresetId;
  /** Absolute path to the config file written, or null when no
   *  write happened (e.g. skip preset). */
  readonly configPath: string | null;
  /** Absolute path to the pre-overwrite backup, or null on first
   *  write. */
  readonly backupPath: string | null;
  /** Human-readable next-steps the user must run for the endpoints
   *  to actually serve traffic. Same content as
   *  `SetupPreset.nextSteps`. */
  readonly nextSteps: ReadonlyArray<string>;
  /** Warnings / hints the calling agent should surface. */
  readonly notes: ReadonlyArray<string>;
}

export interface ApplyOptions {
  readonly projectRoot: string;
  readonly preset: SetupPresetId;
  /** Optional override of the models dir for `recommended-config`. */
  readonly modelsDir?: string;
}

export async function applyLlmSetupChoice(opts: ApplyOptions): Promise<ApplyResult> {
  const plan = await planLlmSetup({ ...(opts.modelsDir ? { modelsDir: opts.modelsDir } : {}) });
  const preset = plan.presets.find((p) => p.id === opts.preset);
  if (!preset) {
    throw new Error(`Unknown preset "${opts.preset}". Available: ${plan.presets.map((p) => p.id).join(', ')}.`);
  }
  if (preset.id === 'skip') {
    return {
      applied: false,
      preset: preset.id,
      configPath: null,
      backupPath: null,
      nextSteps: preset.nextSteps,
      notes: ['User chose to skip. Re-run `cartograph admin llm-plan` or `cartograph llm setup` later when ready.'],
    };
  }

  const cfg = buildConfigForPreset(preset.id, plan, opts.modelsDir);
  if (cfg === null) {
    throw new Error(`Cannot build config for preset "${preset.id}".`);
  }

  // Write through `writeRecommendedLlmConfig`'s atomic-tmp-rename
  // path so the on-disk file mutation has backup semantics matching
  // `admin install-models --write-config`.
  const result = writeRawLlmConfig(opts.projectRoot, cfg);
  const notes: string[] = [];
  let nextSteps: readonly string[] = preset.nextSteps;
  if (preset.requiresInstall) {
    const installNote = await buildInstallPresetNote(preset, nextSteps);
    nextSteps = installNote.nextSteps;
    notes.push(installNote.note);
  }
  return {
    applied: true,
    preset: preset.id,
    configPath: result.configPath,
    backupPath: result.backupPath,
    nextSteps,
    notes,
  };
}

export type LlmTuneTier = 'embed' | 'chat' | 'ask' | 'reranker';
type LlmTuneConfigKey = 'embeddingLlm' | 'summarizeLlm' | 'askLlm' | 'rerankerLlm';

const LLM_TUNE_CONFIG_KEYS: Record<LlmTuneTier, LlmTuneConfigKey> = {
  embed: 'embeddingLlm',
  chat: 'summarizeLlm',
  ask: 'askLlm',
  reranker: 'rerankerLlm',
};

export interface WriteLlmTierConcurrencyOverrideOptions {
  readonly projectRoot: string;
  readonly tier: LlmTuneTier;
  readonly concurrency: number;
}

export interface WriteLlmTierConcurrencyOverrideResult {
  readonly configPath: string;
  readonly backupPath: string;
  readonly configKey: LlmTuneConfigKey;
  readonly previous: number | null;
  readonly concurrency: number;
}

export async function writeLlmTierConcurrencyOverride(
  opts: WriteLlmTierConcurrencyOverrideOptions,
): Promise<WriteLlmTierConcurrencyOverrideResult> {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('concurrency must be a positive integer');
  }
  const configKey = LLM_TUNE_CONFIG_KEYS[opts.tier];
  const configPath = `${opts.projectRoot}/.cartograph/config.json`;
  const exists = await fsp
    .access(configPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    throw new Error(`no config.json at ${configPath}`);
  }
  let parsed: Record<string, unknown>;
  try {
    const raw = await fsp.readFile(configPath, 'utf-8');
    const value = JSON.parse(raw) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new Error('config root must be an object');
    }
    parsed = value as Record<string, unknown>;
  } catch (error_) {
    throw new Error(`could not parse ${configPath}: ${errMsg(error_)}`);
  }
  const llm = (parsed['llm'] as Record<string, unknown> | undefined) ?? {};
  const tierBlock = (llm[configKey] as Record<string, unknown> | null | undefined) ?? null;
  if (!tierBlock) throw new Error(`no llm.${configKey} block in ${configPath}`);
  const previous = typeof tierBlock['concurrency'] === 'number' ? tierBlock['concurrency'] : null;
  tierBlock['concurrency'] = opts.concurrency;
  llm[configKey] = tierBlock;
  parsed['llm'] = llm;
  const backupPath = `${configPath}.bak.${Date.now()}`;
  await fsp.copyFile(configPath, backupPath);
  await fsp.writeFile(`${configPath}.tmp`, JSON.stringify(parsed, null, 2), 'utf-8');
  await fsp.rename(`${configPath}.tmp`, configPath);
  return { configPath, backupPath, configKey, previous, concurrency: opts.concurrency };
}

interface InstallPresetNote {
  readonly nextSteps: readonly string[];
  readonly note: string;
}

async function buildInstallPresetNote(preset: SetupPreset, nextSteps: readonly string[]): Promise<InstallPresetNote> {
  const defaultNote =
    'The chosen preset assumes the backend is not yet running. Follow the `nextSteps` lines before re-running doctor.';
  // For local install presets, re-probe the target endpoints to see
  // whether the user's backends are already running.
  const targetEndpoints = installPresetTargetEndpoints(preset.id);
  if (targetEndpoints.length === 0) return { nextSteps, note: defaultNote };

  const running = await scanForLlmBackends(targetEndpoints);
  const runningTargets = running.filter((b) => targetEndpoints.includes(b.endpoint));
  if (runningTargets.length === 0) return { nextSteps, note: defaultNote };

  const epList = runningTargets.map((b) => b.endpoint).join(', ');
  const doctorStep = nextSteps.find((s) => s.startsWith('cartograph doctor'));
  return {
    nextSteps: doctorStep === undefined ? [] : [doctorStep],
    note: `Detected backend already running on ${epList}; skipping install instructions.`,
  };
}

/** Detected presets: read the structurally-attached `detectedBackend`
 *  off the preset object (kept in sync with the planner so a future
 *  summary-wording change can't silently break config generation). */
function buildConfigForDetectedPreset(id: SetupPresetId, plan: SetupPlan): NonNullable<CartographConfig['llm']> | null {
  const preset = plan.presets.find((p) => p.id === id);
  if (!preset?.detectedBackend) return null;
  const { kind, endpoint, models } = preset.detectedBackend;
  if (kind === 'ollama') {
    return buildSingleEndpointConfig(endpoint, {
      embed: OLLAMA_RECOMMENDED_MODELS.embed,
      summarize: OLLAMA_RECOMMENDED_MODELS.summarize,
      ask: OLLAMA_RECOMMENDED_MODELS.ask,
    });
  }
  if (kind === 'llama-server') {
    return buildDetectedLlamaServerConfig(endpoint, models);
  }
  // mlx_lm / LM Studio / etc. — use the first loaded model as the
  // universal model id. User edits per-tier if needed.
  const fallbackModel = models[0] ?? '<set model in config.json>';
  return buildSingleEndpointConfig(endpoint, {
    embed: fallbackModel,
    summarize: fallbackModel,
    ask: fallbackModel,
  });
}

/** Build the `llm` config block for a preset, given the current plan. */
function buildConfigForPreset(
  id: SetupPresetId,
  plan: SetupPlan,
  _modelsDir: string | undefined,
): NonNullable<CartographConfig['llm']> | null {
  if (id.startsWith('use-detected-')) {
    return buildConfigForDetectedPreset(id, plan);
  }
  if (id === 'install-ollama') {
    return buildSingleEndpointConfig(OLLAMA_DEFAULT_ENDPOINT, {
      embed: OLLAMA_RECOMMENDED_MODELS.embed,
      summarize: OLLAMA_RECOMMENDED_MODELS.summarize,
      ask: OLLAMA_RECOMMENDED_MODELS.ask,
    });
  }
  if (id === 'install-llama-cpp') {
    return buildRecommendedLlmConfig();
  }
  if (id === 'install-mlx') {
    return buildSingleEndpointConfig(MLX_DEFAULT_ENDPOINT, {
      embed: MLX_RECOMMENDED_MODELS.embed,
      summarize: MLX_RECOMMENDED_MODELS.summarize,
      ask: MLX_RECOMMENDED_MODELS.ask,
    });
  }
  if (id === 'cloud-openai') {
    return buildCloudOpenAiConfig();
  }
  if (id === 'cloud-openrouter') {
    return buildCloudOpenRouterConfig();
  }
  if (id === 'cloud-openai-compat') {
    return buildCloudOpenAiCompatTemplateConfig();
  }
  if (id === 'hybrid-claude-bridge' || id === 'hybrid-anthropic-api') {
    const base = buildRecommendedLlmConfig();
    const askProvider = id === 'hybrid-claude-bridge' ? 'claude-bridge' : 'anthropic-api';
    return {
      ...base,
      askLlm: { provider: askProvider, model: DEFAULT_CLAUDE_ASK_MODEL },
    };
  }
  return null;
}

/** Atomic write of `.cartograph/config.json` with a `.bak.<ts>` backup
 *  of any prior file. Single-write — the prior implementation
 *  delegated through `writeRecommendedLlmConfig` which performed two
 *  sequential writes (the recommended config + the overlay), leaving
 *  the wrong config on disk if the process died between them. We now
 *  build the merged config in-memory + write once. */
function writeRawLlmConfig(
  projectRoot: string,
  llmConfig: NonNullable<CartographConfig['llm']>,
): { configPath: string; backupPath: string | null } {
  const cgDir = `${projectRoot}/.cartograph`;
  if (!fs.existsSync(cgDir)) fs.mkdirSync(cgDir, { recursive: true });
  const configPath = `${cgDir}/config.json`;

  // Read + merge: preserve every top-level field the user already had
  // (e.g. `include`, `exclude`, `enableBiomarkers`); only the `llm`
  // block is overwritten. `rootDir` is derived from the project path
  // by `loadConfig`, so it never belongs on disk — drop it if present.
  let merged: Record<string, unknown> = {};
  let backupPath: string | null = null;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        merged = { ...(parsed as Record<string, unknown>) };
      }
    } catch {
      // Corrupt prior config — keep the backup but treat as no prior.
      merged = {};
    }
    backupPath = `${configPath}.bak.${Date.now()}`;
    fs.copyFileSync(configPath, backupPath);
  }
  merged['llm'] = llmConfig;
  delete merged['rootDir'];

  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, configPath);
  return { configPath, backupPath };
}

/** Identifiers the CLI / MCP surface accept as `--preset` values.
 *  Exported so the CLI command-generator can render it as a
 *  closed-enum choice. */
export const AVAILABLE_PRESETS: ReadonlyArray<SetupPresetId> = [
  'install-ollama',
  'install-llama-cpp',
  'install-mlx',
  'cloud-openai',
  'cloud-openrouter',
  'cloud-openai-compat',
  'hybrid-claude-bridge',
  'hybrid-anthropic-api',
  'skip',
];
