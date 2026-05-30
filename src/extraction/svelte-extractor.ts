import type { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types.js';
import { generateNodeId } from './tree-sitter-helpers.js';
// Component nodes are always one-per-file; an ordinal-0 generateNodeId
// is sufficient — no factory needed.
import { TreeSitterExtractor } from './tree-sitter.js';
import { isLanguageSupported } from './grammars.js';
import { errMsg } from '../errors.js';

/** Svelte 5 rune names — compiler builtins, not real functions */
const SVELTE_RUNES = new Set(['$props', '$state', '$derived', '$effect', '$bindable', '$inspect', '$host', '$snippet']);

/** Template-expression call-site identifiers that shouldn't be tracked
 *  as function calls — Svelte block keywords parsed by the same regex
 *  as `cn(` / `buttonVariants(` / etc. */
const TEMPLATE_CALL_SKIP_KEYWORDS: ReadonlySet<string> = new Set(['if', 'else', 'each', 'await']);

/**
 * SvelteExtractor - Extracts code relationships from Svelte component files
 *
 * Svelte files are multi-language (script + template + style). Rather than
 * parsing the full Svelte grammar, we extract the <script> block content
 * and delegate it to the TypeScript/JavaScript TreeSitterExtractor.
 *
 * Also extracts function calls from template expressions (`{fn(...)}`) so
 * cross-file call edges are captured even when calls live in markup.
 *
 * Every .svelte file produces a component node (Svelte components are always importable).
 */

// ---------------------------------------------------------------------------
// Module-level state type
// ---------------------------------------------------------------------------

interface SvelteState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
}

// ---------------------------------------------------------------------------
// Free-function helpers
// ---------------------------------------------------------------------------

/**
 * Translate a TreeSitterExtractor `ExtractionResult` from script-
 * block-local positions into .svelte-file positions and merge it
 * into the extractor's accumulators.
 */
interface SvelteMergeOffsetArgs {
  st: SvelteState;
  result: ExtractionResult;
  blockStart: number;
  componentNodeId: string;
}

function sveltemergeOffsetExtractionResult(args: SvelteMergeOffsetArgs): void {
  const { st, result, blockStart, componentNodeId } = args;
  for (const node of result.nodes) {
    node.startLine += blockStart;
    node.endLine += blockStart;
    node.language = 'svelte'; // Mark as svelte, not TS/JS
    st.nodes.push(node);
    // Add containment edge from component to this node
    st.edges.push({ source: componentNodeId, target: node.id, kind: 'contains' });
  }
  for (const edge of result.edges) {
    if (edge.line) edge.line += blockStart;
    st.edges.push(edge);
  }
  for (const ref of result.unresolvedReferences) {
    ref.line += blockStart;
    ref.filePath = st.filePath;
    ref.language = 'svelte';
    st.unresolvedReferences.push(ref);
  }
  for (const error of result.errors) {
    if (error.line) error.line += blockStart;
    st.errors.push(error);
  }
}

/** Walk one Svelte template expression body for `name(` call
 *  patterns and push an unresolved `calls` ref per match. Skips
 *  Svelte runes and control-flow keywords. Pulled out of
 *  {@link SvelteExtractor.extractTemplateCalls} so the outer line-loop's
 *  expression-loop doesn't sit 4-deep when it walks the inner
 *  call-pattern matches. */
function svelteRecordTemplateCallsInExpression(
  st: SvelteState,
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
    if (SVELTE_RUNES.has(calleeName)) continue;
    if (TEMPLATE_CALL_SKIP_KEYWORDS.has(calleeName)) continue;
    st.unresolvedReferences.push({
      fromNodeId: componentNodeId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: lineIdx + 1,
      column: exprStart + callMatch.index,
      filePath: st.filePath,
      language: 'svelte',
    });
  }
}

// ---------------------------------------------------------------------------
// Class — thin orchestrator
// ---------------------------------------------------------------------------

export class SvelteExtractor {
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

