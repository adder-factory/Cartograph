/**
 * Angular framework resolver.
 *
 * Mines static Router route objects (`Routes = [...]`, `provideRouter([...])`,
 * `RouterModule.forRoot/forChild([...])`) into route nodes and references their
 * routed components / lazy imports. The scanner is intentionally conservative:
 * it handles literal route objects and skips arbitrary expressions.
 */

import type { Language, Node } from '../../types.js';
import type { UnresolvedReference } from '../../extraction/types.js';
import { makeLineIndex, stripCommentsForRegex } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';

const ANGULAR_LANGUAGES = ['typescript'] as const;
const ROUTE_PATH_RE = /\bpath\s*:\s*(['"])(.*?)\1/g;
const COMPONENT_RE = /\bcomponent\s*:\s*([A-Z][A-Za-z0-9_$]*)\b/;

export const angularResolver: FrameworkResolver = {
  name: 'angular',
  languages: ANGULAR_LANGUAGES,
  anchors: ['@angular/', 'Routes', 'RouterModule.', 'provideRouter', 'path:', 'component:', 'loadChildren'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('angular.json')) return true;
    const packageJson = context.readFile('package.json');
    if (!packageJson) return false;
    try {
      const pkg = JSON.parse(packageJson) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      return Boolean(deps['@angular/core'] || deps['@angular/router'] || deps['@angular/cli']);
    } catch {
      return false;
    }
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },

  extract(filePath: string, content: string) {
    const safe = stripCommentsForRegex(content, 'typescript');
    if (!hasAngularRouteSignal(safe)) return { nodes: [], references: [] };

    const lineOf = makeLineIndex(safe);
    const nodes: Node[] = [];
    const references: UnresolvedReference[] = [];
    ROUTE_PATH_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = ROUTE_PATH_RE.exec(safe)) !== null) {
      const rawPath = match[2] ?? '';
      const routeObject = readObjectLiteralWindow(safe, match.index);
      if (!routeObject) continue;
      const routePath = normalizeAngularRoutePath(rawPath);
      const routeNode = makeRouteNode({
        filePath,
        content: safe,
        offset: match.index,
        routePath,
        language: 'typescript',
      });
      nodes.push(routeNode);

      const component = COMPONENT_RE.exec(routeObject)?.[1];
      if (component) {
        references.push(makeReference(routeNode, component, 'references'));
      }

      const lazyImport = extractLazyImport(routeObject);
      if (lazyImport) {
        references.push(makeReference(routeNode, lazyImport.source, 'imports'));
        if (lazyImport.exportName) references.push(makeReference(routeNode, lazyImport.exportName, 'references'));
      }
    }

    return { nodes, references: dedupeReferences(references, lineOf) };
  },
};

function hasAngularRouteSignal(content: string): boolean {
  return (
    content.includes('Routes') ||
    content.includes('RouterModule.forRoot') ||
    content.includes('RouterModule.forChild') ||
    content.includes('provideRouter')
  );
}

function readObjectLiteralWindow(content: string, pathIndex: number): string | null {
  const start = content.lastIndexOf('{', pathIndex);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < content.length; i++) {
    const ch = content[i];
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) return content.slice(start, i + 1);
    }
  }
  return null;
}

function normalizeAngularRoutePath(rawPath: string): string {
  if (rawPath === '') return '/';
  if (rawPath.startsWith('/')) return rawPath;
  return `/${rawPath}`;
}

function extractLazyImport(routeObject: string): { source: string; exportName: string | null } | null {
  const importIndex = routeObject.indexOf('import');
  if (importIndex === -1) return null;
  const open = routeObject.indexOf('(', importIndex);
  if (open === -1) return null;
  const quoteIndex = skipWhitespace(routeObject, open + 1);
  const source = readQuoted(routeObject, quoteIndex);
  if (!source) return null;
  return {
    source: source.value,
    exportName: readThenExport(routeObject.slice(source.end)),
  };
}

function readThenExport(snippet: string): string | null {
  const thenIndex = snippet.indexOf('.then');
  if (thenIndex === -1) return null;
  const dotIndex = snippet.indexOf('.', thenIndex + 5);
  if (dotIndex === -1) return null;
  return readIdentifier(snippet, dotIndex + 1);
}

function readQuoted(text: string, start: number): { value: string; end: number } | null {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  let i = start + 1;
  while (i < text.length) {
    if (text[i] === '\\') {
      i += 2;
      continue;
    }
    if (text[i] === quote) return { value: text.slice(start + 1, i), end: i + 1 };
    i++;
  }
  return null;
}

function readIdentifier(text: string, start: number): string | null {
  let i = skipWhitespace(text, start);
  const first = text[i];
  if (!first || !/[A-Za-z_$]/.test(first)) return null;
  const begin = i;
  i++;
  while (i < text.length && /[\w$]/.test(text[i]!)) i++;
  return text.slice(begin, i);
}

function skipWhitespace(text: string, start: number): number {
  let i = start;
  while (i < text.length && /\s/.test(text[i]!)) i++;
  return i;
}

function makeRouteNode(args: {
  filePath: string;
  content: string;
  offset: number;
  routePath: string;
  language: Language;
}): Node {
  const lineOf = makeLineIndex(args.content);
  const line = lineOf(args.offset);
  return {
    id: `angular:route:${args.filePath}:${line}:${args.routePath}`,
    kind: 'route',
    name: args.routePath,
    qualifiedName: `${args.filePath}#${args.routePath}`,
    filePath: args.filePath,
    language: args.language,
    startLine: line,
    endLine: line,
    startColumn: Math.max(0, args.offset - (args.content.lastIndexOf('\n', args.offset - 1) + 1)),
    endColumn: Math.max(0, args.offset - (args.content.lastIndexOf('\n', args.offset - 1) + 1)) + args.routePath.length,
    signature: `Angular route ${args.routePath}`,
    updatedAt: Date.now(),
  };
}

function makeReference(node: Node, name: string, kind: UnresolvedReference['referenceKind']): UnresolvedReference {
  return {
    fromNodeId: node.id,
    referenceName: name,
    referenceKind: kind,
    line: node.startLine,
    column: node.startColumn,
    filePath: node.filePath,
    language: node.language,
  };
}

function dedupeReferences(refs: UnresolvedReference[], _lineOf: (offset: number) => number): UnresolvedReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.fromNodeId}:${ref.referenceKind}:${ref.referenceName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
