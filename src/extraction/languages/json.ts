import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const JSON_DEF: LanguageDef = {
  name: 'json',
  displayName: 'JSON',
  extensions: ['.json'],
  includeGlobs: ['**/*.json'],
  grammar: { wasmFile: 'json.wasm', extractor: parserOnlyExtractor },
};
