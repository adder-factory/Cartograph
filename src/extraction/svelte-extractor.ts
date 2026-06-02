import type { ExtractionResult } from '../types.js';
import {
  type ComponentExtractorConfig,
  type ComponentExtractorRuntime,
  type TemplateExpressionMatch,
  createComponentExtractorRuntime,
  extractComponentFile,
} from './component-extractor-helpers.js';

/** Svelte 5 rune names — compiler builtins, not real functions */
const SVELTE_RUNES = new Set(['$props', '$state', '$derived', '$effect', '$bindable', '$inspect', '$host', '$snippet']);

/** Template-expression call-site identifiers that shouldn't be tracked
 *  as function calls — Svelte block keywords parsed by the same regex
 *  as `cn(` / `buttonVariants(` / etc. */
const TEMPLATE_CALL_SKIP_KEYWORDS: ReadonlySet<string> = new Set(['if', 'else', 'each', 'await']);

function findSvelteTemplateExpressions(line: string): TemplateExpressionMatch[] {
  const expressions: TemplateExpressionMatch[] = [];
  let cursor = 0;
  while (cursor < line.length) {
    const open = line.indexOf('{', cursor);
    if (open < 0) break;
    const first = line.charAt(open + 1);
    if (first === '' || first === '}' || first === '#' || first === '/' || first === ':' || first === '@') {
      cursor = open + 1;
      continue;
    }
    const close = line.indexOf('}', open + 1);
    if (close < 0) break;
    expressions.push({ expr: line.slice(open + 1, close), start: open });
    cursor = close + 1;
  }
  return expressions;
}

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

// ---------------------------------------------------------------------------
// Class — thin orchestrator
// ---------------------------------------------------------------------------

const SVELTE_COMPONENT_CONFIG: ComponentExtractorConfig = {
  extractionName: 'Svelte',
  componentExtension: '.svelte',
  componentLanguage: 'svelte',
  templateExpressions: findSvelteTemplateExpressions,
  templateSkipNames: new Set([...SVELTE_RUNES, ...TEMPLATE_CALL_SKIP_KEYWORDS]),
  ignoredReferenceNames: SVELTE_RUNES,
};

export class SvelteExtractor {
  private readonly runtime: ComponentExtractorRuntime;

  constructor(filePath: string, source: string) {
    this.runtime = createComponentExtractorRuntime(filePath, source);
  }

  extract(): ExtractionResult {
    return extractComponentFile(this.runtime, SVELTE_COMPONENT_CONFIG);
  }
}
