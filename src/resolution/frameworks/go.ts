/**
 * Go Framework Resolver
 *
 * Handles Gin, Echo, Fiber, Chi, and standard library patterns.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, UnresolvedRef, ResolvedRef, ResolutionContext } from '../types.js';
import { stripCommentsForRegex, makeLineIndex } from '../../utils.js';

export const goResolver: FrameworkResolver = {
  name: 'go',

  detect(context: ResolutionContext): boolean {
    // Check for go.mod file (Go modules)
    const goMod = context.readFile('go.mod');
    if (goMod) {
      return true;
    }

    // Check for .go files
    const allFiles = context.getAllFiles();
    return allFiles.some((f) => f.endsWith('.go'));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // ref.filePath threaded into every resolveByNameAndKind call so the
    // proximity tiebreak picks the same-file / same-package candidate
    // when multiple same-named candidates exist (see Agent A FP1 — the
    // ollama bug where 13 of 14 Options-embed edges resolved to bert's
    // Options because alphabetical order made it `pool[0]`).
    const refFilePath = ref.filePath;

    // Pattern 1: Handler references
    if (ref.referenceName.endsWith('Handler') || ref.referenceName.startsWith('Handle')) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kind: 'function',
        preferredDirs: HANDLER_DIRS,
        context,
        refFilePath,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 2: Service/Repository references
    if (
      ref.referenceName.endsWith('Service') ||
      ref.referenceName.endsWith('Repository') ||
      ref.referenceName.endsWith('Store')
    ) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kind: null,
        preferredDirs: SERVICE_DIRS,
        context,
        kinds: SERVICE_KINDS,
        refFilePath,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.8,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 3: Middleware references
    if (
      ref.referenceName.endsWith('Middleware') ||
      ref.referenceName.startsWith('Auth') ||
      ref.referenceName.startsWith('Log')
    ) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kind: 'function',
        preferredDirs: MIDDLEWARE_DIRS,
        context,
        refFilePath,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.75,
          resolvedBy: 'framework',
        };
      }
    }

    // Pattern 4: Model/Entity references (typically PascalCase structs)
    if (/^[A-Z][a-zA-Z]+$/.test(ref.referenceName)) {
      const result = resolveByNameAndKind({
        name: ref.referenceName,
        kind: 'struct',
        preferredDirs: MODEL_DIRS,
        context,
        refFilePath,
      });
      if (result) {
        return {
          original: ref,
          targetNodeId: result,
          confidence: 0.7,
          resolvedBy: 'framework',
        };
      }
    }

    return null;
  },

  languages: ['go'],

  extractNodes(filePath: string, content: string, getStripped?: () => string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    // Strip comments before regex matching so commented-out examples in
    // doc comments / migration notes don't fire as real routes. Preserves
    // line numbers via blank-newline substitution, so match.index → line.
    const safe = getStripped ? getStripped() : stripCommentsForRegex(content, 'go');
    const lineOf = makeLineIndex(safe);

    // Extract Gin routes
    // r.GET("/path", handler), router.POST("/path", handler), etc.
    const ginRoutePattern = /\.\s*(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s*\(\s*["']([^"']+)["']/g;
    collectGoRegexRoutes({ nodes, pattern: ginRoutePattern, safe, lineOf, filePath, now });

    // Extract Echo routes
    // e.GET("/path", handler)
    const echoRoutePattern = /e\.\s*(GET|POST|PUT|PATCH|DELETE)\s*\(\s*["']([^"']+)["']/g;
    collectGoRegexRoutes({ nodes, pattern: echoRoutePattern, safe, lineOf, filePath, now });

    // Extract Chi routes
    // r.Get("/path", handler), r.Post("/path", handler)
    // (?<!\w) prevents matching the `r.` suffix inside words like
    // `Header.Get("X-Foo")` where the `r` in "Header" would otherwise fire.
    // The path string MUST start with `/` — Chi (and every HTTP router) only
    // mounts slash-rooted paths. This kills the false-positive class where a
    // non-router type also happens to have a `Get(key string)` method, e.g.
    // a registry lookup `r.Get("bash")` (6 such fires in ollama's tool
    // registry tests). Confirmed in Chi's own docs / examples that every
    // route literal is slash-rooted.
    const chiRoutePattern = /(?<!\w)r\.\s*(Get|Post|Put|Patch|Delete)\s*\(\s*["'](\/[^"']*)["']/g;
    collectGoRegexRoutes({
      nodes,
      pattern: chiRoutePattern,
      safe,
      lineOf,
      filePath,
      now,
      normalizeMethod: (method) => method.toUpperCase(),
    });

    // Extract standard library net/http patterns:
    //   http.HandleFunc("/path", h)                         — DefaultServeMux
    //   mux.Handle("/path", h) / mux.HandleFunc("/path", h) — explicit *ServeMux
    //   Go 1.22+ method-prefix syntax: "GET /api/users", "POST /api/users/{id}", etc.
    //
    // The receiver `mux` is matched by NAME, not by type — cartograph has
    // no Go type-info at this layer. A non-ServeMux variable named `mux`
    // (rare in practice — `mux` is the canonical *http.ServeMux name) with
    // a `/path` string arg would fire spuriously. Practical FP rate is low;
    // the spec-must-contain-`/` guard plus the comment-strip pre-pass take
    // care of the remaining noise.
    //
    // Splits method-prefix specs into (METHOD, path); falls back to ANY
    // method when no method prefix is present.
    const httpHandlePattern = /(?<!\w)(?:http|mux)\.(Handle|HandleFunc)\s*\(\s*["']([^"'\n]*\/[^"'\n]*)["']/g;
    let match: RegExpExecArray | null;
    while ((match = httpHandlePattern.exec(safe)) !== null) {
      const spec = match[2]!.trim();
      const methodPrefixMatch = /^([A-Z]+)\s+(\/.*)$/.exec(spec);
      const method = methodPrefixMatch ? methodPrefixMatch[1]! : 'ANY';
      const routePath = methodPrefixMatch ? methodPrefixMatch[2]! : spec;
      const line = lineOf(match.index);

      nodes.push(goRouteNode({ filePath, method, routePath, line, endColumn: match[0].length, now }));
    }

    // Extract cobra subcommands — the dominant CLI framework in Go (kubectl,
    // helm, gh, docker, ollama, etc.). Each `&cobra.Command{ Use: "verb ..." }`
    // (or value-form `cobra.Command{ Use: "..." }`) becomes a `route` node
    // named `cmd <verb>`, matching the convention the commander/yargs/cac
    // resolver uses for JS/TS so the cli bucket in entry-points aggregates
    // both surfaces.
    //
    // The 400-char body window catches the typical struct-literal shape
    // where Use is in the first handful of fields (Aliases / Short /
    // Args / RunE follow). Lazy quantifier locks on the FIRST `Use:` per
    // literal so nested handler structs that happen to define their own
    // `Use` later don't double-fire.
    const cobraCommandPattern = /(?<!\w)(?:&\s*)?cobra\.Command\s*\{[\s\S]{0,400}?Use:\s*["']([^"'\n]+?)["']/g;
    const cobraSeen = new Set<string>();

    while ((match = cobraCommandPattern.exec(safe)) !== null) {
      const useString = match[1]!.trim();
      // First whitespace-separated token is the verb (`create MODEL` → `create`).
      const verb = useString.split(/\s+/)[0];
      if (!verb) continue;
      // Defensive skips for malformed Use strings.
      if (verb.startsWith('-') || verb.startsWith('/') || verb.includes('.')) continue;

      const line = lineOf(match.index);
      const id = `cli:${filePath}:${verb}:${line}`;
      if (cobraSeen.has(id)) continue;
      cobraSeen.add(id);
      nodes.push(goCliNode({ id, filePath, verb, line, endColumn: match[0].length, signature: useString, now }));
    }

    return nodes;
  },
};

interface CollectGoRegexRoutesArgs {
  nodes: Node[];
  pattern: RegExp;
  safe: string;
  lineOf: (index: number) => number;
  filePath: string;
  now: number;
  normalizeMethod?: (method: string) => string;
}

function collectGoRegexRoutes(args: CollectGoRegexRoutesArgs): void {
  const { nodes, pattern, safe, lineOf, filePath, now, normalizeMethod } = args;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(safe)) !== null) {
    const [, rawMethod, routePath] = match;
    const method = normalizeMethod ? normalizeMethod(rawMethod!) : rawMethod!;
    const line = lineOf(match.index);
    nodes.push(goRouteNode({ filePath, method, routePath: routePath!, line, endColumn: match[0].length, now }));
  }
}

interface GoRouteNodeArgs {
  filePath: string;
  method: string;
  routePath: string;
  line: number;
  endColumn: number;
  now: number;
}

function goRouteNode(args: GoRouteNodeArgs): Node {
  const { filePath, method, routePath, line, endColumn, now } = args;
  return {
    id: `route:${filePath}:${method}:${routePath}:${line}`,
    kind: 'route',
    name: `${method} ${routePath}`,
    qualifiedName: `${filePath}::${method}:${routePath}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn,
    language: 'go',
    updatedAt: now,
  };
}

interface GoCliNodeArgs {
  id: string;
  filePath: string;
  verb: string;
  line: number;
  endColumn: number;
  signature: string;
  now: number;
}

function goCliNode(args: GoCliNodeArgs): Node {
  const { id, filePath, verb, line, endColumn, signature, now } = args;
  return {
    id,
    kind: 'route',
    name: `cmd ${verb}`,
    qualifiedName: `${filePath}::cmd:${verb}`,
    filePath,
    startLine: line,
    endLine: line,
    startColumn: 0,
    endColumn,
    language: 'go',
    signature,
    updatedAt: now,
  };
}

// Directory patterns for framework resolution
const HANDLER_DIRS = ['handler', 'handlers', 'api', 'routes', 'controller', 'controllers'];
const SERVICE_DIRS = ['service', 'services', 'repository', 'store', 'pkg'];
const MIDDLEWARE_DIRS = ['middleware', 'middlewares'];
const MODEL_DIRS = ['model', 'models', 'entity', 'entities', 'domain', 'pkg'];
const SERVICE_KINDS = new Set(['struct', 'interface']);

/** Arguments for {@link resolveByNameAndKind}. */
interface ResolveByNameAndKindArgs {
  name: string;
  /** Single preferred kind. Ignored when `kinds` is set. */
  kind: string | null;
  preferredDirs: string[];
  context: ResolutionContext;
  /** Multi-kind filter — used when more than one kind is acceptable. */
  kinds?: Set<string> | undefined;
  /** Originating file path of the reference — used to break ties
   *  among multiple preferred-dir candidates by directory proximity. */
  refFilePath?: string;
}

