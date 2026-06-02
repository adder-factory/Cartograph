import type { Edge, ExtractionError, ExtractionResult, Language, Node, UnresolvedReference } from '../types.js';
import { errMsg } from '../errors.js';
import { isLanguageSupported } from './grammars.js';
import { TreeSitterExtractor } from './tree-sitter.js';
import { generateNodeId } from './tree-sitter-helpers.js';

export interface ComponentExtractorState {
  filePath: string;
  source: string;
  nodes: Node[];
  edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  errors: ExtractionError[];
}

export interface ComponentExtractorRuntime {
  readonly filePath: string;
  readonly source: string;
  readonly nodes: Node[];
  readonly edges: Edge[];
  unresolvedReferences: UnresolvedReference[];
  readonly errors: ExtractionError[];
  readonly st: ComponentExtractorState;
}

export interface ComponentExtractorConfig {
  readonly extractionName: string;
  readonly componentExtension: string;
  readonly componentLanguage: Language;
  readonly templateExpressionRegex: RegExp;
  readonly templateSkipNames: ReadonlySet<string>;
  readonly ignoredReferenceNames: ReadonlySet<string>;
}

export function createComponentExtractorRuntime(filePath: string, source: string): ComponentExtractorRuntime {
  const nodes: Node[] = [];
  const edges: Edge[] = [];
  const unresolvedReferences: UnresolvedReference[] = [];
  const errors: ExtractionError[] = [];
  return {
    filePath,
    source,
    nodes,
    edges,
    unresolvedReferences,
    errors,
    st: { filePath, source, nodes, edges, unresolvedReferences, errors },
  };
}

export function extractComponentFile(runtime: ComponentExtractorRuntime, config: ComponentExtractorConfig): ExtractionResult {
  const startTime = Date.now();

  try {
    const componentNode = createExtractorComponentNode(runtime, config);
    const scriptBlocks = extractComponentScriptBlocks(runtime.source);

    for (const block of scriptBlocks) {
      processComponentScriptBlock({ runtime, config, block, componentNodeId: componentNode.id });
    }

    extractComponentTemplateCalls({ runtime, config, componentNodeId: componentNode.id });
    extractComponentTemplateComponents({ runtime, config, componentNodeId: componentNode.id });
    runtime.unresolvedReferences = runtime.unresolvedReferences.filter(
      (ref) => !config.ignoredReferenceNames.has(ref.referenceName),
    );
    runtime.st.unresolvedReferences = runtime.unresolvedReferences;
  } catch (error) {
    runtime.errors.push({
      message: `${config.extractionName} extraction error: ${errMsg(error)}`,
      severity: 'error',
      code: 'parse_error',
    });
  }

  return {
    nodes: runtime.nodes,
    edges: runtime.edges,
    unresolvedReferences: runtime.unresolvedReferences,
    errors: runtime.errors,
    durationMs: Date.now() - startTime,
  };
}

function createExtractorComponentNode(runtime: ComponentExtractorRuntime, config: ComponentExtractorConfig): Node {
  const node = createFileComponentNode({
    filePath: runtime.filePath,
    source: runtime.source,
    extension: config.componentExtension,
    language: config.componentLanguage,
  });
  runtime.nodes.push(node);
  return node;
}

function processComponentScriptBlock(args: {
  runtime: ComponentExtractorRuntime;
  config: ComponentExtractorConfig;
  block: ScriptBlock;
  componentNodeId: string;
}): void {
  const { runtime, config, block, componentNodeId } = args;
  const scriptLanguage: Language = block.isTypeScript ? 'typescript' : 'javascript';

  if (!isLanguageSupported(scriptLanguage)) {
    runtime.errors.push({
      message: `Parser for ${scriptLanguage} not available, cannot parse ${config.extractionName} script block`,
      severity: 'warning',
    });
    return;
  }

  const scriptExtractor = new TreeSitterExtractor(runtime.filePath, block.content, scriptLanguage);
  mergeOffsetExtractionResult({
    st: runtime.st,
    result: scriptExtractor.extract(),
    blockStart: block.startLine,
    componentNodeId,
    language: config.componentLanguage,
  });
}

function extractComponentTemplateCalls(args: {
  runtime: ComponentExtractorRuntime;
  config: ComponentExtractorConfig;
  componentNodeId: string;
}): void {
  extractTemplateCalls({
    st: args.runtime.st,
    componentNodeId: args.componentNodeId,
    expressionRegex: args.config.templateExpressionRegex,
    language: args.config.componentLanguage,
    skipNames: args.config.templateSkipNames,
  });
}

function extractComponentTemplateComponents(args: {
  runtime: ComponentExtractorRuntime;
  config: ComponentExtractorConfig;
  componentNodeId: string;
}): void {
  extractTemplateComponents({
    st: args.runtime.st,
    componentNodeId: args.componentNodeId,
    language: args.config.componentLanguage,
  });
}

export interface ScriptBlock {
  content: string;
  startLine: number;
  attrs: string;
  isTypeScript: boolean;
}

