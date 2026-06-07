import { TagsQueryExtractor } from '../tags-query-extractor.js';
import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const OCAML_INTERFACE_DEF: LanguageDef = {
  name: 'ocaml_interface',
  displayName: 'OCaml Interface',
  extensions: ['.mli'],
  includeGlobs: ['**/*.mli'],
  grammar: { wasmFile: 'ocaml_interface.wasm', extractor: parserOnlyExtractor },
  customExtractor: (filePath, source) => new TagsQueryExtractor(filePath, source, 'ocaml_interface').extract(),
};
