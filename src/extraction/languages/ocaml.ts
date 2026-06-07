import { TagsQueryExtractor } from '../tags-query-extractor.js';
import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const OCAML_DEF: LanguageDef = {
  name: 'ocaml',
  displayName: 'OCaml',
  extensions: ['.ml'],
  includeGlobs: ['**/*.ml'],
  grammar: { wasmFile: 'ocaml.wasm', extractor: parserOnlyExtractor },
  customExtractor: (filePath, source) => new TagsQueryExtractor(filePath, source, 'ocaml').extract(),
};
