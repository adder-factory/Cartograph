/**
 * Config-refs index hook — extracts env-var / feature-flag read
 * sites and persists to `config_refs`. Incremental on sync; full
 * rescan on indexAll. See `src/config-refs/` for the extractor.
 *
 * Structural twin of `build-context-refs.ts`; the shared hook wiring
 * lives in `makeRefsIndexHook` (ref-hook-helpers.ts).
 */

import {
  extractConfigRefs,
  CONFIG_REFS_ALGO_VERSION,
  LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY,
} from '../config-refs/index.js';
import {
  applyConfigRefs,
  clearConfigRefs,
  deleteConfigRefsForPaths,
  pruneOrphanedConfigRefs,
} from '../db/queries-refs.js';
import { makeRefsIndexHook } from './ref-hook-helpers.js';

export const HOOK = makeRefsIndexHook({
  hookName: 'config-refs',
  isEnabled: (config) => config.enableConfigRefs !== false,
  algoVersionKey: LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY,
  algoVersion: CONFIG_REFS_ALGO_VERSION,
  clearAll: clearConfigRefs,
  pruneOrphaned: pruneOrphanedConfigRefs,
  deleteForPaths: deleteConfigRefsForPaths,
  extract: extractConfigRefs,
  apply: applyConfigRefs,
});
