/**
 * TSX (TypeScript + JSX) — reuses the TypeScript extractor with a
 * dedicated grammar so JSX-specific node types parse correctly.
 */
import { typescriptExtractor } from './typescript.js';
import type { LanguageDef } from './types.js';

export const TSX_DEF: LanguageDef = {
  name: 'tsx',
  displayName: 'TSX',
  extensions: ['.tsx'],
  includeGlobs: ['**/*.tsx'],
  grammar: { wasmFile: 'tsx.wasm', extractor: typescriptExtractor },
};
