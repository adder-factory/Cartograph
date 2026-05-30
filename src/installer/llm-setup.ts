/**
 * Interactive LLM setup wizard — OpenAI-compat HTTP backend stack.
 *
 * Cartograph speaks OpenAI-compat HTTP for all LLM work (chat / embed /
 * rerank). The wizard is detection-first: it scans for running
 * backends on the common localhost ports + offers them as one-click
 * setup paths. When nothing's running, it switches to install-guide
 * mode and walks the user through picking + installing a backend.
 *
 * Flow:
 *   1. Scan well-known ports via `scanForLlmBackends`
 *      (Ollama :11434, llama-server :8080, mlx_lm.server :8000,
 *      LM Studio :1234, LocalAI :5000) — ~1s worst-case.
 *   2. Detect optional cloud-chat tooling (claude binary,
 *      ANTHROPIC_API_KEY).
 *   3. Detection-first branch:
 *      - If ≥1 backend running: list each as a setup option
 *        ("Use detected Ollama at :11434"). Selecting one wires
 *        every tier at that endpoint. For Ollama, offer to
 *        `ollama pull` missing recommended models. For others,
 *        instruct the user to ensure their backend has the
 *        relevant models loaded.
 *      - If nothing running: install-guide mode. Offer Ollama
 *        (simplest), llama-cpp (model-quality parity with the
 *        old in-process pathway), or Apple MLX (Apple Silicon
 *        only). Print install + start commands, write the config
 *        pre-pointed at the default port, tell the user to start
 *        the backend + re-run `cartograph doctor`.
 *   4. Always offer the Claude-bridge / anthropic-api fallback for
 *      `askLlm` when `claude` is on PATH or `ANTHROPIC_API_KEY` is set.
 *   5. Always offer Skip — write nothing, let the user configure manually.
 *
 * Exposed two ways:
 *   1. As a step inside `runInstaller()` (first-run onboarding).
 *   2. As `cartograph llm setup` (re-run later — the detection makes
 *      the second run useful even after the user installs a backend
 *      between attempts).
 */

import * as fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { findOnPath } from '../llm/claude-bridge.js';
import { DEFAULT_CLAUDE_ASK_MODEL } from '../llm/provider.js';
import {
  RECOMMENDED_CHAT_SUMMARIZE,
  RECOMMENDED_CHAT_ASK,
  RECOMMENDED_EMBED,
  RECOMMENDED_RERANKER,
  MODELS_DIR_DEFAULT,
  resolveRecommendedModelPath,
  type RecommendedModel,
} from '../llm/recommended-models.js';
import { installRecommendedModels, type InstallModelsResult } from './install-models.js';
import { buildRecommendedLlmConfig } from './recommended-config.js';
import { OLLAMA_DEFAULT_ENDPOINT, MLX_DEFAULT_ENDPOINT } from './default-endpoints.js';
import { buildSingleEndpointConfig } from './build-endpoint-config.js';
import {
  scanForLlmBackends,
  backendLabel,
  backendInstallHint,
  type DetectedBackend,
  type DetectedBackendKind,
} from './scan-backends.js';
import type { CartographConfig } from '../types.js';

type ClackPrompts = typeof import('@clack/prompts');

/** Detected environment — what the wizard branches on. */
export interface LlmEnvironment {
  /** Backends found on common localhost ports. */
  detectedBackends: DetectedBackend[];
  /** `claude` CLI path if on PATH (drives the hybrid askLlm option). */
  claudeBin: string | null;
  /** Whether ANTHROPIC_API_KEY is set in the environment (drives the
   *  anthropic-api fallback). */
  anthropicApiKey: string | null;
  /** Per-recommended-model presence under `MODELS_DIR_DEFAULT`. Used
   *  by the install-guide path when the user picks llama-cpp. */
  presentModels: Map<RecommendedModel, boolean>;
}

async function probeEnvironment(modelsDir: string = MODELS_DIR_DEFAULT): Promise<LlmEnvironment> {
  const [claudeBin, detectedBackends] = await Promise.all([findOnPath('claude'), scanForLlmBackends()]);
  const presentModels = new Map<RecommendedModel, boolean>(
    await Promise.all(
      [RECOMMENDED_CHAT_SUMMARIZE, RECOMMENDED_CHAT_ASK, RECOMMENDED_EMBED, RECOMMENDED_RERANKER].map(
        async (m): Promise<[RecommendedModel, boolean]> => [
          m,
          await fsp
            .access(resolveRecommendedModelPath(m, modelsDir))
            .then(() => true)
            .catch(() => false),
        ],
      ),
    ),
  );
  return {
    detectedBackends,
    claudeBin,
    anthropicApiKey: process.env['ANTHROPIC_API_KEY'] ?? null,
    presentModels,
  };
}

