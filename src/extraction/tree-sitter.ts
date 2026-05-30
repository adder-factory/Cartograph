/**
 * Tree-sitter Parser Wrapper
 *
 * Handles parsing source code and extracting structural information.
 *
 * The universal hand-extractor's `tsXxx` free functions were split out
 * (god-module split, 2026-05-17) into three sibling files —
 * `ts-extract-declarations.ts`, `ts-extract-calls.ts`,
 * `ts-extract-bodies.ts`. This file keeps the `TreeSitterExtractor`
 * class, the parse driver (`tsParseAndWalk`), the node-kind dispatch,
 * and the small shared helpers the split files import. All four files
 * feed `EXTRACTION_LOGIC_VERSION`.
 */

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import * as path from 'node:path';
import type {
  Language,
  Node,
  Edge,
  NodeKind,
  ExtractionResult,
  ExtractionError,
  UnresolvedReference,
  NestedFunctionManifestRow,
} from '../types.js';
import { getParser, detectLanguage, isLanguageSupported } from './grammars.js';
import { getNodeText, getChildByField, createIdFactory, type NodeIdFactory } from './tree-sitter-helpers.js';
import type { LanguageExtractor, ExtractorContext } from './tree-sitter-types.js';
import { getLanguageDefByName } from './languages/registry.js';
import { errMsg } from '../errors.js';
import { symbolBodyHash, sliceSymbolBody } from './symbol-body-hash.js';
import { profile } from './profile.js';
import { isJsFamily } from '../utils.js';
import { visitPascalNode } from './tree-sitter-pascal.js';
import { extractTypeRefsFromSubtree } from './tree-sitter-typerefs.js';
import { extractRustImplItem } from './tree-sitter-inheritance.js';
import { runSchemaRecognizers } from './schema-recognizers/index.js';
import { extractVariable, extractTypeAlias, extractImport } from './tree-sitter-decls.js';
import { tsExtractCall, tsExtractInstantiation } from './ts-extract-calls.js';
import { tsVisitFunctionBody } from './ts-extract-bodies.js';
import {
  tsExtractFunction,
  tsExtractMethod,
  tsExtractClass,
  tsExtractInterface,
  tsExtractStruct,
  tsExtractEnum,
  tsExtractProperty,
  tsExtractField,
} from './ts-extract-declarations.js';

// Re-export for backward compatibility
export { generateNodeId } from './tree-sitter-helpers.js';
// Re-export the extraction free functions that external collaborators
// (notably `tree-sitter-decls.ts`) import from this module. They moved
// into the god-module split files, but `tree-sitter.ts` stays their
// public face so importers don't need to chase the new file layout.
export { extractName, tsExtractFunction, tsExtractEnumMembers } from './ts-extract-declarations.js';
export { tsVisitVariableInitializer } from './ts-extract-bodies.js';

/**
 * Deduplicate unresolved references by (fromNodeId, referenceName,
 * referenceKind). A function calling `foo()` 100 times pushes 100 refs
 * during extraction; the resolver collapses them to one edge eventually
 * (edges are unique on `(source, target, kind, line)` and most resolvers
 * skip duplicate work), but indexing time and DB churn scale with the
 * raw count. Collapsing here keeps the first occurrence's line/column
 * (which is typically what users want when "go to call site" surfaces).
 */
/**
 * How many *additional* call sites (4) we keep on the kept ref's
 * metadata before discarding the rest. Total sample = 1 (the kept
 * ref's own `line`) + EXTRA_SITES_CAP additional lines. The total
 * `siteCount` is always exact regardless of this cap.
 */
const EXTRA_SITES_CAP = 4;

function dedupeReferences(refs: UnresolvedReference[]): UnresolvedReference[] {
  const seen = new Map<string, UnresolvedReference>();
  const out: UnresolvedReference[] = [];
  for (const ref of refs) {
    const key = `${ref.fromNodeId}\0${ref.referenceKind}\0${ref.referenceName}`;
    const head = seen.get(key);
    if (!head) {
      // First occurrence keeps its own line; siteCount starts at 1 so
      // downstream code can treat the field as "always set" without
      // a defensive `?? 1` everywhere.
      ref.siteCount = 1;
      seen.set(key, ref);
      out.push(ref);
      continue;
    }
    head.siteCount = (head.siteCount ?? 1) + 1;
    if (!head.extraLines) head.extraLines = [];
    // Sample stays distinct: re-pushing line=5 because the same symbol
    // is referenced twice on line 5 (e.g. `foo(foo())`) would render
    // "(4 sites: 3, 5, 5, 7)" — misleading. Skip duplicates of either
    // the head line or a line already in the sample.
    if (head.extraLines.length < EXTRA_SITES_CAP && ref.line !== head.line && !head.extraLines.includes(ref.line)) {
      head.extraLines.push(ref.line);
    }
  }
  return out;
}

/** Member-access / chain node kinds with a `property` or `field` child. */
const RECEIVER_CHAIN_TYPES: ReadonlySet<string> = new Set([
  'member_expression',
  'attribute',
  'selector_expression',
  'navigation_expression',
]);

/** Identifier-shaped leaf kinds that name a chain's terminal property. */
export const RECEIVER_LEAF_KINDS: ReadonlySet<string> = new Set([
  'identifier',
  'simple_identifier',
  'property_identifier',
  'field_identifier',
]);

