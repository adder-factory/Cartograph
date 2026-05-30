/**
 * Build-context-refs index hook — extracts `__dirname` /
 * `import.meta.*` read sites and persists to `build_context_refs`.
 * Incremental on sync, full rescan on indexAll. See
 * `src/build-context-refs/` for the extractor.
 *
 * Structural twin of `config-refs.ts`; the shared hook wiring lives
 * in `makeRefsIndexHook` (ref-hook-helpers.ts).
 */

import {
  extractBuildContextRefs,
  BUILD_CONTEXT_REFS_ALGO_VERSION,
  LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY,
} from '../build-context-refs/index.js';
import {
  applyBuildContextRefs,
  clearBuildContextRefs,
  deleteBuildContextRefsForPaths,
  pruneOrphanedBuildContextRefs,
} from '../db/queries-refs.js';
import { makeRefsIndexHook } from './ref-hook-helpers.js';

export const HOOK = makeRefsIndexHook({
  hookName: 'build-context-refs',
  isEnabled: (config) => config.enableBuildContextRefs !== false,
  algoVersionKey: LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY,
  algoVersion: BUILD_CONTEXT_REFS_ALGO_VERSION,
  clearAll: clearBuildContextRefs,
  pruneOrphaned: pruneOrphanedBuildContextRefs,
  deleteForPaths: deleteBuildContextRefsForPaths,
  extract: extractBuildContextRefs,
  apply: applyBuildContextRefs,
});
