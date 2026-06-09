/**
 * Build a canonical `llm` config block that points at the recommended
 * GGUFs under `~/.cartograph/models/`. One source of truth for the
 * installer, the `admin install-models` CLI, and any test fixture
 * that wants the "default" config without rebuilding it by hand.
 *
 * Returns plain JSON suitable for `JSON.stringify` into
 * `.cartograph/config.json`.
 *
 * Migration arc 2026-05-24c step 4c: the in-process `'nllc'` / `'local'`
 * defaults are gone. Every tier (summarize / ask / local / embedding /
 * reranker) now writes `provider: 'openai-compat'` pointing at a
 * llama-cpp `llama-server` running on a distinct port (one model per
 * server process). Users who prefer Ollama / mlx_lm / LM Studio / a
 * cloud provider override the `endpoint` + `model` fields in the
 * written file — every backend follows the same OpenAI-compat shape
 * so the rest of the block is unchanged.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { CartographConfig } from '../types.js';
import { copyPrivateFileSync, ensurePrivateDirectory, writePrivateFileAtomic } from '../config.js';
import {
  RECOMMENDED_CHAT_SUMMARIZE,
  RECOMMENDED_CHAT_ASK,
  RECOMMENDED_EMBED,
  RECOMMENDED_RERANKER,
  resolveRecommendedModelPath,
  MODELS_DIR_DEFAULT,
} from '../llm/recommended-models.js';
import {
  LLAMA_SERVER_EMBED_ENDPOINT,
  LLAMA_SERVER_SUMMARIZE_ENDPOINT,
  LLAMA_SERVER_ASK_ENDPOINT,
  LLAMA_SERVER_RERANKER_ENDPOINT,
} from './default-endpoints.js';

export interface RecommendedConfigOptions {
  /** Models dir; defaults to MODELS_DIR_DEFAULT (~/.cartograph/models).
   *  Where the recommended GGUFs live — used as the `model` field
   *  written to each tier's config (the user passes the same path to
   *  `llama-server -m <path>` when starting the backend). */
  dir?: string;
  /** Whether to include the optional reranker block. Default true —
   *  the reranker GGUF is downloaded as part of the recommended set. */
  includeReranker?: boolean;
  /** Whether to include the optional ask block. Default true — the
   *  full GGUF set includes the 7B ask model. Minimal installs set
   *  this false so ask falls back to `summarizeLlm` instead of writing
   *  a config that points at an undownloaded file. */
  includeAsk?: boolean;
}

/** Default llama-server ports for each tier. llama-server is
 *  one-model-per-process, so a multi-tier install runs N llama-server
 *  instances on N distinct ports. Users with a different layout
 *  (single Ollama on :11434, mlx_lm on :8000, LM Studio on :1234)
 *  override the `endpoint` field in the written config — the
 *  OpenAI-compat shape is identical, only the URL changes.
 *
 *  Why these specific port assignments:
 *    - :8080 is llama-server's documented default for the first
 *      instance; standard install puts the embedding server there.
 *    - :8081 / :8082 / :8083 are the obvious-next-three slots so
 *      `lsof -iTCP:808X` shows the cartograph stack at a glance.
 *    - `cartograph doctor` probes :8080 + the common alternative ports
 *      (Ollama :11434 / mlx_lm :8000 / LM Studio :1234 / LocalAI
 *      :5000); other ports are visible to the scanner only via the
 *      explicit `extraEndpoints` parameter (which doctor fills with
 *      whatever endpoints the project config carries). */
const ENDPOINT_EMBED = LLAMA_SERVER_EMBED_ENDPOINT;
const ENDPOINT_SUMMARIZE = LLAMA_SERVER_SUMMARIZE_ENDPOINT;
const ENDPOINT_ASK = LLAMA_SERVER_ASK_ENDPOINT;
const ENDPOINT_RERANKER = LLAMA_SERVER_RERANKER_ENDPOINT;

/** Build the `llm` block. Pairs with `installRecommendedModels` —
 *  download the GGUFs first, then merge this block into the project's
 *  `.cartograph/config.json` (via `writeRecommendedLlmConfig` below
 *  or `admin install-models --write-config`).
 *
 *  Every tier writes `provider: 'openai-compat'`. The model field is
 *  the recommended GGUF path so users can `llama-server -m <that-path>
 *  --port <port>` per tier without hand-typing a model basename.
 *
 *  For a simpler single-backend setup (one Ollama on :11434 serving
 *  all four models), the user edits the written file to point every
 *  `endpoint` at `http://localhost:11434` and changes the `model`
 *  field to the Ollama model name (e.g. `qwen2.5-coder:3b`). */
