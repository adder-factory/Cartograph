/**
 * Configuration Management
 *
 * Load, save, and validate Cartograph configuration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesGlob } from './glob.js';
import { isSafeRegex } from './regex.js';
import { z } from 'zod';
import { type CartographConfig, DEFAULT_CONFIG, type Language } from './types.js';
import { MAX_INDEX_FILE_SIZE, MAX_INDEX_FILE_SIZE_LABEL } from './default-config.js';
import { normalizePath, compact } from './utils.js';
import { LLAMA_SERVER_DEFAULT_ENDPOINT } from './installer/default-endpoints.js';

/**
 * Configuration filename
 */
const CONFIG_FILENAME = 'config.json';

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

function migrateLegacyLlmFieldNames(parsed: unknown, configPath: string): unknown {
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

/**
 * Get the config file path for a project
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.cartograph', CONFIG_FILENAME);
}

// `isSafeRegex` lives in `src/regex.ts` (RE2-backed; linear-time;
// rejects lookahead / lookbehind / backreferences alongside obvious
// invalid syntax). Imported at the top of this file.

/**
 * Mirrors the `Language` union in src/types.ts. The `satisfies`
 * clause rejects typos (a non-Language string fails to compile), and
 * the `_LanguageCoverageOk` line below forces tsc to flag any
 * Language member that is missing from this array — so adding a new
 * language to the union without appending it here breaks the build
 * instead of silently rejecting valid configs at runtime.
 */
export const VALID_LANGUAGES = [
  'apex',
  'arkts',
  'aura',
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'cuda',
  'css',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'embedded_template',
  'svelte',
  'vue',
  'liquid',
  'haskell',
  'html',
  'jsdoc',
  'json',
  'julia',
  'lua',
  'luau',
  'objc',
  'ocaml',
  'ocaml_interface',
  'pascal',
  'hcl',
  'r',
  'regex',
  'sql',
  'scala',
  'rescript',
  'elixir',
  'bash',
  'zsh',
  'fish',
  'glsl',
  'graphql',
  'groovy',
  'prisma',
  'properties',
  'solidity',
  'verilog',
  'visualforce',
  'xml',
  'yaml',
  'unknown',
] as const satisfies readonly Language[];

// Compile-time guard: if a new Language member is added to the union
// and forgotten here, `Missing` becomes that member's literal type
// (not `never`), and the `true` literal stops being assignable.
type _LanguageCoverageOk<Missing = Exclude<Language, (typeof VALID_LANGUAGES)[number]>> = [Missing] extends [never]
  ? true
  : never;

function assertLanguageCoverage(value: _LanguageCoverageOk): true {
  return value;
}
assertLanguageCoverage(true);

/**
 * One LLM chat-provider block (`summarizeLlm` / `askLlm` / `localLlm`).
 *
 * `provider` is the single strict field — a typo there is a genuine
 * config bug that would otherwise surface only later as a fallback or
 * a runtime error. Every other field is optional and `.loose()` keeps
 * forward-compat keys (e.g. provider-specific tuning knobs) flowing
 * through untouched.
 */
const llmChatBlockSchema = z
  .object({
    provider: z.enum(['claude-bridge', 'anthropic-api', 'openai-compat'], {
      error: "llm provider must be one of 'openai-compat', 'claude-bridge', 'anthropic-api'",
    }),
    model: z.string().optional(),
    askModel: z.string().optional(),
    apiKey: z.string().optional(),
    /** openai-compat only: base URL of the HTTP backend (e.g.
     *  `http://localhost:8080` for llama-server). */
    endpoint: z.string().optional(),
    timeoutMs: z.number().optional(),
    claudeBin: z.string().optional(),
    summaryBatchSize: z.number().optional(),
    /** Manual override for cartograph-side concurrent in-flight
     *  requests this tier drives. When unset, cartograph uses the
     *  hardware-aware recommendation from `recommendedTuning()`. */
    concurrency: z.number().int().positive().optional(),
  })
  .loose();

/** The optional top-level `llm` block. */
const llmConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    summarizeLlm: llmChatBlockSchema.optional(),
    askLlm: llmChatBlockSchema.optional(),
    localLlm: llmChatBlockSchema.optional(),
    embeddingLlm: z
      .object({
        provider: z.literal('openai-compat', {
          error: "embeddingLlm provider must be 'openai-compat' (the in-process 'local' path was removed 2026-05-24c)",
        }),
        model: z.string(),
        endpoints: z.array(z.string()).optional(),
        /** Base URL of the HTTP backend
         *  (e.g. `http://localhost:8080` for llama-server). */
        endpoint: z.string().optional(),
        /** Optional Bearer token for cloud backends. */
        apiKey: z.string().optional(),
        timeoutMs: z.number().optional(),
        dtype: z.enum(['q4f16', 'fp16', 'fp32', 'q4', 'q8']).optional(),
        /** Manual override for cartograph-side concurrent in-flight
         *  embed batches. When unset, cartograph uses the
         *  hardware-aware recommendation from `recommendedTuning()`. */
        concurrency: z.number().int().positive().optional(),
      })
      .loose()
      .optional(),
    rerankerLlm: z
      .object({
        provider: z.literal('openai-compat', {
          error: "rerankerLlm provider must be 'openai-compat' (the in-process 'local' path was removed 2026-05-24c)",
        }),
        model: z.string().optional(),
        /** Base URL of the HTTP backend. */
        endpoint: z.string().optional(),
        /** Optional Bearer token for cloud backends. */
        apiKey: z.string().optional(),
        timeoutMs: z.number().optional(),
        dtype: z.string().optional(),
        /** Manual override for cartograph-side concurrent in-flight
         *  rerank requests. */
        concurrency: z.number().int().positive().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    summarize: z.boolean().optional(),
    summarizeEagerLimit: z.number().optional(),
  })
  .loose();

/** A framework hint — only `name` is required, matching the prior
 *  hand-rolled `hasValidFrameworks` check. */
const frameworkHintSchema = z
  .object({
    name: z.string(),
    version: z.string().optional(),
    patterns: z
      .object({
        components: z.array(z.string()).optional(),
        routes: z.array(z.string()).optional(),
        models: z.array(z.string()).optional(),
      })
      .loose()
      .optional(),
  })
  .loose();

const layerConfigSchema = z
  .object({
    name: z.string(),
    paths: z.array(z.string()),
    canImport: z.array(z.string()).optional(),
    cannotImport: z.array(z.string()).optional(),
  })
  .loose();

const layerExceptionSchema = z
  .object({
    file: z.string(),
    canImport: z.array(z.string()),
  })
  .loose();

const databaseConfigSchema = z
  .object({
    provider: z.enum(['sqlite', 'postgres']).optional(),
    url: z.string().optional(),
    schema: z.string().optional(),
    pgvector: z.enum(['auto', 'off', 'require']).optional(),
    maxConnections: z.number().int().positive().optional(),
    idleTimeoutSeconds: z.number().int().nonnegative().optional(),
    maxLifetimeSeconds: z.number().int().nonnegative().optional(),
    connectionTimeoutSeconds: z.number().int().positive().optional(),
    queryTimeoutMs: z.number().int().positive().optional(),
    ssl: z.boolean().optional(),
  })
  .loose();

/**
 * Zod v4 schema for a fully-merged `CartographConfig`.
 *
 * Replaces the former hand-rolled `validateConfig` family
 * (`hasRequiredScalarShape`, `hasValidLanguages`, `hasValidFrameworks`,
 * `hasValidCustomPatterns`, `validateStringArrays`). Used for INPUT
 * VALIDATION ONLY — `DEFAULT_CONFIG` stays the authoritative source of
 * defaults (its `include` list is a lazy getter that a parsed plain
 * object cannot carry), so `loadConfig` validates the merged object
 * and returns the merge, never `result.data`.
 *
 * `.loose()` lets unknown keys flow through untouched, matching the
 * forward-compat contract of `mergeConfig` (`{ ...defaults,
 * ...overrides }` never drops a key cartograph doesn't yet know).
 *
 * The nine required fields mirror exactly what the old `validateConfig`
 * required (the fields `DEFAULT_CONFIG` guarantees post-merge); every
 * interface-optional field is `.optional()`, so a minimal user config
 * is never rejected newly. The only validation tightened beyond the
 * old code is the `maxFileSize` range plus the previously-unchecked
 * `llm` block, where a bad `provider` is now caught at load with a
 * field-level message.
 */
const CartographConfigSchema = z
  .object({
    version: z.number(),
    rootDir: z.string(),
    include: z.array(z.string()),
    exclude: z.array(z.string()),
    languages: z.array(z.enum(VALID_LANGUAGES)),
    frameworks: z.array(frameworkHintSchema),
    maxFileSize: z
      .number()
      .int()
      .min(1)
      .max(MAX_INDEX_FILE_SIZE, { error: `maxFileSize must be at most ${MAX_INDEX_FILE_SIZE_LABEL}` }),
    extractDocstrings: z.boolean(),
    trackCallSites: z.boolean(),
    database: databaseConfigSchema.optional(),

    indexSubmodules: z.boolean().optional(),
    indexEmbeddedRepos: z.boolean().optional(),
    enableCoChange: z.boolean().optional(),
    enableBiomarkers: z.boolean().optional(),
    enableCentrality: z.boolean().optional(),
    enableBetweenness: z.boolean().optional(),
    enableChurn: z.boolean().optional(),
    enableIssueHistory: z.boolean().optional(),
    enableConfigRefs: z.boolean().optional(),
    enableSqlRefs: z.boolean().optional(),
    enableBuildContextRefs: z.boolean().optional(),
    enableStringImports: z.boolean().optional(),
    largeFunctionThreshold: z.number().optional(),
    nestedPromotionThreshold: z.number().optional(),

    llm: llmConfigSchema.optional(),
    customPatterns: z
      .array(
        z.object({
          name: z.string(),
          pattern: z.string().refine(isSafeRegex, {
            error: 'unsafe or invalid regex pattern (ReDoS risk, uncompilable, or over 500 chars)',
          }),
          kind: z.string(),
        }),
      )
      .optional(),
    dependenciesAllowlist: z.array(z.string()).optional(),
    layers: z.array(layerConfigSchema).optional(),
    layerExceptions: z.array(layerExceptionSchema).optional(),
    duplicateCodeAllowlist: z.array(z.string()).optional(),
    duplicateCodePartialClones: z.boolean().optional(),
  })
  .loose();

/**
 * Merge configuration with defaults.
 *
 * Special case for `include`: the language registry can grow (new
 * extensions added to existing language defs, e.g. `.mts`/`.cts`
 * joining the TypeScript def). When a persisted config materialized
 * its `include` list at init time, replacing it on every load means
 * the project would silently miss the new extension forever. So `include`
 * is UNIONED with the registry-derived defaults: every user-listed
 * glob is preserved in its original order, then any registry glob the
 * user doesn't already have is appended. This is the "auto-pickup" of
 * new language extensions on next load (G14, 2026-05-21).
 *
 * Trade-off accepted: if a user deliberately removed the Python glob
 * from their include to exclude Python files, the next load re-adds
 * it. That is counted as a misuse of `include` — the supported
 * pattern for excluding a language is the `exclude` array.
 */
function mergeConfig(defaults: CartographConfig, overrides: Partial<CartographConfig>): CartographConfig {
  // Spread `defaults` then `compact(overrides)`:
  //   - undefined-valued overrides (common when callers forward an
  //     unset CLI flag) don't clobber a populated default
  //   - any new field added to `CartographConfig` flows through
  //     automatically — no per-field listing to keep in sync
  // The previous form listed all fields manually; adding a new
  // field meant remembering to update this function or the
  // override would silently no-op.
  const merged: CartographConfig = { ...defaults, ...compact(overrides) };
  const persisted = compact(overrides).include;
  if (Array.isArray(persisted)) {
    const seen = new Set(persisted);
    const extras = defaults.include.filter((g) => !seen.has(g));
    merged.include = extras.length > 0 ? [...persisted, ...extras] : persisted;
  }
  return merged;
}

function assertValidCartographConfig(configPath: string, config: CartographConfig): void {
  const result = CartographConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid configuration in ${configPath}:\n${z.prettifyError(result.error)}`);
  }
}

function assertPersistableMaxFileSize(configPath: string, maxFileSize: number): void {
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 1 || maxFileSize > MAX_INDEX_FILE_SIZE) {
    throw new Error(
      `Invalid configuration in ${configPath}:\nmaxFileSize must be between 1 byte and ${MAX_INDEX_FILE_SIZE_LABEL}`,
    );
  }
}

/**
 * Load configuration from a project
 */
export function loadConfig(projectRoot: string): CartographConfig {
  const configPath = getConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    // Return default config with adjusted rootDir
    return {
      ...DEFAULT_CONFIG,
      rootDir: projectRoot,
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Migrate legacy llm field names (`chat` / `askChat` / `localChat` /
    // `embeddings`) to the purpose-suffixed scheme (`summarizeLlm` /
    // `askLlm` / `localLlm` / `embeddingLlm`). One-shot: writes the
    // migrated config back to disk with a `.bak.legacy-llm-names`
    // backup so any tooling reading the file later sees the new shape.
    const migrated = migrateLegacyLlmFieldNames(parsed, configPath);

    // Merge with defaults to ensure all fields are present
    const merged = mergeConfig(DEFAULT_CONFIG, migrated as Partial<CartographConfig>);
    merged.rootDir = projectRoot; // Always use actual project root

    // Validation-only: `merged` (not parsed result data) is returned so
    // the `DEFAULT_CONFIG` getter-derived fields survive untouched. The
    // formatted error names the offending field/path so the user can fix
    // `config.json` without guessing.
    assertValidCartographConfig(configPath, merged);

    return merged;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`);
    }
    throw error;
  }
}

