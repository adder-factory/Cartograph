/**
 * LLM readiness smoke test.
 *
 * Unlike doctor's reachability probes, this sends tiny real requests to
 * each configured tier. That catches endpoint-shape problems such as
 * a chat backend answering `/v1/models` but rejecting
 * `/v1/chat/completions`, or a reranker endpoint missing `/v1/rerank`.
 */

import { loadConfig } from '../../config.js';
import { createEmbeddingClient } from '../../llm/embedding-client.js';
import {
  LlmClient,
  type ChatProviderConfig,
  type EmbeddingProviderConfig,
  type LlmEndpointConfig,
} from '../../llm/client.js';
import { RerankerClient, type RerankerProviderConfig } from '../../llm/reranker-client.js';
import { errMsg } from '../../errors.js';

type LlmSmokeStatus = 'ok' | 'skip' | 'fail';
export type LlmSmokeOverallStatus = 'ok' | 'warn' | 'fail';

export interface LlmSmokeRow {
  readonly tier: 'embedding' | 'summarize' | 'ask' | 'local' | 'rerank';
  readonly status: LlmSmokeStatus;
  readonly provider?: string;
  readonly endpoint?: string;
  readonly model?: string;
  readonly durationMs?: number;
  readonly detail: string;
}

export interface LlmSmokeResult {
  readonly projectPath: string;
  readonly overallStatus: LlmSmokeOverallStatus;
  readonly rows: readonly LlmSmokeRow[];
  readonly durationMs: number;
}

export interface RunLlmSmokeOptions {
  readonly projectPath: string;
  readonly timeoutMs?: number;
}

const DEFAULT_SMOKE_TIMEOUT_MS = 60_000;
const SMOKE_CHAT_PROMPT = 'Reply with a short acknowledgement for a Cartograph LLM smoke test.';
const SMOKE_EMBED_TEXT = 'Cartograph LLM smoke embedding probe';
const SMOKE_RERANK_QUERY = 'code graph search';
const SMOKE_RERANK_DOCS = ['code graph symbol search', 'banana bread recipe'];

export async function runLlmSmoke(options: RunLlmSmokeOptions): Promise<LlmSmokeResult> {
  const t0 = Date.now();
  const timeoutMs = options.timeoutMs ?? DEFAULT_SMOKE_TIMEOUT_MS;
  const cfg = loadConfig(options.projectPath);
  const llm = cfg.llm ?? {};
  const summarizeLlm = chatProviderConfigOrNull(llm.summarizeLlm);
  const askLlm = chatProviderConfigOrNull(llm.askLlm);
  const localLlm = chatProviderConfigOrNull(llm.localLlm);
  const endpointConfig: LlmEndpointConfig = {
    summarizeLlm,
    askLlm,
    localLlm,
    embeddingLlm: llm.embeddingLlm ?? null,
    rerankerLlm: llm.rerankerLlm ?? null,
  };
  const client = new LlmClient(endpointConfig);

  const rows = [
    await smokeEmbedding(llm.embeddingLlm ?? null, timeoutMs),
    await smokeChat({ tier: 'summarize', cfg: summarizeLlm, client, options: { timeoutMs } }),
    await smokeChat({ tier: 'ask', cfg: askLlm, client, options: { timeoutMs, useAskModel: true } }),
    await smokeChat({ tier: 'local', cfg: localLlm, client, options: { timeoutMs, useLocalChat: true } }),
    await smokeRerank(llm.rerankerLlm ?? null, timeoutMs),
  ];

  return {
    projectPath: options.projectPath,
    overallStatus: smokeOverallStatus(rows),
    rows,
    durationMs: Date.now() - t0,
  };
}

async function smokeEmbedding(
  cfg: EmbeddingProviderConfig | null | undefined,
  timeoutMs: number,
): Promise<LlmSmokeRow> {
  if (!cfg) {
    return { tier: 'embedding', status: 'fail', detail: 'embeddingLlm is not configured.' };
  }
  const t0 = Date.now();
  try {
    const client = createEmbeddingClient(cfg);
    const vecs = await withTimeout(timeoutMs, (signal) => client.embed([SMOKE_EMBED_TEXT], { signal }));
    const dim = vecs[0]?.length ?? 0;
    if (dim <= 0) throw new Error('embedding endpoint returned an empty vector');
    return {
      tier: 'embedding',
      status: 'ok',
      ...smokeConfigFields(cfg),
      durationMs: Date.now() - t0,
      detail: `1 vector returned (${dim} dimensions).`,
    };
  } catch (err) {
    return failRow({ tier: 'embedding', cfg, durationMs: Date.now() - t0, err });
  }
}

interface SmokeChatArgs {
  tier: 'summarize' | 'ask' | 'local';
  cfg: ChatProviderConfig | null | undefined;
  client: LlmClient;
  options: { timeoutMs: number; useAskModel?: boolean; useLocalChat?: boolean };
}

