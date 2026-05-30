import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Node, Edge, ExtractionResult, ExtractionError, UnresolvedReference, Language } from '../types.js';
import { generateNodeId, createIdFactory, type NodeIdFactory } from './tree-sitter-helpers.js';
import { errMsg } from '../errors.js';
import { buildExtractionResult } from './extraction-result-helpers.js';

/**
 * Abstract base class for standalone (non-`LanguageExtractor`) extractors that
 * own their own accumulator fields and do not delegate to `tree-sitter.ts`.
 *
 * Provides:
 *  - `protected` accumulator fields: `nodes`, `edges`, `unresolvedReferences`, `errors`.
 *  - `protected result(startTime)` — assembles an `ExtractionResult` from the
 *    accumulators (eliminates the byte-identical clone across graphql / hcl / sql).
 *  - `protected createFileNode(language)` — pushes a file-kind node and returns
 *    the full `Node` record (callers that only need the id use `.id`). The
 *    `filePath` and `source` come from the subclass constructor fields.
 *    Eliminates the near-clone in graphql / sql (clone class 3) and dfm / liquid
 *    (clone class 4) — the only variation was the `language` string.
 *  - `protected tryVisit(node, visitFn, errorMsgPrefix)` — per-node try/catch
 *    wrapper (eliminates the near-clone across `tryVisitDefinition` /
 *    `tryVisitTopLevelBlock` / `tryVisitStatement`). On a thrown error it
 *    records an `ExtractionError` at the node's line and keeps going.
 */
export abstract class StandaloneExtractor {
  protected readonly filePath: string;
  protected readonly source: string;
  protected readonly nodes: Node[] = [];
  protected readonly edges: Edge[] = [];
  protected readonly unresolvedReferences: UnresolvedReference[] = [];
  protected readonly errors: ExtractionError[] = [];
  protected readonly idFactory: NodeIdFactory;

  constructor(filePath: string, source: string) {
    this.filePath = filePath;
    this.source = source;
    this.idFactory = createIdFactory(filePath);
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  /**
   * Assemble an {@link ExtractionResult} from the accumulated state and the
   * epoch captured at the start of `extract()`. Eliminates the byte-identical
   * `result(startTime)` clone across all standalone extractors.
   */
  protected result(startTime: number): ExtractionResult {
    return buildExtractionResult(
      { nodes: this.nodes, edges: this.edges, unresolvedReferences: this.unresolvedReferences, errors: this.errors },
      startTime,
    );
  }

  /**
   * Push a file-kind `Node` for the current source file and return it.
   * The caller takes `.id` when only the node id is needed.
   *
   * Eliminates the near-clone between graphql / sql (clone class 3) and
   * dfm / liquid (clone class 4) — the only variation between them was the
   * `language` string.
   */
  protected createFileNode(language: Language): Node {
    const lines = this.source.split('\n');
    const id = generateNodeId({ filePath: this.filePath, kind: 'file', name: this.filePath, ordinal: 0 });
    const fileNode: Node = {
      id,
      kind: 'file',
      name: this.filePath.split('/').pop() || this.filePath,
      qualifiedName: this.filePath,
      filePath: this.filePath,
      language,
      startLine: 1,
      endLine: lines.length,
      startColumn: 0,
      endColumn: lines.at(-1)?.length ?? 0,
      updatedAt: Date.now(),
    };
    this.nodes.push(fileNode);
    return fileNode;
  }

  /**
   * Per-node try/catch wrapper for tree-sitter-backed extractors.
   *
   * Pulled from the three near-identical `tryVisitDefinition` /
   * `tryVisitTopLevelBlock` / `tryVisitStatement` methods — the only
   * differences were the error-message prefix and the inner call.
   *
   * @param node          The AST node being visited (used for `line` on error).
   * @param visitFn       The per-node visitor; should be a bound method or arrow.
   * @param errorMsgPrefix  Human-readable prefix, e.g. `'GraphQL definition extraction error: '`.
   */
  protected tryVisit(node: SyntaxNode, visitFn: () => void, errorMsgPrefix: string): void {
    try {
      visitFn();
    } catch (e) {
      this.errors.push({
        message: `${errorMsgPrefix}${errMsg(e)}`,
        line: node.startPosition.row + 1,
        severity: 'warning',
        code: 'extraction_error',
      });
    }
  }
}
