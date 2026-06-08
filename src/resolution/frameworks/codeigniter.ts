/**
 * CodeIgniter 3 framework resolver.
 *
 * CI3's useful static signals are route-array entries in
 * `application/config/routes.php`, convention-dispatched controller
 * methods under `application/controllers`, and models/libraries made
 * available through `$this->load`.
 */
import type { UnresolvedReference } from '../../extraction/types.js';
import type { Node } from '../../types.js';
import { makeLineIndex, normalizePath, stripCommentsForRegex } from '../../utils.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';

type CodeIgniterResourceKind = 'model' | 'library' | 'controller';

interface LoadedResource {
  kind: Exclude<CodeIgniterResourceKind, 'controller'>;
  resourcePath: string;
}

interface RouteTargetCandidate {
  controllerPath: string;
  methodName: string;
}

interface RouteAssignment {
  routeKey: string;
  method: string;
  target: string;
  offset: number;
}

const CI_REF_PREFIX = 'ci3:';
const CI_ROUTE_PREFIX = `${CI_REF_PREFIX}route:`;
const CI_SYMBOL_PREFIX = `${CI_REF_PREFIX}symbol:`;
const CI_MEMBER_PREFIX = `${CI_REF_PREFIX}member:`;
const PHP_IDENTIFIER_RE = /^[A-Za-z]\w*$/;
const RESERVED_ROUTE_KEYS = new Set(['translate_uri_dashes']);