/**
 * Walk a method-call receiver expression to extract the most-specific
 * named identifier the resolver can use as a class/instance hint.
 *
 * Simple identifier (`obj.method()`)         → returns `'obj'`.
 * Chained property (`this.field.method()`)   → returns `'field'`.
 * Chained property (`this.a.b.method()`)     → returns `'b'`.
 * Bare `this`/`self`/`super`/etc.            → returns `null` (no hint).
 * Function-call chains (`getFoo().method()`) → returns `null`.
 *
 * Without this walk, the extractor falls back to recording the call
 * with no receiver hint, collapsing many distinct method calls into a
 * single "by-name" lookup that the resolver can't disambiguate. The
 * receiver-name lets `matchMethodCall` apply its
 * `Receiver → Capitalized → Class` heuristic for instance fields.
 *
 * Exported — `ts-extract-calls.ts` (member-call resolution) and
 * `ts-extract-bodies.ts` (field-access capture) both reuse it.
 */
export function extractLeafReceiverName(
  node: SyntaxNode,
  source: string,
  skipReceivers: ReadonlySet<string>,
): string | null {
  // Bare identifier — the existing case.
  if (node.type === 'identifier' || node.type === 'simple_identifier') {
    const name = getNodeText(node, source);
    return skipReceivers.has(name) ? null : name;
  }
  if (RECEIVER_CHAIN_TYPES.has(node.type)) {
    return tryReceiverFromChain(node, source, skipReceivers);
  }
  return null;
}

/**
 * Pick the LEAF property name of a member-access chain (the field
 * most likely to map to an instance type). For
 * `this.embeddingCache.invalidate()`, the func node is
 * `this.embeddingCache.invalidate` and the `object` receiver is
 * `this.embeddingCache` — we want `embeddingCache`.
 *
 * Two grammar shapes handled:
 *   1. `property` / `field` named-field on the chain node (TS/JS/Go/etc).
 *   2. Kotlin's `navigation_suffix` wrapper around a simple_identifier.
 */
function tryReceiverFromChain(node: SyntaxNode, source: string, skipReceivers: ReadonlySet<string>): string | null {
  const property = getChildByField(node, 'property') || getChildByField(node, 'field');
  if (property && RECEIVER_LEAF_KINDS.has(property.type)) {
    const name = getNodeText(property, source);
    if (!skipReceivers.has(name)) return name;
  }
  // Kotlin navigation_suffix wrapper.
  const child1 = node.namedChild(1);
  if (child1?.type !== 'navigation_suffix') return null;
  const inner = child1.namedChildren.find((c: SyntaxNode) => c.type === 'simple_identifier');
  if (!inner) return null;
  const name = getNodeText(inner, source);
  return skipReceivers.has(name) ? null : name;
}

/**
 * Tree-sitter node kinds that represent constructor invocations
 * (`new Foo()` and friends). Used by the body-walker
 * (`ts-extract-bodies.ts`) and the reference-like dispatch below to
 * route to `tsExtractInstantiation`.
 */
export const INSTANTIATION_KINDS: ReadonlySet<string> = new Set([
  'new_expression', // typescript / javascript / tsx / jsx
  'object_creation_expression', // java / c#
  'instance_creation_expression', // some grammars
  'struct_expression', // rust — `Foo { x: 1 }` literal construction.
  //   Tuple-struct construction (`Foo(1, 2)`) parses as call_expression
  //   and is counted as `calls` instead — matches Rust's semantics
  //   where tuple constructors ARE function values.
  // F#44 (2026-05-26): Go `Foo{X: 1}` AND `&Foo{X: 1}` BOTH parse to
  // `composite_literal` (the `&` wraps in a `unary_expression`).
  // The composite_literal is ALSO used for slice / map / array
  // literals (`[]int{1,2}`, `map[string]int{"a": 1}`) — those are NOT
  // instantiations. `tsExtractInstantiation` filters via the `type`
  // child's kind: it must be one of `type_identifier`, `qualified_type`,
  // `generic_type` (see {@link STRUCT_LITERAL_CTOR_KINDS}).
  'composite_literal',
]);

/**
 * F#44 (2026-05-26): tree-sitter type-child kinds that represent a
 * struct-name in a Go composite literal. Slice / map / array / channel
 * literals also parse to `composite_literal` but with non-struct type
 * kinds (`slice_type`, `map_type`, `array_type`, `channel_type`); those
 * are NOT instantiations and the gate below skips them.
 */
export const STRUCT_LITERAL_CTOR_KINDS: ReadonlySet<string> = new Set([
  'type_identifier', // bare struct: `Foo{}`
  'qualified_type', // package-qualified: `pkg.Foo{}`
  'generic_type', // generic struct (Go 1.18+): `Foo[T]{}`
]);

/**
 * Per-node dispatch context threaded through the `tryDispatch*` family.
 * Bundles the four values every dispatcher needs so the functions stay
 * under the long_parameter_list threshold.
 */
interface TsDispatchCtx {
  ext: TreeSitterExtractor;
  lang: NonNullable<TreeSitterExtractor['extractor']>;
  node: SyntaxNode;
  t: string;
}

