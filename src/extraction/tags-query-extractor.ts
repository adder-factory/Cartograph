import * as fs from 'node:fs';
import * as path from 'node:path';
import { Query } from 'web-tree-sitter';
import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { ExtractionResult, NodeKind, Language } from '../types.js';
import { getNodeText, type NodeIdFactory } from './tree-sitter-helpers.js';
import { getParser, getLanguageGrammar } from './grammars.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * TagsQueryExtractor — a query-driven generic extractor.
 *
 * Most cartograph languages have a hand-written extractor in
 * `tree-sitter.ts` / `languages/<name>.ts` that walks the AST and emits
 * cartograph's full edge graph (imports, signatures, type refs, the
 * method-vs-function split, …). This extractor is NOT a replacement for
 * those — it is the *new-language onramp*.
 *
 * tree-sitter's ecosystem ships a standard code-navigation query
 * convention: each grammar repo carries `queries/tags.scm` with captures
 * like `@definition.{class,function,method,module,…}`,
 * `@reference.{call,…}`, `@name`, and sometimes `@doc`. This extractor
 * runs a vendored `tags.scm` (`src/extraction/tags/<lang>.scm`) against
 * the file and turns those captures into cartograph `Node`s + `calls`
 * references — baseline symbol coverage for a language that has no hand
 * extractor yet.
 *
 * What it produces:
 *  - one `Node` per `@definition.<kind>` capture (kind mapped via
 *    {@link DEFINITION_KIND_MAP}; unknown kinds are skipped),
 *  - `contains` edges (file → def, and def → def by range nesting),
 *  - an `UnresolvedReference` (`calls`) per `@reference.call` capture,
 *  - a best-effort docstring from a `@doc` capture when present.
 *
 * What it does NOT produce: imports, signatures with parameter/return
 * types, or any of cartograph's richer edges. A `tags.scm` query is a
 * strict subset of what a hand extractor sees — this is a floor, not
 * parity. A language that earns it should graduate to a hand extractor.
 */

// ---------------------------------------------------------------------------
// Kind mapping
// ---------------------------------------------------------------------------

/**
 * `@definition.<suffix>` → cartograph `NodeKind`. The suffix vocabulary is
 * tree-sitter's tags convention; grammars vary in which subset they use.
 * A suffix absent from this map produces no node (the match is skipped).
 */
const DEFINITION_KIND_MAP: Readonly<Record<string, NodeKind>> = {
  class: 'class',
  function: 'function',
  method: 'method',
  module: 'module',
  interface: 'interface',
  constant: 'constant',
  struct: 'struct',
  type: 'type_alias',
  enum: 'enum',
  field: 'field',
  variable: 'variable',
  namespace: 'namespace',
  // Languages with macros / protocols / traits map onto the nearest kind.
  macro: 'function',
  protocol: 'protocol',
  trait: 'trait',
};

/**
 * `@reference.<suffix>` suffixes that become an `UnresolvedReference`.
 * Only `call` is wired for v1 — the resolver name-matches these into
 * `calls` edges. Other reference suffixes (`reference.implementation`,
 * `reference.type`, …) are intentionally dropped: a hand extractor is the
 * right tool for richer cross-references.
 */
const REFERENCE_SUFFIXES: ReadonlySet<string> = new Set(['call']);

// ---------------------------------------------------------------------------
// Per-language `.scm` + compiled-`Query` caches
// ---------------------------------------------------------------------------

/** Raw `tags.scm` text per language, read from disk once. */
const scmTextCache = new Map<Language, string | null>();
/** Compiled `Query` per language. A `Query` is bound to a grammar that
 *  lives in `grammars.ts`'s `languageCache` (never evicted), so caching
 *  one per language for the process lifetime is safe. */
const queryCache = new Map<Language, Query>();

/**
 * Vendored tags query for `language`, or null when no `.scm` is shipped.
 * Resolved against this module's directory — `src/extraction/tags/` in
 * source, `dist/extraction/tags/` in a built artifact (copied there by
 * `scripts/copy-assets.mjs`).
 */
function loadTagsScm(language: Language): string | null {
  const cached = scmTextCache.get(language);
  if (cached !== undefined) return cached;
  const scmPath = path.join(import.meta.dirname, 'tags', `${language}.scm`);
  let text: string | null;
  try {
    text = fs.readFileSync(scmPath, 'utf-8');
  } catch {
    text = null;
  }
  scmTextCache.set(language, text);
  return text;
}

// ---------------------------------------------------------------------------
// Per-match parsing
// ---------------------------------------------------------------------------

