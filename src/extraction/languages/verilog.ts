import { TagsQueryExtractor } from '../tags-query-extractor.js';
import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const VERILOG_DEF: LanguageDef = {
  name: 'verilog',
  displayName: 'Verilog / SystemVerilog',
  extensions: ['.v', '.vh', '.sv', '.svh'],
  includeGlobs: ['**/*.v', '**/*.vh', '**/*.sv', '**/*.svh'],
  grammar: { wasmFile: 'verilog.wasm', extractor: parserOnlyExtractor },
  customExtractor: (filePath, source) => new TagsQueryExtractor(filePath, source, 'verilog').extract(),
};
