/**
 * Svelte / SvelteKit Framework Resolver
 *
 * Handles Svelte component references, Svelte 5 runes,
 * store auto-subscriptions, and SvelteKit route/module patterns.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types.js';
import { hasPackageDependency } from './package-dependencies.js';
import { isSameDirectoryPath } from './resolve-by-name.js';

const SVELTE_DEPENDENCIES = ['svelte', '@sveltejs/kit'] as const;

/**
 * Svelte 5 runes — compiler-provided, not user code
 */
const SVELTE_RUNES = new Set([
  '$state',
  '$state.raw',
  '$state.snapshot',
  '$derived',
  '$derived.by',
  '$effect',
  '$effect.pre',
  '$effect.root',
  '$effect.tracking',
  '$props',
  '$bindable',
  '$inspect',
  '$host',
]);

/**
 * SvelteKit framework-provided module prefixes
 */
const SVELTEKIT_MODULE_PREFIXES = [
  '$app/navigation',
  '$app/stores',
  '$app/environment',
  '$app/forms',
  '$app/paths',
  '$env/static/private',
  '$env/static/public',
  '$env/dynamic/private',
  '$env/dynamic/public',
];

export const svelteResolver: FrameworkResolver = {
  name: 'svelte',

  detect(context: ResolutionContext): boolean {
    // Check for svelte or @sveltejs/kit in package.json
    if (hasPackageDependency(context.readFile('package.json'), SVELTE_DEPENDENCIES)) return true;

    // Check for .svelte files in project
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.svelte'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return (
      resolveRune(ref) ??
      resolveStoreSubscription(ref, context) ??
      resolveSvelteKitImport(ref, context) ??
      resolveSvelteComponent(ref, context)
    );
  },

  // SvelteKit route files: `+page.svelte` (svelte), `+server.ts` /
  // `+server.js` (typescript / javascript), `+layout.svelte` (svelte).
  // Filename heuristic legitimately spans the union.
  languages: ['svelte', 'typescript', 'javascript'],

  extractNodes(filePath: string, _content: string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();

    // Detect SvelteKit route files
    const fileName = filePath.split(/[/\\]/).pop() || '';
    const routeMatch = getSvelteKitRouteInfo(fileName);

    if (routeMatch) {
      // Extract route path from directory structure
      // e.g., src/routes/blog/[slug]/+page.svelte -> /blog/:slug
      const routePath = filePathToSvelteKitRoute(filePath);

      if (routePath) {
        nodes.push({
          id: `route:${filePath}:${routePath}:1`,
          kind: 'route',
          name: routePath,
          qualifiedName: `${filePath}::route:${routePath}`,
          filePath,
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          language: filePath.endsWith('.svelte') ? 'svelte' : 'typescript',
          updatedAt: now,
        });
      }
    }

    return nodes;
  },
};

/**
 * Check if a reference name is a Svelte rune
 */
function isRuneReference(name: string): boolean {
  // Direct match (e.g. $state, $derived)
  if (SVELTE_RUNES.has(name)) return true;

  // Rune method calls come through as the base rune name
  // e.g. $state.raw -> the call is to "$state" with ".raw" accessed as property
  // Check if it's a base rune that has sub-methods
  if (name === '$state' || name === '$derived' || name === '$effect') return true;

  return false;
}

function frameworkResolved(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}

function resolveRune(ref: UnresolvedRef): ResolvedRef | null {
  if (!isRuneReference(ref.referenceName)) return null;
  return frameworkResolved(ref, ref.fromNodeId, 1);
}

function resolveStoreSubscription(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!ref.referenceName.startsWith('$') || ref.referenceName.startsWith('$$')) return null;
  const storeName = ref.referenceName.substring(1);
  const storeNode = context.getNodesByName(storeName).find((n) => n.kind === 'variable' || n.kind === 'constant');
  return storeNode ? frameworkResolved(ref, storeNode.id, 0.85) : null;
}

function resolveSvelteKitImport(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'imports' || !ref.referenceName.startsWith('$')) return null;
  return resolveLibImport(ref, context) ?? resolveProvidedSvelteKitModule(ref);
}

