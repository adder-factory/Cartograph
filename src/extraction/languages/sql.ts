/**
 * SQL — custom extractor that runs over the tree-sitter-sql
 * grammar to extract DDL (CREATE TABLE / VIEW / INDEX). The query
 * grammar is too dialect-specific to use the universal extractor;
 * SqlExtractor handles it directly.
 */
import { SqlExtractor } from '../sql-extractor.js';
import type { LanguageDef } from './types.js';

export const SQL_DEF: LanguageDef = {
  name: 'sql',
  displayName: 'SQL',
  extensions: ['.sql', '.ddl', '.dml'],
  includeGlobs: ['**/*.sql', '**/*.ddl', '**/*.dml'],
  grammar: {
    wasmFile: 'sql.wasm',
    extractor: {
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
      bodyField: 'body',
      paramsField: 'parameters',
    },
  },
  customExtractor: (filePath, source) => new SqlExtractor(filePath, source).extract(),
};
