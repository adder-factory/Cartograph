/**
 * React Framework Resolver
 *
 * Handles React and Next.js patterns.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types.js';
import { makeLineIndex } from '../../utils.js';
import { hasPackageDependency } from './package-dependencies.js';
import { isSameDirectoryPath, pathMatchesDirectoryPattern } from './resolve-by-name.js';

const REACT_DEPENDENCIES = ['react', 'next', 'react-native'] as const;

export const reactResolver: FrameworkResolver = {
  name: 'react',

  detect(context: ResolutionContext): boolean {
    // Check for React in package.json
    if (hasPackageDependency(context.readFile('package.json'), REACT_DEPENDENCIES)) return true;

    // Check for .jsx/.tsx files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.jsx') || f.endsWith('.tsx'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Pattern 1: Component references (PascalCase)
    if (isPascalCase(ref.referenceName) && !isBuiltInType(ref.referenceName)) {
      const result = resolveComponent(ref.referenceName, ref.filePath, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Hook references (use*)
    if (ref.referenceName.startsWith('use') && ref.referenceName.length > 3) {
      const result = resolveHook(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.85,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Context references
    if (ref.referenceName.endsWith('Context') || ref.referenceName.endsWith('Provider')) {
      const result = resolveContext(ref.referenceName, context);
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  languages: ['typescript', 'javascript', 'tsx', 'jsx'],

  extractNodes(filePath: string, content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Components and custom hooks are NOT regex-extracted here anymore.
    // The tree-sitter extractors (`ts-extract-declarations.ts` +
    // javascript/typescript `visitNode` hooks) already emit `component`
    // nodes for both the function-declaration and arrow-assigned forms,
    // and `function` nodes for `use*` hooks. The old regex pass appended
    // a SECOND node per symbol with a raw-string id that didn't coalesce
    // with the tree-sitter hash id — a double-emission. Only the Next.js
    // filepath→route mapping below is unique to this resolver.

    // Extract Next.js pages/routes (pages directory convention)
    if (filePath.includes('pages/') || filePath.includes('app/')) {
      // Default export in pages becomes a route
      if (content.includes('export default')) {
        const routePath = filePathToRoute(filePath);
        if (routePath) {
          const lineOf = makeLineIndex(content);
          const exportOffset = content.indexOf('export default');
          const lineNum = lineOf(exportOffset);

          nodes.push({
            id: `route:${filePath}:${routePath}:${lineNum}`,
            kind: 'route',
            name: routePath,
            qualifiedName: `${filePath}::route:${routePath}`,
            filePath,
            startLine: lineNum,
            endLine: lineNum,
            startColumn: 0,
            endColumn: 0,
            language: routeLanguageForPath(filePath),
            updatedAt: now,
          });
        }
      }
    }

    return nodes;
  },
};

function routeLanguageForPath(filePath: string): 'tsx' | 'typescript' | 'javascript' {
  if (filePath.endsWith('.tsx')) return 'tsx';
  if (filePath.endsWith('.ts') || filePath.endsWith('.mts') || filePath.endsWith('.cts')) return 'typescript';
  return 'javascript';
}

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Check if name is a built-in type
 */
function isBuiltInType(name: string): boolean {
  return BUILT_IN_TYPES.has(name);
}

const BUILT_IN_TYPES = new Set([
  'Array',
  'Boolean',
  'Date',
  'Error',
  'Function',
  'JSON',
  'Math',
  'Number',
  'Object',
  'Promise',
  'RegExp',
  'String',
  'Symbol',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'React',
  'Component',
  'Fragment',
  'Suspense',
  'StrictMode',
]);

const COMPONENT_KINDS = new Set(['component', 'function', 'class']);

/**
 * Resolve a component reference using name-based lookup
 */
function resolveComponent(name: string, fromFile: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const components = candidates.filter((n) => COMPONENT_KINDS.has(n.kind));
  if (components.length === 0) return null;

  // Prefer same directory
  const sameDir = components.filter((n) => isSameDirectoryPath(n.filePath, fromFile));
  if (sameDir.length > 0) return sameDir[0]!.id;

  // Prefer component directories
  const COMPONENT_DIRS = [
    '/components/',
    '/src/components/',
    '/app/components/',
    '/pages/',
    '/src/pages/',
    '/views/',
    '/src/views/',
  ];
  const preferred = components.filter((n) => COMPONENT_DIRS.some((d) => pathMatchesDirectoryPattern(n.filePath, d)));
  if (preferred.length > 0) return preferred[0]!.id;

  return components[0]!.id;
}

/**
 * Resolve a custom hook reference using name-based lookup
 */
function resolveHook(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const hooks = candidates.filter((n) => n.kind === 'function' && n.name.startsWith('use'));
  if (hooks.length === 0) return null;

  // Prefer hooks directories
  const HOOK_DIRS = ['/hooks/', '/src/hooks/', '/lib/hooks/', '/utils/hooks/'];
  const preferred = hooks.filter((n) => HOOK_DIRS.some((d) => pathMatchesDirectoryPattern(n.filePath, d)));
  if (preferred.length > 0) return preferred[0]!.id;

  return hooks[0]!.id;
}

/**
 * Resolve a context reference using name-based lookup
 */
function resolveContext(name: string, context: ResolutionContext): string | null {
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) {
    // Try without Context/Provider suffix
    const baseName = name.replace(/Context$|Provider$/, '');
    if (baseName !== name) {
      const baseCandidates = context.getNodesByName(baseName);
      if (baseCandidates.length > 0) return baseCandidates[0]!.id;
    }
    return null;
  }

  // Prefer context directories
  const CONTEXT_DIRS = ['/context/', '/contexts/', '/src/context/', '/src/contexts/', '/providers/', '/src/providers/'];
  const preferred = candidates.filter((n) => CONTEXT_DIRS.some((d) => pathMatchesDirectoryPattern(n.filePath, d)));
  if (preferred.length > 0) return preferred[0]!.id;

  return candidates[0]!.id;
}

/**
 * Convert file path to Next.js route
 */
function filePathToRoute(filePath: string): string | null {
  // pages/index.tsx -> /
  // pages/about.tsx -> /about
  // pages/blog/[slug].tsx -> /blog/:slug
  // app/page.tsx -> /
  // app/about/page.tsx -> /about

  if (filePath.includes('pages/')) {
    let route = filePath
      .replace(/^.*pages\//, '/')
      .replace(/\/index\.(tsx?|jsx?)$/, '')
      .replace(/\.(tsx?|jsx?)$/, '')
      .replaceAll(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  if (filePath.includes('app/')) {
    // App router - only page.tsx files are routes
    if (!filePath.includes('page.')) {
      return null;
    }

    let route = filePath
      .replace(/^.*app\//, '/')
      .replace(/\/page\.(tsx?|jsx?)$/, '')
      .replaceAll(/\[([^\]]+)\]/g, ':$1');

    if (route === '') route = '/';
    return route;
  }

  return null;
}