/** A `@definition.*` capture resolved into a cartograph symbol. */
interface DefRecord {
  kind: NodeKind;
  name: string;
  /** The whole construct (used for range nesting + line numbers). */
  defNode: SyntaxNode;
  doc: string | undefined;
  /** Assigned during emit — dotted path through enclosing defs. */
  qualifiedName: string;
  /** Assigned during emit. */
  id: string;
}

/** A `@reference.call` capture awaiting cross-file resolution. */
interface RefRecord {
  referenceName: string;
  node: SyntaxNode;
}

/** First non-blank line of a node's text, trimmed and length-capped. */
function firstLineSignature(node: SyntaxNode, source: string): string {
  const text = getNodeText(node, source);
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
  }
  return '';
}

/** Collapse a `@doc` capture to a short single-paragraph docstring. */
function cleanDoc(node: SyntaxNode, source: string): string | undefined {
  const text = getNodeText(node, source).trim();
  if (!text) return undefined;
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

/**
 * `dn` strictly contains `target` — equal ranges are NOT containment, so
 * two same-range definitions never become parent/child of each other
 * (which would risk a `contains` cycle).
 */
function strictlyContains(dn: SyntaxNode, target: SyntaxNode): boolean {
  return (
    dn.startIndex <= target.startIndex &&
    dn.endIndex >= target.endIndex &&
    (dn.startIndex < target.startIndex || dn.endIndex > target.endIndex)
  );
}

/** Innermost def whose range strictly contains `target`, or null. */
function innermostDefAround(defs: DefRecord[], target: SyntaxNode): DefRecord | null {
  let best: DefRecord | null = null;
  let bestSpan = Number.POSITIVE_INFINITY;
  for (const d of defs) {
    if (!strictlyContains(d.defNode, target)) continue;
    const span = d.defNode.endIndex - d.defNode.startIndex;
    if (span < bestSpan) {
      best = d;
      bestSpan = span;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Capture processing helpers
// ---------------------------------------------------------------------------

/** Return type of {@link collectSuppressionSets}. */
interface SuppressionSets {
  /** IDs of AST nodes captured as `@ignore` — any def/ref whose `@name` is in this set is dropped. */
  ignoredNodeIds: Set<number>;
  /** IDs of `@name` nodes that belong to a definition match — filters out self-matching reference patterns. */
  defNameNodeIds: Set<number>;
}

/**
 * Pass 1 — scan all matches and collect the two suppression sets described
 * in {@link TagsQueryExtractor.collectCaptures}'s method doc. Pure function
 * over the match list; extracted to keep the main pass linear and testable.
 */
function collectSuppressionSets(matches: ReturnType<Query['matches']>): SuppressionSets {
  const ignoredNodeIds = new Set<number>();
  const defNameNodeIds = new Set<number>();
  for (const match of matches) {
    let isDefinition = false;
    let nameNode: SyntaxNode | undefined;
    for (const cap of match.captures) {
      if (cap.name === 'ignore') {
        ignoredNodeIds.add(cap.node.id);
        continue;
      }
      if (cap.name === 'name') {
        nameNode = cap.node;
        continue;
      }
      if (cap.name.startsWith('definition.')) isDefinition = true;
    }
    if (isDefinition && nameNode) defNameNodeIds.add(nameNode.id);
  }
  return { ignoredNodeIds, defNameNodeIds };
}

/** The role-relevant capture nodes pulled from one tags.scm match. */
interface MatchRole {
  /** `'definition'` or `'reference'` — the half of the `@role.suffix` capture before the dot. */
  roleKind: string;
  /** The capture suffix after the dot (`function`, `call`, `class`, …). */
  suffix: string;
  /** The `@definition.*` / `@reference.*` capture node — the role anchor. */
  roleNode: SyntaxNode;
  /** The `@name` capture node — the identifier token. */
  nameNode: SyntaxNode;
  /** The optional `@doc` capture node. */
  docNode: SyntaxNode | undefined;
}

/** Loop-invariant context threaded into {@link buildDefRecord}. */
interface DefBuildContext {
  filePath: string;
  source: string;
  /** Dedup key (kind:name:astNodeId) of defs already emitted — overlapping
   *  patterns can double-capture the same AST node. Pre-2026-05-21 the
   *  generated id itself collided when line+kind+name matched; the factory
   *  now mints distinct ordinals per call, so we dedup on the AST node id
   *  instead. */
  seenDefKeys: Set<string>;
  idFactory: NodeIdFactory;
}

/** Arguments for {@link buildDefAndRefRecords}. */
interface BuildRecordsArgs {
  matches: ReturnType<Query['matches']>;
  suppression: SuppressionSets;
  source: string;
  filePath: string;
  idFactory: NodeIdFactory;
}

/**
 * Pull the `@name` / `@doc` / `@definition.*` | `@reference.*` capture nodes
 * from one match. `null` when the match carries no role or no name node.
 */
function readMatchRole(match: ReturnType<Query['matches']>[number]): MatchRole | null {
  let roleName: string | undefined;
  let roleNode: SyntaxNode | undefined;
  let nameNode: SyntaxNode | undefined;
  let docNode: SyntaxNode | undefined;
  for (const cap of match.captures) {
    if (cap.name === 'name') {
      nameNode = cap.node;
      continue;
    }
    if (cap.name === 'doc') {
      docNode = cap.node;
      continue;
    }
    if (cap.name.startsWith('definition.') || cap.name.startsWith('reference.')) {
      roleName = cap.name;
      roleNode = cap.node;
    }
  }
  if (!roleName || !roleNode || !nameNode) return null;
  const [roleKind, suffix] = roleName.split('.', 2) as [string, string];
  return { roleKind, suffix, roleNode, nameNode, docNode };
}

/** Build a {@link RefRecord} from a reference-role match — `null` when the
 *  suffix isn't a reference suffix or rule 2 (self-match) suppresses it. */
function buildRefRecord(role: MatchRole, name: string, suppression: SuppressionSets): RefRecord | null {
  if (!REFERENCE_SUFFIXES.has(role.suffix)) return null;
  if (suppression.defNameNodeIds.has(role.nameNode.id)) return null; // rule 2
  return { referenceName: name, node: role.roleNode };
}

/** Build a {@link DefRecord} from a definition-role match — `null` when the
 *  suffix maps to no kind or the generated id was already emitted. */
function buildDefRecord(role: MatchRole, name: string, ctx: DefBuildContext): DefRecord | null {
  const kind = DEFINITION_KIND_MAP[role.suffix];
  if (!kind) return null;
  const dedupKey = `${kind}:${name}:${role.roleNode.id}`;
  if (ctx.seenDefKeys.has(dedupKey)) return null;
  ctx.seenDefKeys.add(dedupKey);
  const id = ctx.idFactory.next(kind, name);
  return {
    kind,
    name,
    defNode: role.roleNode,
    doc: role.docNode ? cleanDoc(role.docNode, ctx.source) : undefined,
    qualifiedName: name,
    id,
  };
}

/**
 * Pass 2 — iterate all matches and build {@link DefRecord} / {@link RefRecord}
 * lists, enforcing the two suppression rules. Definitions are de-duplicated
 * by generated node id (overlapping tags.scm patterns can capture the same
 * symbol twice).
 */
function buildDefAndRefRecords({ matches, suppression, source, filePath, idFactory }: BuildRecordsArgs): {
  defs: DefRecord[];
  refs: RefRecord[];
} {
  const defs: DefRecord[] = [];
  const refs: RefRecord[] = [];
  const ctx: DefBuildContext = { filePath, source, seenDefKeys: new Set<string>(), idFactory };

  for (const match of matches) {
    const role = readMatchRole(match);
    if (!role) continue;
    if (suppression.ignoredNodeIds.has(role.nameNode.id)) continue; // rule 1
    const name = getNodeText(role.nameNode, source).trim();
    if (!name) continue;

    if (role.roleKind === 'reference') {
      const ref = buildRefRecord(role, name, suppression);
      if (ref) refs.push(ref);
    } else {
      const def = buildDefRecord(role, name, ctx);
      if (def) defs.push(def);
    }
  }
  return { defs, refs };
}

// ---------------------------------------------------------------------------
// Extractor
// ---------------------------------------------------------------------------

export class TagsQueryExtractor extends StandaloneExtractor {
  private readonly language: Language;

  constructor(filePath: string, source: string, language: Language) {
    super(filePath, source);
    this.language = language;
  }

  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser(this.language);
    if (!parser) {
      this.errors.push({
        message: `${this.language} grammar not loaded`,
        severity: 'error',
        code: 'grammar_unavailable',
      });
      return this.result(startTime);
    }

    const query = this.getQuery();
    if (!query) return this.result(startTime);

    let tree: Tree | null;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({
        message: `${this.language} parse error: ${errMsg(e)}`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({
        message: `${this.language} parse returned no tree`,
        severity: 'error',
        code: 'parse_error',
      });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode(this.language).id;
      const { defs, refs } = this.collectCaptures(query, tree.rootNode);
      this.emitDefs(defs, fileNodeId);
      this.emitRefs(refs, defs, fileNodeId);
      return this.result(startTime);
    } catch (e) {
      this.errors.push({
        message: `${this.language} tags extraction error: ${errMsg(e)}`,
        severity: 'warning',
        code: 'extraction_error',
      });
      return this.result(startTime);
    } finally {
      // Free WASM heap — web-tree-sitter trees hold native memory
      // invisible to V8's GC.
      tree.delete();
    }
  }

  /** Compile (and cache) the vendored `tags.scm` query for this language. */
  private getQuery(): Query | null {
    const cached = queryCache.get(this.language);
    if (cached) return cached;

    const scm = loadTagsScm(this.language);
    if (!scm) {
      this.errors.push({
        message: `No vendored tags.scm for ${this.language} (expected src/extraction/tags/${this.language}.scm)`,
        severity: 'error',
        code: 'grammar_unavailable',
      });
      return null;
    }
    const grammar = getLanguageGrammar(this.language);
    if (!grammar) {
      this.errors.push({
        message: `${this.language} grammar not loaded`,
        severity: 'error',
        code: 'grammar_unavailable',
      });
      return null;
    }
    try {
      const query = new Query(grammar, scm);
      queryCache.set(this.language, query);
      return query;
    } catch (e) {
      this.errors.push({
        message: `${this.language} tags.scm failed to compile: ${errMsg(e)}`,
        severity: 'error',
        code: 'extraction_error',
      });
      return null;
    }
  }

  /**
   * Walk every query match into {@link DefRecord} / {@link RefRecord}.
   *
   * The tags convention puts at most one `@definition.*` / `@reference.*`
   * capture per match alongside a `@name` (and maybe `@doc`). Two
   * suppression rules keep the output honest:
   *
   *  1. `@ignore` — a grammar suppresses keyword / builtin "calls" with a
   *     pattern that captures the keyword identifier as `@ignore` (in
   *     Elixir: `def` / `defmodule` / `@attr`). Without this, every
   *     `def`/`defmodule` re-matches the generic call-reference pattern
   *     and floods the graph with bogus `calls "def"` edges. Any def /
   *     ref whose `@name` node IS an `@ignore`-captured node is dropped.
   *  2. A `@reference.call` whose `@name` node is also a definition's
   *     `@name` node is the definition site itself re-matching the
   *     call pattern (Elixir's function-clause head), not a real call —
   *     dropped. Genuine recursion uses a distinct call node and lives.
   *
   * Definitions are de-duplicated by node id — overlapping tags.scm
   * patterns can capture the same symbol twice.
   */
  private collectCaptures(query: Query, root: SyntaxNode): { defs: DefRecord[]; refs: RefRecord[] } {
    const matches = query.matches(root);
    // Pass 1 — collect the two suppression sets (see method doc).
    const suppression = collectSuppressionSets(matches);
    // Pass 2 — build records, applying the suppression rules.
    return buildDefAndRefRecords({
      matches,
      suppression,
      source: this.source,
      filePath: this.filePath,
      idFactory: this.idFactory,
    });
  }

  /**
   * Emit one `Node` per definition plus its `contains` edge. Outer-first
   * ordering means each definition's enclosing parent is already emitted
   * when we reach it, so its `qualifiedName` (a dotted path through the
   * enclosing defs) is ready to extend.
   */
  private emitDefs(defs: DefRecord[], fileNodeId: string): void {
    const ordered = [...defs].sort(
      (a, b) => a.defNode.startIndex - b.defNode.startIndex || b.defNode.endIndex - a.defNode.endIndex,
    );
    for (const def of ordered) {
      const parent = innermostDefAround(defs, def.defNode);
      if (parent) def.qualifiedName = `${parent.qualifiedName}.${def.name}`;

      this.nodes.push({
        id: def.id,
        kind: def.kind,
        name: def.name,
        qualifiedName: def.qualifiedName,
        filePath: this.filePath,
        language: this.language,
        startLine: def.defNode.startPosition.row + 1,
        endLine: def.defNode.endPosition.row + 1,
        startColumn: def.defNode.startPosition.column,
        endColumn: def.defNode.endPosition.column,
        signature: firstLineSignature(def.defNode, this.source),
        ...(def.doc ? { docstring: def.doc } : {}),
        updatedAt: Date.now(),
      });
      this.edges.push({ source: parent ? parent.id : fileNodeId, target: def.id, kind: 'contains' });
    }
  }

  /**
   * Emit an `UnresolvedReference` (`calls`) per `@reference.call`,
   * attributed to the innermost enclosing definition (the file node when
   * the call sits outside every definition — top-level script code).
   */
  private emitRefs(refs: RefRecord[], defs: DefRecord[], fileNodeId: string): void {
    for (const ref of refs) {
      const owner = innermostDefAround(defs, ref.node);
      this.unresolvedReferences.push({
        fromNodeId: owner ? owner.id : fileNodeId,
        referenceName: ref.referenceName,
        referenceKind: 'calls',
        line: ref.node.startPosition.row + 1,
        column: ref.node.startPosition.column,
      });
    }
  }
}
