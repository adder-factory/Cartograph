import { TagsQueryExtractor } from '../tags-query-extractor.js';
import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const HASKELL_DEF: LanguageDef = {
  name: 'haskell',
  displayName: 'Haskell',
  extensions: ['.hs'],
  includeGlobs: ['**/*.hs'],
  grammar: { wasmFile: 'haskell.wasm', extractor: parserOnlyExtractor },
  customExtractor: (filePath, source) => new TagsQueryExtractor(filePath, source, 'haskell').extract(),
};
