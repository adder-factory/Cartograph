/**
 * Biomarker analysis hook — runs after every indexAll/sync to keep
 * `code_health_findings` in step with the source.
 *
 * Cheap on sync (only re-analyses files the sync touched). Capped
 * to a few seconds even on large indexAll runs by re-using the
 * cached tree-sitter parsers from the extraction pass.
 */

import type { IndexHook } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import { analyseProject, isBiomarkerCacheCold } from '../biomarkers/index.js';
import { logDebug, logWarn } from '../errors.js';

/** Surface biomarker-rule errors at WARN so a recurring failure (e.g. a
 *  cross-file worker timeout that preserved stale findings instead of
 *  refreshing them) is visible, not buried in the debug-level pass log. */
function warnOnBiomarkerErrors(phase: string, errors: number): void {
  if (errors > 0) {
    logWarn(`Biomarkers: ${phase} completed with ${errors} rule error(s); affected findings kept from the prior pass`);
  }
}

export const HOOK: IndexHook = {
  name: 'biomarkers',
  async afterIndexAll(ctx) {
    if (ctx.config.enableBiomarkers === false) return;
    const result = await analyseProject(ctx.queries, ctx.projectRoot);
    logDebug('Biomarkers: indexAll', {
      files: result.filesScanned,
      symbols: result.symbolsAnalysed,
      findings: result.findingsEmitted,
      unsupportedLanguages: result.unsupportedLanguages,
      durationMs: result.durationMs,
      errors: result.errors,
      // Aggregate count of friction #20 defensive-guard hits. Surfaced
      // here so a recurrence is visible in the standard hook log; the
      // per-symbol context still lands via logDebug inside analyseProject.
      skippedRangeMismatch: result.skippedRangeMismatch,
    });
    warnOnBiomarkerErrors('indexAll', result.errors);
  },
  async afterSync(ctx, result: SyncResult) {
    if (ctx.config.enableBiomarkers === false) return;
    // Default: only re-analyse the files the sync actually touched.
    // Exception: when the per-file content-hash cache is empty (first
    // sync after a cache version bump or initial install on a freshly-
    // indexed project), run a full pass once so stored findings catch
    // up to the current engine. After that, subsequent syncs revert
    // to the cheap changed-files-only path. Edge case: a cold-cache
    // afterSync with zero changed files still runs a full pass — minor
    // one-shot cost in exchange for the self-heal property.
    const cold = isBiomarkerCacheCold(ctx.queries);
    const filePaths = cold ? undefined : result.changedFilePaths;
    const r = await analyseProject(ctx.queries, ctx.projectRoot, filePaths === undefined ? {} : { filePaths });
    logDebug('Biomarkers: sync', {
      files: r.filesScanned,
      symbols: r.symbolsAnalysed,
      findings: r.findingsEmitted,
      durationMs: r.durationMs,
      errors: r.errors,
      skippedRangeMismatch: r.skippedRangeMismatch,
    });
    warnOnBiomarkerErrors('sync', r.errors);
  },
};
