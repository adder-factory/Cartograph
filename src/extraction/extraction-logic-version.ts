/**
 * Extraction-logic version + self-heal helper (friction #66).
 *
 * The extractor builds nodes/edges from source files. When that logic
 * changes (new edge kinds emitted, attribution changes, bug fixes that
 * alter the emitted set), already-extracted files whose `content_hash`
 * hasn't changed silently keep the OLD extractor's output. Subsequent
 * `sync` passes skip them entirely because the disk-vs-DB hash compare
 * short-circuits the re-extraction path.
 *
 * Symptom shape: false-positive `unused_export` findings for symbols
 * that ARE imported / called by other files, because the references
 * edges from those callers were emitted under the older extractor and
 * never refreshed. Diagnosed 2026-05-09 — 26 of 26 `unused_export`
 * info findings on this repo were stale-extraction FPs that vanished
 * after a forced full re-extraction.
 *
 * Distinct from the parse_cache `PAYLOAD_VERSION` (in
 * `src/db/queries-parse-cache.ts`): that constant invalidates cached
 * parse trees on the next re-parse of an already-changing file.
 * `EXTRACTION_LOGIC_VERSION` instead forces a one-shot full
 * re-extraction even for files whose content didn't change. They can
 * coexist — bumping one doesn't imply bumping the other.
 *
 * The self-heal:
 *   - Stored value lives in `project_metadata` keyed by
 *     `extraction_logic_version`.
 *   - On every `sync` / `indexAll` boot, compare stored to the constant
 *     below. If they differ, set `files.needs_reextract = 1` for every
 *     row (migration 047) and persist the new version. The next pass
 *     sees `needs_reextract = 1` and re-extracts every file even when
 *     its content_hash still matches — full re-extraction → fresh edges.
 *     The heal runs at most once per change. Prior versions zeroed
 *     `files.content_hash` directly; that pattern was abandoned in
 *     Phase 1 of the staleness redesign (friction F4) because it
 *     corrupted the stale-artifact display.
 *
 * `EXTRACTION_LOGIC_VERSION` is derived from a sha256 of the spec
 * files listed in the `computeAlgoHash` call below — the universal-
 * extractor core (`tree-sitter.ts` + its `tree-sitter-decls` /
 * `-typerefs` / `-helpers` siblings + the three `ts-extract-*` split
 * files) plus the `schema-recognizers/*` pass that runs inside
 * extraction. That array is the source of truth; this prose is not —
 * don't trust a count here, read the list.
 * Edit one of those files substantively → hash changes → heal triggers
 * on the next sync. The comment-strip + whitespace-normalise in the
 * hasher means JSDoc / reformat-only edits don't invalidate. There's
 * no manual bump to remember and no contributor checklist to forget.
 *
 * Pre-2026-05-11 this was a hand-bumped integer guarded by a drift
 * detector; the new shape is the same workflow with the human step
 * removed. See `src/algo-hash.ts` for the hashing helper and the
 * design rationale.
 *
 * Phase 1 (friction F4): the heal now sets `needs_reextract = 1` on
 * every files row instead of zeroing content_hash. The
 * `getStaleArtifactsCount` window-of-inflated-counts bug is gone —
 * embeddings and summaries can compare against the real file hash
 * throughout the heal, so unchanged files contribute zero stale
 * artifacts. The re-extraction itself is gated on
 * `needs_reextract = 1` in the sync change-detection path; after
 * each file is re-extracted, `upsertFile` writes
 * `needs_reextract = 0` alongside the fresh content_hash.
 */

import type { QueryBuilder } from '../db/queries.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug } from '../errors.js';
import { computeAlgoHash } from '../algo-hash.js';

