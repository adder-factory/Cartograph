import { GraphqlExtractor } from '../graphql-extractor.js';
import type { LanguageDef } from './types.js';
import type { LanguageExtractor } from '../tree-sitter-types.js';

/**
 * GraphQL is declarative SDL — no functions/methods to extract through the
 * universal `LanguageExtractor` dispatcher. We register a `customExtractor`
 * (Path B in `docs/ADDING-A-LANGUAGE.md`), but still attach a skeleton
 * `LanguageExtractor` so the grammar is loaded by the framework's grammar
 * registry. The skeleton is never dispatched — `customExtractor` wins.
 *
 * Grammar: joowani/tree-sitter-graphql v0.1.0 (default branch as of
 * 2026-02), MIT — loaded as graphql.wasm by web-tree-sitter from
 * src/extraction/wasm/.
 */

const graphqlExtractorSkeleton: LanguageExtractor = {
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

export const GRAPHQL_DEF: LanguageDef = {
  name: 'graphql',
  displayName: 'GraphQL',
  extensions: ['.graphql', '.gql'],
  includeGlobs: ['**/*.graphql', '**/*.gql'],
  grammar: { wasmFile: 'graphql.wasm', extractor: graphqlExtractorSkeleton },
  customExtractor: (filePath, source) => new GraphqlExtractor(filePath, source).extract(),
};
