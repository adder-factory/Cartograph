/**
 * Reference Resolution Types
 *
 * Types for the reference resolution system.
 */

import type { EdgeKind, Language, Node } from '../types.js';

/**
 * Threshold above which an "every resolved-reference edge collapsed but
 * `unresolved_refs` is heavy" reading flips from "natural early state
 * on a freshly-indexed tiny project" to "real corruption that needs the
 * safety-net drain". Set conservatively to avoid firing on small tests
 * / fixture projects whose few unresolved refs are legitimately waiting
 * for a later sync (Pass B's rename / new-export case relies on those
 * refs surviving across syncs).
 *
 * Calibrated from the 2026-05-19 live-bug snapshot: the corrupted index
 * sat at 31000+ stranded refs, three orders of magnitude above this
 * floor. A real project's unresolved_refs tail (cross-language stdlib,
 * framework hooks) easily clears 1000 too — so the practical effect is
 * "fire on large-codebase corruption; ignore on small projects".
 *
 * Single source of truth for both `cgSyncResolveReferences`'s safety-
 * net drain (`src/index.ts`) and the `appendDegradedEdges` status banner
 * (`src/mcp/tools/status.ts`). Lives here in the leaf resolution module
 * so consumers don't drag in `src/index.ts`'s heavy import graph (which
 * would create a circular dependency with the MCP tool registry).
 */
export const DEGENERATE_EDGE_UREF_FLOOR = 1000;

/**
 * An unresolved reference from extraction
 */
export interface UnresolvedRef {
  /** ID of the source node containing the reference */
  fromNodeId: string;
  /** The name being referenced */
  referenceName: string;
  /** Type of reference */
  referenceKind: EdgeKind;
  /** Line where reference occurs */
  line: number;
  /** Column where reference occurs */
  column: number;
  /** File path where reference occurs */
  filePath: string;
  /** Language of the source file */
  language: Language;
  /** Possible qualified names it might resolve to */
  candidates?: string[];
  /**
   * Number of call/reference sites that collapsed into this entry at
   * extraction time. ≥ 1. The dedup keeps one entry per
   * (source, kind, name); the count surfaces real usage to consumers.
   */
  siteCount?: number;
  /** Sample of additional 1-based call-site lines beyond `line`. Capped. */
  extraLines?: number[];
}

/**
 * A resolved reference
 */
export interface ResolvedRef {
  /** Original unresolved reference */
  original: UnresolvedRef;
  /** ID of the target node */
  targetNodeId: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** How it was resolved */
  resolvedBy:
    | 'exact-match'
    | 'import'
    | 'qualified-name'
    | 'framework'
    | 'fuzzy'
    | 'instance-method'
    | 'file-path'
    /** F#33 (2026-05-26) — import matched by name but the source path was
     *  unresolvable (stdlib / external dep) OR the target file had no
     *  matching export. Fallback target is the local `import` node;
     *  classified as INFERRED because the specific symbol isn't known. */
    | 'external-import'
    /** F#57 (2026-05-26) — Java/Kotlin import FQN selected ONE class out
     *  of N same-simple-name candidates by file-path-suffix match. The
     *  strongest disambiguation signal an import gives; classified
     *  EXTRACTED. Without it, file-path-proximity picked arbitrarily
     *  (the bug closed by upstream #314). */
    | 'fqn-disambiguated';
  /**
   * Distance to the runner-up candidate's confidence, when the picker
   * considered ≥2 candidates with DIFFERENT targets (#8 AMBIGUOUS
   * detection — B3). Undefined when there was only one candidate or
   * the runner-up resolved to the same target. Smaller margin = more
   * ambiguous; classifyConfidence treats `< AMBIGUOUS_TIE_MARGIN` as
   * AMBIGUOUS regardless of the chosen resolvedBy.
   */
  tieMargin?: number;
}

/** Below this winner-vs-runner-up gap, classifyConfidence flags AMBIGUOUS. */
const AMBIGUOUS_TIE_MARGIN = 0.05;

/**
 * Categorical confidence (#8) derived from how the resolver landed on
 * the target. Promoted to a dedicated `edges.confidence` column so
 * `cartograph_callers` / `_callees` / `_impact` can filter without
 * unpacking the `metadata` JSON. Three buckets:
 *
 *   - `EXTRACTED`: concrete (import / qualified-name / file-path /
 *     high-confidence framework rule). Trustworthy.
 *   - `INFERRED`: heuristic (instance-method dispatch / fuzzy / a
 *     framework rule that scored low). Verify before acting.
 *   - `AMBIGUOUS`: the picker considered two-or-more DIFFERENT-target
 *     candidates with confidences within {@link AMBIGUOUS_TIE_MARGIN}
 *     of each other — the chosen target is one of several plausible
 *     answers, not the only one. Trumps EXTRACTED/INFERRED so the
 *     agent always sees the ambiguity flag even when the winner came
 *     from a "concrete" resolver path.
 *
 * Free function so the mapping is unit-testable without spinning up
 * the full resolver, and so non-resolver edge sources (extractor
 * direct edges) can default it consistently.
 */