/**
 * Current extractor emit-set version — derived from a sha256 of the
 * files that collectively own the "what gets emitted" contract: see
 * the `computeAlgoHash` array below. It spans the universal-extractor
 * core (`tree-sitter.ts` + `tree-sitter-decls` / `-typerefs` /
 * `-helpers` — the last owns `getPrecedingDocstring` + `generateNodeId`,
 * both emit-affecting — plus the three `ts-extract-*` split files) and
 * the `schema-recognizers/*` pass that runs inside extraction.
 * Whenever any of them changes substantively (after the helper strips
 * comments + normalises whitespace), the hash changes and the next
 * sync sees the stored version mismatch → triggers the self-heal that
 * sets `needs_reextract = 1` on every file and wipes parse_cache.
 *
 * Why this shape: prior to 2026-05-11 this was a hand-bumped integer
 * (1 → 7 over seven bumps), guarded by a drift-detector test that
 * yelled when a contributor edited the spec files without updating a
 * checked-in hash manifest. The detector caught misses, but the bump
 * itself was a manual decision that contributors had to remember.
 * Switching to a source-derived hash makes the workflow automatic:
 * edit a spec file → hash changes → cache invalidates. Refactor PRs
 * that only touch comments / whitespace don't invalidate (the helper
 * normalises both away before hashing).
 *
 * Trade-off: a substantive refactor of any spec file in that array
 * that doesn't change emit semantics still invalidates the cache. The
 * old manifest-only-update workflow let
 * contributors document "this is a pure refactor, don't re-extract."
 * That option is gone — refactors of any spec file always
 * trigger a one-shot full re-extraction on the next sync. We
 * judged the simplicity-vs-spurious-rework trade worth it; the bump
 * misses the system used to catch were more common than spurious
 * cache invalidations on pure refactors.
 *
 * Historical bump notes (v1 → v9, kept for archaeology — see git
 * blame for the actual changes):
 *   v1 initial heal • v2 nodes.decorators populated • v3 Java/C#/PHP
 *   attribute wrappers • v4 type-only import refs • v5 nodes.body_hash
 *   added • v6 export_statement docstring walk • v7
 *   SCREAMING_SNAKE_CASE body reads • v8 dynamic-import TS-wrapper
 *   unwrap (`as`, type_assertion, parens, satisfies) so
 *   `import('node-llama-cpp' as any)` emits an import node • v9
 *   `tree-sitter-helpers.ts` added to the spec set (it owns
 *   `getPrecedingDocstring` + `generateNodeId`) — coincided with the
 *   decorative-banner docstring-strip fix (friction sweep 2026-05-16).
 */
export const EXTRACTION_LOGIC_VERSION = computeAlgoHash('src/extraction/extraction-logic-version.ts', [
  './extraction-logic-version',
  './tree-sitter',
  './tree-sitter-decls',
  './tree-sitter-typerefs',
  './tree-sitter-helpers',
  // The universal hand-extractor's `tsXxx` free functions were split
  // out of `tree-sitter.ts` (god-module split, 2026-05-17). Each new
  // file owns extraction LOGIC, so it must join the spec set or an
  // edit there would silently skip the re-extract heal.
  './ts-extract-declarations',
  './ts-extract-calls',
  './ts-extract-bodies',
  // F#82b (2026-05-29): the ObjC RN-bridge-macro pre-parse rewrite changes what
  // the grammar sees (and thus what's emitted) for `.m`/`.mm` files. It's wired
  // via `languages/objc.ts` (already hashed) but the rewrite LOGIC lives here, so
  // a body edit must flip this version to reach already-indexed projects.
  './objc-macro-rewrite',
  // Class-inheritance dispatch (extends/implements emission per
  // language). F#26 slice 3 (2026-05-26) reclassified Python's
  // Protocol/ABC/ABCMeta superclasses from `extends` to `implements`
  // — without this file in the hash, that fix wouldn't reach
  // already-indexed projects until source content changed.
  './tree-sitter-inheritance',
  // F#47 (2026-05-26): the Vue SFC extractor lives outside the
  // `languages/*.ts` registry-shape because Vue uses a `customExtractor`
  // (no tree-sitter-vue WASM). The bulk of the LOGIC sits in
  // `vue-extractor.ts`; the `languages/vue.ts` registry file is a 23-line
  // shim. Hashing the registry shim alone would miss the extractor's
  // real logic — include both. `svelte-extractor.ts` is the analogous
  // pre-existing gap; the reviewer flagged it during F#47 review,
  // adding alongside for consistency.
  './vue-extractor',
  './svelte-extractor',
  // The B2 schema-DSL recognizer pass runs inside extraction
  // (`tsParseAndWalk` → `runSchemaRecognizers`), so its source files
  // own extraction LOGIC: editing a recognizer must flip this version
  // and trigger the re-extract heal — there is no separate
  // `SCHEMA_RECOGNIZER_VERSION` constant.
  './schema-recognizers/index',
  './schema-recognizers/helpers',
  './schema-recognizers/zod',
  './schema-recognizers/pydantic',
  './schema-recognizers/types',
  // F#41 (2026-05-26): per-language extractor files own the per-
  // grammar `extractImport` / `isExported` / `isConst` / `visitNode` /
  // `returnField` / `extractBareCall` hooks. Editing one of these
  // changes what gets emitted for that language — without these in
  // the spec set, a fix like F#34 (Ruby constants in `ruby.ts`) or
  // F#40 (C return-type field in `c-cpp.ts`) wouldn't trip the heal,
  // and already-indexed projects would silently keep the old emit
  // set until source content changed. `registry.ts` is the dispatch
  // table — included for the same reason. `types.ts` and `index.ts`
  // are pure type/barrel modules and stay out (their edits ride
  // alongside a real extractor edit that DOES flip the hash).
  './languages/registry',
  './languages/apex',
  './languages/aura',
  './languages/bash',
  './languages/c-cpp',
  './languages/csharp',
  './languages/dart',
  './languages/elixir',
  './languages/fish',
  './languages/glsl',
  './languages/go',
  './languages/graphql',
  './languages/groovy',
  './languages/hcl',
  './languages/java',
  './languages/javascript',
  './languages/jsx',
  './languages/kotlin',
  './languages/liquid',
  './languages/lua',
  './languages/luau',
  './languages/objc',
  './languages/pascal',
  './languages/php',
  './languages/prisma',
  './languages/properties',
  './languages/python',
  './languages/r',
  './languages/rescript',
  './languages/ruby',
  './languages/rust',
  './languages/scala',
  './languages/sql',
  './languages/solidity',
  './languages/svelte',
  './languages/swift',
  './languages/tsx',
  './languages/typescript',
  './languages/visualforce',
  './languages/vue',
  './languages/xml',
  './languages/yaml',
  './languages/zsh',
]);

