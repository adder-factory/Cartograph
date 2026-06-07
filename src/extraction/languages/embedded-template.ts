import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const EMBEDDED_TEMPLATE_DEF: LanguageDef = {
  name: 'embedded_template',
  displayName: 'ERB / EJS',
  extensions: ['.erb', '.ejs', '.eta', '.etlua'],
  includeGlobs: ['**/*.erb', '**/*.ejs', '**/*.eta', '**/*.etlua'],
  grammar: { wasmFile: 'embedded_template.wasm', extractor: parserOnlyExtractor },
};