/**
 * Classify resolver type to confidence level.
 * EXTRACTED = concrete, INFERRED = heuristic, AMBIGUOUS = tie.
 */
function classifyByResolvedType(resolvedBy: ResolvedRef['resolvedBy'], score: number): 'EXTRACTED' | 'INFERRED' {
  switch (resolvedBy) {
    case 'import':
    case 'qualified-name':
    case 'file-path':
    case 'exact-match':
    case 'fqn-disambiguated':
      return 'EXTRACTED';
    case 'framework':
      return score >= 0.85 ? 'EXTRACTED' : 'INFERRED';
    case 'instance-method':
    case 'fuzzy':
    case 'external-import':
      return 'INFERRED';
  }
}

export function classifyConfidence(
  resolvedBy: ResolvedRef['resolvedBy'],
  score: number,
  tieMargin?: number,
): 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS' {
  // AMBIGUOUS short-circuit: when the picker had a near-tied
  // runner-up with a DIFFERENT target, the winner could just as
  // easily have been the loser. Flag regardless of resolvedBy —
  // an "import" resolution that happened to score 0.61 over an
  // exact-match's 0.60 is still a coin flip from the agent's POV.
  if (typeof tieMargin === 'number' && tieMargin < AMBIGUOUS_TIE_MARGIN) {
    return 'AMBIGUOUS';
  }
  return classifyByResolvedType(resolvedBy, score);
}

/**
 * Result of resolution attempt
 */
export interface ResolutionResult {
  /** Successfully resolved references */
  resolved: ResolvedRef[];
  /** References that couldn't be resolved */
  unresolved: UnresolvedRef[];
  /** Statistics */
  stats: {
    total: number;
    resolved: number;
    unresolved: number;
    byMethod: Record<string, number>;
  };
}

/**
 * Context for resolution - provides access to the graph
 */
export interface ResolutionContext {
  /** Get all nodes in a file */
  getNodesInFile(filePath: string): Node[];
  /** Get all nodes by name */
  getNodesByName(name: string): Node[];
  /** Get all nodes by qualified name */
  getNodesByQualifiedName(qualifiedName: string): Node[];
  /** Get all nodes of a kind */
  getNodesByKind(kind: Node['kind']): Node[];
  /** Check if a file exists */
  fileExists(filePath: string): boolean;
  /** Read file content */
  readFile(filePath: string): string | null;
  /** Get project root */
  getProjectRoot(): string;
  /** Get all files */
  getAllFiles(): string[];
  /** Get nodes by lowercase name (O(1) lookup for fuzzy matching) */
  getNodesByLowerName(lowerName: string): Node[];
  /** Get cached import mappings for a file */
  getImportMappings(filePath: string, language: Language): ImportMapping[];
  /**
   * Project import-path aliases (tsconfig/jsconfig `paths`). Returns
   * `null` when the project doesn't define any. Cached per resolver
   * instance — safe to call from any resolver code path. Optional so
   * existing test fixtures and external context implementations
   * compile without modification; production resolver implements it.
   */
  getProjectAliases?(): import('./path-aliases.js').AliasMap | null;
  /**
   * Re-exports declared by a file (`export { x } from './other'`,
   * `export * from './other'`). Empty array when the file has none.
   * Optional so older callers compile; the import resolver follows
   * re-export chains when this is provided.
   */
  getReExports?(filePath: string, language: Language): ReExport[];
}

/**
 * Framework-specific resolver
 */