const PUBLIC_METHOD_RE = /\bpublic\s+function\s+([A-Za-z]\w*)\s*\(/g;
const LOAD_CALL_RE = /\$this\s*->\s*load\s*->\s*(model|library)\s*\(([^)]*)\)/g;
const STRING_LITERAL_RE = /(["'])([^"']+)\1/g;
const THIS_MEMBER_CALL_RE = /\$this\s*->\s*([A-Za-z]\w*)\s*->\s*([A-Za-z]\w*)\s*\(/g;

export const codeIgniterResolver: FrameworkResolver = {
  name: 'codeigniter',
  languages: ['php'],

  detect(context): boolean {
    const hasConfig =
      context.fileExists('application/config/routes.php') || context.fileExists('application/config/config.php');
    if (!hasConfig) return false;
    if (context.fileExists('index.php') || context.fileExists('system/core/CodeIgniter.php')) return true;
    return context.getAllFiles().some(isCodeIgniterApplicationPath);
  },

  claimsReference(name): boolean {
    return name.startsWith(CI_REF_PREFIX);
  },

  extract(filePath, content) {
    const safe = stripCommentsForRegex(content, 'php');
    return {
      nodes: [...extractRouteConfigNodes(filePath, safe), ...extractConventionControllerRoutes(filePath, safe)],
      references: [
        ...extractRouteConfigRefs(filePath, safe),
        ...extractConventionControllerRefs(filePath, safe),
        ...extractLoadedResourceRefs(filePath, safe),
      ],
    };
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (ref.referenceName.startsWith(CI_ROUTE_PREFIX)) return resolveRouteRef(ref, context);
    if (ref.referenceName.startsWith(CI_SYMBOL_PREFIX)) return resolveResourceRef(ref, context, 'symbol');
    if (ref.referenceName.startsWith(CI_MEMBER_PREFIX)) return resolveResourceRef(ref, context, 'member');
    return null;
  },
};

function extractRouteConfigNodes(filePath: string, content: string): Node[] {
  if (!isCodeIgniterRoutesFile(filePath)) return [];
  const nodes: Node[] = [];
  const lineOf = makeLineIndex(content);
  for (const assignment of routeAssignments(content)) {
    const route = routeEntry(assignment);
    if (!route) continue;
    nodes.push(
      routeNode({
        filePath,
        method: route.method,
        routePath: route.routePath,
        line: lineOf(assignment.offset),
        offset: assignment.offset,
        content,
      }),
    );
  }
  return nodes;
}

function extractRouteConfigRefs(filePath: string, content: string): UnresolvedReference[] {
  if (!isCodeIgniterRoutesFile(filePath)) return [];
  const refs: UnresolvedReference[] = [];
  const lineOf = makeLineIndex(content);
  for (const assignment of routeAssignments(content)) {
    const route = routeEntry(assignment);
    if (!route || route.target.length === 0) continue;
    const line = lineOf(assignment.offset);
    refs.push({
      fromNodeId: routeNodeId(filePath, route.method, route.routePath, line),
      referenceName: `${CI_ROUTE_PREFIX}${route.target}`,
      referenceKind: 'calls',
      line,
      column: columnAt(content, assignment.offset),
    });
  }
  return refs;
}

function routeEntry(assignment: RouteAssignment): { routePath: string; method: string; target: string } | null {
  const routeKey = assignment.routeKey;
  if (RESERVED_ROUTE_KEYS.has(routeKey)) return null;
  const rawTarget = assignment.target;
  const method = assignment.method.toUpperCase();
  if (routeKey === 'default_controller') {
    return { routePath: '/', method: 'ANY', target: rawTarget };
  }
  if (routeKey === '404_override') {
    if (rawTarget.trim().length === 0) return null;
    return { routePath: '<404>', method: 'ANY', target: rawTarget };
  }
  return { routePath: normalizeRoutePath(routeKey), method, target: rawTarget };
}

function routeAssignments(content: string): RouteAssignment[] {
  const assignments: RouteAssignment[] = [];
  let cursor = 0;
  while (cursor < content.length) {
    const offset = content.indexOf('$route', cursor);
    if (offset < 0) break;
    const parsed = parseRouteAssignmentAt(content, offset);
    if (parsed) {
      assignments.push(parsed.assignment);
      cursor = parsed.nextOffset;
    } else {
      cursor = offset + '$route'.length;
    }
  }
  return assignments;
}

function parseRouteAssignmentAt(
  content: string,
  offset: number,
): { assignment: RouteAssignment; nextOffset: number } | null {
  let cursor = offset + '$route'.length;
  const routeKey = parseBracketedString(content, cursor);
  if (!routeKey) return null;
  cursor = routeKey.nextOffset;
  let method = 'ANY';
  const methodToken = parseBracketedString(content, cursor);
  if (methodToken) {
    if (!isAlphaToken(methodToken.value)) return null;
    method = methodToken.value;
    cursor = methodToken.nextOffset;
  }
  cursor = skipWhitespace(content, cursor);
  if (content[cursor] !== '=') return null;
  const target = parseQuotedString(content, skipWhitespace(content, cursor + 1));
  if (!target) return null;
  return {
    assignment: {
      routeKey: routeKey.value,
      method,
      target: target.value,
      offset,
    },
    nextOffset: target.nextOffset,
  };
}

function parseBracketedString(content: string, offset: number): { value: string; nextOffset: number } | null {
  let cursor = skipWhitespace(content, offset);
  if (content[cursor] !== '[') return null;
  const parsed = parseQuotedString(content, skipWhitespace(content, cursor + 1));
  if (!parsed) return null;
  cursor = skipWhitespace(content, parsed.nextOffset);
  if (content[cursor] !== ']') return null;
  return { value: parsed.value, nextOffset: cursor + 1 };
}

function parseQuotedString(content: string, offset: number): { value: string; nextOffset: number } | null {
  const quote = content[offset];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let cursor = offset + 1; cursor < content.length; cursor++) {
    const char = content[cursor]!;
    if (char === '\\') {
      const next = content[cursor + 1];
      if (next === undefined) return null;
      value += next;
      cursor++;
      continue;
    }
    if (char === quote) return { value, nextOffset: cursor + 1 };
    value += char;
  }
  return null;
}

function skipWhitespace(content: string, offset: number): number {
  let cursor = offset;
  while (cursor < content.length && isWhitespace(content[cursor]!)) cursor++;
  return cursor;
}

function isWhitespace(char: string): boolean {
  return char === ' ' || char === '\t' || char === '\n' || char === '\r';
}

function isAlphaToken(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (!((char >= 'A' && char <= 'Z') || (char >= 'a' && char <= 'z'))) return false;
  }
  return true;
}

function extractConventionControllerRoutes(filePath: string, content: string): Node[] {
  const controllerPath = controllerPathFromFile(filePath);
  if (!controllerPath || !isControllerSource(content)) return [];
  const nodes: Node[] = [];
  const lineOf = makeLineIndex(content);
  PUBLIC_METHOD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PUBLIC_METHOD_RE.exec(content)) !== null) {
    const methodName = match[1]!;
    if (!isRoutableControllerMethod(methodName)) continue;
    const routePath = conventionRoutePath(controllerPath, methodName);
    nodes.push(
      routeNode({
        filePath,
        method: 'ANY',
        routePath,
        line: lineOf(match.index),
        offset: match.index,
        content,
      }),
    );
  }
  return nodes;
}

