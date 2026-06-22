/**
 * `Bun.serve` Framework Resolver — emits `kind:'route'` nodes for each
 * route declared in a `Bun.serve({ routes: { ... } })` call.
 *
 * The pre-2026-05-22 entry_points tool's HTTP-routes bucket recognised
 * Express / Laravel / Go / .NET / Django / Rails — but not Bun.serve,
 * the Bun-native HTTP API every 2026 Bun-runtime project ships with.
 * Bug #2 from the G16 polyglot arc: a real-world Bun monorepo (nextssh)
 * declared 30 routes via `Bun.serve({ routes: {...} })` and ALL 30 were
 * invisible to entry_points. This resolver closes that gap.
 *
 * Two route-value shapes are supported, matching Bun's API:
 *
 *   1. **Single handler** — `'/path': handler`. One `route` node emitted
 *      with `name = '/path'` (no method prefix; Bun.serve dispatches on
 *      Request.method inside the handler, so the method isn't carried
 *      on the key).
 *   2. **Method-explicit** — `'/path': { GET: handlerA, POST: handlerB }`.
 *      One `route` node per method, `name = 'GET /path'` / `'POST /path'`
 *      etc. — matches the Express resolver's convention so the
 *      entry_points bucket renders uniformly across frameworks.
 *
 * Extraction strategy: regex-locate `Bun.serve(` call sites, walk the
 * matching parentheses to find the call body, then locate `routes: {`
 * and walk the matching braces to find the routes block. Iterate
 * top-level path entries within that block via a regex tuned to npm-
 * style path literals (single / double / backtick quoted strings
 * starting with `/`). The brace/paren walker tracks string state so
 * `'}'` inside a handler's body literal doesn't confuse the depth count.
 *
 * Same regex-based shape the Express resolver uses; we deliberately do
 * NOT reach for the AST here. The trade-off matches the rest of the
 * frameworks/ directory — false positives are rare in practice (a
 * stray `Bun.serve` token inside a comment-stripped doc block would be
 * the only realistic shape), and the pattern stays one focused file.
 *
 * Method-explicit value shape gating: when the value after `'/path':`
 * opens with `{`, we treat that block as a method map IFF its first
 * key is an HTTP method literal (`GET` / `POST` / `PUT` / `PATCH` /
 * `DELETE` / `HEAD` / `OPTIONS`). A `{ key: 'value' }` shape that
 * doesn't open with a method key is ignored entirely (defensive — a
 * future shape could legitimately use an object value that isn't a
 * method map; we'd rather under-collect than emit garbage).
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, UnresolvedRef, ResolvedRef } from '../types.js';
import { stripCommentsForRegex, makeLineIndex } from '../../utils.js';
import { detectTsOrJs } from './detect-language.js';
import { hasPackageDependency } from './package-dependencies.js';

/** HTTP methods Bun.serve's per-method route shape supports. */
const BUN_SERVE_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
const BUN_SERVE_DEPENDENCIES = ['@types/bun', 'bun'] as const;

