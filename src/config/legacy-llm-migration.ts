import * as fs from 'node:fs';
import { LLAMA_SERVER_DEFAULT_ENDPOINT } from '../installer/default-endpoints.js';

/**
 * Map of legacy llm field name → new purpose-suffixed name. Applied
 * by `migrateLegacyLlmFieldNames` on first load of an old config.
 *
 *   chat       → summarizeLlm  (cartograph's own indexing-time calls)
 *   askChat    → askLlm        (user-driven cartograph_ask + dead-code)
 *   localChat  → localLlm      (agent-delegated subtasks; local-tier
 *                              sibling of Haiku/Sonnet)
 *   embeddings → embeddingLlm  (vec0 vectors)
 *
 * Migration is one-shot: the new config is written back to disk with
 * a `.bak.legacy-llm-names` backup so re-running setup or any other
 * tooling sees the new shape. Idempotent — running on an already-
 * migrated config is a no-op.
 */
const LEGACY_LLM_FIELD_MAP: ReadonlyArray<readonly [string, string]> = [
  ['chat', 'summarizeLlm'],
  ['askChat', 'askLlm'],
  ['localChat', 'localLlm'],
  ['embeddings', 'embeddingLlm'],
];

/** Process-scoped guard: config paths whose legacy-llm write-back has
 *  already been attempted this process. On a read-only mount the write
 *  fails but `changed` stays true, so without this every `loadConfig` —
 *  now once per sync (FRICTION-11) — would spew another timestamped
 *  `.bak.legacy-llm-names` file. Exported reset for tests. */
const legacyLlmWriteBackAttempted = new Set<string>();
export function _resetLegacyLlmMigrationForTest(): void {
  legacyLlmWriteBackAttempted.clear();
}

/** Per-tier default endpoint to use when auto-migrating legacy
 *  `'nllc'` / `'local'` provider values to `'openai-compat'`. Matches
 *  the per-port layout in `recommended-config.ts` so a freshly
 *  migrated config points at the same `llama-server -m <gguf> --port
 *  <port>` instances `install-models --write-config` would have
 *  written. Users on a different layout (single Ollama on its default
 *  port, mlx_lm.server, etc.) see the migrated config + the
 *  `cartograph doctor` reachability check flagging the wrong endpoint
 *  with the right remediation. */
const LEGACY_PROVIDER_DEFAULT_ENDPOINTS: Record<string, string> = {
  summarizeLlm: 'http://localhost:8081',
  localLlm: 'http://localhost:8081',
  askLlm: 'http://localhost:8082',
  embeddingLlm: 'http://localhost:8080',
  rerankerLlm: 'http://localhost:8083',
};

/** Tiers whose `provider: 'nllc'` (chat) or `provider: 'local'`
 *  (embedding / reranker) values are deprecated post-2026-05-24c (step
 *  4c). On config load they auto-migrate in-memory to
 *  `'openai-compat'` with the per-tier default endpoint above + a
 *  stderr warning naming the tier. The disk file is NOT rewritten —
 *  the migration is in-memory only, so the user's original config
 *  (including the GGUF paths in `model` fields) stays intact for them
 *  to hand-edit if they prefer a different layout. */
const LEGACY_PROVIDER_TIERS = ['summarizeLlm', 'localLlm', 'askLlm', 'embeddingLlm', 'rerankerLlm'] as const;

function migrateLegacyProviderValue(
  tier: string,
  block: Record<string, unknown>,
): { migrated: boolean; out: Record<string, unknown> } {
  const provider = block['provider'];
  // Chat tiers — `'nllc'` was the in-process libcgshim path.
  const isChat = tier === 'summarizeLlm' || tier === 'localLlm' || tier === 'askLlm';
  const isEmbedOrRerank = tier === 'embeddingLlm' || tier === 'rerankerLlm';
  const stale = (isChat && provider === 'nllc') || (isEmbedOrRerank && provider === 'local');
  if (!stale) return { migrated: false, out: block };
  const defaultEndpoint = LEGACY_PROVIDER_DEFAULT_ENDPOINTS[tier] ?? LLAMA_SERVER_DEFAULT_ENDPOINT;
  return {
    migrated: true,
    out: {
      ...block,
      provider: 'openai-compat',
      // Preserve an explicit user endpoint if somehow present (defensive —
      // legacy configs don't have one, but don't clobber).
      endpoint: block['endpoint'] ?? defaultEndpoint,
    },
  };
}

