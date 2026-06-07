/**
 * Vue / Nuxt framework resolver.
 *
 * Handles Vue compiler macros, Nuxt auto-imports / virtual modules,
 * Vue/Nuxt aliases, PascalCase component references, and Nuxt file
 * route conventions.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';

const VUE_COMPILER_MACROS = new Set([
  'defineProps',
  'defineEmits',
  'defineExpose',
  'defineOptions',
  'defineSlots',
  'defineModel',
  'withDefaults',
]);

const NUXT_AUTO_IMPORTS = new Set([
  'abortNavigation',
  'clearError',
  'clearNuxtState',
  'createError',
  'defineNuxtConfig',
  'defineNuxtPlugin',
  'defineNuxtRouteMiddleware',
  'definePageMeta',
  'navigateTo',
  'refreshNuxtData',
  'showError',
  'useAppConfig',
  'useAsyncData',
  'useCookie',
  'useError',
  'useFetch',
  'useHead',
  'useLazyAsyncData',
  'useLazyFetch',
  'useNuxtApp',
  'useRequestEvent',
  'useRequestFetch',
  'useRequestHeaders',
  'useRequestURL',
  'useRoute',
  'useRouter',
  'useRuntimeConfig',
  'useSeoMeta',
  'useServerSeoMeta',
  'useState',
]);

const NUXT_VIRTUAL_MODULE_PREFIXES = ['#imports', '#components', '#app', '#build', '#head'];

const MODULE_EXTENSIONS = [
  '',
  '.vue',
  '.ts',
  '.js',
  '.tsx',
  '.jsx',
  '/index.vue',
  '/index.ts',
  '/index.js',
  '/index.tsx',
  '/index.jsx',
];

const SERVER_ROUTE_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.cjs']);

export const vueResolver: FrameworkResolver = {
  name: 'vue',
  languages: ['vue', 'typescript', 'javascript', 'tsx', 'jsx'],

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (packageJson) {
      try {
        const pkg = JSON.parse(packageJson) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['vue'] || deps['nuxt'] || deps['@nuxt/kit']) return true;
      } catch {
        /* malformed package.json — fall back to file signal */
      }
    }
    return context.getAllFiles().some((file) => file.endsWith('.vue') || file.endsWith('nuxt.config.ts'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    return (
      resolveProvidedVueSymbol(ref) ??
      resolveNuxtVirtualImport(ref) ??
      resolveAliasImport(ref, context) ??
      resolveVueComponent(ref, context)
    );
  },

  extractNodes(filePath: string): Node[] {
    const normalized = normalizeFilePath(filePath);
    return [
      ...extractNuxtPageRoute(filePath, normalized),
      ...extractNuxtApiRoute(filePath, normalized),
      ...extractNuxtMiddleware(filePath, normalized),
    ];
  },
};

function frameworkResolved(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}

function resolveProvidedVueSymbol(ref: UnresolvedRef): ResolvedRef | null {
  if (!VUE_COMPILER_MACROS.has(ref.referenceName) && !NUXT_AUTO_IMPORTS.has(ref.referenceName)) return null;
  return frameworkResolved(ref, ref.fromNodeId, 1);
}

function resolveNuxtVirtualImport(ref: UnresolvedRef): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  const isVirtual = NUXT_VIRTUAL_MODULE_PREFIXES.some(
    (prefix) => ref.referenceName === prefix || ref.referenceName.startsWith(`${prefix}/`),
  );
  return isVirtual ? frameworkResolved(ref, ref.fromNodeId, 1) : null;
}

function resolveAliasImport(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'imports') return null;
  const candidates = aliasCandidates(ref.referenceName);
  if (candidates.length === 0) return null;

  for (const base of candidates) {
    const resolved = resolvePathToNode(base, context);
    if (resolved) return frameworkResolved(ref, resolved, 0.9);
  }
  return null;
}

function aliasCandidates(referenceName: string): string[] {
  if (referenceName.startsWith('@/')) {
    const tail = referenceName.slice(2);
    return [`src/${tail}`, tail];
  }
  if (referenceName.startsWith('~/')) {
    const tail = referenceName.slice(2);
    return [tail, `src/${tail}`];
  }
  return [];
}

function resolvePathToNode(basePath: string, context: ResolutionContext): string | null {
  for (const ext of MODULE_EXTENSIONS) {
    const filePath = basePath + ext;
    if (!context.fileExists(filePath)) continue;
    const nodes = context.getNodesInFile(filePath);
    const preferred =
      nodes.find((n) => n.kind === 'component') ??
      nodes.find((n) => n.kind !== 'file' && n.kind !== 'import') ??
      nodes[0];
    if (preferred) return preferred.id;
  }
  return null;
}