export const bunServeResolver: FrameworkResolver = {
  name: 'bun-serve',
  // F#73 — the regex pattern is `\bBun\.serve\s*\(`; the literal
  // `Bun.serve` MUST appear in the file for any route to extract.
  anchors: ['Bun.serve'],

  detect(context: ResolutionContext): boolean {
    // Signal A: `@types/bun` or `bun` in package.json (Bun-runtime
    // projects always declare one or the other for typings).
    if (hasPackageDependency(context.readFile('package.json'), BUN_SERVE_DEPENDENCIES)) return true;
    // Signal B: bunfig.toml at the project root — bun-native project.
    if (context.readFile('bunfig.toml') !== null) return true;
    // Signal C: source-level `Bun.serve(` token anywhere in the indexed
    // files. Lets non-package.json shapes (rare but possible — e.g. a
    // single-file Bun script) still trigger extraction.
    for (const file of context.getAllFiles()) {
      if (!/\.(?:tsx?|jsx?|mts|cts|mjs|cjs)$/.test(file)) continue;
      const content = context.readFile(file);
      if (content?.includes('Bun.serve')) return true;
    }
    return false;
  },

  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    // No framework-specific name resolution. Bun.serve route handlers
    // are just function references; the standard name-matcher in the
    // resolver pipeline picks them up via the import / qualified-name
    // paths.
    return null;
  },

  languages: ['typescript', 'javascript', 'tsx', 'jsx'],

  extractNodes(filePath: string, content: string, getStripped?: () => string): Node[] {
    if (!content.includes('Bun.serve')) return [];
    const nodes: Node[] = [];
    const now = Date.now();
    // Neutralise comments and JSDoc blocks so a doc-block example of
    // `Bun.serve({ routes: { '/x': h } })` doesn't extract as a real
    // route. Mirrors the express resolver's defence.
    const safe = getStripped ? getStripped() : stripCommentsForRegex(content, 'javascript');
    const lineOf = makeLineIndex(safe);
    const language = detectTsOrJs(filePath);

    const callRe = /\bBun\.serve\s*\(/g;
    let callMatch: RegExpExecArray | null;
    while ((callMatch = callRe.exec(safe)) !== null) {
      const routesBlock = findBunServeRoutesBlock(safe, callMatch);
      if (!routesBlock) continue;
      const routesCloseIdx = findMatchingClose({
        source: safe,
        openIdx: routesBlock.routesOpenIdx,
        openChar: '{',
        closeChar: '}',
      });
      if (routesCloseIdx === -1 || routesCloseIdx > routesBlock.closeParenIdx) continue;

      // Walk top-level path entries inside the routes block.
      collectRouteEntries({
        safe,
        lineOf,
        routesBodyStart: routesBlock.routesOpenIdx + 1,
        routesBodyEnd: routesCloseIdx,
        filePath,
        language,
        now,
        out: nodes,
      });
    }

    return nodes;
  },
};

function findBunServeRoutesBlock(
  safe: string,
  callMatch: RegExpExecArray,
): { routesOpenIdx: number; closeParenIdx: number } | null {
  // `callMatch.index` points at `B` in `Bun.serve(`; the `(` is at
  // `callMatch.index + callMatch[0].length - 1`.
  const openParenIdx = callMatch.index + callMatch[0].length - 1;
  const closeParenIdx = findMatchingClose({ source: safe, openIdx: openParenIdx, openChar: '(', closeChar: ')' });
  if (closeParenIdx === -1) return null;

  const configOpenIdx = firstNonWhitespaceIndex(safe, openParenIdx + 1, closeParenIdx);
  if (safe[configOpenIdx] !== '{') return null;

  const routesMatch = findTopLevelRoutesMatch(safe, configOpenIdx + 1, closeParenIdx);
  if (!routesMatch) return null;
  return { routesOpenIdx: routesMatch.index + routesMatch[0].length - 1, closeParenIdx };
}

function firstNonWhitespaceIndex(safe: string, start: number, limit: number): number {
  let i = start;
  while (i < limit && /\s/.test(safe[i] ?? '')) i++;
  return i;
}