/**
 * Count shared leading directory segments between two file paths.
 * Higher = closer in the directory tree. Same as
 * `name-matcher.ts:computePathProximity`'s leading segment count.
 */
function sharedDirSegments(a: string, b: string): number {
  const da = a.split('/').slice(0, -1);
  const db = b.split('/').slice(0, -1);
  let shared = 0;
  for (let i = 0; i < Math.min(da.length, db.length); i++) {
    if (da[i] === db[i]) shared++;
    else break;
  }
  return shared;
}

/**
 * Sort candidates by descending proximity to `refFilePath`: exact
 * same-file wins outright, then nearest by shared-segment count.
 * Mutates `arr`; returns it for chaining.
 */
function sortByProximityToRef<T extends Node>(arr: T[], refFilePath: string): T[] {
  arr.sort((a, b) => {
    const aSame = a.filePath === refFilePath ? 1 : 0;
    const bSame = b.filePath === refFilePath ? 1 : 0;
    if (aSame !== bSame) return bSame - aSame; // same-file first
    return sharedDirSegments(b.filePath, refFilePath) - sharedDirSegments(a.filePath, refFilePath);
  });
  return arr;
}

/**
 * Resolve a symbol by name using indexed queries instead of scanning
 * all files. Uses getNodesByName (O(log n) indexed lookup) instead of
 * iterating every file.
 *
 * Proximity tiebreak: when multiple candidates survive the kind +
 * preferred-dirs filters AND the caller passed `refFilePath`, prefer
 * (in order): same file > same directory > nearest by shared-segment
 * count. Without this, alphabetical name-index order picks an arbitrary
 * "winner" — caught against ollama where every `model/models/<pkg>/model.go`
 * got its `*Options` embed resolved to `model/models/bert/embed.go:Options`
 * (13 of 14 wrong) because `bert` sorted first among the 14 same-named
 * structs. Without `refFilePath` the legacy `[0]` behaviour is kept.
 */
function resolveByNameAndKind(args: ResolveByNameAndKindArgs): string | null {
  const { name, kind, preferredDirs, context, kinds, refFilePath } = args;
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  // Filter by kind
  const kindFiltered = candidates.filter((n) => {
    if (kinds) return kinds.has(n.kind);
    if (kind) return n.kind === kind;
    return true;
  });

  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) => preferredDirs.some((d) => n.filePath.includes(`/${d}/`)));
  const pool = preferred.length > 0 ? preferred : kindFiltered;

  // Proximity tiebreak when the caller passed `refFilePath` — picks
  // the same-file / same-package candidate over an arbitrary alphabetic
  // winner. Without `refFilePath` the legacy `[0]` behaviour is kept
  // (no foot-gun for callers that haven't been updated yet).
  if (refFilePath) sortByProximityToRef(pool, refFilePath);
  return pool[0]!.id;
}