export function migrateLegacyLlmFieldNames(parsed: unknown, configPath: string): unknown {
  if (typeof parsed !== 'object' || parsed === null) return parsed;
  const root = parsed as Record<string, unknown>;
  const llmRaw = root['llm'];
  if (typeof llmRaw !== 'object' || llmRaw === null) return parsed;
  const llm = { ...(llmRaw as Record<string, unknown>) };
  let changed = false;
  for (const [oldKey, newKey] of LEGACY_LLM_FIELD_MAP) {
    // Only migrate when the OLD key is present AND the NEW key is
    // absent. Skip when the new shape already wins so we don't
    // clobber an explicit user override.
    if (oldKey in llm && !(newKey in llm)) {
      llm[newKey] = llm[oldKey];
      delete llm[oldKey];
      changed = true;
    } else if (oldKey in llm) {
      // Both present — drop the old one. The new one wins; the user
      // would otherwise see legacy fields lingering forever.
      delete llm[oldKey];
      changed = true;
    }
  }
  // Per-tier provider value migration: `'nllc'` (chat) and `'local'`
  // (embedding / reranker) are the removed in-process pathway. Translate
  // to `'openai-compat'` with a tier-specific default endpoint so the
  // resolver doesn't drop the tier on load.
  for (const tier of LEGACY_PROVIDER_TIERS) {
    const block = llm[tier];
    if (typeof block !== 'object' || block === null) continue;
    const { migrated, out } = migrateLegacyProviderValue(tier, block as Record<string, unknown>);
    if (migrated) {
      llm[tier] = out;
      changed = true;
      process.stderr.write(
        `[Cartograph] Auto-migrated legacy ${tier}.provider value to "openai-compat" + endpoint=${
          (out['endpoint'] as string) ?? '(unset)'
        } (in-process pathway removed 2026-05-24c step 4c). Run \`cartograph doctor\` to confirm the endpoint is reachable + start a llama-server there if not.\n`,
      );
    }
  }
  if (!changed) return parsed;
  const migrated = { ...root, llm };
  // Write-back is attempted at most once per config path per process.
  // After a SUCCESSFUL write the file no longer has legacy keys, so
  // `changed` is false on later calls anyway — the guard's real job is
  // the FAILURE path (read-only mount): without it, every loadConfig
  // (now once per sync — FRICTION-11) would emit a fresh timestamped
  // `.bak.legacy-llm-names` backup.
  if (legacyLlmWriteBackAttempted.has(configPath)) return migrated;
  legacyLlmWriteBackAttempted.add(configPath);
  // Write the migrated config back to disk with a timestamp-suffixed
  // backup. Atomic via tmp + rename.
  const backupPath = `${configPath}.bak.legacy-llm-names.${Date.now()}`;
  try {
    fs.copyFileSync(configPath, backupPath);
    const tmp = configPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(migrated, null, 2), 'utf-8');
    fs.renameSync(tmp, configPath);
    process.stderr.write(`[Cartograph] Migrated legacy llm field names in ${configPath}; backup at ${backupPath}\n`);
    return migrated;
  } catch (err) {
    // If we can't write back (e.g. read-only mount), still return
    // the migrated in-memory version so the rest of the load works.
    process.stderr.write(
      `[Cartograph] Migrated legacy llm field names in memory; failed to write back to ${configPath}: ${(err as Error).message}\n`,
    );
    return migrated;
  }
}
