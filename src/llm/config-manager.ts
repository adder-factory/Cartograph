/**
 * Phase 1 of CartographLlmService god_class refactor (design at
 * `project_cartograph_llm_service_refactor_plan.md`).
 *
 * Owns the resolved-LLM cache and the three config-shape predicates
 * (`hasLlm`, `getEffectiveLlmConfig`, `resolveLlmConfig`). Moved off
 * `CartographLlmService` to clear the `god_class` biomarker.
 *
 * Public callers reach this through `cg.llm.config.X()`. Backwards-
 * compatible delegators on `CartographLlmService` (`cg.llm.hasLlm()`
 * etc.) forward here so existing call-sites keep working unchanged.
 */

import type { Cartograph } from '../index.js';
import { resolveLlmProviders, type ResolvedLlm } from './provider.js';
import { loadConfig } from '../config.js';
import { logDebug } from '../errors.js';
import * as fs from 'node:fs';
import * as path from 'node:path';

export class LlmConfigManager {
  // Resolved LLM providers — populated lazily on first LLM call.
  // Cached per LlmConfigManager instance: never `undefined` after the
  // first resolution attempt, even if it returned `null` (LLM disabled).
  private resolvedLlm: ResolvedLlm | null | undefined = undefined;

  /** mtime (ms) of `.cartograph/config.json` at the last resolution, so
   *  `resolveLlmConfig` can detect an out-of-band edit (CLI `llm-apply`,
   *  `llm setup`, or a hand-edit) and re-read without a server restart
   *  (issue #14). */
  private configMtimeMs: number | undefined;

  constructor(private readonly cg: Cartograph) {}

  /**
   * Lazy LLM-provider resolution. Cached per manager instance — the
   * `resolvedLlm` slot is `undefined` before first use and one of
   * `ResolvedLlm | null` afterwards (null = LLM disabled). Callers
   * that need to refresh after a config edit pass `forceReload: true`
   * to skip the cache.
   *
   * Resolution failures are swallowed (logged, treated as "no LLM
   * available") so callers never have to wrap LLM-feature-gating
   * checks in try/catch.
   */
  async resolveLlmConfig(forceReload = false): Promise<ResolvedLlm | null> {
    // #14: a running MCP server caches config.llm at startup. Detect an
    // out-of-band edit (CLI `admin llm-apply`, `llm setup`, or a hand-edit)
    // via the config file's mtime and re-read + re-resolve, so MCP-side LLM
    // tools pick it up without a restart. Cheap — one stat per resolve, and
    // bulk passes resolve once per pass.
    const mtime = this.configFileMtimeMs();
    if (this.configMtimeMs === undefined) {
      // First resolution — record the baseline mtime; no reload.
      this.configMtimeMs = mtime;
    } else if (mtime !== undefined && mtime !== this.configMtimeMs) {
      try {
        this.cg.config.llm = loadConfig(this.cg.projectRoot).llm;
        // Advance the baseline + drop the cache ONLY after a clean read, so a
        // transient read failure (e.g. a half-written file) retries on the
        // next call instead of getting stuck serving stale config.
        this.configMtimeMs = mtime;
        this.resolvedLlm = undefined;
        logDebug('LLM config.json changed on disk — reloaded without restart', { projectRoot: this.cg.projectRoot });
      } catch (err) {
        logDebug('LLM config reload failed, keeping cached and retrying next call', { error: String(err) });
      }
    }

    if (this.resolvedLlm !== undefined && !forceReload) {
      return this.resolvedLlm;
    }
    try {
      this.resolvedLlm = await resolveLlmProviders(this.cg.config);
      if (this.resolvedLlm) {
        logDebug('LLM providers resolved', { trace: this.resolvedLlm.resolutionTrace });
      }
    } catch (err) {
      this.resolvedLlm = null;
      logDebug('LLM provider resolution failed', { error: String(err) });
    }
    return this.resolvedLlm;
  }

  /**
   * Synchronously discard the resolved-LLM cache. The next
   * `resolveLlmConfig()` call (or any tool path that goes through it)
   * will re-run `resolveLlmProviders(cg.config)`. Pair with a fresh
   * read of `config.json` — `cg.config` itself must already reflect
   * the new contents (e.g. via `cgRefreshConfigFromDisk`) for the
   * re-resolution to pick up the change.
   */
  invalidate(): void {
    this.resolvedLlm = undefined;
    // Reset the mtime baseline too: callers pair invalidate() with a fresh
    // cgRefreshConfigFromDisk (e.g. evictCachedProject after a CLI llm-apply),
    // so the next resolve should re-record the baseline rather than treat the
    // already-applied change as a reload trigger (avoids a redundant load).
    this.configMtimeMs = undefined;
  }

  /** mtime (ms) of `.cartograph/config.json`, or undefined when it can't be
   *  stat'd (missing / pre-init) — treated as "no change". */
  private configFileMtimeMs(): number | undefined {
    try {
      return fs.statSync(path.join(this.cg.projectRoot, '.cartograph', 'config.json')).mtimeMs;
    } catch {
      return undefined;
    }
  }

  /**
   * Whether an LLM is configured in `config.llm`. Synchronous, config-
   * only — does NOT probe disk for `claude` binary or check
   * environment variables. Callers that want to know whether features
   * are actually *usable* should `await getEffectiveLlmConfig()`.
   */
  hasLlm(): boolean {
    const llm = this.cg.config.llm;
    if (!llm || llm.enabled === false) return false;
    return Boolean(llm.summarizeLlm?.provider || llm.embeddingLlm?.provider);
  }

  /**
   * Returns the resolved LLM config that will be used. Includes
   * binary-presence and env-var checks for the configured provider.
   * Callers use this to decide whether to surface LLM-dependent UI.
   *
   * Re-reads `.cartograph/config.json` from disk on every call so a
   * status tool reflects post-startup config edits without a server
   * restart. Cheap (one fs read per status query); no MCP server
   * watcher needed.
   */
  async getEffectiveLlmConfig(): Promise<ResolvedLlm | null> {
    try {
      const fresh = loadConfig(this.cg.projectRoot);
      this.cg.config.llm = fresh.llm;
    } catch (err) {
      logDebug('LLM config reload failed, using cached', { error: String(err) });
    }
    return this.resolveLlmConfig(true);
  }
}
