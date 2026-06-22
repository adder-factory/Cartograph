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
import { stripCommentsForRegex } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { makeFrameworkNodeAtOffset } from './node-builders.js';
import { hasPackageDependency } from './package-dependencies.js';
import { readQuoted } from './quoted.js';
import { makeFrameworkReference } from './reference.js';

const ANGULAR_LANGUAGES = ['typescript'] as const;
const ANGULAR_DEPENDENCIES = ['@angular/core', '@angular/router', '@angular/cli'] as const;
const ROUTE_PATH_RE = /\bpath\s*:\s*(['"])(.*?)\1/g;
const COMPONENT_RE = /\bcomponent\s*:\s*([A-Z][A-Za-z0-9_$]*)\b/;

export const angularResolver: FrameworkResolver = {
  name: 'angular',
  languages: ANGULAR_LANGUAGES,
  anchors: ['@angular/', 'Routes', 'RouterModule.', 'provideRouter', 'path:', 'component:', 'loadChildren'],

  detect(context: ResolutionContext): boolean {
    if (context.fileExists('angular.json')) return true;
    return hasPackageDependency(context.readFile('package.json'), ANGULAR_DEPENDENCIES);
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },

  extract(filePath: string, content: string) {
    const safe = stripCommentsForRegex(content, 'typescript');
    if (!hasAngularRouteSignal(safe)) return { nodes: [], references: [] };

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
        references.push(makeFrameworkReference(routeNode, component, 'references'));
      }

      const lazyImport = extractLazyImport(routeObject);
      if (lazyImport) {
        references.push(makeFrameworkReference(routeNode, lazyImport.source, 'imports'));
        if (lazyImport.exportName)
          references.push(makeFrameworkReference(routeNode, lazyImport.exportName, 'references'));
      }
    }

    return { nodes, references: dedupeReferences(references) };
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
  return makeFrameworkNodeAtOffset({
    idPrefix: 'angular:route',
    kind: 'route',
    name: args.routePath,
    filePath: args.filePath,
    content: args.content,
    offset: args.offset,
    language: args.language,
    signature: `Angular route ${args.routePath}`,
  });
}

function dedupeReferences(refs: UnresolvedReference[]): UnresolvedReference[] {
  const seen = new Set<string>();
  return refs.filter((ref) => {
    const key = `${ref.fromNodeId}:${ref.referenceKind}:${ref.referenceName}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