/**
 * TreeSitterExtractor - Main extraction class
 *
 * Kept intentionally thin: only the four methods that external
 * collaborators (tree-sitter-pascal.ts, tree-sitter-decls.ts) call
 * directly on the instance live here. Every other extraction step is
 * a module-scope free function that takes `ext: TreeSitterExtractor`
 * as its first argument — same pattern as Wave A (GraphqlExtractor /
 * HclExtractor / SqlExtractor).
 */
// Internal collaborators (PascalHelpers, etc.) read these fields
// directly. Marked /** @internal */ — not part of the public API
// surface, but visible across the extraction module's helper files.
export class TreeSitterExtractor {
  /** @internal */ filePath: string;
  /** @internal */ language: Language;
  /** @internal */ source: string;
  /** @internal */ nodes: Node[] = [];
  /** @internal */ edges: Edge[] = [];
  /** @internal */ unresolvedReferences: UnresolvedReference[] = [];
  /** @internal */ extractor: LanguageExtractor | null = null;
  /** @internal */ nodeStack: string[] = []; // Stack of parent node IDs
  /** @internal */ methodIndex: Map<string, string> | null = null; // lookup key → node ID for Pascal defProc lookup
  /** @internal */ idFactory: NodeIdFactory;

  constructor(filePath: string, source: string, language?: Language) {
    this.filePath = filePath;
    this.source = source;
    this.language = language || detectLanguage(filePath, source);
    this.idFactory = createIdFactory(filePath);
    // Single source of truth: read the extractor straight off the
    // language def so adding a new grammar-backed language is a
    // one-file change (no parallel EXTRACTORS map to keep in sync).
    this.extractor = getLanguageDefByName(this.language)?.grammar?.extractor ?? null;
  }

  /** Parse and extract from the source code. */
  extract(): ExtractionResult {
    const startTime = Date.now();
    const errors: ExtractionError[] = [];
    const earlyReturn = (message: string, code: string): ExtractionResult => ({
      nodes: [],
      edges: [],
      unresolvedReferences: [],
      nestedFunctionManifest: [],
      errors: [{ message, filePath: this.filePath, severity: 'error', code }],
      durationMs: Date.now() - startTime,
    });
    // F#12 slice 2: ensure the manifest collection is empty before
    // visitor walk in case the extractor instance is reused. Lives on
    // a module-scope WeakMap (same pattern as `sourceLinesCache` and
    // `eagerNestedFnCache`) rather than a class field — the
    // `TreeSitterExtractor` member count is at the `god_class` info
    // threshold and adding output-collection fields would trip it.
    nestedManifestCache.set(this, []);
    if (!isLanguageSupported(this.language)) {
      return earlyReturn(`Unsupported language: ${this.language}`, 'unsupported_language');
    }
    const parser = getParser(this.language);
    if (!parser) {
      return earlyReturn(`Failed to get parser for language: ${this.language}`, 'parser_error');
    }
    tsParseAndWalk(this, parser, errors);
    return {
      nodes: this.nodes,
      edges: this.edges,
      unresolvedReferences: dedupeReferences(this.unresolvedReferences),
      nestedFunctionManifest: nestedManifestCache.get(this) ?? [],
      errors,
      durationMs: Date.now() - startTime,
    };
  }

  /**
   * Visit a node and extract information.
   * Called directly by external collaborators (pascal, decls, fish,
   * rescript, c-cpp, scala, kotlin, ruby, r) — either by direct
   * `extractor.visitNode(...)` or by `ctx.visitNode(...)` from the
   * `ExtractorContext`. Update the list when adding a new collaborator
   * so the call-graph is greppable from this header.
   */
  /** @internal */ visitNode(node: SyntaxNode): void {
    if (!this.extractor) return;

    // Language-specific custom visitor hook — short-circuits the
    // default dispatch when the extractor handles the node itself.
    if (this.extractor.visitNode) {
      const ctx = tsMakeExtractorContext(this);
      if (this.extractor.visitNode(node, ctx)) return;
    }

    // Pascal has its own subtree handler that may consume the whole node.
    if (this.language === 'pascal' && visitPascalNode(this, node)) return;

    const skipChildren = tsDispatchByNodeKind(this, node);

    if (!skipChildren) {
      // B14 (2026-05-23) — read children in ONE bulk call instead of
      // N separate `node.namedChild(i)` calls. Profile measured 99.1%
      // of `worker:visitNode:typescript` wall (443/447 sec on
      // microsoft/TypeScript's `reallyLargeFile.ts`) was spent in
      // those indexed reads — each one crosses the JS↔WASM boundary
      // AND `namedChild(i)` appears to walk children from i=0 each
      // call (max=100ms for one read on a node with thousands of
      // children = O(i) cost → O(n²) loop). `namedChildren` returns
      // an already-iterated array in one call; the iteration cost
      // per child is essentially free.
      const children = profile(`worker:tsReadChildren`, () => node.namedChildren);
      for (const child of children) {
        if (child) this.visitNode(child);
      }
    }
  }

