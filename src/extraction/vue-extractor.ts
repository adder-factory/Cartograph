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

import type { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types.js';
import { generateNodeId } from './tree-sitter-helpers.js';
import { TreeSitterExtractor } from './tree-sitter.js';
import { isLanguageSupported } from './grammars.js';
import { errMsg } from '../errors.js';

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

interface VueState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
}

interface VueMergeOffsetArgs {
  st: VueState;
  result: ExtractionResult;
  blockStart: number;
  componentNodeId: string;
}

/**
 * Translate a TreeSitterExtractor `ExtractionResult` from script-
 * block-local positions into .vue-file positions and merge it
 * into the extractor's accumulators. Mirrors the Svelte helper
 * one-for-one — every TreeSitterExtractor consumer of a sub-region
 * needs this offset pass.
 */
function vueMergeOffsetExtractionResult(args: VueMergeOffsetArgs): void {
  const { st, result, blockStart, componentNodeId } = args;
  for (const node of result.nodes) {
    node.startLine += blockStart;
    node.endLine += blockStart;
    node.language = 'vue';
    st.nodes.push(node);
    st.edges.push({ source: componentNodeId, target: node.id, kind: 'contains' });
  }
  for (const edge of result.edges) {
    if (edge.line) edge.line += blockStart;
    st.edges.push(edge);
  }
  for (const ref of result.unresolvedReferences) {
    ref.line += blockStart;
    ref.filePath = st.filePath;
    ref.language = 'vue';
    st.unresolvedReferences.push(ref);
  }
  for (const error of result.errors) {
    if (error.line) error.line += blockStart;
    st.errors.push(error);
  }
}

/**
 * Record `name(` call patterns inside a Vue mustache expression body.
 * Skips Vue compiler macros and JS keywords.
 */
function vueRecordTemplateCallsInExpression(
  st: VueState,
  args: {
    componentNodeId: string;
    expr: string;
    exprStart: number;
    lineIdx: number;
  },
): void {
  const { componentNodeId, expr, exprStart, lineIdx } = args;
  const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = callRegex.exec(expr)) !== null) {
    const calleeName = callMatch[1]!;
    if (VUE_COMPILER_MACROS.has(calleeName)) continue;
    if (TEMPLATE_CALL_SKIP_KEYWORDS.has(calleeName)) continue;
    st.unresolvedReferences.push({
      fromNodeId: componentNodeId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: lineIdx + 1,
      column: exprStart + callMatch.index,
      filePath: st.filePath,
      language: 'vue',
    });
  }
}

