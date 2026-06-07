import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const HTML_DEF: LanguageDef = {
  name: 'html',
  displayName: 'HTML',
  extensions: ['.html', '.htm'],
  includeGlobs: ['**/*.html', '**/*.htm'],
  grammar: { wasmFile: 'html.wasm', extractor: parserOnlyExtractor },
};