/** Models the wizard's Ollama auto-pull path will try to fetch. Ollama
 *  uses short model ids, not GGUF paths — these are the canonical
 *  drop-in equivalents to the recommended GGUFs. Reranker is omitted
 *  because Ollama doesn't expose `/v1/rerank` today — users wanting
 *  rerank pick the install-llama-cpp preset instead. */
const OLLAMA_RECOMMENDED_MODELS: Record<'embed' | 'summarize' | 'ask', string> = {
  embed: 'nomic-embed-text',
  summarize: 'qwen2.5-coder:3b',
  ask: 'qwen2.5-coder:7b',
};

type SetupChoice =
  | { kind: 'detected'; backend: DetectedBackend }
  | { kind: 'install-llama-cpp' }
  | { kind: 'install-ollama' }
  | { kind: 'install-mlx' }
  | { kind: 'hybrid' }
  | { kind: 'skip' };

function backendOptionLabel(b: DetectedBackend): string {
  const label = backendLabel(b.kind);
  const modelCount = b.models.length;
  const modelHint = modelCount > 0 ? `${modelCount} model${modelCount === 1 ? '' : 's'} loaded` : 'no models loaded';
  return `✓ Use detected ${label} at ${b.endpoint} (${modelHint})`;
}

/** Build the list of options shown to the user. Detected backends come
 *  first — the wizard is detection-first. */
function buildOptions(env: LlmEnvironment): Array<{ value: SetupChoice; label: string; hint?: string }> {
  const options: Array<{ value: SetupChoice; label: string; hint?: string }> = [];

  // Detected backends: one option per running backend.
  for (const b of env.detectedBackends) {
    options.push({
      value: { kind: 'detected', backend: b },
      label: backendOptionLabel(b),
      hint:
        b.kind === 'ollama'
          ? 'Single endpoint serves every tier. Offers to `ollama pull` any missing recommended models.'
          : `Single endpoint, wired to every tier. Ensure the backend has the relevant model(s) loaded.`,
    });
  }

  // Install-guide options — always offered, but pushed down when
  // something's already running.
  if (env.detectedBackends.length === 0) {
    // Nothing running — install-guide mode is the headline.
    options.push({
      value: { kind: 'install-ollama' },
      label: '🦙 Install Ollama (simplest — auto-manages models)',
      hint: 'One process serves every tier. Models auto-load on demand. Recommended for new users.',
    });
    options.push({
      value: { kind: 'install-llama-cpp' },
      label: '⚡ Install llama-cpp + download GGUFs (recommended for cartograph)',
      hint: `Downloads ~${totalDownloadMb(env)} MB of GGUFs. One llama-server per tier (4 processes). Closest model quality to the curated GGUF set.`,
    });
    options.push({
      value: { kind: 'install-mlx' },
      label: '🍎 Install Apple MLX (Apple Silicon only)',
      hint: 'Native Metal-optimised. mlx_lm.server provides the OpenAI-compat surface.',
    });
  } else {
    // Detected backends present, but offer install-other-backend as alternatives.
    options.push({
      value: { kind: 'install-llama-cpp' },
      label: '⚡ ...or install llama-cpp + download GGUFs',
      hint: 'Run alongside the detected backend(s) on different ports for per-tier mix-and-match.',
    });
  }

  // Hybrid: cloud Claude for ask only. Offered whenever cloud auth exists.
  if (env.claudeBin !== null || env.anthropicApiKey !== null) {
    options.push({
      value: { kind: 'hybrid' },
      label: '🔀 Hybrid — route `cartograph_ask` to Claude',
      hint: env.claudeBin
        ? `claude binary at ${env.claudeBin}. Pick another option above for embed/chat; this slots Claude into askLlm.`
        : 'ANTHROPIC_API_KEY detected. Pick another option above for embed/chat; this slots Claude into askLlm.',
    });
  }

  options.push({
    value: { kind: 'skip' },
    label: '⏭  Skip — configure later',
    hint: 'Leave .cartograph/config.json untouched. Re-run `cartograph llm setup` when ready.',
  });

  return options;
}