function findTopLevelRoutesMatch(safe: string, configBodyStart: number, closeParenIdx: number): RegExpExecArray | null {
  const routesKeyRe = /\broutes\s*:\s*\{/g;
  routesKeyRe.lastIndex = configBodyStart;
  let routesMatch: RegExpExecArray | null;
  while ((routesMatch = routesKeyRe.exec(safe)) !== null) {
    if (routesMatch.index >= closeParenIdx) return null;
    if (depthAtIndex(safe, configBodyStart, routesMatch.index) === 0) return routesMatch;
  }
  return null;
}

interface CollectRouteEntriesArgs {
  safe: string;
  lineOf: (offset: number) => number;
  routesBodyStart: number;
  routesBodyEnd: number;
  filePath: string;
  language: Node['language'];
  now: number;
  out: Node[];
}

/**
 * Iterate top-level path entries inside a `routes: { ... }` block and
 * push one (or more) `kind:'route'` node(s) per entry.
 *
 * Single-handler entries (`'/path': handler`) emit ONE node named
 * just `/path`. Method-explicit entries (`'/path': { GET: h, POST: h }`)
 * emit one node per declared method, named `'<METHOD> /path'` to match
 * the Express resolver's convention. The method map is recognised by
 * its first-key matching one of {@link BUN_SERVE_METHODS}.
 */
function collectRouteEntries(args: CollectRouteEntriesArgs): void {
  const { safe, lineOf, routesBodyStart, routesBodyEnd, filePath, language, now, out } = args;
  // Match each `'/<path>':` or `"/<path>":` or `` `/<path>`: `` entry.
  // Quote group + path group; we require the path to start with `/`
  // so a generic config-object key like `description:` can't match.
  const entryRe = /(['"`])(\/[^'"`\r\n]*)\1\s*:/g;
  entryRe.lastIndex = routesBodyStart;
  let entry: RegExpExecArray | null;
  while ((entry = entryRe.exec(safe)) !== null) {
    if (entry.index >= routesBodyEnd) break;
    const path = entry[2]!;
    // Skip entries that aren't at the routes block's top level —
    // depth > 0 indicates we're inside a method map's body and that
    // entry is a method handler, not a sub-route.
    if (depthAtIndex(safe, routesBodyStart, entry.index) > 0) continue;
    const valueStart = entry.index + entry[0].length;
    const line = lineOf(entry.index);
    const baseColumn = entry.index - safe.lastIndexOf('\n', entry.index - 1) - 1;
    const methodMap = readMethodMap(safe, valueStart, routesBodyEnd);
    if (methodMap !== null && methodMap.length > 0) {
      for (const method of methodMap) {
        out.push(buildRouteNode({ filePath, path, method, line, baseColumn, language, now }));
      }
    } else {
      out.push(buildRouteNode({ filePath, path, method: null, line, baseColumn, language, now }));
    }
  }
}

interface BuildRouteNodeArgs {
  filePath: string;
  path: string;
  method: string | null;
  line: number;
  baseColumn: number;
  language: Node['language'];
  now: number;
}

function buildRouteNode(args: BuildRouteNodeArgs): Node {
  const { filePath, path, method, line, baseColumn, language, now } = args;
  const name = method === null ? path : `${method} ${path}`;
  const idMethod = method ?? 'BUN';
  return {
    id: `route:${filePath}:${idMethod}:${path}:${line}`,
    kind: 'route',
    name,
    qualifiedName: `${filePath}::${idMethod}:${path}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: baseColumn,
    endColumn: baseColumn + name.length,
    language,
    updatedAt: now,
  };
}

/**
 * If the value at `valueStart` is `{ <METHOD>: ..., ... }` (a Bun.serve
 * method map), return the list of declared methods in source order.
 * Returns `null` otherwise (caller emits a single path-only route).
 *
 * The recogniser walks past whitespace, asserts the next non-space
 * character is `{`, walks to the matching `}`, then matches keys at
 * depth-1 inside that block via a regex tuned to bare-identifier
 * method names (`GET`, `POST`, …). String-quoted method keys
 * (`'GET': handler`) are also matched — Bun's typing allows both.
 */
function readMethodMap(safe: string, valueStart: number, limit: number): string[] | null {
  let i = valueStart;
  while (i < limit && /\s/.test(safe[i] ?? '')) i++;
  if (safe[i] !== '{') return null;
  const closeIdx = findMatchingClose({ source: safe, openIdx: i, openChar: '{', closeChar: '}' });
  if (closeIdx === -1 || closeIdx > limit) return null;
  // Start the scan AT the opening `{` (not after it) so the brace
  // itself is the leading delimiter the regex's `[,{\s]` matches.
  // Pre-2026-05-22 the scan started at `i + 1` and the anchor used
  // `(?:^|[,{\s])`, but `^` only matches at string position 0 (never
  // at a `lastIndex > 0`), so a brace-tight method map like
  // `{GET: handler}` (no whitespace after `{`) silently missed the
  // first key. With `lastIndex = i` the regex matches `{` as the
  // delimiter and the first method key is picked up cleanly.
  const blockStart = i + 1;
  const methodKeyRe = /[,{\s]\s*(?:(['"`])([A-Z]+)\1|([A-Z]+))\s*:/g;
  methodKeyRe.lastIndex = i;
  const methods: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = methodKeyRe.exec(safe)) !== null) {
    if (m.index >= closeIdx) break;
    // Require depth 1 (we're inside the method map's first level).
    if (depthAtIndex(safe, blockStart, m.index) > 0) continue;
    const candidate = m[2] ?? m[3]!;
    if (!BUN_SERVE_METHODS.includes(candidate as (typeof BUN_SERVE_METHODS)[number])) continue;
    if (!methods.includes(candidate)) methods.push(candidate);
  }
  return methods.length > 0 ? methods : null;
}

/** Arg bundle for `findMatchingClose` — keeps the helper at the
 *  long_parameter_list info-tier floor (≤3 positional params) per
 *  CLAUDE.md biomarker conventions. */
interface FindMatchingCloseArgs {
  source: string;
  openIdx: number;
  openChar: string;
  closeChar: string;
}

/**
 * Walk `source` from `openIdx` to the matching `closeChar`, respecting
 * nested `openChar`/`closeChar` pairs AND string-literal state so a
 * brace inside a handler's body literal can't unbalance the count.
 * Returns the closing index, or -1 when the document runs out before
 * the close is found.
 */
function findMatchingClose(args: FindMatchingCloseArgs): number {
  const { source, openIdx, openChar, closeChar } = args;
  if (source[openIdx] !== openChar) return -1;
  let depth = 0;
  let inString: string | null = null;
  for (let i = openIdx; i < source.length; i++) {
    const c = source[i];
    if (inString !== null) {
      const consumed = consumeStringChar(c, inString);
      inString = consumed.inString;
      if (consumed.skipNext) i++;
      continue;
    }
    if (isStringDelimiter(c)) {
      inString = c;
      continue;
    }
    depth = updateMatchingDepth({ c, depth, openChar, closeChar });
    if (depth === 0) return i;
  }
  return -1;
}

function isStringDelimiter(c: string | undefined): c is string {
  return c === '"' || c === "'" || c === '`';
}

function updateMatchingDepth(args: {
  c: string | undefined;
  depth: number;
  openChar: string;
  closeChar: string;
}): number {
  const { c, depth, openChar, closeChar } = args;
  if (c === openChar) return depth + 1;
  if (c === closeChar) return depth - 1;
  return depth;
}

function consumeStringChar(c: string | undefined, inString: string): { inString: string | null; skipNext: boolean } {
  if (c === '\\') return { inString, skipNext: true };
  return { inString: c === inString ? null : inString, skipNext: false };
}

function updateBraceDepth(c: string | undefined, depth: number): number {
  if (c === '{') return depth + 1;
  if (c === '}') return depth - 1;
  return depth;
}

/**
 * Count net `{` over `}` between `from` and `at`, ignoring text inside
 * string literals. Used to gate `collectRouteEntries` and
 * `readMethodMap`: a `'/x':` entry that lives inside a handler's body
 * literal `{ if (cond) { return ... } }` would otherwise leak as a
 * spurious route.
 */
function depthAtIndex(s: string, from: number, at: number): number {
  let depth = 0;
  let inString: string | null = null;
  for (let i = from; i < at; i++) {
    const c = s[i];
    if (inString !== null) {
      const next = consumeStringChar(c, inString);
      inString = next.inString;
      if (next.skipNext) {
        i++;
      }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      inString = c;
      continue;
    }
    depth = updateBraceDepth(c, depth);
  }
  return depth;
}
