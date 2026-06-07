import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const JSDOC_DEF: LanguageDef = {
  name: 'jsdoc',
  displayName: 'JSDoc',
  extensions: ['.jsdoc'],
  includeGlobs: ['**/*.jsdoc'],
  grammar: { wasmFile: 'jsdoc.wasm', extractor: parserOnlyExtractor },
};