const STORAGE_KEY = 'extraction_logic_version';

/** Read the stored version. Returns the empty string when the key is
 *  absent (fresh project or pre-self-heal indexed project). The
 *  empty-string sentinel will never equal a real source hash, so it
 *  always trips {@link isExtractionLogicVersionStale}. */
export function getStoredExtractionLogicVersion(qb: QueryBuilder): string {
  return getMetadata(qb, STORAGE_KEY) ?? '';
}

/** Persist the current version. Call after the heal runs (or after a
 *  successful indexAll / sync that already sees every file). */
export function setStoredExtractionLogicVersion(qb: QueryBuilder, version: string): void {
  setMetadata(qb, STORAGE_KEY, String(version));
}

/** True when the stored version doesn't match the binary's current
 *  version. The heal must run on the next pass. Hashes are unordered
 *  strings (no notion of "older than"), so mismatch in either
 *  direction triggers the heal — which is strictly safer than the
 *  old `<` check (handles downgrades cleanly too). */
export function isExtractionLogicVersionStale(qb: QueryBuilder): boolean {
  return getStoredExtractionLogicVersion(qb) !== EXTRACTION_LOGIC_VERSION;
}

/**
 * Apply the self-heal: set `needs_reextract = 1` on every files row
 * AND wipe the parse_cache so the next pass re-parses + re-extracts
 * every file with the current logic. Persist the new version so the
 * heal runs at most once per bump. Idempotent — calling twice is a
 * no-op the second time.
 *
 * Why both writes matter:
 *   - Setting `files.needs_reextract = 1` forces sync to re-extract
 *     each file. The flag is preferred over zeroing `content_hash`
 *     because the latter corrupts the stale-artifact comparison
 *     basis (Phase 1 of the staleness redesign, friction F4).
 *   - Wiping `parse_cache` ensures the re-extraction doesn't pull a
 *     stale `ExtractionResult` from the cache. Without this, the
 *     re-extraction path consults the cache, gets back the OLD
 *     extractor's output, and inserts the same stale edges it would
 *     have written before. (parse_cache stores `ExtractionResult`,
 *     not just the AST.)
 *
 * The dual write makes a single `EXTRACTION_LOGIC_VERSION` bump
 * sufficient — contributors don't have to remember to also bump
 * `PAYLOAD_VERSION` in `queries-parse-cache.ts` for every extractor
 * change. (They still SHOULD bump PAYLOAD_VERSION when the cached
 * result SCHEMA changes, but for emit-set-only changes, the
 * EXTRACTION_LOGIC_VERSION bump alone closes the loop.)
 *
 * Call this at the top of `sync()` and `indexAll()` before the
 * orchestrator dispatches. Cheap when the version matches (single
 * metadata read); the writes only fire on a version mismatch.
 *
 * Returns `true` when the heal ran this call, `false` when the
 * stored version was already current.
 */
export function applyExtractionLogicVersionHeal(qb: QueryBuilder): boolean {
  if (!isExtractionLogicVersionStale(qb)) return false;
  // Flag every file as needing re-extract so sync re-extracts. We don't
  // touch nodes/edges/content_hash directly — the no-empty-window
  // invariant holds: each file's old graph survives until its
  // re-extraction overwrites it, and the real content_hash stays put
  // so stale-artifact queries don't spike to 100%.
  qb.db.prepare('UPDATE files SET needs_reextract = 1').run();
  qb.db.prepare('DELETE FROM parse_cache').run();
  setStoredExtractionLogicVersion(qb, EXTRACTION_LOGIC_VERSION);
  logDebug('extraction-logic-version heal applied — full re-extraction will run this pass', {
    newVersion: EXTRACTION_LOGIC_VERSION,
  });
  return true;
}
