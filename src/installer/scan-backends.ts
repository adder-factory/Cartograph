/**
 * LLM-backend scanner — probes well-known localhost ports for an
 * OpenAI-compatible `/v1/models` endpoint so cartograph can detect what's
 * already running and offer it to the user. Reduces the "configure
 * embeddingLlm" friction: instead of telling the user "install Ollama"
 * we can say "Ollama is already running on :11434 with 3 models loaded
 * — use it?".
 *
 * Migration arc 2026-05-24c step 3: this is the data source for both
 * the doctor remediation messages and the future `install-models`
 * interactive picker.
 *
 * **What we probe:**
 *
 *   - `http://localhost:8080` — llama-cpp's `llama-server` embed tier
 *     (default `--port`; cartograph's recommended embed backend).
 *   - `http://localhost:8081` — llama-server summarize tier (cartograph
 *     recommended layout — consecutive port per tier).
 *   - `http://localhost:8082` — llama-server ask/chat tier.
 *   - `http://localhost:8083` — llama-server reranker tier.
 *   - `http://localhost:11434` — Ollama (default port; auto-started
 *     by Homebrew / systemd on install).
 *   - `http://localhost:8000` — Apple MLX's `mlx_lm.server` and vLLM
 *     (both default to 8000).
 *   - `http://localhost:1234` — LM Studio (default API server port).
 *   - `http://localhost:5000` — LocalAI (default port).
 *
 * **Detection method:** GET `/v1/models` with a 1-second per-port
 * timeout. The probes run in parallel via `Promise.all`. A 2xx
 * response means the backend is alive AND speaks OpenAI-compat.
 * Identifying which backend is which is a best-effort heuristic
 * based on the port and the `User-Agent` / `Server` response
 * headers — get this right when we can, fall back to "unknown
 * OpenAI-compat backend" when we can't.
 *
 * Bun-only: uses `globalThis.fetch`.
 */

import {
  LLAMA_SERVER_EMBED_ENDPOINT,
  LLAMA_SERVER_SUMMARIZE_ENDPOINT,
  LLAMA_SERVER_ASK_ENDPOINT,
  LLAMA_SERVER_RERANKER_ENDPOINT,
  OLLAMA_DEFAULT_ENDPOINT,
  MLX_DEFAULT_ENDPOINT,
} from './default-endpoints.js';

/** Per-port probe deadline in milliseconds. 1000 ms is generous for a
 *  localhost-only fetch (most replies land in <50 ms); the cap bounds
 *  the worst case when a port is held open by an unrelated process
 *  that accepts the connection but never responds. */
const PROBE_TIMEOUT_MS = 1000;

/** Backend install / docs URLs — kept centralised so the per-backend
 *  switch in `backendInstallHint` doesn't carry the hardcoded URL
 *  cluster (the `hardcoded_url` biomarker fires at metric≥4). */
const INSTALL_URLS = {
  llamaCpp: 'https://github.com/ggml-org/llama.cpp',
  ollama: 'https://ollama.com',
  lmStudio: 'https://lmstudio.ai',
  localai: 'https://localai.io',
} as const;

/** Per-backend known-port + canonical name. The scanner walks this
 *  list in parallel. Includes cartograph's recommended four-tier
 *  llama-server layout (8080–8083) so all running tiers are discovered,
 *  not just the embed server on 8080. */
const SCAN_TARGETS: ReadonlyArray<{ kind: DetectedBackendKind; endpoint: string; port: number }> = [
  { kind: 'llama-server', endpoint: LLAMA_SERVER_EMBED_ENDPOINT, port: 8080 },
  { kind: 'llama-server', endpoint: LLAMA_SERVER_SUMMARIZE_ENDPOINT, port: 8081 },
  { kind: 'llama-server', endpoint: LLAMA_SERVER_ASK_ENDPOINT, port: 8082 },
  { kind: 'llama-server', endpoint: LLAMA_SERVER_RERANKER_ENDPOINT, port: 8083 },
  { kind: 'ollama', endpoint: OLLAMA_DEFAULT_ENDPOINT, port: 11434 },
  { kind: 'mlx_lm', endpoint: MLX_DEFAULT_ENDPOINT, port: 8000 },
  { kind: 'lm-studio', endpoint: 'http://localhost:1234', port: 1234 },
  { kind: 'localai', endpoint: 'http://localhost:5000', port: 5000 },
];

export type DetectedBackendKind = 'llama-server' | 'ollama' | 'mlx_lm' | 'lm-studio' | 'localai' | 'unknown';

export interface DetectedBackend {
  /** Best-effort identification based on port + response headers.
   *  `'unknown'` when probing succeeded at the URL but we couldn't
   *  fingerprint which backend it is. */
  readonly kind: DetectedBackendKind;
  /** Base URL (no `/v1` suffix). What the user puts in
   *  `embeddingLlm.endpoint`. */
  readonly endpoint: string;
  /** Models the backend reported. Ollama / llama-server / LM Studio
   *  all return this; empty array if the call succeeded but no
   *  models are loaded (rare). */
  readonly models: string[];
  /** Free-form server identifier from the response's `Server` /
   *  `User-Agent` headers, useful for diagnostics. */
  readonly serverHeader?: string;
}

/**
 * Probe all known ports in parallel for an OpenAI-compatible
 * `/v1/models` response. Returns the detected backends in arbitrary
 * order. Empty array means nothing OpenAI-compat is running locally.
 *
 * **Side-effect-free** beyond the HTTP probes themselves — no
 * processes spawned, no config written. The caller decides what to
 * do with the result.
 *
 * @param extraEndpoints — additional URLs to probe beyond the
 *   known-port list. Pass `[cfg.embeddingLlm.endpoint]` to also
 *   probe whatever the user has configured (useful for `doctor`).
 */