function extractConventionControllerRefs(filePath: string, content: string): UnresolvedReference[] {
  const controllerPath = controllerPathFromFile(filePath);
  if (!controllerPath || !isControllerSource(content)) return [];
  const refs: UnresolvedReference[] = [];
  const lineOf = makeLineIndex(content);
  PUBLIC_METHOD_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PUBLIC_METHOD_RE.exec(content)) !== null) {
    const methodName = match[1]!;
    if (!isRoutableControllerMethod(methodName)) continue;
    const line = lineOf(match.index);
    const routePath = conventionRoutePath(controllerPath, methodName);
    refs.push({
      fromNodeId: routeNodeId(filePath, 'ANY', routePath, line),
      referenceName: `${CI_ROUTE_PREFIX}${controllerPath}/${methodName}`,
      referenceKind: 'calls',
      line,
      column: columnAt(content, match.index),
    });
  }
  return refs;
}

function extractLoadedResourceRefs(filePath: string, content: string): UnresolvedReference[] {
  if (!isCodeIgniterApplicationPath(filePath) && !hasCodeIgniterClassSignal(content)) return [];
  const refs: UnresolvedReference[] = [];
  const loaded = new Map<string, LoadedResource>();
  const lineOf = makeLineIndex(content);
  LOAD_CALL_RE.lastIndex = 0;
  let loadMatch: RegExpExecArray | null;
  while ((loadMatch = LOAD_CALL_RE.exec(content)) !== null) {
    const loadedResource = parseLoadedResource(loadMatch);
    if (!loadedResource) continue;
    loaded.set(loadedResource.propertyName, loadedResource.resource);
    refs.push({
      fromNodeId: `file:${filePath}`,
      referenceName: `${CI_SYMBOL_PREFIX}${loadedResource.resource.kind}:${loadedResource.resource.resourcePath}`,
      referenceKind: 'references',
      line: lineOf(loadMatch.index),
      column: columnAt(content, loadMatch.index),
    });
  }

  THIS_MEMBER_CALL_RE.lastIndex = 0;
  let callMatch: RegExpExecArray | null;
  while ((callMatch = THIS_MEMBER_CALL_RE.exec(content)) !== null) {
    const propertyName = callMatch[1]!;
    if (propertyName === 'load') continue;
    const resource = loaded.get(propertyName) ?? inferLoadedResource(propertyName);
    if (!resource) continue;
    refs.push({
      fromNodeId: `file:${filePath}`,
      referenceName: `${CI_MEMBER_PREFIX}${resource.kind}:${resource.resourcePath}.${callMatch[2]!}`,
      referenceKind: 'calls',
      line: lineOf(callMatch.index),
      column: columnAt(content, callMatch.index),
    });
  }
  return refs;
}

function parseLoadedResource(match: RegExpExecArray): { propertyName: string; resource: LoadedResource } | null {
  const kind = match[1] as LoadedResource['kind'];
  const args = stringArgs(match[2] ?? '');
  const resourcePath = args[0];
  if (!resourcePath) return null;
  const alias = kind === 'model' ? args[1] : args[2];
  return {
    propertyName: alias ?? defaultPropertyName(resourcePath),
    resource: { kind, resourcePath },
  };
}

function inferLoadedResource(propertyName: string): LoadedResource | null {
  if (!looksLikeCustomCiProperty(propertyName)) return null;
  const kind = propertyName.toLowerCase().endsWith('_model') ? 'model' : 'library';
  return { kind, resourcePath: propertyName };
}

function resolveRouteRef(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
  const rawTarget = ref.referenceName.slice(CI_ROUTE_PREFIX.length);
  for (const candidate of routeTargetCandidates(rawTarget)) {
    const target = resolveResourceMethod({
      kind: 'controller',
      resourcePath: candidate.controllerPath,
      methodName: candidate.methodName,
      context,
    });
    if (target) return frameworkRef(ref, target, 0.9);
  }
  return null;
}

function resolveResourceRef(
  ref: UnresolvedRef,
  context: ResolutionContext,
  shape: 'symbol' | 'member',
): ResolvedRef | null {
  const raw = ref.referenceName.slice(shape === 'symbol' ? CI_SYMBOL_PREFIX.length : CI_MEMBER_PREFIX.length);
  if (shape === 'symbol') {
    const parsed = parseSymbolRef(raw);
    if (!parsed) return null;
    const target = resolveResourceClass(parsed.kind, parsed.resourcePath, context);
    return target ? frameworkRef(ref, target, 0.85) : null;
  }
  const parsed = parseMemberRef(raw);
  if (!parsed) return null;
  const target = resolveResourceMethod({
    kind: parsed.kind,
    resourcePath: parsed.resourcePath,
    methodName: parsed.methodName,
    context,
  });
  return target ? frameworkRef(ref, target, 0.9) : null;
}

