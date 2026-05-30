/**
 * Schema-DSL recognizer registry (backlog B2).
 *
 * `runSchemaRecognizers` is a POST-EXTRACTION pass: `tree-sitter.ts`
 * calls it after the language extractor has produced the base nodes
 * and while the parsed tree is still live. Each registered
 * `SchemaRecognizer` whose `languages` match and whose `detect` fires
 * synthesizes data-model nodes/edges (a Zod schema → `struct` /
 * `field` / `enum_member`), which are appended to the file's
 * `ExtractionResult`.
 *
 * Adding a DSL (Pydantic, Prisma, …) is one file + one entry in
 * `RECOGNIZERS` — the `frameworks/`-registry shape.
 *
 * SELF-HEAL. There is deliberately no separate `SCHEMA_RECOGNIZER_VERSION`
 * constant: the recognizer pass runs INSIDE extraction, so the
 * recognizer source files (`schema-recognizers/{index,zod,types}.ts`)
 * are folded into `EXTRACTION_LOGIC_VERSION`'s algo-hash (see
 * `extraction-logic-version.ts`). Editing a recognizer flips that
 * version; the next sync re-extracts every file and re-runs the
 * recognizers — the existing self-heal, reused.
 */

import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Language, Node } from '../../types.js';
import type { NodeIdFactory } from '../tree-sitter-helpers.js';
import type { SchemaRecognizer, SchemaRecognizerContext, SchemaRecognizerResult } from './types.js';
import { EMPTY_RESULT } from './types.js';
import { pydanticRecognizer } from './pydantic.js';
import { zodRecognizer } from './zod.js';

/** Every registered recognizer. Add a DSL by appending one entry. */
const RECOGNIZERS: readonly SchemaRecognizer[] = [zodRecognizer, pydanticRecognizer];

/** Inputs `tree-sitter.ts` hands the post-extraction pass. */
export interface RunSchemaRecognizersArgs {
  readonly filePath: string;
  readonly source: string;
  readonly language: Language;
  /** Root of the file's still-live parsed tree-sitter tree. */
  readonly rootNode: SyntaxNode;
  /** Nodes the language extractor already emitted for this file —
   *  the file's import set is derived from them to gate `detect`. */
  readonly extractedNodes: readonly Node[];
  /** The host extractor's per-file id factory. Shared so a synthesized
   *  `struct` facet and the base `class` facet stay in the same ordinal
   *  namespace per (kind, name). */
  readonly idFactory: NodeIdFactory;
}

/**
 * Run every applicable recognizer over one file and return the
 * synthesized nodes + edges (empty when nothing matched).
 */
export function runSchemaRecognizers(args: RunSchemaRecognizersArgs): SchemaRecognizerResult {
  // Fast bail — no recognizer handles this language.
  if (!RECOGNIZERS.some((r) => r.languages.has(args.language))) return EMPTY_RESULT;

  // The file's import specifiers live on the already-emitted import
  // nodes (`import_node.name` is the spec, e.g. `'zod'`).
  const imports = new Set<string>();
  for (const n of args.extractedNodes) {
    if (n.kind === 'import') imports.add(n.name);
  }

  const ctx: SchemaRecognizerContext = {
    filePath: args.filePath,
    source: args.source,
    language: args.language,
    rootNode: args.rootNode,
    imports,
    extractedNodes: args.extractedNodes,
    idFactory: args.idFactory,
  };

  const nodes: Node[] = [];
  const edges: Edge[] = [];
  for (const recognizer of RECOGNIZERS) {
    if (!recognizer.languages.has(ctx.language)) continue;
    if (!recognizer.detect(ctx)) continue;
    const res = recognizer.extract(ctx);
    nodes.push(...res.nodes);
    edges.push(...res.edges);
  }
  return nodes.length > 0 ? { nodes, edges } : EMPTY_RESULT;
}
