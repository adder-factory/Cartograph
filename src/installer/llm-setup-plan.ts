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
import {
  backendInstallHint,
  backendLabel,
  scanForLlmBackends,
  type DetectedBackend,
  type DetectedBackendKind,
} from './scan-backends.js';
import { recommendedTuning } from './hardware-tuning.js';
import {
  OLLAMA_DEFAULT_ENDPOINT,
  MLX_DEFAULT_ENDPOINT,
  LLAMA_SERVER_EMBED_ENDPOINT,
  LLAMA_SERVER_SUMMARIZE_ENDPOINT,
  LLAMA_SERVER_ASK_ENDPOINT,
  LLAMA_SERVER_RERANKER_ENDPOINT,
  CLOUD_OPENAI_PUBLIC_ENDPOINT,
  CLOUD_OPENAI_KEYS_URL,
  OPENAI_COMPAT_PLACEHOLDER_ENDPOINT,
} from './default-endpoints.js';
import type { CartographConfig } from '../types.js';

/** Canonical Ollama model ids that match the recommended GGUF tiers.
 *  Kept in this module so the interactive wizard + the agent-driven
 *  applier read the same source. */
export const OLLAMA_RECOMMENDED_MODELS = {
  embed: 'nomic-embed-text',
  summarize: 'qwen2.5-coder:3b',
  ask: 'qwen2.5-coder:7b',
} as const;

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
  // Detection-first: when ≥1 backend is running, the first detected
  // preset is the recommendation; otherwise default to install-ollama
  // (simplest install + auto model management).
  const recommendedPresetId: SetupPresetId = presets.length > 0 ? presets[0]!.id : ('install-ollama' as SetupPresetId);

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
  presets.push(buildInstallOllamaPreset());
  presets.push(buildInstallLlamaCppPreset(localGgufPresence));
  presets.push(buildInstallMlxPreset());

  // Cloud presets — always available. Most accessible when local
  // hardware can't host the recommended model sizes (limited
  // VRAM/RAM, slow disk, no GPU).
  presets.push(buildCloudOpenAiPreset());
  presets.push(buildCloudOpenAiCompatPreset());

  // Hybrid: cloud Claude for ask. Only when cloud auth is present.
  if (claudeBin !== null) presets.push(buildHybridPreset('hybrid-claude-bridge', claudeBin));
  if (anthropicApiKey) presets.push(buildHybridPreset('hybrid-anthropic-api', null));

  presets.push({
    id: 'skip',
    label: 'Skip — configure later',
    description: 'Write nothing. Re-run `cartograph llm setup` when ready.',
    summary: 'No config change.',
    nextSteps: [],
    requiresInstall: false,
  });

  return presets;
}

