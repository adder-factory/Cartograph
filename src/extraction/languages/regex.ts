import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const REGEX_DEF: LanguageDef = {
  name: 'regex',
  displayName: 'Regex',
  extensions: ['.regex', '.regexp'],
  includeGlobs: ['**/*.regex', '**/*.regexp'],
  grammar: { wasmFile: 'regex.wasm', extractor: parserOnlyExtractor },
};
