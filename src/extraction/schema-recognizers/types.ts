/**
 * Schema-DSL recognizer registry — types (backlog B2).
 *
 * THE GAP
 * -------
 * To tree-sitter, a `z.object({ ... })` is an opaque `const` whose
 * value is a call-chain. The language extractor sees the binding but
 * not the *data model* inside it — the fields, their typed
 * constraints, the enum literal sets. A `SchemaRecognizer` runs over
 * the already-parsed AST and synthesizes that structure as ordinary
 * `struct` / `field` / `enum_member` nodes + `contains` edges, so
 * `cartograph_find` / `cartograph_graph` can answer field-granular
 * questions ("what fields does this schema have").
 *
 * Modelled on `src/resolution/frameworks/` (per-framework recognizers
 * over a parsed AST) — but a recognizer here runs as a POST-EXTRACTION
 * pass (see `./index.ts`), not at resolution time. Adding a DSL is one
 * file + one registry entry.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Language, Node } from '../../types.js';
import type { NodeIdFactory } from '../tree-sitter-helpers.js';

/** What a recognizer is handed for one file. */
export interface SchemaRecognizerContext {
  /** Project-relative path of the file under extraction. */
  readonly filePath: string;
  /** File source text. */
  readonly source: string;
  /** Detected language of the file. */
  readonly language: Language;
  /** Root of the file's parsed tree-sitter tree. */
  readonly rootNode: SyntaxNode;
  /**
   * Import specifiers the file pulls in (e.g. `'zod'`). A recognizer's
   * `detect` gates on this so it fires ONLY on files that actually
   * import the library — a Zod recognizer never walks a file that
   * doesn't `import … from 'zod'`.
   */
  readonly imports: ReadonlySet<string>;
  /**
   * Nodes the language extractor already emitted for this file. A
   * recognizer uses these to attribute *consumer* edges — e.g. a
   * `type_of` edge from a `type User = z.infer<typeof X>` alias needs
   * the alias's already-extracted node id as the edge source. Found by
   * smallest-enclosing line range (see `zod.ts` `enclosingNodeId`).
   */
  readonly extractedNodes: readonly Node[];
  /**
   * The per-file id factory the host extractor has already been minting
   * ids from. Recognizers share the same factory so a struct facet
   * synthesized here and the base `class` facet emitted by the language
   * extractor share the file's ordinal namespace without colliding
   * (kind differs).
   */
  readonly idFactory: NodeIdFactory;
}

/** Nodes + edges a recognizer synthesized for one file. */
export interface SchemaRecognizerResult {
  readonly nodes: Node[];
  readonly edges: Edge[];
}

/** One embedded-schema-DSL recognizer (Zod, …). */
export interface SchemaRecognizer {
  /** Stable identifier — `'zod'` | `'pydantic'` | … */
  readonly name: string;
  /** Languages this recognizer can run on; the registry skips others. */
  readonly languages: ReadonlySet<Language>;
  /** Cheap gate — does the file use this DSL? (usually an import check) */
  detect(ctx: SchemaRecognizerContext): boolean;
  /** Walk the AST and synthesize data-model nodes + edges. */
  extract(ctx: SchemaRecognizerContext): SchemaRecognizerResult;
}

/** Empty result — the shared "this recognizer found nothing" value. */
export const EMPTY_RESULT: SchemaRecognizerResult = { nodes: [], edges: [] };