function buildUseDetectedPreset(b: DetectedBackend): SetupPreset {
  const id: SetupPresetId = `use-detected-${b.kind}-${b.endpoint.replace(/[^a-z0-9]/gi, '-')}`;
  const isOllama = b.kind === 'ollama';
  const summary = `All tiers → ${b.endpoint} (${b.models.length} model${b.models.length === 1 ? '' : 's'} loaded)`;
  const nextSteps: string[] = [];
  if (isOllama) {
    // Detect which recommended models the running Ollama is missing.
    const needed = [
      OLLAMA_RECOMMENDED_MODELS.embed,
      OLLAMA_RECOMMENDED_MODELS.summarize,
      OLLAMA_RECOMMENDED_MODELS.ask,
    ];
    const loadedNames = b.models.map((m) => m.split(':')[0]!);
    const missing = needed.filter((m) => !loadedNames.includes(m.split(':')[0]!));
    for (const m of missing) {
      nextSteps.push(`ollama pull ${m}`);
    }
  }
  nextSteps.push('cartograph doctor   # verify');
  return {
    id,
    label: `Use detected ${backendLabel(b.kind)} at ${b.endpoint}`,
    description: isOllama
      ? 'Single endpoint, model auto-swap. Easiest path when Ollama is already installed.'
      : 'Single endpoint. Ensure the backend has the relevant model(s) loaded for each tier you want to use.',
    summary,
    nextSteps,
    requiresInstall: nextSteps.length === 1, // only 'doctor' line → no install
    detectedBackend: { kind: b.kind, endpoint: b.endpoint, models: b.models },
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
  // Hardware-aware `--parallel N` per tier. Embed gets the most
  // slots (cheap model, batches well); ask gets the fewest (largest
  // model, biggest KV-cache per slot). See `hardware-tuning.ts` for
  // the per-tier sizing rationale.
  const tuning = recommendedTuning();
  return {
    id: 'install-llama-cpp',
    label: 'Install llama-cpp + download recommended GGUFs',
    description:
      'One llama-server per tier (4 processes on consecutive ports). Closest model quality to the curated GGUF set.',
    summary: `Embed :8080 / chat :8081 / ask :8082 / reranker :8083 (${downloadHint})`,
    nextSteps: [
      backendInstallHint('llama-server'),
      'cartograph admin install-models   # if not already downloaded',
      `llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_EMBED)} --port 8080 --embeddings --parallel ${tuning.embed.llamaServerParallel} --batch-size 512 --ubatch-size 512 &`,
      `llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_CHAT_SUMMARIZE)} --port 8081 --parallel ${tuning.chat.llamaServerParallel} &`,
      `llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_CHAT_ASK)} --port 8082 --parallel ${tuning.ask.llamaServerParallel} &`,
      `llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_RERANKER)} --port 8083 --reranking --parallel ${tuning.reranker.llamaServerParallel} &`,
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
      'python -m mlx_lm.server --model nomic-embed-text --port 8000 &',
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
      notes: ['User chose to skip. Re-run `cartograph llm plan` later when ready.'],
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
    // For local install presets, re-probe the target endpoints to see
    // whether the user's backends are already running. When at least
    // one target is reachable the "assumes not yet running" note is
    // misleading — replace it with a "detected running" note and drop
    // the install lines from nextSteps (keep only the doctor step).
    const targetEndpoints = installPresetTargetEndpoints(preset.id);
    if (targetEndpoints.length > 0) {
      const running = await scanForLlmBackends(targetEndpoints);
      const runningTargets = running.filter((b) => targetEndpoints.includes(b.endpoint));
      if (runningTargets.length > 0) {
        const epList = runningTargets.map((b) => b.endpoint).join(', ');
        notes.push(`Detected backend already running on ${epList}; skipping install instructions.`);
        // Keep only the verification step so the agent can confirm the
        // config works, but omit the backend-install / model-download
        // lines that no longer apply.
        const doctorStep = nextSteps.find((s) => s.startsWith('cartograph doctor'));
        nextSteps = doctorStep !== undefined ? [doctorStep] : [];
      } else {
        notes.push(
          'The chosen preset assumes the backend is not yet running. Follow the `nextSteps` lines before re-running doctor.',
        );
      }
    } else {
      // Cloud / hybrid / compat presets: backends aren't local, keep
      // the original note unchanged.
      notes.push(
        'The chosen preset assumes the backend is not yet running. Follow the `nextSteps` lines before re-running doctor.',
      );
    }
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

/** Build the `llm` config block for a preset, given the current plan. */
function buildConfigForPreset(
  id: SetupPresetId,
  plan: SetupPlan,
  _modelsDir: string | undefined,
): NonNullable<CartographConfig['llm']> | null {
  void _modelsDir;
  // Detected presets: read the structurally-attached `detectedBackend`
  // off the preset object (kept in sync with the planner so a future
  // summary-wording change can't silently break config generation).
  if (id.startsWith('use-detected-')) {
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
    // llama-server / mlx_lm / LM Studio / etc. — use the first loaded
    // model as the universal model id. User edits per-tier if needed.
    const fallbackModel = models[0] ?? '<set model in config.json>';
    return buildSingleEndpointConfig(endpoint, {
      embed: fallbackModel,
      summarize: fallbackModel,
      ask: fallbackModel,
    });
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
      embed: 'nomic-embed-text',
      summarize: 'qwen2.5-coder-3b',
      ask: 'qwen2.5-coder-7b',
    });
  }
  if (id === 'cloud-openai') {
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
  if (id === 'cloud-openai-compat') {
    // Template config — user MUST hand-edit before it works. Placeholder
    // values are sentinels doctor will flag as "endpoint not reachable"
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
  'cloud-openai-compat',
  'hybrid-claude-bridge',
  'hybrid-anthropic-api',
  'skip',
];
