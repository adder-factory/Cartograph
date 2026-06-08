import type { ExtractionResult } from './types.js';
import {
  createComponentExtractorRuntime,
  createFileComponentNode,
  extractTemplateCalls,
  extractTemplateComponents,
  mergeOffsetExtractionResult,
} from './component-extractor-helpers.js';
import { TreeSitterExtractor } from './tree-sitter.js';

const ASTRO_SKIP_TEMPLATE_CALLS = new Set(['if', 'else', 'for', 'await']);

interface AstroFrontmatter {
  content: string;
  startLineOffset: number;
}

function extractAstroFrontmatter(source: string): AstroFrontmatter | null {
  if (!source.startsWith('---')) return null;
  const newline = source.indexOf('\n');
  if (newline < 0) return null;
  const close = source.indexOf('\n---', newline + 1);
  if (close < 0) return null;
  return {
    content: source.slice(newline + 1, close),
    startLineOffset: 1,
  };
}

function findAstroTemplateExpressions(line: string): Array<{ expr: string; start: number }> {
  const expressions: Array<{ expr: string; start: number }> = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('{', cursor);
    if (open < 0) break;
    const close = line.indexOf('}', open + 1);
    if (close < 0) break;
    const raw = line.slice(open + 1, close);
    const leadingTrim = raw.length - raw.trimStart().length;
    const expr = raw.trim();
    if (expr.length > 0) expressions.push({ expr, start: open + 1 + leadingTrim });
    cursor = close + 1;
  }
  return expressions;
}

export class AstroExtractor {
  private readonly runtime: ReturnType<typeof createComponentExtractorRuntime>;

  constructor(filePath: string, source: string) {
    this.runtime = createComponentExtractorRuntime(filePath, source);
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    const component = createFileComponentNode({
      filePath: this.runtime.filePath,
      source: this.runtime.source,
      extension: '.astro',
      language: 'astro',
    });
    this.runtime.nodes.push(component);

    const frontmatter = extractAstroFrontmatter(this.runtime.source);
    if (frontmatter) {
      const result = new TreeSitterExtractor(this.runtime.filePath, frontmatter.content, 'typescript').extract();
      mergeOffsetExtractionResult({
        st: this.runtime.st,
        result,
        blockStart: frontmatter.startLineOffset,
        componentNodeId: component.id,
        language: 'astro',
      });
    }

    extractTemplateCalls({
      st: this.runtime.st,
      componentNodeId: component.id,
      templateExpressions: findAstroTemplateExpressions,
      language: 'astro',
      skipNames: ASTRO_SKIP_TEMPLATE_CALLS,
    });
    extractTemplateComponents({
      st: this.runtime.st,
      componentNodeId: component.id,
      language: 'astro',
    });

    return {
      nodes: this.runtime.nodes,
      edges: this.runtime.edges,
      unresolvedReferences: this.runtime.unresolvedReferences,
      errors: this.runtime.errors,
      durationMs: Date.now() - startTime,
    };
  }
}
