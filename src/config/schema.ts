import { z } from 'zod';
import { MAX_INDEX_FILE_SIZE, MAX_INDEX_FILE_SIZE_LABEL } from '../default-config.js';
import { isSafeRegex } from '../regex.js';
import type { CartographConfig } from '../types.js';
import { VALID_LANGUAGES } from './languages.js';

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
     *  hardware-aware recommendation from `recommendedTuning()`. For a
     *  `cartograph backend start`-managed local llama-server this value
     *  also drives the backend's `--parallel N`. */
    concurrency: z.number().int().positive().optional(),
    /** openai-compat + local llama-server only: extra flags appended
     *  verbatim to the `cartograph backend start` command for this
     *  tier (e.g. `["--cache-ram", "1024", "-c", "8192", "-ngl",
     *  "999"]`). Lets you cap KV-cache / context / offload per tier for
     *  constrained hardware without cartograph owning every flag. An
     *  explicit `--parallel` (or `-np`) here overrides cartograph's
     *  computed value. */
    llamaServerArgs: z.array(z.string()).optional(),
    /** Declare this tier's backend as externally managed (you run the
     *  `llama-server` yourself). Cartograph then never starts, stops, or
     *  restarts it: `backend start` always skips it (instead of the
     *  "is the port live right now" heuristic), `stop` never signals it,
     *  `restart` prints a relaunch hint, and `status` labels it external.
     *  You own applying config changes by relaunching with the new
     *  `--parallel`/flags. NOTE: if several tiers share one endpoint (one
     *  llama-server process), declaring this on ANY of them marks the whole
     *  shared process external — cartograph won't manage it for the others. */
    externallyManaged: z.boolean().optional(),
  })
  .loose();

/** The optional top-level `llm` block. */
const llmConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    summarizeLlm: llmChatBlockSchema.optional(),
    askLlm: llmChatBlockSchema.optional(),
    localLlm: llmChatBlockSchema.optional(),
    classifyLlm: llmChatBlockSchema.optional(),
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
         *  hardware-aware recommendation from `recommendedTuning()`. For
         *  a `cartograph backend start`-managed local llama-server this
         *  value also drives the backend's `--parallel N`. */
        concurrency: z.number().int().positive().optional(),
        /** Extra flags appended verbatim to `cartograph backend start`
         *  for this tier (e.g. `["--cache-ram", "2048"]`). An explicit
         *  `--parallel`/`-np` here overrides the computed value. */
        llamaServerArgs: z.array(z.string()).optional(),
        /** Declare this tier's backend as externally managed — cartograph
         *  never starts/stops/restarts it. See `llmChatBlockSchema`. */
        externallyManaged: z.boolean().optional(),
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
         *  rerank requests. For a `cartograph backend start`-managed
         *  local llama-server this value also drives `--parallel N`. */
        concurrency: z.number().int().positive().optional(),
        /** Extra flags appended verbatim to `cartograph backend start`
         *  for this tier. An explicit `--parallel`/`-np` here overrides
         *  the computed value. */
        llamaServerArgs: z.array(z.string()).optional(),
        /** Declare this tier's backend as externally managed — cartograph
         *  never starts/stops/restarts it. See `llmChatBlockSchema`. */
        externallyManaged: z.boolean().optional(),
      })
      .loose()
      .nullable()
      .optional(),
    summarize: z.boolean().optional(),
    summarizeEagerLimit: z.number().optional(),
    // Minimum symbol body-line floor for summarisation. Defaults to 4
    // (route: 1). Lower it for fuller coverage of short symbols; raise it
    // to skip more. Applied in lock-step across the LLM pass, the
    // structural pass, and the status rollup.
    minBodyLines: z.number().int().nonnegative().optional(),
    minBodyLinesByKind: z.record(z.string(), z.number().int().nonnegative()).optional(),
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

export function assertValidCartographConfig(configPath: string, config: unknown): asserts config is CartographConfig {
  const result = CartographConfigSchema.safeParse(config);
  if (!result.success) {
    throw new Error(`Invalid configuration in ${configPath}:\n${z.prettifyError(result.error)}`);
  }
}
