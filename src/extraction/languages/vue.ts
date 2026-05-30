/**
 * Vue SFC (.vue Single-File Component) — F#47 (2026-05-26). Uses a
 * whole-language custom extractor that strips template/style blocks
 * and delegates the `<script>` content to the TS or JS tree-sitter
 * grammar. Mirrors the Svelte LangDef shape; the script-language
 * routing (`lang="ts"` → typescript, default → javascript) lives in
 * the extractor.
 *
 * No tree-sitter-vue WASM is loaded — the file lookup table never
 * needs to find a grammar for the `vue` language because
 * `customExtractor` short-circuits before the tree-sitter path.
 */

import { VueExtractor } from '../vue-extractor.js';
import type { LanguageDef } from './types.js';

export const VUE_DEF: LanguageDef = {
  name: 'vue',
  displayName: 'Vue',
  extensions: ['.vue'],
  includeGlobs: ['**/*.vue'],
  customExtractor: (filePath, source) => new VueExtractor(filePath, source).extract(),
};