async function smokeChat({ tier, cfg, client, options }: SmokeChatArgs): Promise<LlmSmokeRow> {
  if (!cfg) {
    return { tier, status: tier === 'summarize' ? 'fail' : 'skip', detail: missingChatTierDetail(tier) };
  }
  const t0 = Date.now();
  try {
    const result = await withTimeout(options.timeoutMs, (signal) =>
      client.chat([{ role: 'user', content: SMOKE_CHAT_PROMPT }], {
        temperature: 0,
        maxTokens: 24,
        signal,
        ...(options.useAskModel ? { useAskModel: true } : {}),
        ...(options.useLocalChat ? { useLocalChat: true } : {}),
      }),
    );
    if (result.text.trim().length === 0) throw new Error('chat endpoint returned an empty response');
    const tokenDetail =
      result.promptTokens !== undefined || result.completionTokens !== undefined
        ? ` tokens prompt=${result.promptTokens ?? '?'} completion=${result.completionTokens ?? '?'}`
        : '';
    return {
      tier,
      status: 'ok',
      ...smokeConfigFields(cfg),
      durationMs: Date.now() - t0,
      detail: `chat completion returned ${result.text.trim().length} chars.${tokenDetail}`,
    };
  } catch (err) {
    return failRow({ tier, cfg, durationMs: Date.now() - t0, err });
  }
}

async function smokeRerank(cfg: RerankerProviderConfig | null | undefined, timeoutMs: number): Promise<LlmSmokeRow> {
  if (!cfg) {
    return {
      tier: 'rerank',
      status: 'skip',
      detail: 'rerankerLlm is not configured; semantic search will use cosine order.',
    };
  }
  if (!cfg.model) {
    return failRow({ tier: 'rerank', cfg, durationMs: 0, err: new Error('rerankerLlm.model is not configured.') });
  }
  const t0 = Date.now();
  try {
    const client = new RerankerClient(cfg);
    const scores = await withTimeout(timeoutMs, (signal) =>
      client.rerank(SMOKE_RERANK_QUERY, SMOKE_RERANK_DOCS, { signal }),
    );
    if (
      scores.length !== SMOKE_RERANK_DOCS.length ||
      scores.some((score) => !Number.isFinite(score) || score < 0 || score > 1)
    ) {
      throw new Error(`rerank endpoint returned invalid scores: ${JSON.stringify(scores)}`);
    }
    return {
      tier: 'rerank',
      status: 'ok',
      ...smokeConfigFields(cfg),
      durationMs: Date.now() - t0,
      detail: `scores returned: ${scores.map((score) => score.toFixed(3)).join(', ')}`,
    };
  } catch (err) {
    return failRow({ tier: 'rerank', cfg, durationMs: Date.now() - t0, err });
  }
}

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

interface LlmSmokeFailureArgs {
  tier: LlmSmokeRow['tier'];
  cfg: { provider?: string; endpoint?: string; model?: string } | null | undefined;
  durationMs: number;
  err: unknown;
}

function failRow({ tier, cfg, durationMs, err }: LlmSmokeFailureArgs): LlmSmokeRow {
  return {
    tier,
    status: 'fail',
    ...smokeConfigFields(cfg),
    durationMs,
    detail: errMsg(err),
  };
}

function chatProviderConfigOrNull(raw: unknown): ChatProviderConfig | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const cfg = raw as Partial<ChatProviderConfig>;
  if (typeof cfg.provider !== 'string') return null;
  if (typeof cfg.model !== 'string' || cfg.model.length === 0) return null;
  return cfg as ChatProviderConfig;
}

function smokeConfigFields(
  cfg: { provider?: string; endpoint?: string; model?: string } | null | undefined,
): Partial<Pick<LlmSmokeRow, 'provider' | 'endpoint' | 'model'>> {
  return {
    ...(cfg?.provider ? { provider: cfg.provider } : {}),
    ...(cfg?.endpoint ? { endpoint: cfg.endpoint } : {}),
    ...(cfg?.model ? { model: cfg.model } : {}),
  };
}

function smokeOverallStatus(rows: readonly LlmSmokeRow[]): LlmSmokeOverallStatus {
  if (rows.some((row) => row.status === 'fail')) return 'fail';
  if (rows.some((row) => row.status === 'skip')) return 'warn';
  return 'ok';
}

export function formatLlmSmokeReport(result: LlmSmokeResult): string {
  const lines = ['## cartograph llm smoke', ''];
  for (const row of result.rows) {
    const icon = llmSmokeStatusIcon(row.status);
    const location = [row.provider, row.endpoint, row.model].filter(Boolean).join(' / ');
    const suffix = row.durationMs === undefined ? '' : ` (${row.durationMs}ms)`;
    const locationSuffix = location ? ` — ${location}` : '';
    lines.push(`${icon} **${row.tier}**${locationSuffix}${suffix}`, `  ${row.detail}`);
  }
  lines.push('');
  if (result.overallStatus === 'ok') lines.push('_All configured LLM tiers completed smoke requests._');
  else if (result.overallStatus === 'warn') lines.push('_Configured tiers passed; optional tiers were skipped._');
  else lines.push('_One or more required/configured LLM tiers failed their smoke request._');
  return lines.join('\n');
}

export function formatLlmSmokeJson(result: LlmSmokeResult): string {
  return JSON.stringify(result, null, 2);
}

function missingChatTierDetail(tier: 'summarize' | 'ask' | 'local'): string {
  if (tier === 'ask') return 'askLlm is not configured; ask calls fall back to summarizeLlm.';
  if (tier === 'local') return 'localLlm is not configured; local chat calls fall back to summarizeLlm.';
  return 'summarizeLlm is not configured.';
}

function llmSmokeStatusIcon(status: LlmSmokeRow['status']): string {
  if (status === 'ok') return '✓';
  if (status === 'skip') return '○';
  return '✗';
}
