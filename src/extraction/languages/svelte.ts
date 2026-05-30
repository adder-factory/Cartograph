/**
 * Svelte — custom extractor that delegates the script block back
 * through the universal extraction pipeline as TypeScript/JavaScript,
 * then merges in template-level call references.
 */
import { SvelteExtractor } from '../svelte-extractor.js';
import type { LanguageDef } from './types.js';

export const SVELTE_DEF: LanguageDef = {
  name: 'svelte',
  displayName: 'Svelte',
  extensions: ['.svelte'],
  includeGlobs: ['**/*.svelte'],
  customExtractor: (filePath, source) => new SvelteExtractor(filePath, source).extract(),
};