/** Bytes still to download given current presence map. */
function totalDownloadMb(env: LlmEnvironment): number {
  let total = 0;
  for (const [model, present] of env.presentModels) {
    if (!present) total += model.sizeMb;
  }
  return total;
}

/** Print a short status line per recommended GGUF + the detected
 *  backend summary so the user knows what the wizard saw before it
 *  shows the choice picker. */
/** How many loaded-model names to show per detected backend before
 *  collapsing the tail into a "+N more" counter. */
const SUMMARY_MODELS_LIMIT = 3;

function showEnvironmentSummary(clack: ClackPrompts, env: LlmEnvironment): void {
  // Detected-backends summary first — most directly informs the choice.
  if (env.detectedBackends.length === 0) {
    clack.note(
      'No OpenAI-compat backends responding on the well-known localhost ports. ' +
        'The wizard will guide you through installing one.',
      'Detected backends',
    );
  } else {
    const lines = env.detectedBackends.map((b) => {
      const head = b.models.length > 0 ? b.models.slice(0, SUMMARY_MODELS_LIMIT).join(', ') : '(no models loaded)';
      const moreModels =
        b.models.length > SUMMARY_MODELS_LIMIT ? ` (+${b.models.length - SUMMARY_MODELS_LIMIT} more)` : '';
      return `  ✓ ${backendLabel(b.kind)} at ${b.endpoint} — ${head}${moreModels}`;
    });
    clack.note(lines.join('\n'), 'Detected backends (already running)');
  }
  // GGUF presence under MODELS_DIR_DEFAULT — relevant if user picks
  // the llama-cpp install path.
  const ggufLines: string[] = [];
  for (const [model, present] of env.presentModels) {
    const mark = present ? '✓' : '✗';
    ggufLines.push(`  ${mark} ${model.filename}  (${model.sizeMb} MB) — ${model.description}`);
  }
  clack.note(ggufLines.join('\n'), `Recommended GGUFs in ${MODELS_DIR_DEFAULT}`);
}

/** Run install with a clack-rendered progress spinner. */
async function downloadWithProgress(
  clack: ClackPrompts,
  models: readonly RecommendedModel[],
): Promise<InstallModelsResult> {
  const spinner = clack.spinner();
  spinner.start('Downloading recommended GGUFs');
  try {
    const result = await installRecommendedModels({
      models,
      onProgress: ({ model, downloaded, total }) => {
        const pct = total > 0 ? ((downloaded / total) * 100).toFixed(0) : '?';
        spinner.message(`${model.filename}: ${pct}%`);
      },
    });
    spinner.stop(`Downloaded ${result.downloaded.length} new model(s); ${result.skipped.length} already present.`);
    return result;
  } catch (err) {
    spinner.stop('Download failed.');
    throw err;
  }
}

/** Run `ollama pull <model>` as a subprocess with live stderr piped
 *  through clack's spinner. Returns true on success, false on failure
 *  (the wizard surfaces the failure but keeps going — the user can
 *  pull missing models manually). */
async function ollamaPull(clack: ClackPrompts, model: string): Promise<boolean> {
  const spinner = clack.spinner();
  spinner.start(`ollama pull ${model}`);
  return new Promise<boolean>((resolve) => {
    const child = spawn('ollama', ['pull', model], { stdio: ['ignore', 'pipe', 'pipe'] });
    let lastLine = '';
    const onData = (chunk: Buffer): void => {
      const text = chunk.toString('utf-8').trim();
      if (text.length > 0) {
        lastLine = text.split('\n').pop() ?? text;
        spinner.message(`${model}: ${lastLine.slice(0, 80)}`);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', () => {
      spinner.stop(`ollama pull ${model} failed (is the \`ollama\` CLI installed?)`);
      resolve(false);
    });
    child.on('exit', (code) => {
      if (code === 0) {
        spinner.stop(`ollama pull ${model} done`);
        resolve(true);
      } else {
        spinner.stop(`ollama pull ${model} exited ${code}: ${lastLine.slice(0, 80)}`);
        resolve(false);
      }
    });
  });
}

