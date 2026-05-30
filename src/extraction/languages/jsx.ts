/**
 * JSX — reuses the JavaScript extractor (the JS grammar handles JSX
 * via the same `tree-sitter-javascript` grammar).
 */
import { javascriptExtractor } from './javascript.js';
import type { LanguageDef } from './types.js';

export const JSX_DEF: LanguageDef = {
  name: 'jsx',
  displayName: 'JSX',
  extensions: ['.jsx'],
  includeGlobs: ['**/*.jsx'],
  grammar: { wasmFile: 'javascript.wasm', extractor: javascriptExtractor },
};