  /**
   * Create a Node object.
   * Called directly by external collaborators (pascal, decls, bash, fish, lua, r, rescript).
   */
  /** @internal */ createNode(args: {
    kind: NodeKind;
    name: string;
    node: SyntaxNode;
    extra?: Partial<Node>;
  }): Node | null {
    const { kind, name, node, extra } = args;
    // Skip nodes with empty/missing names — they are not meaningful symbols
    // and would cause FK violations when edges reference them (see issue #42)
    if (!name) {
      return null;
    }

    const id = this.idFactory.next(kind, name);

    const newNode: Node = {
      id,
      kind,
      name,
      qualifiedName: tsBuildQualifiedName(this, name),
      filePath: this.filePath,
      language: this.language,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      updatedAt: Date.now(),
      ...extra,
    };
    // Per-symbol content hash (Phase 2 / Design A). The body is a
    // line-based slice — NOT `node.text` — to match the summarizer's
    // `sliceSymbolBody` slice exactly. The two functions write hashes
    // that getStaleArtifactsCount joins on; any divergence (e.g. the
    // byte-range `node.text` for an indented method that starts at
    // column > 0) makes every comparison report stale. Both sides go
    // through `sliceSymbolBody(lines, startLine, endLine)`.
    const body = profile(`worker:sliceBody:${this.language}`, () =>
      sliceSymbolBody(getSourceLines(this), newNode.startLine, newNode.endLine),
    );
    newNode.bodyHash = profile(`worker:bodyHash:${this.language}`, () => symbolBodyHash(newNode.signature, body));

    this.nodes.push(newNode);

    // Add containment edge from parent
    if (this.nodeStack.length > 0) {
      const parentId = this.nodeStack[this.nodeStack.length - 1];
      if (parentId) {
        this.edges.push({
          source: parentId,
          target: id,
          kind: 'contains',
        });
      }
    }

    return newNode;
  }
}

// ---- Extraction free functions -------------------------------------------
// All extraction logic that WAS on TreeSitterExtractor as @internal methods
// lives as module-scope free functions that take `ext: TreeSitterExtractor`
// as the first argument. The bulk of them moved into the god-module split
// files (ts-extract-declarations / ts-extract-calls / ts-extract-bodies,
// 2026-05-17); what remains here is the parse driver, the node-kind
// dispatch, and the small helpers those files share.
// --------------------------------------------------------------------------

/**
 * Per-extractor lazy split of `ext.source` into lines. Lives on a
 * module-scope WeakMap rather than as a `_sourceLines` field + a
 * `sourceLines` getter on the class because `god_class` member-count
 * counts every field/getter on the class — and the cache is purely
 * an internal memoisation concern, not state collaborators read.
 *
 * Used by `createNode` to compute `nodes.body_hash` with the same
 * line-slice semantic the summarizer uses (sliceSymbolBody). Split
 * once per file; entries are released when the extractor is GC'd.
 */
const sourceLinesCache = new WeakMap<TreeSitterExtractor, string[]>();
/** Per-extractor cached split of `source` into lines, memoised so the
 *  body-hash slice + the manifest-row hash share one pass. Exported so
 *  the manifest collector in `ts-extract-bodies.ts` reads the same
 *  lines the createNode body-hash path does. */
export function getSourceLines(ext: TreeSitterExtractor): string[] {
  let lines = sourceLinesCache.get(ext);
  if (lines === undefined) {
    lines = ext.source.split('\n');
    sourceLinesCache.set(ext, lines);
  }
  return lines;
}

/**
 * F#12 slice 1: per-file mode decision. `true` when this file's
 * largest function body LOC is at or below `largeFunctionThreshold`
 * (see {@link getLargeFunctionThreshold}). Set in `tsParseAndWalk`
 * after the tree is parsed and before `visitNode` recurses; the body
 * walker (`ts-extract-bodies.ts`) reads it via
 * {@link isEagerNestedFnMode}.
 *
 * Lives on a module-scope WeakMap (same pattern as
 * {@link sourceLinesCache}) rather than a class field so the
 * `god_class` member-count detector doesn't trip on a memoisation
 * concern that's not part of the public collaborator surface.
 * Entries release when the extractor is GC'd (per-file).
 */
const eagerNestedFnCache = new WeakMap<TreeSitterExtractor, boolean>();

/** F#12 slice 1: set the per-file mode flag — called once per parse
 *  inside `tsParseAndWalk` after the tree is available. */
function setEagerNestedFnMode(ext: TreeSitterExtractor, eager: boolean): void {
  eagerNestedFnCache.set(ext, eager);
}

/** F#12 slice 1: read the per-file mode flag — called by the body walker
 *  on every nested-fn candidate. Returns `false` when the flag was never
 *  set (defensive — non-TS-family paths skip the set step). */
export function isEagerNestedFnMode(ext: TreeSitterExtractor): boolean {
  return eagerNestedFnCache.get(ext) ?? false;
}

/**
 * F#12 slice 2: per-extractor manifest-row collection. Mined in
 * `ts-extract-bodies.ts > tryCollectNestedFnManifest` whenever the
 * eager mode flag is OFF (mega-file). Empty for eager-mode files.
 *
 * Lives on a module-scope WeakMap (same precedent as
 * {@link eagerNestedFnCache} and {@link sourceLinesCache}) — a class
 * field would push `TreeSitterExtractor`'s member count past the
 * `god_class` info threshold. The collection is reset to `[]` at the
 * top of `extract()` so a reused extractor doesn't accumulate stale
 * rows across parses.
 */