export class VueExtractor {
  private filePath: string;
  private source: string;
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private unresolvedReferences: UnresolvedReference[] = [];
  private errors: ExtractionError[] = [];

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      const componentNode = this.createComponentNode();
      const scriptBlocks = this.extractScriptBlocks();
      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }
      this.extractTemplateCalls(componentNode.id);
      this.extractTemplateComponents(componentNode.id);

      this.unresolvedReferences = this.unresolvedReferences.filter(
        (ref) => !VUE_COMPILER_MACROS.has(ref.referenceName),
      );
    } catch (error) {
      this.errors.push({
        message: `Vue extraction error: ${errMsg(error)}`,
        severity: 'error',
        code: 'parse_error',
      });
    }

    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Create a component node for the .vue file. Vue components default
   * to importable (same as Svelte). The component name is derived from
   * the file basename minus the .vue extension.
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.vue$/, '');
    const id = generateNodeId({ filePath: this.filePath, kind: 'component', name: componentName, ordinal: 0 });

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'vue',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true,
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * Extract `<script>` and `<script setup>` blocks from .vue source.
   * Both shapes are recognized; the `setup` flag is preserved for
   * documentation/debugging only — extraction is the same for both.
   *
   * `lang="ts"` / `lang="typescript"` routes the block through the
   * TypeScript grammar; otherwise JavaScript. The same line-offset
   * dance as Svelte: the regex captures the leading newline after
   * `>`, so the offset is the line where the opening `<script ...>`
   * tag ends (0-indexed) — adding it to the inner extractor's
   * 1-indexed lines yields correct file-relative positions.
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isSetup: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isSetup: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.['content'] || match[2] || '';

      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);
      // `setup` may be a bare attribute (`<script setup>`) or an
      // explicit-value attribute (`<script setup="true">`). The bare
      // form is by far the common case; we accept either shape. The
      // trailing `$` covers `<script lang="ts" setup>` where `setup`
      // is the last token in the attrs string (R1 reviewer-caught).
      const isSetup = /\bsetup(\s|=|>|$)/.test(attrs);

      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines;

      blocks.push({
        content,
        startLine: contentStartLine,
        isSetup,
        isTypeScript,
      });
    }

    return blocks;
  }

  private processScriptBlock(
    block: { content: string; startLine: number; isSetup: boolean; isTypeScript: boolean },
    componentNodeId: string,
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Vue script block`,
        severity: 'warning',
      });
      return;
    }

    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    vueMergeOffsetExtractionResult({
      st: this.state(),
      result: extractor.extract(),
      blockStart: block.startLine,
      componentNodeId,
    });
  }

  /**
   * Extract function calls from Vue `{{ expression }}` mustache blocks.
   * Vue templates carry many calls in markup (`{{ format(date) }}`,
   * `{{ items.map(toLabel) }}`) — without this pass those edges are
   * invisible and downstream tools see false-positive dead code.
   *
   * Uses `{{ ... }}` (double-brace) delimiters; the closing `}}` is
   * required so a single CSS `}` doesn't terminate a Vue expression.
   * Covered ranges (script / style blocks) are skipped because their
   * own grammars own those bytes.
   */
  private extractTemplateCalls(componentNodeId: string): void {
    const st = this.state();
    const coveredRanges: Array<[number, number]> = [];

    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    // `{{ expr }}` — non-greedy to handle multiple interpolations on
    // one line. The negative-look first char keeps Vue 3 block
    // comments like `{{/* … */}}` from being captured as expressions.
    const exprRegex = /\{\{\s*([^{}#/][^{}]*?)\s*\}\}/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let exprMatch: RegExpExecArray | null;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        vueRecordTemplateCallsInExpression(st, {
          componentNodeId,
          expr: exprMatch[1]!,
          exprStart: exprMatch.index,
          lineIdx,
        });
      }
    }
  }

  /**
   * Extract component usages from Vue templates: PascalCase tags like
   * `<Modal />`, `<UserCard :user="u" />` are component references —
   * analogous to function calls in imperative code. Vue ALSO supports
   * kebab-case (`<user-card />`) but distinguishing kebab-case from
   * regular HTML elements requires the registered component list,
   * which we don't have. PascalCase-only is the safe convention; the
   * vast majority of Vue 3 + TS codebases use PascalCase for
   * authored components per the style guide.
   */
  private extractTemplateComponents(componentNodeId: string): void {
    const coveredRanges: Array<[number, number]> = [];
    const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
    let tagMatch: RegExpExecArray | null;
    while ((tagMatch = tagRegex.exec(this.source)) !== null) {
      const startLine = (this.source.substring(0, tagMatch.index).match(/\n/g) || []).length;
      const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
      coveredRanges.push([startLine, endLine]);
    }

    const lines = this.source.split('\n');
    const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let match: RegExpExecArray | null;
      while ((match = componentTagRegex.exec(line)) !== null) {
        const componentName = match[1]!;

        this.unresolvedReferences.push({
          fromNodeId: componentNodeId,
          referenceName: componentName,
          referenceKind: 'references',
          line: lineIdx + 1,
          column: match.index + 1,
          filePath: this.filePath,
          language: 'vue',
        });
      }
    }
  }

  private state(): VueState {
    return {
      filePath: this.filePath,
      source: this.source,
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: this.unresolvedReferences,
      errors: this.errors,
    };
  }
}
