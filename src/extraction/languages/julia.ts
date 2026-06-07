import { TagsQueryExtractor } from '../tags-query-extractor.js';
import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const JULIA_DEF: LanguageDef = {
  name: 'julia',
  displayName: 'Julia',
  extensions: ['.jl'],
  includeGlobs: ['**/*.jl'],
  grammar: { wasmFile: 'julia.wasm', extractor: parserOnlyExtractor },
  customExtractor: (filePath, source) => new TagsQueryExtractor(filePath, source, 'julia').extract(),
};