export function buildRecommendedLlmConfig(
  options: RecommendedConfigOptions = {},
): NonNullable<CartographConfig['llm']> {
  const dir = options.dir ?? MODELS_DIR_DEFAULT;
  const includeReranker = options.includeReranker ?? true;
  const includeAsk = options.includeAsk ?? true;

  const cfg: NonNullable<CartographConfig['llm']> = {
    summarizeLlm: {
      provider: 'openai-compat',
      endpoint: ENDPOINT_SUMMARIZE,
      model: resolveRecommendedModelPath(RECOMMENDED_CHAT_SUMMARIZE, dir),
    },
    localLlm: {
      provider: 'openai-compat',
      endpoint: ENDPOINT_SUMMARIZE,
      model: resolveRecommendedModelPath(RECOMMENDED_CHAT_SUMMARIZE, dir),
    },
    embeddingLlm: {
      provider: 'openai-compat',
      endpoint: ENDPOINT_EMBED,
      model: resolveRecommendedModelPath(RECOMMENDED_EMBED, dir),
    },
  };

  if (includeAsk) {
    cfg.askLlm = {
      provider: 'openai-compat',
      endpoint: ENDPOINT_ASK,
      model: resolveRecommendedModelPath(RECOMMENDED_CHAT_ASK, dir),
    };
  }

  if (includeReranker) {
    cfg.rerankerLlm = {
      provider: 'openai-compat',
      endpoint: ENDPOINT_RERANKER,
      model: resolveRecommendedModelPath(RECOMMENDED_RERANKER, dir),
    };
  }

  return cfg;
}

/** Slots the recommended `llm` block writes. Anything inside `.llm`
 *  that's not in this set is preserved (e.g. `enabled`). */
const RECOMMENDED_LLM_SLOTS = ['summarizeLlm', 'localLlm', 'askLlm', 'embeddingLlm', 'rerankerLlm'] as const;

interface ConfigDiffSummary {
  /** Top-level llm slots written by the recommended block. */
  readonly addedOrUpdated: readonly string[];
}

export interface MergeRecommendedLlmResult {
  /** Whole config object after merge, ready to JSON.stringify. */
  readonly nextConfig: Record<string, unknown>;
  /** Diff summary suitable for printing to the operator. */
  readonly diff: ConfigDiffSummary;
}

/** Pure merge: take the current parsed config + a freshly-built
 *  recommended llm block and return the merged config plus a diff
 *  summary. Drops the deprecated keys / sub-fields documented above;
 *  preserves every other field at the top level and inside `.llm`. */
export function mergeRecommendedLlmConfig(
  current: Record<string, unknown> | undefined,
  recommended: NonNullable<CartographConfig['llm']>,
): MergeRecommendedLlmResult {
  const base: Record<string, unknown> = current ? { ...current } : {};
  const priorLlmRaw = base['llm'];
  const priorLlm: Record<string, unknown> =
    typeof priorLlmRaw === 'object' && priorLlmRaw !== null ? { ...(priorLlmRaw as Record<string, unknown>) } : {};

  // Walk each recommended slot and overwrite it.
  for (const slot of RECOMMENDED_LLM_SLOTS) {
    const next = (recommended as Record<string, unknown>)[slot];
    if (next === undefined) {
      delete priorLlm[slot];
    } else {
      priorLlm[slot] = next;
    }
  }

  base['llm'] = priorLlm;

  return {
    nextConfig: base,
    diff: {
      addedOrUpdated: RECOMMENDED_LLM_SLOTS.filter((s) => (recommended as Record<string, unknown>)[s] !== undefined),
    },
  };
}

export interface WriteRecommendedLlmOptions extends RecommendedConfigOptions {
  /** Project root containing `.cartograph/config.json`. */
  projectRoot: string;
}

export interface WriteRecommendedLlmResult {
  /** Absolute path to the config file written. */
  readonly configPath: string;
  /** Absolute path to the `.bak.<ts>` written before overwrite, or
   *  null when no prior config existed. */
  readonly backupPath: string | null;
  /** What changed — same shape as {@link mergeRecommendedLlmConfig}. */
  readonly diff: ConfigDiffSummary;
}

/** Write `.cartograph/config.json` for the given project, merging the
 *  recommended `llm` block over whatever is already there. Always
 *  creates a `.bak.<timestamp>` of the prior file (when one exists)
 *  before overwriting. Atomic via tmp + rename. */
export function writeRecommendedLlmConfig(options: WriteRecommendedLlmOptions): WriteRecommendedLlmResult {
  const configPath = path.join(options.projectRoot, '.cartograph', 'config.json');
  const dir = path.dirname(configPath);
  ensurePrivateDirectory(dir);

  let current: Record<string, unknown> | undefined;
  let backupPath: string | null = null;
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf-8');
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === 'object' && parsed !== null) {
        current = parsed as Record<string, unknown>;
      }
    } catch {
      // Corrupt prior config — treat as no prior config but still
      // back up the file (the operator may want it).
      current = undefined;
    }
    backupPath = `${configPath}.bak.${Date.now()}`;
    copyPrivateFileSync(configPath, backupPath);
  }

  const recommended = buildRecommendedLlmConfig(options);
  const { nextConfig, diff } = mergeRecommendedLlmConfig(current, recommended);

  // rootDir is always derived from the project path — strip it so the
  // file on disk matches the convention used by saveConfig.
  delete nextConfig['rootDir'];

  writePrivateFileAtomic(configPath, JSON.stringify(nextConfig, null, 2));

  return { configPath, backupPath, diff };
}
