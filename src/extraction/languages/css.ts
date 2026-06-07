import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const CSS_DEF: LanguageDef = {
  name: 'css',
  displayName: 'CSS',
  extensions: ['.css'],
  includeGlobs: ['**/*.css'],
  grammar: { wasmFile: 'css.wasm', extractor: parserOnlyExtractor },
};