/**
 * Save configuration to a project
 */
export function saveConfig(projectRoot: string, config: CartographConfig): void {
  const configPath = getConfigPath(projectRoot);
  const dir = path.dirname(configPath);

  assertPersistableMaxFileSize(configPath, config.maxFileSize);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create a copy without rootDir (it's always derived from project path)
  const toSave = { ...config };
  delete (toSave as Partial<CartographConfig>).rootDir;

  const content = JSON.stringify(toSave, null, 2);

  // Atomic write: write to temp file then rename to prevent partial/corrupt configs
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/**
 * Create default configuration for a new project
 */
export function createDefaultConfig(projectRoot: string): CartographConfig {
  return {
    ...DEFAULT_CONFIG,
    rootDir: projectRoot,
  };
}

/**
 * Check if a file path matches the include/exclude patterns
 */
export function shouldIncludeFile(filePath: string, config: CartographConfig): boolean {
  // Normalize to forward slashes so Windows backslash paths match glob patterns
  filePath = normalizePath(filePath);

  const matchesPattern = (pattern: string, filePath: string): boolean => {
    return matchesGlob(filePath, pattern);
  };

  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesPattern(pattern, filePath)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesPattern(pattern, filePath)) {
      return true;
    }
  }

  // Default to not including if no pattern matches
  return false;
}