const nestedManifestCache = new WeakMap<TreeSitterExtractor, NestedFunctionManifestRow[]>();

/** F#12 slice 2: push a manifest row from the body walker.
 *  Initialises the array on first push if `extract()`'s reset somehow
 *  didn't run (defensive — keeps the call site a one-liner). */
export function pushNestedFunctionManifestRow(ext: TreeSitterExtractor, row: NestedFunctionManifestRow): void {
  let rows = nestedManifestCache.get(ext);
  if (!rows) {
    rows = [];
    nestedManifestCache.set(ext, rows);
  }
  rows.push(row);
}

/**
 * Cap on syntax-error warnings emitted per file. A catastrophically
 * broken file could otherwise flood `files.errors` with hundreds of
 * entries; past the cap one summary warning is emitted instead.
 */
const MAX_SYNTAX_ERROR_WARNINGS = 25;

/**
 * Scan a parsed tree for tree-sitter `ERROR` / `MISSING` nodes and emit
 * one `warning`-severity {@link ExtractionError} per broken region.
 *
 * tree-sitter recovers from syntax errors and still returns a tree, so
 * a file can extract partially while harbouring unparseable spans. This
 * surfaces those spans — with line numbers, so `cartograph_at_range` can
 * map a broken span to its enclosing symbol — instead of letting them
 * pass silently. Distinct from the `parse_error` code, which marks a
 * hard parser failure (throw / null tree).
 */
function tsCollectSyntaxErrors(root: SyntaxNode, filePath: string): ExtractionError[] {
  // `hasError` is a precomputed flag — bail before any walk on the
  // common (syntactically clean) case.
  if (!root.hasError) return [];
  const out: ExtractionError[] = [];
  const stack: SyntaxNode[] = [root];
  let truncated = false;
  while (stack.length > 0) {
    if (out.length >= MAX_SYNTAX_ERROR_WARNINGS) {
      truncated = true;
      break;
    }
    const node = stack.pop()!;
    if (node.isError || node.isMissing) {
      // One warning per top-level broken region — don't descend into an
      // ERROR node's mangled children.
      out.push({
        message: node.isMissing ? `Syntax error: missing '${node.type}'` : 'Syntax error: unparseable region',
        filePath,
        line: node.startPosition.row + 1,
        column: node.startPosition.column,
        severity: 'warning',
        code: 'syntax_error',
      });
      continue;
    }
    // Descend only where the error actually lives.
    for (const child of node.children) {
      if (child && child.hasError) stack.push(child);
    }
  }
  if (truncated) {
    out.push({
      message: `Syntax errors truncated at ${MAX_SYNTAX_ERROR_WARNINGS} — file has extensive parse damage`,
      filePath,
      severity: 'warning',
      code: 'syntax_error',
    });
  }
  return out;
}

/**
 * Parse the source + walk the tree from root, accumulating
 * nodes/edges/references into `ext.*`. Re-throws WASM
 * memory-corruption errors so the parse worker can crash and
 * restart with a fresh heap (every subsequent parse against the
 * corrupted module would otherwise also fail).
 */
function tsParseAndWalk(
  ext: TreeSitterExtractor,
  parser: NonNullable<ReturnType<typeof getParser>>,
  errors: ExtractionError[],
): void {
  let tree: Tree | null = null;
  try {
    tree = profile(`worker:tsParse:${ext.language}`, () => parser.parse(ext.source) ?? null);
    if (!tree) throw new Error('Parser returned null tree');

    const fileNode: Node = {
      id: `file:${ext.filePath}`,
      kind: 'file',
      name: path.basename(ext.filePath),
      qualifiedName: ext.filePath,
      filePath: ext.filePath,
      language: ext.language,
      startLine: 1,
      endLine: ext.source.split('\n').length,
      startColumn: 0,
      endColumn: 0,
      isExported: false,
      updatedAt: Date.now(),
    };
    ext.nodes.push(fileNode);
    // F#12 slice 1: decide per-file eager nested-fn mode BEFORE the
    // walk starts. Pre-scan is JS-family-only and short-circuits on
    // small files, so the cost is near-zero on the dominant case.
    setEagerNestedFnMode(
      ext,
      profile(`worker:eagerNestedFnScan:${ext.language}`, () => determineEagerNestedFnMode(ext, tree!.rootNode)),
    );
    // Push file node onto stack so top-level declarations get contains edges
    ext.nodeStack.push(fileNode.id);
    profile(`worker:visitNode:${ext.language}`, () => ext.visitNode(tree!.rootNode));
    ext.nodeStack.pop();
    // Surface syntactically broken spans the error-recovering parse
    // walked over — recorded as warnings, so partial extraction still
    // succeeds but the damage is visible.
    errors.push(...tsCollectSyntaxErrors(tree.rootNode, ext.filePath));
    // B2 — schema-DSL recognizer pass: synthesize the data-model
    // structure the language extractor can't see (a `z.object({...})`
    // is an opaque call chain to tree-sitter). Runs HERE, while the
    // parsed tree is still live — the `finally` below `tree.delete()`s
    // it. Gated per-recognizer by language + import `detect`, so a
    // file that doesn't use a recognised DSL pays only a cheap check.
    const schemaResult = profile(`worker:schemaRecognizers:${ext.language}`, () =>
      runSchemaRecognizers({
        filePath: ext.filePath,
        source: ext.source,
        language: ext.language,
        rootNode: tree!.rootNode,
        extractedNodes: ext.nodes,
        idFactory: ext.idFactory,
      }),
    );
    ext.nodes.push(...schemaResult.nodes);
    ext.edges.push(...schemaResult.edges);
  } catch (error) {
    const msg = errMsg(error);
    if (msg.includes('memory access out of bounds') || msg.includes('out of memory')) {
      throw error;
    }
    errors.push({
      message: `Parse error: ${msg}`,
      filePath: ext.filePath,
      severity: 'error',
      code: 'parse_error',
    });
  } finally {
    // Free tree-sitter WASM memory immediately — trees hold native heap
    // memory invisible to V8's GC that accumulates across thousands of
    // files.
    if (tree) {
      tree.delete();
    }
    ext.source = '';
  }
}