function parseSymbolRef(raw: string): { kind: CodeIgniterResourceKind; resourcePath: string } | null {
  const split = raw.indexOf(':');
  if (split <= 0) return null;
  const kind = raw.slice(0, split);
  if (!isResourceKind(kind)) return null;
  return { kind, resourcePath: raw.slice(split + 1) };
}

function parseMemberRef(
  raw: string,
): { kind: CodeIgniterResourceKind; resourcePath: string; methodName: string } | null {
  const symbol = parseSymbolRef(raw);
  if (!symbol) return null;
  const dot = symbol.resourcePath.lastIndexOf('.');
  if (dot <= 0) return null;
  return {
    kind: symbol.kind,
    resourcePath: symbol.resourcePath.slice(0, dot),
    methodName: symbol.resourcePath.slice(dot + 1),
  };
}

function resolveResourceMethod(args: {
  kind: CodeIgniterResourceKind;
  resourcePath: string;
  methodName: string;
  context: ResolutionContext;
}): string | null {
  const { kind, resourcePath, methodName, context } = args;
  for (const method of methodNameCandidates(methodName)) {
    if (!PHP_IDENTIFIER_RE.test(method)) continue;
    for (const filePath of resourceFileCandidates(kind, resourcePath)) {
      const methodNode = findNodeInFile(context, filePath, method, 'method');
      if (methodNode) return methodNode.id;
      const classNode = findClassInFile(context, filePath);
      if (classNode && method === 'index') return classNode.id;
    }
    const namedMethod = findMethodByResourceClass({ context, kind, resourcePath, methodName: method });
    if (namedMethod) return namedMethod.id;
  }
  return null;
}

function resolveResourceClass(
  kind: CodeIgniterResourceKind,
  resourcePath: string,
  context: ResolutionContext,
): string | null {
  for (const filePath of resourceFileCandidates(kind, resourcePath)) {
    const classNode = findClassInFile(context, filePath);
    if (classNode) return classNode.id;
  }
  for (const className of classNameCandidates(lastPathSegment(resourcePath))) {
    const classNode = context.getNodesByName(className).find((node) => isClassNodeInCiKind(node, kind));
    if (classNode) return classNode.id;
  }
  return null;
}

function findMethodByResourceClass(args: {
  context: ResolutionContext;
  kind: CodeIgniterResourceKind;
  resourcePath: string;
  methodName: string;
}): Node | null {
  const { context, kind, resourcePath, methodName } = args;
  for (const className of classNameCandidates(lastPathSegment(resourcePath))) {
    for (const classNode of context.getNodesByName(className)) {
      if (!isClassNodeInCiKind(classNode, kind)) continue;
      const method = context
        .getNodesInFile(classNode.filePath)
        .find((node) => node.kind === 'method' && node.name === methodName);
      if (method) return method;
      if (methodName === 'index') return classNode;
    }
  }
  return null;
}

function routeTargetCandidates(target: string): RouteTargetCandidate[] {
  const segments = pathSegments(target);
  if (segments.length === 0) return [];
  if (segments.length === 1) return [{ controllerPath: segments[0]!, methodName: 'index' }];
  const candidates: RouteTargetCandidate[] = [];
  for (let methodIdx = 1; methodIdx < segments.length; methodIdx++) {
    candidates.push({
      controllerPath: segments.slice(0, methodIdx).join('/'),
      methodName: segments[methodIdx]!,
    });
  }
  return candidates;
}

function resourceFileCandidates(kind: CodeIgniterResourceKind, resourcePath: string): string[] {
  const segments = pathSegments(resourcePath);
  const last = segments.at(-1);
  if (!last) return [];
  const prefix = resourceDirectory(kind);
  const dirs = segments.slice(0, -1).join('/');
  const directoryPrefix = dirs.length > 0 ? `${dirs}/` : '';
  return unique(classNameCandidates(last).map((className) => `${prefix}${directoryPrefix}${className}.php`));
}

function resourceDirectory(kind: CodeIgniterResourceKind): string {
  switch (kind) {
    case 'controller':
      return 'application/controllers/';
    case 'model':
      return 'application/models/';
    case 'library':
      return 'application/libraries/';
  }
}

function isClassNodeInCiKind(node: Node, kind: CodeIgniterResourceKind): boolean {
  return node.kind === 'class' && normalizePath(node.filePath).startsWith(resourceDirectory(kind));
}

