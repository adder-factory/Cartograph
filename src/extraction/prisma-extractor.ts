import type { Node as SyntaxNode, Tree } from 'web-tree-sitter';
import type { ExtractionResult } from './types.js';
import type { NodeKind } from '../types.js';
import { getNodeText } from './tree-sitter-helpers.js';
import { getParser } from './grammar-cache.js';
import { errMsg } from '../errors.js';
import { StandaloneExtractor } from './standalone-extractor.js';

/**
 * PrismaExtractor — extracts a Prisma schema (`schema.prisma`) into the
 * graph.
 *
 * Prisma's schema language is declarative — `model` / `type` / `enum`
 * blocks, no functions or classes — so this is a self-contained
 * extractor (same shape as `SqlExtractor` / `HclExtractor`) rather than
 * a `LanguageExtractor` config plug-in.
 *
 *   Prisma declaration          | NodeKind     | notes
 *   ----------------------------|--------------|---------------------------
 *   model X { … }               | struct       | + a `field` per column
 *   type X { … }   (composite)  | struct       | + a `field` per column
 *   enum X { A B }              | enum         | + an `enum_member` per value
 *   datasource / generator      | (skipped)    | config blocks, not symbols
 *
 * Edges:
 *   - `contains`  file→struct/enum, struct→field, enum→enum_member.
 *   - `type_of`   a field whose column type names another model / enum
 *     (i.e. a non-scalar type — a relation) → an `UnresolvedReference`
 *     the resolver binds across files.
 *
 * Grammar: `tree-sitter-prisma` (victorhqc/tree-sitter-prisma, MIT),
 * built to `src/extraction/wasm/prisma.wasm`.
 */

/** Prisma's built-in scalar field types — a column of one of these
 *  names a primitive, not another model/enum, so no `type_of` edge.
 *  `Unsupported` is the DB-native escape hatch (`Unsupported("…")`) —
 *  also not a user-defined type, so it belongs here. */
const PRISMA_SCALARS: ReadonlySet<string> = new Set([
  'String',
  'Boolean',
  'Int',
  'BigInt',
  'Float',
  'Decimal',
  'DateTime',
  'Json',
  'Bytes',
  'Unsupported',
]);

/** Bundled args for {@link PrismaExtractor.mkNode}. */
interface MkNodeArgs {
  /** The {@link NodeKind} for the pushed node. */
  readonly kind: NodeKind;
  /** The node's short name. */
  readonly name: string;
  /** The node's fully-qualified name. */
  readonly qualifiedName: string;
  /** The tree-sitter syntax node providing the source span. */
  readonly node: SyntaxNode;
  /** The node's signature string. */
  readonly signature: string;
}