export interface FrameworkResolver {
  /** Framework name */
  name: string;
  /** Languages this resolver's `extractNodes` should run on. When omitted,
   *  the resolver's pattern is treated as language-agnostic and runs on
   *  every file (legacy behaviour — kept for backward compat with the
   *  PHP/Ruby/Laravel resolvers that produce framework-specific nodes
   *  via filename heuristics rather than language detection). All
   *  receiver-pattern resolvers (express, swift/Vapor, python/django,
   *  rust/axum, …) MUST set this so a `.get('a.ts')` SQLite call in a
   *  TS test file doesn't get matched by the Vapor regex.
   *
   *  The orchestrator (`eoRunFrameworkExtractors`) gates on this — when
   *  the file's language isn't in the set, `extractNodes` AND `extract`
   *  are both skipped. */
  languages?: ReadonlyArray<Language>;
  /** F#73 (2026-05-28) — Aho-Corasick pre-filter anchors. Fixed
   *  substrings that MUST appear in the file for ANY of this
   *  resolver's regex patterns to fire. The dispatcher runs ONE
   *  combined Aho-Corasick scan over the file content; resolvers
   *  whose anchors don't appear get skipped without ever running
   *  their per-pattern regex passes. Declare conservatively — a
   *  missing anchor is a CORRECTNESS bug (resolver wrongly skipped);
   *  an over-broad anchor merely loses the pre-filter win on files
   *  that match the anchor but no real pattern. Resolvers without
   *  declared anchors always run (legacy behaviour). */
  anchors?: ReadonlyArray<string>;
  /** Detect if project uses this framework */
  detect(context: ResolutionContext): boolean;
  /** Resolve a reference using framework-specific patterns */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null;
  /** Optional pre-filter bypass. `resolve()` only runs for refs that pass
   *  the known-node pre-filter (`resolverHasAnyPossibleMatch`) — but some
   *  framework refs are named after nothing in the graph (an ObjC selector
   *  `fooWithBar:` has no same-named node; its bridged Swift method is
   *  `foo`). Returning true opts a name PAST the pre-filter so this
   *  resolver's `resolve()` sees it. Only consulted for DETECTED
   *  frameworks, so an opt-in is scoped to projects using the framework. */
  claimsReference?(name: string): boolean;
  /** Optional per-context cache invalidation. A resolver that memoizes
   *  graph-derived state (keyed by the `ResolutionContext`) implements this
   *  to drop that state — the resolver's `ReferenceResolver.clearCaches()`
   *  calls it at every resolution-pass boundary (sync + indexAll), so a
   *  cache built from ObjC method nodes can't go stale when a sync adds or
   *  removes nodes against the SAME long-lived context. */
  clearCache?(context: ResolutionContext): void;
  /** Extract additional nodes specific to this framework. Existing
   *  resolvers (express, swift/Vapor, etc.) use this when they only
   *  need to emit nodes — no cross-file references.
   *
   *  F#74 (2026-05-28) — the optional `getStripped` thunk shares a
   *  per-file comment-stripped buffer across every resolver that the
   *  orchestrator dispatches for the same file. The thunk's result is
   *  memoised inside `eoRunFrameworkExtractors`, so the first
   *  resolver that calls it pays the O(n) `stripCommentsForRegex`
   *  cost and every later resolver returns the cached string.
   *  Resolvers that scan raw `content` (Java / Ruby / Swift / React)
   *  ignore the third arg; resolvers that strip comments pass
   *  `getStripped` through with a fall-back to the legacy in-resolver
   *  strip when the orchestrator omits it (kept for tests + direct
   *  callers that construct a resolver outside the dispatcher). */
  extractNodes?(filePath: string, content: string, getStripped?: () => string): Node[];
  /**
   * F#62 (2026-05-26) — richer extractor that emits BOTH nodes and
   * unresolved references. Used when a framework's source (e.g.
   * Drupal's `*.routing.yml` files) carries cross-file references
   * to handler classes/methods that should resolve to indexed PHP
   * symbols. When BOTH `extract` and `extractNodes` are defined on
   * the same resolver, `extract` wins; the orchestrator does not
   * call both for the same file. Backward-compatible additive
   * extension to the interface; existing resolvers keep working
   * unchanged.
   *
   * `references` uses the extraction-time `UnresolvedReference`
   * shape (where `filePath` / `language` are optional — the
   * orchestrator fills them in from the source file context),
   * NOT the resolver-time `UnresolvedRef`. */
  extract?(
    filePath: string,
    content: string,
  ): { nodes: Node[]; references: import('../types.js').UnresolvedReference[] };
}

/**
 * Import mapping from a file
 */
export interface ImportMapping {
  /** Local name used in the file */
  localName: string;
  /** Original exported name (may differ due to aliasing) */
  exportedName: string;
  /** Source module/path */
  source: string;
  /** Whether it's a default import */
  isDefault: boolean;
  /** Whether it's a namespace import (import * as X) */
  isNamespace: boolean;
  /** Resolved file path (if local) */
  resolvedPath?: string;
  /**
   * 1-indexed line of the import statement in the source file.
   * Used by `resolveViaImport` to disambiguate when N imports share
   * the same `exportedName` but bind to different `localName`s — the
   * unresolved-ref's line pins to the specific import statement.
   * Optional because regex extractors that don't track byte offsets
   * (older fixtures, non-JS) don't populate it.
   */
  line?: number;
}

/**
 * Re-export from a file: `export { x } from './other'` or
 * `export * from './other'`. Used by the resolver to chase
 * symbols through barrel files.
 */
export type ReExport =
  | {
      kind: 'named';
      /** Name as exported by THIS file. */
      exportedName: string;
      /** Name in the upstream module (differs when renamed: `as`). */
      originalName: string;
      /** Module specifier of the upstream module. */
      source: string;
    }
  | {
      kind: 'wildcard';
      /** Module specifier of the upstream module. */
      source: string;
    };