function findNodeInFile(context: ResolutionContext, filePath: string, name: string, kind: Node['kind']): Node | null {
  if (!context.fileExists(filePath)) return null;
  return context.getNodesInFile(filePath).find((node) => node.kind === kind && node.name === name) ?? null;
}

function findClassInFile(context: ResolutionContext, filePath: string): Node | null {
  if (!context.fileExists(filePath)) return null;
  return context.getNodesInFile(filePath).find((node) => node.kind === 'class') ?? null;
}

function isResourceKind(value: string): value is CodeIgniterResourceKind {
  return value === 'model' || value === 'library' || value === 'controller';
}

function classNameCandidates(rawName: string): string[] {
  const normalized = rawName.replaceAll('-', '_');
  return unique([
    normalized,
    uppercaseFirst(normalized),
    snakeToStudly(normalized),
    uppercaseFirst(snakeToStudly(normalized)),
  ]);
}

function methodNameCandidates(rawName: string): string[] {
  return unique([rawName, rawName.replaceAll('-', '_')]);
}

function pathSegments(rawPath: string): string[] {
  return rawPath
    .trim()
    .replaceAll('\\', '/')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

function lastPathSegment(rawPath: string): string {
  return pathSegments(rawPath).at(-1) ?? rawPath;
}

function controllerPathFromFile(filePath: string): string | null {
  const normalized = normalizePath(filePath);
  const prefix = 'application/controllers/';
  if (!normalized.startsWith(prefix) || !normalized.endsWith('.php')) return null;
  return normalized.slice(prefix.length, -4).toLowerCase();
}

function isControllerSource(content: string): boolean {
  return hasCodeIgniterClassSignal(content);
}

function hasCodeIgniterClassSignal(content: string): boolean {
  return (
    content.includes('CI_Controller') ||
    content.includes('MY_Controller') ||
    content.includes('MX_Controller') ||
    content.includes('HMVC_Controller') ||
    content.includes('CI_Model')
  );
}

function isRoutableControllerMethod(methodName: string): boolean {
  return !methodName.startsWith('_') && methodName !== '__construct' && methodName !== '__destruct';
}

function conventionRoutePath(controllerPath: string, methodName: string): string {
  return normalizeRoutePath(methodName === 'index' ? controllerPath : `${controllerPath}/${methodName}`);
}

function routeNode(args: {
  filePath: string;
  method: string;
  routePath: string;
  line: number;
  offset: number;
  content: string;
}): Node {
  const { filePath, method, routePath, line, offset, content } = args;
  const id = routeNodeId(filePath, method, routePath, line);
  return {
    id,
    kind: 'route',
    name: `${method} ${routePath}`,
    qualifiedName: `${filePath}::${method}:${routePath}`,
    filePath,
    language: 'php',
    startLine: line,
    endLine: line,
    startColumn: columnAt(content, offset),
    endColumn: columnAt(content, offset) + routePath.length,
    updatedAt: Date.now(),
  };
}

function routeNodeId(filePath: string, method: string, routePath: string, line: number): string {
  return `route:${filePath}:ci3:${method}:${routePath}:${line}`;
}

function normalizeRoutePath(routePath: string): string {
  const trimmed = trimSlashes(routePath.trim());
  return trimmed.length > 0 ? `/${trimmed}` : '/';
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '/') start++;
  while (end > start && value[end - 1] === '/') end--;
  return value.slice(start, end);
}

function columnAt(content: string, offset: number): number {
  const lineStart = content.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
  return Math.max(0, offset - lineStart);
}

function stringArgs(rawArgs: string): string[] {
  const args: string[] = [];
  STRING_LITERAL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = STRING_LITERAL_RE.exec(rawArgs)) !== null) {
    args.push(match[2]!);
  }
  return args;
}

function defaultPropertyName(resourcePath: string): string {
  return lastPathSegment(resourcePath).toLowerCase();
}

function looksLikeCustomCiProperty(propertyName: string): boolean {
  return /[A-Z]/.test(propertyName) || propertyName.includes('_');
}

function snakeToStudly(rawName: string): string {
  return rawName
    .split('_')
    .filter((part) => part.length > 0)
    .map(uppercaseFirst)
    .join('');
}

function uppercaseFirst(value: string): string {
  return value.length === 0 ? value : `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function frameworkRef(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}

function isCodeIgniterRoutesFile(filePath: string): boolean {
  return normalizePath(filePath) === 'application/config/routes.php';
}

function isCodeIgniterApplicationPath(filePath: string): boolean {
  return /^application\/(?:controllers|models|libraries|config)\//.test(normalizePath(filePath));
}
