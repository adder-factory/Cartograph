/**
 * Vue SFC (.vue Single-File Component) extractor — F#47 (2026-05-26).
 *
 * .vue files are multi-block: `<script>` + `<template>` + `<style>`,
 * each with its own language. Rather than parsing the full Vue grammar
 * (no shipped tree-sitter-vue WASM), we extract the `<script>` block
 * and delegate it to the existing TS/JS TreeSitterExtractor. The
 * design mirrors {@link SvelteExtractor}; the differences are:
 *
 *   - Vue supports `<script setup>` (composition API) and bare
 *     `<script>` (options API). Both are extracted identically — the
 *     `setup` flag has no effect on extraction shape.
 *   - Vue interpolation uses `{{ expr }}` (mustache) instead of
 *     Svelte's `{ expr }`. The `{{` AND `}}` delimiters keep CSS
 *     `}` braces from being misread as expression closers.
 *   - Vue template directives (`v-on`, `@click`, `:class`) carry
 *     expressions inside HTML attributes. Capturing them is out of
 *     scope here — start with mustache + PascalCase tags (mirrors
 *     Svelte's coverage floor).
 *   - Vue 3's `<script setup>` syntax exposes compiler macros
 *     (`defineProps`, `defineEmits`, `defineExpose`, `defineOptions`,
 *     `defineModel`, `withDefaults`) that aren't real function imports
 *     — filtered from the calls stream so they don't leak as
 *     unresolved references.
 *
 * Every .vue file produces a `component` node — Vue components are
 * always importable (same convention as Svelte).
 */

import type { ExtractionResult } from '../types.js';
import {
  type ComponentExtractorConfig,
  type ComponentExtractorRuntime,
  type TemplateExpressionMatch,
  createComponentExtractorRuntime,
  extractComponentFile,
} from './component-extractor-helpers.js';

/**
 * Vue 3 `<script setup>` compiler macros — not real functions, so a
 * `defineProps<T>()` / `defineEmits([...])` call shouldn't surface as
 * an unresolved `calls` reference. Mirrors the Svelte rune filter.
 */
const VUE_COMPILER_MACROS: ReadonlySet<string> = new Set([
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineModel',
  'defineSlots',
  'withDefaults',
]);

/**
 * Template-expression call-site identifiers that shouldn't be tracked
 * as function calls — Vue control-flow directives parsed by the same
 * regex as `fmt(...)`. Vue templates use `v-if`, `v-else`, `v-for`
 * as directive attribute names rather than expression keywords, so
 * the surface area is smaller than Svelte's — but `if`/`else`/`for`
 * can still appear inside expression bodies (`{{ x ?? 'fallback' }}`
 * — no risk here, but defensive).
 */
const TEMPLATE_CALL_SKIP_KEYWORDS: ReadonlySet<string> = new Set(['if', 'else', 'for']);

function findVueTemplateExpressions(line: string): TemplateExpressionMatch[] {
  const expressions: TemplateExpressionMatch[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('{{', cursor);
    if (open < 0) break;
    const close = line.indexOf('}}', open + 2);
    if (close < 0) break;
    const raw = line.slice(open + 2, close);
    const leadingTrim = raw.length - raw.trimStart().length;
    const expr = raw.trim();
    if (expr.length > 0 && !expr.startsWith('#') && !expr.startsWith('/')) {
      expressions.push({ expr, start: open + 2 + leadingTrim });
    }
    cursor = close + 2;
  }
  return expressions;
}

const VUE_COMPONENT_CONFIG: ComponentExtractorConfig = {
  extractionName: 'Vue',
  componentExtension: '.vue',
  componentLanguage: 'vue',
  templateExpressions: findVueTemplateExpressions,
  templateSkipNames: new Set([...VUE_COMPILER_MACROS, ...TEMPLATE_CALL_SKIP_KEYWORDS]),
  ignoredReferenceNames: VUE_COMPILER_MACROS,
};

export class VueExtractor {
  private readonly runtime: ComponentExtractorRuntime;

  constructor(filePath: string, source: string) {
    this.runtime = createComponentExtractorRuntime(filePath, source);
  }

  extract(): ExtractionResult {
    return extractComponentFile(this.runtime, VUE_COMPONENT_CONFIG);
  }
}