/**
 * Build an ExtractorContext for passing to language-specific visitNode hooks.
 */
function tsMakeExtractorContext(ext: TreeSitterExtractor): ExtractorContext {
  return {
    createNode: (args) => ext.createNode(args),
    visitNode: (node) => ext.visitNode(node),
    visitFunctionBody: (body, functionId) => tsVisitFunctionBody(ext, body, functionId),
    addUnresolvedReference: (ref) => ext.unresolvedReferences.push(ref),
    extractTypeRefs: (node, fromNodeId, kind) =>
      extractTypeRefsFromSubtree({ extractor: ext, node, fromNodeId, kind: kind ?? 'type_of' }),
    pushScope: (nodeId) => ext.nodeStack.push(nodeId),
    popScope: () => ext.nodeStack.pop(),
    get filePath() {
      return ext.filePath;
    },
    get source() {
      return ext.source;
    },
    get nodeStack() {
      return ext.nodeStack;
    },
    get nodes() {
      return ext.nodes;
    },
  };
}

/**
 * Build qualified name from node stack — semantic hierarchy only, no file path
 * (file path is stored separately in filePath and pollutes FTS if included here).
 */
function tsBuildQualifiedName(ext: TreeSitterExtractor, name: string): string {
  const parts: string[] = [];
  for (const nodeId of ext.nodeStack) {
    const node = ext.nodes.find((n) => n.id === nodeId);
    if (node && node.kind !== 'file') {
      parts.push(node.name);
    }
  }
  parts.push(name);
  return parts.join('::');
}

/**
 * Check if the current node stack indicates we are inside a class-like node
 * (class, struct, interface, trait). File nodes do not count as class-like.
 *
 * Exported — `ts-extract-declarations.ts` (method/receiver routing) reuses it.
 */
export function tsIsInsideClassLikeNode(ext: TreeSitterExtractor): boolean {
  if (ext.nodeStack.length === 0) return false;
  const parentId = ext.nodeStack[ext.nodeStack.length - 1];
  if (!parentId) return false;
  const parentNode = ext.nodes.find((n) => n.id === parentId);
  if (!parentNode) return false;
  return (
    parentNode.kind === 'class' ||
    parentNode.kind === 'struct' ||
    parentNode.kind === 'interface' ||
    parentNode.kind === 'trait' ||
    parentNode.kind === 'enum' ||
    parentNode.kind === 'module'
  );
}

/**
 * Check if any ancestor on the nodeStack is a function or method.
 * Used to skip variable extraction for locals inside function bodies
 * — they're not exported symbols, just call-frame storage. Without
 * this guard, locals like `const fd = fs.openSync(...)` get emitted
 * as project-level constants and trip `unused_export` plus inflate
 * the symbol count.
 */
function tsIsInsideFunctionLikeNode(ext: TreeSitterExtractor): boolean {
  if (ext.nodeStack.length === 0) return false;
  for (const id of ext.nodeStack) {
    const node = ext.nodes.find((n) => n.id === id);
    if (node && (node.kind === 'function' || node.kind === 'method')) return true;
  }
  return false;
}

/**
 * Try to dispatch a function- or method-shaped node. Returns:
 *  - `true`  — node was extracted; caller MUST NOT descend
 *  - `null`  — not function-shaped; caller advances to next dispatcher
 *
 * Python/Ruby reuse `function_definition` for methods inside class
 * bodies; the inside-class guard picks the method extractor in that
 * case (otherwise the symbol would be emitted as a free function).
 */
function tryDispatchFunctionLike(ctx: TsDispatchCtx): boolean | null {
  const { ext, lang, node, t } = ctx;
  if (lang.functionTypes.includes(t)) {
    if (tsIsInsideClassLikeNode(ext) && lang.methodTypes.includes(t)) {
      tsExtractMethod(ext, node);
    } else {
      tsExtractFunction(ext, node);
    }
    return true;
  }
  if (lang.methodTypes.includes(t)) {
    tsExtractMethod(ext, node);
    return true;
  }
  return null;
}

/**
 * Try to dispatch a type-shaped node (class, struct, enum, interface,
 * type alias). `extractTypeAlias` returns its OWN recurse flag (Go
 * `type_spec` may wrap a struct or interface inside the alias).
 * Returns `null` when no type-shape matched.
 */
