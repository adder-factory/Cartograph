import type { LanguageExtractor } from '../tree-sitter-types.js';

/**
 * Minimal extractor for grammar-backed languages whose immediate value is
 * file recognition, parse diagnostics, and future injection/query support.
 * It emits the file node through TreeSitterExtractor's parse driver but no
 * language-specific symbols.
 */
export const parserOnlyExtractor: LanguageExtractor = {
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
