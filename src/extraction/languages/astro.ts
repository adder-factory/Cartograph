import { AstroExtractor } from '../astro-extractor.js';
import { parserOnlyExtractor } from './parser-only.js';
import type { LanguageDef } from './types.js';

export const ASTRO_DEF: LanguageDef = {
  name: 'astro',
  displayName: 'Astro',
  extensions: ['.astro'],
  includeGlobs: ['**/*.astro'],
  grammar: { wasmFile: 'astro.wasm', extractor: parserOnlyExtractor },
  customExtractor: (filePath, source) => new AstroExtractor(filePath, source).extract(),
};