/** Print the install-and-start guidance for a backend kind. The user
 *  follows the printed commands in another terminal; cartograph
 *  doesn't try to run them itself (avoids needing platform-specific
 *  package-manager logic). */
function printInstallGuide(clack: ClackPrompts, kind: DetectedBackendKind): void {
  clack.note(backendInstallHint(kind), `Install ${backendLabel(kind)}`);
}

/**
 * Run the full interactive flow. Returns the chosen `llm` config block
 * (ready to merge into config.json) or `null` if the user declined.
 *
 * `envArg` is honoured for tests; otherwise we probe the environment
 * fresh. `_projectPath` is reserved for future use (e.g. probing a
 * project-local model override dir); unused today.
 */
export async function runLlmSetup(
  clack: ClackPrompts,
  envArg?: LlmEnvironment,
  _projectPath?: string,
): Promise<NonNullable<CartographConfig['llm']> | null> {
  void _projectPath;
  const env = envArg ?? (await probeEnvironment());
  showEnvironmentSummary(clack, env);

  const options = buildOptions(env);
  const choice = (await clack.select<SetupChoice>({
    message: 'How should cartograph run its LLMs?',
    options,
    initialValue: options[0]!.value,
  })) as SetupChoice;

  if (clack.isCancel(choice) || choice.kind === 'skip') {
    clack.log.info('Skipping LLM setup. Run `cartograph llm setup` again when ready.');
    return null;
  }

  switch (choice.kind) {
    case 'detected':
      return runDetectedPath(clack, choice.backend, env);
    case 'install-ollama':
      return runInstallOllamaPath(clack, env);
    case 'install-llama-cpp':
      return runInstallLlamaCppPath(clack);
    case 'install-mlx':
      return runInstallMlxPath(clack);
    case 'hybrid':
      return runHybridPath(clack, env);
  }
}

/** Detected-backend path: wire every tier at the detected endpoint.
 *  For Ollama specifically, offer to `ollama pull` missing
 *  recommended models so the user doesn't need to track which
 *  models the wizard expects. */
async function runDetectedPath(
  clack: ClackPrompts,
  backend: DetectedBackend,
  _env: LlmEnvironment,
): Promise<NonNullable<CartographConfig['llm']> | null> {
  void _env;
  if (backend.kind === 'ollama') {
    const needed: Array<{ tier: 'embed' | 'summarize' | 'ask' | 'reranker'; model: string }> = [
      { tier: 'embed', model: OLLAMA_RECOMMENDED_MODELS.embed },
      { tier: 'summarize', model: OLLAMA_RECOMMENDED_MODELS.summarize },
      { tier: 'ask', model: OLLAMA_RECOMMENDED_MODELS.ask },
    ];
    const missing = needed.filter((m) => !backend.models.some((loaded) => loaded.startsWith(m.model.split(':')[0]!)));
    if (missing.length > 0) {
      const list = missing.map((m) => `  • ${m.model}  (for ${m.tier})`).join('\n');
      const shouldPull = await clack.confirm({
        message: `Pull ${missing.length} missing recommended model${missing.length === 1 ? '' : 's'} via \`ollama pull\`?\n${list}`,
        initialValue: true,
      });
      if (!clack.isCancel(shouldPull) && shouldPull === true) {
        for (const m of missing) {
          await ollamaPull(clack, m.model);
        }
      }
    }
    return buildSingleEndpointConfig(backend.endpoint, {
      embed: OLLAMA_RECOMMENDED_MODELS.embed,
      summarize: OLLAMA_RECOMMENDED_MODELS.summarize,
      ask: OLLAMA_RECOMMENDED_MODELS.ask,
      // Ollama doesn't expose /v1/rerank — skip the reranker block.
    });
  }

  // llama-server / mlx_lm / LM Studio / LocalAI / unknown: one process
  // = one model, so single-endpoint config only makes sense if the user
  // has the right model loaded. Pick the first loaded model as a guess;
  // the user can hand-edit if they need different models per tier.
  const fallbackModel = backend.models[0] ?? '<set model in config.json>';
  clack.log.info(
    `Wiring every tier at ${backend.endpoint} with model "${fallbackModel}". ` +
      `Edit .cartograph/config.json to swap models per tier if needed — see CLAUDE.md for the per-port layout.`,
  );
  return buildSingleEndpointConfig(backend.endpoint, {
    embed: fallbackModel,
    summarize: fallbackModel,
    ask: fallbackModel,
  });
}

