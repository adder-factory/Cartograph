/**
 * Hono framework resolver.
 *
 * Hono uses arbitrary receiver variables (`app`, `api`, `users`) rather
 * than Express's common `app` / `router` pair. We first identify
 * `new Hono()` / `new OpenAPIHono()` receivers, then extract routes only
 * from those receivers so unrelated `.get()` calls stay out of the graph.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { stripCommentsForRegex, makeLineIndex } from '../../utils.js';
import { detectTsOrJs } from './detect-language.js';
import { hasPackageDependencyMatching } from './package-dependencies.js';

const HONO_LANGUAGES = ['typescript', 'javascript', 'tsx', 'jsx'] as const;
const HONO_METHODS: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete', 'options', 'all']);
const JS_LIKE_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.xsjs', '.xsjslib'] as const;
const ASCII_UPPER_A = 'A'.codePointAt(0)!;
const ASCII_UPPER_Z = 'Z'.codePointAt(0)!;
const ASCII_LOWER_A = 'a'.codePointAt(0)!;
const ASCII_LOWER_Z = 'z'.codePointAt(0)!;
const ASCII_DIGIT_0 = '0'.codePointAt(0)!;
const ASCII_DIGIT_9 = '9'.codePointAt(0)!;

interface HonoRoute {
  receiver: string;
  method: string;
  routePath: string;
  line: number;
  column: number;
  width: number;
  isMounted: boolean;
}

interface HonoMount {
  parent: string;
  prefix: string;
  child: string;
}

interface ReceiverCall {
  methodName: string;
  index: number;
  openParenIndex: number;
}

interface QuotedArg {
  value: string;
  endIndex: number;
}

interface RouteCollectionArgs {
  content: string;
  lineOf: (index: number) => number;
  receiver: string;
  calls: readonly ReceiverCall[];
}

export const honoResolver: FrameworkResolver = {
  name: 'hono',
  anchors: ['Hono', '.get(', '.post(', '.put(', '.patch(', '.delete(', '.route(', '.on('],

  detect(context: ResolutionContext): boolean {
    if (hasPackageDependencyMatching(context.readFile('package.json'), isHonoDependencyName)) return true;

    for (const file of context.getAllFiles()) {
      if (!isJsLikePath(file)) continue;
      const content = context.readFile(file);
      if (
        content &&
        (hasHonoImport(content) || content.includes('new Hono(') || content.includes('new OpenAPIHono('))
      ) {
        return true;
      }
    }
    return false;
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },

  languages: HONO_LANGUAGES,

  extractNodes(filePath: string, content: string, getStripped?: () => string): Node[] {
    const safe = getStripped ? getStripped() : stripCommentsForRegex(content, 'javascript');
    const receivers = collectHonoReceivers(safe);
    if (receivers.size === 0) return [];

    const lineOf = makeLineIndex(safe);
    const routes: HonoRoute[] = [];
    const mounts: HonoMount[] = [];
    for (const receiver of receivers) {
      const calls = collectReceiverCalls(safe, receiver);
      const routeArgs = { content: safe, lineOf, receiver, calls };
      const receiverRoutes = [...collectMethodRoutes(routeArgs), ...collectOnRoutes(routeArgs)];
      routes.push(...receiverRoutes);
      mounts.push(...collectRouteMounts(safe, receiver, calls));
    }

    return toRouteNodes(filePath, [...routes, ...buildMountedRoutes(routes, mounts)]);
  },
};

function isHonoDependencyName(name: string): boolean {
  return name === 'hono' || name.startsWith('@hono/');
}

function hasHonoImport(content: string): boolean {
  return (
    content.includes("from 'hono'") ||
    content.includes('from "hono"') ||
    content.includes("require('hono')") ||
    content.includes('require("hono")') ||
    content.includes("from '@hono/") ||
    content.includes('from "@hono/') ||
    content.includes("require('@hono/") ||
    content.includes('require("@hono/')
  );
}

function collectHonoReceivers(content: string): Set<string> {
  const receivers = new Set<string>();
  for (const line of content.split('\n')) {
    const receiver = receiverFromHonoDeclaration(line);
    if (receiver) receivers.add(receiver);
  }
  return receivers;
}

function receiverFromHonoDeclaration(line: string): string | null {
  const newIndex = firstPresentIndex(line, ['new Hono', 'new OpenAPIHono']);
  if (newIndex === -1) return null;
  const equalsIndex = line.lastIndexOf('=', newIndex);
  if (equalsIndex === -1) return null;
  const declaration = line.slice(0, equalsIndex).trim();
  const cleaned = stripLeadingKeyword(stripLeadingKeyword(declaration, 'export'), 'default');
  const receiver = lastWhitespaceSeparatedToken(cleaned);
  return receiver && isIdentifier(receiver) ? receiver : null;
}

function stripLeadingKeyword(value: string, keyword: string): string {
  if (value === keyword) return '';
  const prefix = `${keyword} `;
  return value.startsWith(prefix) ? value.slice(prefix.length).trimStart() : value;
}

function firstPresentIndex(value: string, needles: readonly string[]): number {
  let best = -1;
  for (const needle of needles) {
    const index = value.indexOf(needle);
    if (index !== -1 && (best === -1 || index < best)) best = index;
  }
  return best;
}

function lastWhitespaceSeparatedToken(value: string): string {
  let end = value.length;
  while (end > 0 && isWhitespace(value[end - 1])) end--;
  let start = end;
  while (start > 0 && !isWhitespace(value[start - 1])) start--;
  return value.slice(start, end);
}

function collectReceiverCalls(content: string, receiver: string): ReceiverCall[] {
  const calls: ReceiverCall[] = [];
  const token = `${receiver}.`;
  let index = content.indexOf(token);
  while (index !== -1) {
    if (isReceiverBoundary(content, index)) {
      const methodStart = index + token.length;
      const methodName = readIdentifier(content, methodStart);
      const openParenIndex = skipWhitespace(content, methodStart + methodName.length);
      if (methodName && content[openParenIndex] === '(') {
        calls.push({ methodName, index, openParenIndex });
      }
    }
    index = content.indexOf(token, index + token.length);
  }
  return calls;
}

function isReceiverBoundary(content: string, index: number): boolean {
  return index === 0 || !isIdentifierChar(content[index - 1]);
}

function collectMethodRoutes(args: RouteCollectionArgs): HonoRoute[] {
  const { content, lineOf, receiver, calls } = args;
  const routes: HonoRoute[] = [];
  for (const call of calls) {
    if (!HONO_METHODS.has(call.methodName)) continue;
    const routeArg = readQuotedArg(content, call.openParenIndex + 1);
    if (!routeArg) continue;
    routes.push(
      routeFromCall({ receiver, method: call.methodName.toUpperCase(), routePath: routeArg.value, call, lineOf }),
    );
  }
  return routes;
}

function collectOnRoutes(args: RouteCollectionArgs): HonoRoute[] {
  const { content, lineOf, receiver, calls } = args;
  const routes: HonoRoute[] = [];
  for (const call of calls) {
    if (call.methodName !== 'on') continue;
    const methodArg = readQuotedArg(content, call.openParenIndex + 1);
    if (!methodArg) continue;
    const commaIndex = nextCommaIndex(content, methodArg.endIndex);
    if (commaIndex === -1) continue;
    const routeArg = readQuotedArg(content, commaIndex + 1);
    if (!routeArg) continue;
    routes.push(
      routeFromCall({ receiver, method: methodArg.value.toUpperCase(), routePath: routeArg.value, call, lineOf }),
    );
  }
  return routes;
}

function collectRouteMounts(content: string, receiver: string, calls: readonly ReceiverCall[]): HonoMount[] {
  const mounts: HonoMount[] = [];
  for (const call of calls) {
    if (call.methodName !== 'route') continue;
    const prefixArg = readQuotedArg(content, call.openParenIndex + 1);
    if (!prefixArg) continue;
    const commaIndex = nextCommaIndex(content, prefixArg.endIndex);
    if (commaIndex === -1) continue;
    const childStart = skipWhitespace(content, commaIndex + 1);
    const child = readIdentifier(content, childStart);
    if (child) mounts.push({ parent: receiver, prefix: prefixArg.value, child });
  }
  return mounts;
}

function routeFromCall(args: {
  receiver: string;
  method: string;
  routePath: string;
  call: ReceiverCall;
  lineOf: (index: number) => number;
}): HonoRoute {
  const { receiver, method, routePath, call, lineOf } = args;
  return {
    receiver,
    method,
    routePath,
    line: lineOf(call.index),
    column: 0,
    width: call.openParenIndex - call.index + 1,
    isMounted: false,
  };
}

function buildMountedRoutes(routes: readonly HonoRoute[], mounts: readonly HonoMount[]): HonoRoute[] {
  const out: HonoRoute[] = [];
  for (const mount of mounts) {
    for (const route of routes) {
      if (route.receiver !== mount.child) continue;
      out.push({
        ...route,
        receiver: mount.parent,
        routePath: joinHonoPaths(mount.prefix, route.routePath),
        isMounted: true,
      });
    }
  }
  return out;
}

function toRouteNodes(filePath: string, routes: readonly HonoRoute[]): Node[] {
  const now = Date.now();
  const seen = new Set<string>();
  const nodes: Node[] = [];
  for (const route of routes) {
    const key = `${route.method}:${route.routePath}:${route.line}:${route.isMounted ? 'mounted' : 'direct'}`;
    if (seen.has(key)) continue;
    seen.add(key);
    nodes.push({
      id: `route:${filePath}:${route.method}:${route.routePath}:${route.line}:${route.isMounted ? 'mounted' : 'direct'}`,
      kind: 'route',
      name: `${route.method} ${route.routePath}`,
      qualifiedName: `${filePath}::${route.method}:${route.routePath}`,
      filePath,
      startLine: route.line,
      endLine: route.line,
      startColumn: route.column,
      endColumn: route.column + route.width,
      language: detectTsOrJs(filePath),
      updatedAt: now,
    });
  }
  return nodes;
}

function readQuotedArg(content: string, startIndex: number): QuotedArg | null {
  let i = skipWhitespace(content, startIndex);
  const quote = content[i];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  i++;
  while (i < content.length) {
    const ch = content[i];
    if (ch === quote) return { value, endIndex: i + 1 };
    if (ch === '\\' && i + 1 < content.length) {
      value += ch + content[i + 1];
      i += 2;
      continue;
    }
    value += ch ?? '';
    i++;
  }
  return null;
}

function nextCommaIndex(content: string, startIndex: number): number {
  let i = startIndex;
  while (i < content.length) {
    const ch = content[i];
    if (ch === ',') return i;
    if (ch === '\n' || ch === ')') return -1;
    i++;
  }
  return -1;
}

function skipWhitespace(content: string, startIndex: number): number {
  let i = startIndex;
  while (i < content.length) {
    const ch = content[i];
    if (!isWhitespace(ch)) return i;
    i++;
  }
  return i;
}

function isWhitespace(ch: string | undefined): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function readIdentifier(content: string, startIndex: number): string {
  let i = startIndex;
  while (i < content.length && isIdentifierChar(content[i])) i++;
  return content.slice(startIndex, i);
}

function isIdentifier(value: string): boolean {
  if (!value || !isIdentifierStart(value[0])) return false;
  for (let i = 1; i < value.length; i++) {
    if (!isIdentifierChar(value[i])) return false;
  }
  return true;
}

function isIdentifierStart(ch: string | undefined): boolean {
  return ch === '_' || ch === '$' || isAsciiLetter(ch);
}

function isIdentifierChar(ch: string | undefined): boolean {
  return isIdentifierStart(ch) || isAsciiDigit(ch);
}

function isAsciiLetter(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return (code >= ASCII_UPPER_A && code <= ASCII_UPPER_Z) || (code >= ASCII_LOWER_A && code <= ASCII_LOWER_Z);
}

function isAsciiDigit(ch: string | undefined): boolean {
  if (!ch) return false;
  const code = ch.codePointAt(0) ?? 0;
  return code >= ASCII_DIGIT_0 && code <= ASCII_DIGIT_9;
}

function joinHonoPaths(prefix: string, routePath: string): string {
  const left = stripTrailingSlashes(prefix);
  const right = stripLeadingSlashes(routePath);
  const joined = [left === '/' ? '' : left, right === '/' ? '' : right].filter(Boolean).join('/');
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}

function stripLeadingSlashes(value: string): string {
  let start = 0;
  while (start < value.length - 1 && value[start] === '/') start++;
  return value.slice(start);
}

function isJsLikePath(filePath: string): boolean {
  return JS_LIKE_EXTENSIONS.some((extension) => filePath.endsWith(extension));
}
