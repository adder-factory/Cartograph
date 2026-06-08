import type { LanguageDef } from './types.js';
import { parserOnlyExtractor } from './parser-only.js';

export const JUPYTER_DEF: LanguageDef = {
  name: 'jupyter',
  displayName: 'Jupyter Notebook',
  extensions: ['.ipynb'],
  includeGlobs: ['**/*.ipynb'],
  grammar: { wasmFile: 'json.wasm', extractor: parserOnlyExtractor },
};
