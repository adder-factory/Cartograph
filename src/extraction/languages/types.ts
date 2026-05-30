/**
 * Per-language registry types.
 *
 * Each language ships its own self-contained `LanguageDef` (file
 * extensions, default-config globs, grammar config, etc.) so that
 * adding a new language is a single-file addition rather than 6
 * coordinated edits across `types.ts`, `grammars.ts`, and the
 * `extraction/languages/index.ts` barrel. The registry
 * (`./registry`) auto-discovers definitions at module load.
 */

import type { LanguageExtractor } from '../tree-sitter-types.js';
import type { ExtractionResult } from '../../types.js';

/**
 * Custom extraction function for languages that don't fit the
 * universal tree-sitter AST shape (Liquid, Svelte, HCL, SQL,
 * Pascal DFM/FMX form files).
 */
type CustomExtractorFn = (filePath: string, source: string) => ExtractionResult;

interface GrammarBackedConfig {
  /**
   * Grammar `.wasm` filename (e.g. `typescript.wasm`, `c_sharp.wasm`).
   * Always resolved against `src/extraction/wasm/` — copied to
   * `dist/extraction/wasm/` at build time by `scripts/copy-assets.mjs`.
   * Loaded by `web-tree-sitter` in `src/extraction/grammars.ts`.
   * Pre-2026-05-17 this was a native npm-package name + optional
   * `.node` vendoring; the loader and packaging story changed when we
   * re-adopted web-tree-sitter to drop the native-binary distribution.
   */
  wasmFile: string;
  /**
   * Per-language tree-sitter extraction config consumed by
   * `TreeSitterExtractor`. The existing per-language objects
   * (e.g. `typescriptExtractor`) are passed in here unchanged.
   */
  extractor: LanguageExtractor;
}

export interface LanguageDef {
  /**
   * Canonical language name. Stored as the `language` value on
   * `Node`, `Edge`, and `FileRecord` rows. Should match an entry
   * in the `Language` union in `src/types.ts` for known
   * languages; new registry-only languages are accepted as
   * strings at runtime.
   */
  name: string;
  /** Human-readable display label (e.g. "HCL / Terraform"). */
  displayName: string;
  /**
   * File extensions, lower-cased, with leading dot. Each
   * extension uniquely maps to one language (caller should not
   * register the same extension twice).
   */
  extensions: readonly string[];
  /**
   * Default-config include glob patterns. Combined into
   * `DEFAULT_CONFIG.include` at registry load.
   */
  includeGlobs: readonly string[];
  /**
   * Tree-sitter grammar config. Absent for purely-custom
   * languages like Liquid (regex-based) and Svelte (script
   * delegation).
   */
  grammar?: GrammarBackedConfig;
  /**
   * Whole-language custom extractor. Used when `grammar` is
   * absent. If both are present, `extensionOverrides` and
   * `customExtractor` win over `grammar`.
   */
  customExtractor?: CustomExtractorFn;
  /**
   * Per-extension override. Used by Pascal where `.dfm`/`.fmx`
   * (form files) are extracted by `DfmExtractor` rather than the
   * tree-sitter Pascal grammar. Keys are lower-cased extensions
   * with the leading dot.
   */
  extensionOverrides?: Readonly<Record<string, { customExtractor: CustomExtractorFn }>>;
  /**
   * Optional grammar-only source rewrite applied to the file text
   * IMMEDIATELY before the tree-sitter parse (not used on the
   * `customExtractor` path). MUST be byte-for-byte length-preserving
   * so node offsets / line numbers stay exact — every downstream text
   * read uses the rewritten string. Used by ObjC to rewrite React
   * Native bridge macros (`RCT_EXPORT_METHOD` …) into parseable method
   * syntax the preprocessor-less grammar can't otherwise handle (F#82b).
   */
  preParseSourceTransform?: (source: string) => string;
}