export async function scanForLlmBackends(extraEndpoints: readonly string[] = []): Promise<DetectedBackend[]> {
  const targets: Array<{ kind: DetectedBackendKind; endpoint: string }> = [
    ...SCAN_TARGETS.map((t) => ({ kind: t.kind, endpoint: t.endpoint })),
  ];
  // Add any extra user-configured endpoints that aren't already in the
  // known-port list — dedup by endpoint URL.
  const known = new Set(targets.map((t) => normaliseEndpoint(t.endpoint)));
  for (const ep of extraEndpoints) {
    const n = normaliseEndpoint(ep);
    if (!known.has(n)) {
      targets.push({ kind: 'unknown', endpoint: n });
      known.add(n);
    }
  }

  const results = await Promise.all(targets.map(probeOne));
  return results.filter((r): r is DetectedBackend => r !== null);
}

interface OpenAiModelsResponse {
  readonly data?: ReadonlyArray<{ readonly id?: unknown }>;
}

/** Probe a single endpoint. Returns null when the endpoint doesn't
 *  respond, returns non-2xx, or returns a non-JSON body. Returns a
 *  `DetectedBackend` on success. */
async function probeOne(target: { kind: DetectedBackendKind; endpoint: string }): Promise<DetectedBackend | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${target.endpoint}/v1/models`, {
      method: 'GET',
      signal: controller.signal,
    });
    if (!res.ok) return null;
    let body: OpenAiModelsResponse;
    try {
      body = (await res.json()) as OpenAiModelsResponse;
    } catch {
      // 2xx but non-JSON body — not OpenAI-compat. Don't claim a
      // backend here; let the caller treat it as absent.
      return null;
    }
    const models: string[] = [];
    if (Array.isArray(body.data)) {
      for (const m of body.data) {
        if (m && typeof m.id === 'string') models.push(m.id);
      }
    }
    const serverHeader = res.headers.get('server') ?? res.headers.get('x-server') ?? undefined;
    // Refine `kind` from headers when the port-based default would
    // be `'unknown'`. Helps users who run a backend on a non-default
    // port (e.g. multiple llama-server instances).
    let kind = target.kind;
    if (kind === 'unknown' && serverHeader) {
      kind = identifyFromHeader(serverHeader) ?? 'unknown';
    }
    return {
      kind,
      endpoint: target.endpoint,
      models,
      ...(serverHeader ? { serverHeader } : {}),
    };
  } catch {
    // ETIMEDOUT / ECONNREFUSED / abort — nothing listening on this port.
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function identifyFromHeader(header: string): DetectedBackendKind | null {
  const h = header.toLowerCase();
  if (h.includes('ollama')) return 'ollama';
  if (h.includes('llama')) return 'llama-server';
  if (h.includes('mlx')) return 'mlx_lm';
  if (h.includes('lm-studio') || h.includes('lmstudio')) return 'lm-studio';
  if (h.includes('localai')) return 'localai';
  return null;
}

/** Normalise a user-supplied endpoint URL to the bare base-URL shape
 *  the scanner uses internally. Strips a trailing slash + a trailing
 *  `/v1` segment so `http://localhost:8080`, `http://localhost:8080/`,
 *  and `http://localhost:8080/v1` all dedup to the same canonical
 *  form. Exported so callers comparing a configured endpoint against
 *  scanner output (e.g. `doctor.ts`'s reachability check) share one
 *  normalisation rule with the scanner. */
export function normaliseEndpoint(endpoint: string): string {
  const trimmed = endpoint.endsWith('/') ? endpoint.slice(0, -1) : endpoint;
  return trimmed.endsWith('/v1') ? trimmed.slice(0, -3) : trimmed;
}

/** Human-readable label for a detected backend kind, used in CLI +
 *  doctor output. */
export function backendLabel(kind: DetectedBackendKind): string {
  switch (kind) {
    case 'llama-server':
      return 'llama.cpp llama-server';
    case 'ollama':
      return 'Ollama';
    case 'mlx_lm':
      return 'Apple MLX (mlx_lm.server)';
    case 'lm-studio':
      return 'LM Studio';
    case 'localai':
      return 'LocalAI';
    case 'unknown':
      return 'OpenAI-compatible backend';
  }
}

/** Build the install / run guidance for a backend kind. Used by
 *  `OpenAiSdkEmbeddingClient.isReachable` failure messages + the
 *  doctor's remediation hints. */
export function backendInstallHint(kind: DetectedBackendKind): string {
  switch (kind) {
    case 'llama-server':
      return `Install llama-cpp: \`brew install llama.cpp\` (macOS) or see ${INSTALL_URLS.llamaCpp} (Linux/Windows). Then run: \`llama-server -m <path-to-GGUF> --port 8080 --embeddings\`.`;
    case 'ollama':
      return `Install Ollama from ${INSTALL_URLS.ollama} (or \`brew install ollama\` on macOS). Ollama auto-starts as a system service. Pull an embedding model with \`ollama pull nomic-embed-text\`.`;
    case 'mlx_lm':
      return 'Install MLX-LM: `pip install mlx-lm` (Apple Silicon only). Then run: `python -m mlx_lm.server --model <model-id> --port 8000`.';
    case 'lm-studio':
      return `Install LM Studio from ${INSTALL_URLS.lmStudio}. Start its built-in OpenAI-compat server from the UI.`;
    case 'localai':
      return `Install LocalAI from ${INSTALL_URLS.localai}. Default port 5000.`;
    case 'unknown':
      return (
        'Configure any OpenAI-compatible backend (Ollama, llama-server, mlx_lm.server, LM Studio, ' +
        'vLLM, LocalAI, or a cloud OpenAI-compat provider) and set `embeddingLlm.endpoint` to its URL.'
      );
  }
}
