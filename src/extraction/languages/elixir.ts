import { TagsQueryExtractor } from '../tags-query-extractor.js';
import type { LanguageDef } from './types.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

/**
 * Elixir — the first language onboarded via the generic
 * `TagsQueryExtractor` (`src/extraction/tags-query-extractor.ts`)
 * instead of a hand-written extractor. cartograph runs the grammar's
 * stock `queries/tags.scm` (vendored at `src/extraction/tags/elixir.scm`)
 * to produce baseline symbol coverage — module / function / macro
 * definitions and `calls` references. It does NOT extract imports,
 * typed signatures, or cartograph's richer edges; a hand extractor is
 * the upgrade path if Elixir earns one.
 *
 * As with GraphQL, a skeleton `LanguageExtractor` is attached purely so
 * the framework's grammar registry loads `elixir.wasm`. It is never
 * dispatched — `customExtractor` wins in `extractFromSource`.
 *
 * Grammar: elixir-lang/tree-sitter-elixir — loaded as elixir.wasm by
 * web-tree-sitter from src/extraction/wasm/.
 */

const elixirExtractorSkeleton: LanguageExtractor = {
  functionTypes: [],
  classTypes: [],
  methodTypes: [],
  interfaceTypes: [],
  structTypes: [],
  enumTypes: [],
  typeAliasTypes: [],
  importTypes: [],
  callTypes: [],
  variableTypes: [],
  nameField: 'name',
  bodyField: '__unused__',
  paramsField: '__unused__',
};

export const ELIXIR_DEF: LanguageDef = {
  name: 'elixir',
  displayName: 'Elixir',
  extensions: ['.ex', '.exs'],
  includeGlobs: ['**/*.ex', '**/*.exs'],
  grammar: { wasmFile: 'elixir.wasm', extractor: elixirExtractorSkeleton },
  customExtractor: (filePath, source) => new TagsQueryExtractor(filePath, source, 'elixir').extract(),
};