function resolveLibImport(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!ref.referenceName.startsWith('$lib/')) return null;
  const libPath = ref.referenceName.replace('$lib/', 'src/lib/');
  for (const ext of ['', '.ts', '.js', '.svelte', '/index.ts', '/index.js']) {
    const fullPath = libPath + ext;
    if (!context.fileExists(fullPath)) continue;
    const nodes = context.getNodesInFile(fullPath);
    if (nodes.length > 0) return frameworkResolved(ref, nodes[0]!.id, 0.9);
  }
  return null;
}

function resolveProvidedSvelteKitModule(ref: UnresolvedRef): ResolvedRef | null {
  const isFrameworkModule = SVELTEKIT_MODULE_PREFIXES.some((prefix) => ref.referenceName.startsWith(prefix));
  return isFrameworkModule ? frameworkResolved(ref, ref.fromNodeId, 1) : null;
}

function resolveSvelteComponent(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (!isPascalCase(ref.referenceName) || ref.referenceKind !== 'calls') return null;
  const result = resolveComponent(ref.referenceName, ref.filePath, context);
  return result ? frameworkResolved(ref, result, 0.8) : null;
}

/**
 * Check if string is PascalCase
 */
function isPascalCase(str: string): boolean {
  return /^[A-Z][a-zA-Z0-9]*$/.test(str);
}

/**
 * Resolve a Svelte component reference using name-based lookup
 */
function resolveComponent(name: string, fromFile: string, context: ResolutionContext): string | null {
  // Look for component nodes by name
  const candidates = context.getNodesByName(name);
  const components = candidates.filter((n) => n.kind === 'component');

  if (components.length === 0) return null;

  // Prefer same directory
  const sameDir = components.filter((n) => isSameDirectoryPath(n.filePath, fromFile));
  if (sameDir.length > 0) return sameDir[0]!.id;

  return components[0]!.id;
}

/**
 * SvelteKit route file patterns
 */
const SVELTEKIT_ROUTE_FILES: Record<string, string> = {
  '+page.svelte': 'page',
  '+page.ts': 'page-load',
  '+page.js': 'page-load',
  '+page.server.ts': 'page-server-load',
  '+page.server.js': 'page-server-load',
  '+layout.svelte': 'layout',
  '+layout.ts': 'layout-load',
  '+layout.js': 'layout-load',
  '+layout.server.ts': 'layout-server-load',
  '+layout.server.js': 'layout-server-load',
  '+server.ts': 'api-endpoint',
  '+server.js': 'api-endpoint',
  '+error.svelte': 'error-page',
};

/**
 * Check if filename is a SvelteKit route file
 */
function getSvelteKitRouteInfo(fileName: string): string | null {
  return SVELTEKIT_ROUTE_FILES[fileName] || null;
}

/**
 * Convert a file path to a SvelteKit route path
 */
function filePathToSvelteKitRoute(filePath: string): string | null {
  // Normalize to forward slashes
  const normalized = filePath.replaceAll('\\', '/');

  // Find the routes directory
  const routesIndex = normalized.indexOf('/routes/');
  if (routesIndex === -1) return null;

  // Extract the path after routes/
  const afterRoutes = normalized.substring(routesIndex + '/routes/'.length);

  // Remove the file name
  const lastSlash = afterRoutes.lastIndexOf('/');
  const dirPath = lastSlash === -1 ? '' : afterRoutes.substring(0, lastSlash);

  // Convert SvelteKit param syntax [param] to :param
  const route =
    '/' +
    dirPath
      .replaceAll(/\[\.\.\.([^\]]+)\]/g, '*$1') // [...rest] -> *rest
      .replaceAll(/\[{2}([^\]]+)\]{2}/g, ':$1?') // [[optional]] -> :optional?
      .replaceAll(/\[([^\]]+)\]/g, ':$1'); // [param] -> :param

  if (route === '/') return '/';
  // Remove trailing slash
  return route.replace(/\/$/, '');
}
