/**
 * Tests for the Prisma extractor — `PrismaExtractor` walks the
 * tree-sitter-prisma AST and turns `model` / composite `type` blocks
 * into `struct` + `field` nodes and `enum` blocks into `enum` +
 * `enum_member` nodes, with `contains` edges and `type_of` references
 * for relation fields.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Node } from '../src/types.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const byKind = (nodes: Node[], kind: string): Node[] => nodes.filter((n) => n.kind === kind);
const byString = (a: string, b: string): number => a.localeCompare(b);

describe('Prisma extraction', () => {
  it('extracts a model as a struct with field children', () => {
    const code = `
model User {
  id    Int    @id @default(autoincrement())
  email String @unique
  name  String
}
`;
    const result = extractFromSource('schema.prisma', code);
    const struct = byKind(result.nodes, 'struct').find((n) => n.name === 'User');
    expect(struct).toBeDefined();

    const fields = byKind(result.nodes, 'field');
    expect(fields.map((n) => n.name).sort(byString)).toEqual(['email', 'id', 'name']);
    // The column type is captured as the field signature.
    expect(fields.find((f) => f.name === 'id')?.signature).toBe('Int');

    // contains edges struct → field
    const contained = result.edges.filter((e) => e.kind === 'contains' && e.source === struct!.id).map((e) => e.target);
    expect(contained).toContain(fields.find((f) => f.name === 'email')!.id);
  });

  it('extracts an enum with enum_member children', () => {
    const code = `
enum Role {
  ADMIN
  EDITOR
  VIEWER
}
`;
    const result = extractFromSource('schema.prisma', code);
    const enumNode = byKind(result.nodes, 'enum').find((n) => n.name === 'Role');
    expect(enumNode).toBeDefined();

    const members = byKind(result.nodes, 'enum_member');
    expect(members.map((n) => n.name).sort(byString)).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);
    const contained = result.edges
      .filter((e) => e.kind === 'contains' && e.source === enumNode!.id)
      .map((e) => e.target);
    expect(contained).toHaveLength(3);
  });

  it('emits a type_of reference for a relation field, not for scalar fields', () => {
    const code = `
model Post {
  id       Int    @id
  author   User   @relation(fields: [authorId], references: [id])
  authorId Int
}
`;
    const result = extractFromSource('schema.prisma', code);
    const authorField = byKind(result.nodes, 'field').find((n) => n.name === 'author')!;
    const idField = byKind(result.nodes, 'field').find((n) => n.name === 'id')!;

    // author: User → a type_of reference to the User model.
    expect(
      result.unresolvedReferences.some(
        (r) => r.fromNodeId === authorField.id && r.referenceKind === 'type_of' && r.referenceName === 'User',
      ),
    ).toBe(true);
    // id: Int is a scalar → no reference.
    expect(result.unresolvedReferences.some((r) => r.fromNodeId === idField.id)).toBe(false);
  });

  it('extracts a composite type as a struct', () => {
    const code = `
type Photo {
  height Int
  width  Int
}
`;
    const result = extractFromSource('schema.prisma', code);
    expect(byKind(result.nodes, 'struct').map((n) => n.name)).toContain('Photo');
    expect(
      byKind(result.nodes, 'field')
        .map((n) => n.name)
        .sort(byString),
    ).toEqual(['height', 'width']);
  });

  it('does not emit symbol nodes for datasource / generator config blocks', () => {
    const code = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}
`;
    const result = extractFromSource('schema.prisma', code);
    expect(byKind(result.nodes, 'struct')).toHaveLength(0);
    expect(byKind(result.nodes, 'enum')).toHaveLength(0);
    // Only the file node is emitted.
    expect(result.nodes.every((n) => n.kind === 'file')).toBe(true);
  });
});