/** Install-Ollama path: print install commands, build a config
 *  pre-pointed at :11434 so doctor can verify after install. */
async function runInstallOllamaPath(
  clack: ClackPrompts,
  _env: LlmEnvironment,
): Promise<NonNullable<CartographConfig['llm']> | null> {
  void _env;
  printInstallGuide(clack, 'ollama');
  clack.note(
    `After install, pull the recommended models:\n` +
      `  ollama pull ${OLLAMA_RECOMMENDED_MODELS.embed}\n` +
      `  ollama pull ${OLLAMA_RECOMMENDED_MODELS.summarize}\n` +
      `  ollama pull ${OLLAMA_RECOMMENDED_MODELS.ask}\n` +
      `Then re-run \`cartograph doctor\` to verify; the wizard has already written your config to point at :11434.`,
    'Next steps',
  );
  return buildSingleEndpointConfig(OLLAMA_DEFAULT_ENDPOINT, {
    embed: OLLAMA_RECOMMENDED_MODELS.embed,
    summarize: OLLAMA_RECOMMENDED_MODELS.summarize,
    ask: OLLAMA_RECOMMENDED_MODELS.ask,
  });
}

/** Install-llama-cpp path: download GGUFs + write the 4-port config. */
async function runInstallLlamaCppPath(clack: ClackPrompts): Promise<NonNullable<CartographConfig['llm']> | null> {
  printInstallGuide(clack, 'llama-server');
  try {
    await downloadWithProgress(clack, [
      RECOMMENDED_EMBED,
      RECOMMENDED_CHAT_SUMMARIZE,
      RECOMMENDED_RERANKER,
      RECOMMENDED_CHAT_ASK,
    ]);
  } catch (err) {
    clack.log.error(`Download failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  const cfg = buildRecommendedLlmConfig();
  clack.note(
    `After install, start one llama-server per tier (each in its own terminal):\n` +
      `  llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_EMBED)} --port 8080 --embeddings\n` +
      `  llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_CHAT_SUMMARIZE)} --port 8081\n` +
      `  llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_CHAT_ASK)} --port 8082\n` +
      `  llama-server -m ${resolveRecommendedModelPath(RECOMMENDED_RERANKER)} --port 8083 --rerank\n` +
      `Then re-run \`cartograph doctor\` to verify.`,
    'Next steps',
  );
  return cfg;
}

/** Install-MLX path: print install + start guidance, write a config
 *  pre-pointed at :8000. mlx_lm.server is one-model-per-process like
 *  llama-server but Apple Silicon-only. */
async function runInstallMlxPath(clack: ClackPrompts): Promise<NonNullable<CartographConfig['llm']> | null> {
  printInstallGuide(clack, 'mlx_lm');
  clack.note(
    `mlx_lm.server is one-model-per-process; start one per tier you need (or run a model swap manually). Example:\n` +
      `  python -m mlx_lm.server --model nomic-embed-text --port 8000\n` +
      `Then point each *Llm.endpoint in .cartograph/config.json at the port serving its model. ` +
      `The wizard has written a starter config targeting :8000 for the embedding tier; hand-edit for the others.`,
    'Next steps',
  );
  return buildSingleEndpointConfig(MLX_DEFAULT_ENDPOINT, {
    embed: 'nomic-embed-text',
    summarize: 'qwen2.5-coder-3b',
    ask: 'qwen2.5-coder-7b',
  });
}

/** Hybrid path: route askLlm to Claude (claude-bridge if `claude` is
 *  on PATH, otherwise anthropic-api). Other tiers fall back to the
 *  llama-cpp install path (downloads GGUFs + writes per-port config).
 *  When run standalone (no other backend chosen first), this means
 *  Claude for ask + llama-server for everything else.  */
async function runHybridPath(
  clack: ClackPrompts,
  env: LlmEnvironment,
): Promise<NonNullable<CartographConfig['llm']> | null> {
  const localCfg = await runInstallLlamaCppPath(clack);
  if (!localCfg) return null;
  const askProvider: 'claude-bridge' | 'anthropic-api' = env.claudeBin ? 'claude-bridge' : 'anthropic-api';
  return {
    ...localCfg,
    askLlm: {
      provider: askProvider,
      model: DEFAULT_CLAUDE_ASK_MODEL,
    },
  };
}