  /**
   * Extract from Svelte source
   */
  extract(): ExtractionResult {
    const startTime = Date.now();

    try {
      // Create component node for the .svelte file itself
      const componentNode = this.createComponentNode();

      // Extract and process script blocks
      const scriptBlocks = this.extractScriptBlocks();

      for (const block of scriptBlocks) {
        this.processScriptBlock(block, componentNode.id);
      }

      // Extract function calls from template expressions ({fn(...)})
      this.extractTemplateCalls(componentNode.id, scriptBlocks);

      // Extract component usages from template (<ComponentName>)
      this.extractTemplateComponents(componentNode.id);

      // Filter out Svelte rune calls ($state, $props, $derived, etc.)
      this.unresolvedReferences = this.unresolvedReferences.filter((ref) => !SVELTE_RUNES.has(ref.referenceName));
    } catch (error) {
      this.errors.push({
        message: `Svelte extraction error: ${errMsg(error)}`,
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
   * Create a component node for the .svelte file
   */
  private createComponentNode(): Node {
    const lines = this.source.split('\n');
    const fileName = this.filePath.split(/[/\\]/).pop() || this.filePath;
    const componentName = fileName.replace(/\.svelte$/, '');
    const id = generateNodeId({ filePath: this.filePath, kind: 'component', name: componentName, ordinal: 0 });

    const node: Node = {
      id,
      kind: 'component',
      name: componentName,
      qualifiedName: `${this.filePath}::${componentName}`,
      filePath: this.filePath,
      language: 'svelte',
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines[lines.length - 1]?.length || 0,
      isExported: true, // Svelte components are always importable
      updatedAt: Date.now(),
    };

    this.nodes.push(node);
    return node;
  }

  /**
   * Extract <script> blocks from the Svelte source
   */
  private extractScriptBlocks(): Array<{
    content: string;
    startLine: number;
    isModule: boolean;
    isTypeScript: boolean;
  }> {
    const blocks: Array<{
      content: string;
      startLine: number;
      isModule: boolean;
      isTypeScript: boolean;
    }> = [];

    const scriptRegex = /<script(\s[^>]*)?>(?<content>[\s\S]*?)<\/script>/g;
    let match: RegExpExecArray | null;

    while ((match = scriptRegex.exec(this.source)) !== null) {
      const attrs = match[1] || '';
      const content = match.groups?.['content'] || match[2] || '';

      const isTypeScript = /lang\s*=\s*["'](ts|typescript)["']/.test(attrs);
      const isModule = /context\s*=\s*["']module["']/.test(attrs);

      // The content captured by the regex includes the leading newline that
      // follows `>`, so the inner extractor sees that newline as line 1 of
      // its (1-indexed) input and the first real code on line 2. Offset is
      // therefore the line number where the opening `<script ...>` tag ends
      // (0-indexed) — adding it to the inner extractor's 1-indexed lines
      // yields correct 1-indexed positions in the .svelte file.
      const beforeScript = this.source.substring(0, match.index);
      const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
      const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
      const openingTagLines = (openingTag.match(/\n/g) || []).length;
      const contentStartLine = scriptTagLine + openingTagLines;

      blocks.push({
        content,
        startLine: contentStartLine,
        isModule,
        isTypeScript,
      });
    }

    return blocks;
  }

  /**
   * Process a script block by delegating to TreeSitterExtractor
   */
  private processScriptBlock(
    block: { content: string; startLine: number; isModule: boolean; isTypeScript: boolean },
    componentNodeId: string,
  ): void {
    const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

    if (!isLanguageSupported(scriptLanguage)) {
      this.errors.push({
        message: `Parser for ${scriptLanguage} not available, cannot parse Svelte script block`,
        severity: 'warning',
      });
      return;
    }

    const extractor = new TreeSitterExtractor(this.filePath, block.content, scriptLanguage);
    sveltemergeOffsetExtractionResult({
      st: this.state(),
      result: extractor.extract(),
      blockStart: block.startLine,
      componentNodeId,
    });
  }

  /**
   * Extract function calls from Svelte template expressions.
   *
   * In Svelte, many function calls happen in markup (e.g., `class={cn(...)}`),
   * not inside `<script>` blocks. We scan the template portion for `{expression}`
   * blocks and extract call patterns from them.
   */
  private extractTemplateCalls(
    componentNodeId: string,
    _scriptBlocks: Array<{ content: string; startLine: number }>,
  ): void {
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
    const exprRegex = /\{([^}#/:@][^}]*)\}/g;

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
      if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;

      const line = lines[lineIdx]!;
      let exprMatch: RegExpExecArray | null;
      while ((exprMatch = exprRegex.exec(line)) !== null) {
        svelteRecordTemplateCallsInExpression(st, {
          componentNodeId,
          expr: exprMatch[1]!,
          exprStart: exprMatch.index,
          lineIdx,
        });
      }
    }
  }

  /**
   * Extract component usages from the Svelte template.
   *
   * PascalCase tags like <Modal>, <Button />, <DevServerPreview> represent
   * component instantiations — analogous to function calls in imperative code.
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
          line: lineIdx + 1, // 1-indexed
          column: match.index + 1,
          filePath: this.filePath,
          language: 'svelte',
        });
      }
    }
  }

  /** Expose mutable state to module-scope free functions. */
  private state(): SvelteState {
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