function resolveVueComponent(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  if (ref.referenceKind !== 'calls' || !isPascalCase(ref.referenceName)) return null;

  const candidates = context.getNodesByName(ref.referenceName).filter((n) => n.kind === 'component');
  if (candidates.length === 0) return null;

  const fromDir = dirname(ref.filePath);
  const sameDir = candidates.find((n) => dirname(n.filePath) === fromDir);
  const nearbyComponents = candidates.find((n) => n.filePath.includes('/components/'));
  return frameworkResolved(ref, (sameDir ?? nearbyComponents ?? candidates[0]!).id, 0.8);
}

function isPascalCase(value: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(value);
}

function normalizeFilePath(filePath: string): string {
  return filePath.replaceAll('\\', '/');
}

function dirname(filePath: string): string {
  const normalized = normalizeFilePath(filePath);
  const idx = normalized.lastIndexOf('/');
  return idx < 0 ? '' : normalized.slice(0, idx);
}

function routeFileParts(normalized: string, marker: string): { afterMarker: string; extension: string } | null {
  const bareMarker = stripLeadingSlashes(marker);
  const idx = normalized.indexOf(marker);
  let afterMarker: string | null = null;
  if (idx >= 0) afterMarker = normalized.slice(idx + marker.length);
  else if (normalized.startsWith(bareMarker)) afterMarker = normalized.slice(bareMarker.length);
  if (afterMarker === null) return null;
  const lastSlash = afterMarker.lastIndexOf('/');
  const fileName = lastSlash < 0 ? afterMarker : afterMarker.slice(lastSlash + 1);
  const extensionIdx = fileName.lastIndexOf('.');
  if (extensionIdx < 0) return null;
  return { afterMarker, extension: fileName.slice(extensionIdx) };
}

function extractNuxtPageRoute(filePath: string, normalized: string): Node[] {
  const marker = '/pages/';
  const parts = routeFileParts(normalized, marker);
  if (parts?.extension !== '.vue') return [];
  const routePath = filePathToNuxtRoute(parts.afterMarker);
  if (!routePath) return [];
  return [routeNode(filePath, routePath, 'vue')];
}

function stripLeadingSlashes(value: string): string {
  let start = 0;
  while (value[start] === '/') start++;
  return value.slice(start);
}

function extractNuxtApiRoute(filePath: string, normalized: string): Node[] {
  const marker = '/server/api/';
  const parts = routeFileParts(normalized, marker);
  if (!parts || !SERVER_ROUTE_EXTENSIONS.has(parts.extension)) return [];
  const routePath = `/api${filePathToNuxtRoute(parts.afterMarker)}`;
  return [routeNode(filePath, routePath, parts.extension === '.ts' ? 'typescript' : 'javascript')];
}

function extractNuxtMiddleware(filePath: string, normalized: string): Node[] {
  const marker = '/middleware/';
  const parts = routeFileParts(normalized, marker);
  if (!parts || !SERVER_ROUTE_EXTENSIONS.has(parts.extension)) return [];
  const name = stripExtension(parts.afterMarker)
    .replace(/\/index$/, '')
    .replaceAll('/', '.');
  if (!name) return [];
  const now = Date.now();
  return [
    {
      id: `middleware:${filePath}:${name}:1`,
      kind: 'function',
      name,
      qualifiedName: `${filePath}::middleware:${name}`,
      filePath,
      startLine: 1,
      endLine: 1,
      startColumn: 0,
      endColumn: 0,
      language: parts.extension === '.ts' ? 'typescript' : 'javascript',
      updatedAt: now,
    },
  ];
}

function routeNode(filePath: string, routePath: string, language: Node['language']): Node {
  const now = Date.now();
  return {
    id: `route:${filePath}:${routePath}:1`,
    kind: 'route',
    name: routePath,
    qualifiedName: `${filePath}::route:${routePath}`,
    filePath,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    language,
    updatedAt: now,
  };
}

function stripExtension(filePath: string): string {
  return filePath.replace(/\.[^/.]+$/, '');
}

function filePathToNuxtRoute(afterMarker: string): string {
  const withoutExt = stripExtension(afterMarker)
    .replace(/\/index$/, '')
    .replace(/^index$/, '');
  const route = withoutExt
    .split('/')
    .filter(Boolean)
    .map((part) =>
      part
        .replace(/^\[\.\.\.([^\]]+)\]$/, '*$1')
        .replace(/^\[\[([^\]]+)\]\]$/, ':$1?')
        .replace(/^\[([^\]]+)\]$/, ':$1'),
    )
    .join('/');
  return route ? `/${route}` : '/';
}