export class PrismaExtractor extends StandaloneExtractor {
  extract(): ExtractionResult {
    const startTime = Date.now();

    const parser = getParser('prisma');
    if (!parser) {
      this.errors.push({ message: 'Prisma grammar not loaded', severity: 'error', code: 'grammar_unavailable' });
      return this.result(startTime);
    }

    let tree: Tree | null;
    try {
      tree = parser.parse(this.source);
    } catch (e) {
      this.errors.push({ message: `Prisma parse error: ${errMsg(e)}`, severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }
    if (!tree) {
      this.errors.push({ message: 'Prisma parse returned no tree', severity: 'error', code: 'parse_error' });
      return this.result(startTime);
    }

    try {
      const fileNodeId = this.createFileNode('prisma').id;
      const root = tree.rootNode;
      for (const decl of root.namedChildren) {
        if (!decl) continue;
        this.tryVisit(decl, () => this.visitDeclaration(decl, fileNodeId), 'Prisma declaration extraction error: ');
      }
      return this.result(startTime);
    } finally {
      // Free WASM heap — web-tree-sitter trees hold native memory.
      tree.delete();
    }
  }

  private visitDeclaration(decl: SyntaxNode, fileNodeId: string): void {
    switch (decl.type) {
      case 'model_declaration':
      case 'type_declaration':
        this.emitModel(decl, fileNodeId);
        return;
      case 'enum_declaration':
        this.emitEnum(decl, fileNodeId);
        return;
      default:
        // datasource_declaration / generator_declaration — config
        // blocks, not symbol declarations.
        return;
    }
  }

  /** Push a node and return its id. */
  private mkNode(args: MkNodeArgs): string {
    const { kind, name, qualifiedName, node, signature } = args;
    const id = this.idFactory.next(kind, name);
    this.nodes.push({
      id,
      kind,
      name,
      qualifiedName,
      filePath: this.filePath,
      language: 'prisma',
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      startColumn: node.startPosition.column,
      endColumn: node.endPosition.column,
      signature,
      updatedAt: Date.now(),
    });
    return id;
  }

  /** First direct `identifier` child's text, or `null`. */
  private declName(decl: SyntaxNode): string | null {
    for (const c of decl.namedChildren) {
      if (c?.type === 'identifier') return getNodeText(c, this.source);
    }
    return null;
  }

  /** A `model` / composite `type` block → `struct` + a `field` per column. */
  private emitModel(decl: SyntaxNode, fileNodeId: string): void {
    const name = this.declName(decl);
    if (!name) return;
    const keyword = decl.type === 'type_declaration' ? 'type' : 'model';
    const structId = this.mkNode({
      kind: 'struct',
      name,
      qualifiedName: name,
      node: decl,
      signature: `${keyword} ${name}`,
    });
    this.edges.push({ source: fileNodeId, target: structId, kind: 'contains' });

    const block = decl.namedChildren.find((c: SyntaxNode | null) => c?.type === 'statement_block');
    if (!block) return;
    for (const col of block.namedChildren) {
      if (col?.type === 'column_declaration') this.emitField(col, name, structId);
    }
  }

  /** A `column_declaration` → a `field` node (+ a `type_of` ref when its
   *  type names another model / enum). */
  private emitField(col: SyntaxNode, modelName: string, structId: string): void {
    const fieldName = this.declName(col);
    if (!fieldName) return;
    const typeNode = col.namedChildren.find((c: SyntaxNode | null) => c?.type === 'column_type');
    const signature = typeNode ? getNodeText(typeNode, this.source).trim() : '';
    const fieldId = this.mkNode({
      kind: 'field',
      name: fieldName,
      qualifiedName: `${modelName}.${fieldName}`,
      node: col,
      signature,
    });
    this.edges.push({ source: structId, target: fieldId, kind: 'contains' });

    if (!typeNode) return;
    const baseType = this.columnBaseType(typeNode);
    // A non-scalar column type names another model / enum — a relation.
    if (baseType && !PRISMA_SCALARS.has(baseType)) {
      this.unresolvedReferences.push({
        fromNodeId: fieldId,
        referenceName: baseType,
        referenceKind: 'type_of',
        line: typeNode.startPosition.row + 1,
        column: typeNode.startPosition.column,
      });
    }
  }

  /** The base type name of a `column_type` (`Post[]` → `Post`). */
  private columnBaseType(typeNode: SyntaxNode): string | null {
    for (const c of typeNode.namedChildren) {
      if (c?.type === 'identifier') return getNodeText(c, this.source);
    }
    return null;
  }

  /** An `enum` block → `enum` + an `enum_member` per value. */
  private emitEnum(decl: SyntaxNode, fileNodeId: string): void {
    const name = this.declName(decl);
    if (!name) return;
    const enumId = this.mkNode({ kind: 'enum', name, qualifiedName: name, node: decl, signature: `enum ${name}` });
    this.edges.push({ source: fileNodeId, target: enumId, kind: 'contains' });

    const block = decl.namedChildren.find((c: SyntaxNode | null) => c?.type === 'enum_block');
    if (!block) return;
    for (const e of block.namedChildren) {
      if (e?.type !== 'enumeral') continue;
      const memberName = this.declName(e) ?? getNodeText(e, this.source).trim();
      if (!memberName) continue;
      const memberId = this.mkNode({
        kind: 'enum_member',
        name: memberName,
        qualifiedName: `${name}.${memberName}`,
        node: e,
        signature: memberName,
      });
      this.edges.push({ source: enumId, target: memberId, kind: 'contains' });
    }
  }
}