function tryDispatchClassLike(ctx: TsDispatchCtx): boolean | null {
  const { ext, lang, node, t } = ctx;
  if (lang.classTypes.includes(t)) {
    tsExtractClassByClassification(ext, node);
    return true;
  }
  if (lang.extraClassNodeTypes?.includes(t)) {
    tsExtractClass(ext, node);
    return true;
  }
  if (lang.interfaceTypes.includes(t)) {
    tsExtractInterface(ext, node);
    return true;
  }
  if (lang.structTypes.includes(t)) {
    tsExtractStruct(ext, node);
    return true;
  }
  if (lang.enumTypes.includes(t)) {
    tsExtractEnum(ext, node);
    return true;
  }
  if (lang.typeAliasTypes.includes(t)) return extractTypeAlias(ext, node);
  return null;
}

/**
 * Try to dispatch a class-member declaration (property, field) or a
 * top-level variable. The `variableTypes` case is gated by the
 * INVERSE class-context guard: a variable-shaped node inside a class
 * body falls through to its children (so e.g. decorators on a
 * variable can still extract) instead of emitting a stray variable
 * symbol that would compete with the class field.
 */
function tryDispatchMemberLike(ctx: TsDispatchCtx): boolean | null {
  const { ext, lang, node, t } = ctx;
  if (lang.propertyTypes?.includes(t) && tsIsInsideClassLikeNode(ext)) {
    tsExtractProperty(ext, node);
    return true;
  }
  if (lang.fieldTypes?.includes(t) && tsIsInsideClassLikeNode(ext)) {
    tsExtractField(ext, node);
    return true;
  }
  if (lang.variableTypes.includes(t) && !tsIsInsideClassLikeNode(ext) && !tsIsInsideFunctionLikeNode(ext)) {
    extractVariable(ext, node);
    return true;
  }
  return null;
}

/**
 * Try to dispatch an edge-emitting node that should NOT short-circuit
 * the recursion — imports, calls, instantiations, `impl_item`. The
 * `false` return signals "handled, but caller still walks children"
 * (e.g. nested calls inside constructor args still produce their own
 * edges).
 */
function tryDispatchReferenceLike(ctx: TsDispatchCtx): boolean | null {
  const { ext, lang, node, t } = ctx;
  if (lang.importTypes.includes(t)) {
    extractImport(ext, node);
    return false;
  }
  if (t === 'export_statement') {
    tryEmitTypeReExportRefs(ext, node);
    return false;
  }
  if (lang.callTypes.includes(t)) {
    tsExtractCall(ext, node);
    return false;
  }
  if (INSTANTIATION_KINDS.has(t)) {
    tsExtractInstantiation(ext, node);
    return false;
  }
  if (t === 'impl_item') {
    extractRustImplItem(ext, node);
    return false;
  }
  return null;
}

/**
 * Match a node against the extractor's declared kind tables and
 * dispatch to the right extract* free function. Returns `true` when the
 * extractor walks its own children (caller should not recurse).
 *
 * Branch ordering matters: `functionTypes` is checked before
 * `methodTypes` so a node listed in both (Python/Ruby `function_definition`)
 * routes via the in-class check inside the function-types branch.
 */
function tsDispatchByNodeKind(ext: TreeSitterExtractor, node: SyntaxNode): boolean {
  const ctx: TsDispatchCtx = { ext, lang: ext.extractor!, node, t: node.type };
  // Per-branch profile wraps — B14 bisection. Records hit-counts AND
  // cumulative wall per category on `worker:dispatch:<branch>:<lang>`,
  // so the rollup at end of parse phase shows which kind of AST node
  // (function/class/member/reference) dominates the walker cost.
  // Zero overhead when `CARTOGRAPH_EXTRACTION_PROFILE` is unset.
  const handled =
    profile(`worker:dispatch:fn`, () => tryDispatchFunctionLike(ctx)) ??
    profile(`worker:dispatch:class`, () => tryDispatchClassLike(ctx)) ??
    profile(`worker:dispatch:member`, () => tryDispatchMemberLike(ctx)) ??
    profile(`worker:dispatch:ref`, () => tryDispatchReferenceLike(ctx));
  return handled ?? false;
}

/**
 * Some languages reuse `class_declaration` for structs / enums / interfaces /
 * traits (e.g. Swift). Defer to the extractor's classifier and route to the
 * matching extract* free function.
 */
function tsExtractClassByClassification(ext: TreeSitterExtractor, node: SyntaxNode): void {
  const classification = ext.extractor!.classifyClassNode?.(node) ?? 'class';
  switch (classification) {
    case 'struct':
      tsExtractStruct(ext, node);
      break;
    case 'enum':
      tsExtractEnum(ext, node);
      break;
    case 'interface':
      tsExtractInterface(ext, node);
      break;
    case 'trait':
      tsExtractClass(ext, node, 'trait');
      break;
    default:
      tsExtractClass(ext, node);
      break;
  }
}

/**
 * Resolve the body subtree for a function/method/class node, honoring
 * the language extractor's optional `resolveBody` override before
 * falling back to the configured `bodyField`.
 *
 * Exported — `ts-extract-declarations.ts` and `ts-extract-bodies.ts`
 * both resolve a node's body through it.
 */