export function createFileComponentNode(args: {
  filePath: string;
  source: string;
  extension: string;
  language: Language;
}): Node {
  const { filePath, source, extension, language } = args;
  const lines = source.split('\n');
  const fileName = filePath.split(/[/\\]/).pop() || filePath;
  const componentName = fileName.endsWith(extension) ? fileName.slice(0, -extension.length) : fileName;
  return {
    id: generateNodeId({ filePath, kind: 'component', name: componentName, ordinal: 0 }),
    kind: 'component',
    name: componentName,
    qualifiedName: `${filePath}::${componentName}`,
    filePath,
    language,
    startLine: 1,
    endLine: lines.length,
    startColumn: 0,
    endColumn: lines.at(-1)?.length || 0,
    isExported: true,
    updatedAt: Date.now(),
  };
}

export function extractComponentScriptBlocks(source: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const scriptRegex = /<script(\s[^>]*)?>([\s\S]*?)<\/script>/g;
  let match: RegExpExecArray | null;
  while ((match = scriptRegex.exec(source)) !== null) {
    const attrs = match[1] || '';
    const beforeScript = source.substring(0, match.index);
    const scriptTagLine = (beforeScript.match(/\n/g) || []).length;
    const openingTag = match[0].substring(0, match[0].indexOf('>') + 1);
    const openingTagLines = (openingTag.match(/\n/g) || []).length;
    blocks.push({
      content: match[2] || '',
      startLine: scriptTagLine + openingTagLines,
      attrs,
      isTypeScript: /lang\s*=\s*["'](ts|typescript)["']/.test(attrs),
    });
  }
  return blocks;
}

export function mergeOffsetExtractionResult(args: {
  st: ComponentExtractorState;
  result: ExtractionResult;
  blockStart: number;
  componentNodeId: string;
  language: Language;
}): void {
  const { st, result, blockStart, componentNodeId, language } = args;
  for (const node of result.nodes) {
    node.startLine += blockStart;
    node.endLine += blockStart;
    node.language = language;
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
    ref.language = language;
    st.unresolvedReferences.push(ref);
  }
  for (const error of result.errors) {
    if (error.line) error.line += blockStart;
    st.errors.push(error);
  }
}

function coveredMarkupRanges(source: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  const tagRegex = /<(script|style)(\s[^>]*)?>[\s\S]*?<\/\1>/g;
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRegex.exec(source)) !== null) {
    const startLine = (source.substring(0, tagMatch.index).match(/\n/g) || []).length;
    const endLine = startLine + (tagMatch[0].match(/\n/g) || []).length;
    ranges.push([startLine, endLine]);
  }
  return ranges;
}

export function recordTemplateCallsInExpression(args: {
  st: ComponentExtractorState;
  componentNodeId: string;
  expr: string;
  exprStart: number;
  lineIdx: number;
  language: Language;
  skipNames: ReadonlySet<string>;
}): void {
  const callRegex = /\b([a-zA-Z_$][\w$.]*)\s*\(/g;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = callRegex.exec(args.expr)) !== null) {
    const calleeName = callMatch[1]!;
    if (args.skipNames.has(calleeName)) continue;
    args.st.unresolvedReferences.push({
      fromNodeId: args.componentNodeId,
      referenceName: calleeName,
      referenceKind: 'calls',
      line: args.lineIdx + 1,
      column: args.exprStart + callMatch.index,
      filePath: args.st.filePath,
      language: args.language,
    });
  }
}

export function extractTemplateCalls(args: {
  st: ComponentExtractorState;
  componentNodeId: string;
  expressionRegex: RegExp;
  language: Language;
  skipNames: ReadonlySet<string>;
}): void {
  const coveredRanges = coveredMarkupRanges(args.st.source);
  const lines = args.st.source.split('\n');
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;
    const line = lines[lineIdx]!;
    let exprMatch: RegExpExecArray | null;
    while ((exprMatch = args.expressionRegex.exec(line)) !== null) {
      recordTemplateCallsInExpression({
        st: args.st,
        componentNodeId: args.componentNodeId,
        expr: exprMatch[1]!,
        exprStart: exprMatch.index,
        lineIdx,
        language: args.language,
        skipNames: args.skipNames,
      });
    }
  }
}

export function extractTemplateComponents(args: {
  st: ComponentExtractorState;
  componentNodeId: string;
  language: Language;
}): void {
  const coveredRanges = coveredMarkupRanges(args.st.source);
  const lines = args.st.source.split('\n');
  const componentTagRegex = /<([A-Z][a-zA-Z0-9_$]*)\b/g;
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    if (coveredRanges.some(([start, end]) => lineIdx >= start && lineIdx <= end)) continue;
    const line = lines[lineIdx]!;
    let match: RegExpExecArray | null;
    while ((match = componentTagRegex.exec(line)) !== null) {
      args.st.unresolvedReferences.push({
        fromNodeId: args.componentNodeId,
        referenceName: match[1]!,
        referenceKind: 'references',
        line: lineIdx + 1,
        column: match.index + 1,
        filePath: args.st.filePath,
        language: args.language,
      });
    }
  }
}