export function resolveNodeBody(ext: TreeSitterExtractor, node: SyntaxNode): SyntaxNode | null {
  if (!ext.extractor) return null;
  return ext.extractor.resolveBody?.(node, ext.extractor.bodyField) ?? getChildByField(node, ext.extractor.bodyField);
}

/**
 * F#12 slice 1: read the per-file mode threshold. Default 500 LOC.
 * `Infinity` (env var = `Infinity` literal) means "always eager"
 * (Option A behaviour); `0` means "never eager". The orchestrator
 * exports this env var from `config.largeFunctionThreshold` before the
 * worker pool spawns so workers inherit it.
 *
 * Reading the env var on every parse is cheap (a tiny string parse);
 * keeping it function-local avoids module-load order issues with the
 * orchestrator setting the env var AFTER this module loaded.
 */
function getLargeFunctionThreshold(): number {
  const raw = process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'];
  if (raw === undefined || raw === '') return 500;
  if (raw === 'Infinity') return Number.POSITIVE_INFINITY;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 500;
}

/**
 * F#12 slice 1: decide whether this file gets eager nested-function
 * extraction. JS/JS-family-only — other languages need their own
 * nested-fn recognizers (per the F#12 plan's open question #7).
 *
 * Fast path: file LOC at or below threshold → no function body can
 * exceed it. Otherwise walk the tree once to find the largest function
 * body LOC; short-circuit as soon as one crosses the threshold.
 */
function determineEagerNestedFnMode(ext: TreeSitterExtractor, root: SyntaxNode): boolean {
  if (!ext.extractor) return false;
  if (!isJsFamily(ext.language)) return false;
  const threshold = getLargeFunctionThreshold();
  if (threshold === 0) return false;
  if (threshold === Number.POSITIVE_INFINITY) return true;
  const fileLoc = root.endPosition.row - root.startPosition.row + 1;
  if (fileLoc <= threshold) return true;
  const fnTypes = new Set<string>([...ext.extractor.functionTypes, ...ext.extractor.methodTypes]);
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (fnTypes.has(node.type)) {
      const body = resolveNodeBody(ext, node);
      if (body) {
        const loc = body.endPosition.row - body.startPosition.row + 1;
        if (loc > threshold) return false;
      }
    }
    for (const child of node.namedChildren) {
      if (child) stack.push(child);
    }
  }
  return true;
}

/**
 * Try to emit `references` edges for type re-exports in TS/JS.
 * When an export_statement contains a `source` field (re-export) and
 * we can find named_exports, we emit references so the `unused_export`
 * biomarker counts the re-exporting module as a consumer of the original
 * exports. We don't check for the `type` keyword — just emit references
 * for all re-exports because they're all consumers.
 *
 * Shape: `export type { Foo, Bar } from './module';`
 * Shape: `export { Foo, Bar } from './module';` (also re-exports)
 */
function tryEmitTypeReExportRefs(ext: TreeSitterExtractor, exportNode: SyntaxNode): void {
  if (ext.nodeStack.length === 0) return;
  const parentId = ext.nodeStack[ext.nodeStack.length - 1];
  if (!parentId) return;

  // Look for named_exports in the export_statement's children (indicates a re-export)
  const namedExports = exportNode.namedChildren.find((c) => c.type === 'named_exports');
  if (!namedExports) return;

  for (const spec of namedExports.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    // For export_specifier, the name field holds the exported name,
    // and alias holds the local alias (if present).
    const aliasNode = getChildByField(spec, 'alias');
    const nameNode = aliasNode ?? getChildByField(spec, 'name') ?? spec.namedChild(0);
    if (!nameNode) continue;
    const exportName = getNodeText(nameNode, ext.source);
    if (!exportName) continue;
    ext.unresolvedReferences.push({
      fromNodeId: parentId,
      referenceName: exportName,
      referenceKind: 'references',
      line: spec.startPosition.row + 1,
      column: spec.startPosition.column,
    });
  }
}

/**
 * Extract nodes and edges from source code
 */
export function extractFromSource(filePath: string, source: string, language?: Language): ExtractionResult {
  const detectedLanguage = language || detectLanguage(filePath, source);
  const fileExtension = path.extname(filePath).toLowerCase();
  const def = getLanguageDefByName(detectedLanguage);

  // Per-extension override wins (e.g. Pascal `.dfm`/`.fmx` route to
  // DfmExtractor rather than the tree-sitter Pascal grammar).
  const override = def?.extensionOverrides?.[fileExtension];
  if (override) {
    return override.customExtractor(filePath, source);
  }

  // Whole-language custom extractor (Liquid, Svelte, etc.).
  if (def?.customExtractor) {
    return def.customExtractor(filePath, source);
  }

  // Optional length-preserving pre-parse rewrite (e.g. ObjC RN bridge macros,
  // F#82b). Length-preserving by contract, so node offsets / line numbers stay
  // exact; the rewritten text is used for ALL subsequent reads.
  const parseSource = def?.preParseSourceTransform ? def.preParseSourceTransform(source) : source;

  // Tree-sitter path.
  const extractor = new TreeSitterExtractor(filePath, parseSource, detectedLanguage);
  return extractor.extract();
}
