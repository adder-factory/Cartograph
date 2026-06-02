/**
 * GraphQL `extend type` cross-file merging — Section B #27.
 *
 * Pre-PR, tree-sitter-graphql's `type_system_extension` was
 * intentionally skipped, so federation extensions were invisible to
 * the graph (`extend type User { posts: [Post] }` produced zero
 * nodes / edges). This test verifies the extractor now emits a
 * separate node per extension with the same kind as its base, plus
 * an `extends` reference targeting the base type — cross-file
 * merging is reconstructible by following the edge.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('GraphQL extend type — cross-file merging', () => {
  it('emits a separate node + extends-ref for each `extend <kind>` form', () => {
    const source = `
      type User { id: ID!, email: String }
      extend type User { posts: [Post!]! }

      interface Node { id: ID! }
      extend interface Node { lastSeen: String }

      enum Role { ADMIN }
      extend enum Role { OBSERVER }

      union Animal = Dog | Cat
      extend union Animal = Bird

      input CreateUserInput { email: String! }
      extend input CreateUserInput { name: String }

      type Post { id: ID!, body: String! }
      type Dog { name: String }
      type Cat { name: String }
      type Bird { species: String }
    `;
    const r = extractFromSource('schema.graphql', source);
    expect(r.errors).toHaveLength(0);

    // Each base + extension pair produces two nodes with the same
    // name and kind; per-line node-id derivation makes them distinct.
    const nodesByNameKind = new Map<string, number>();
    for (const n of r.nodes) {
      const key = `${n.kind}::${n.name}`;
      nodesByNameKind.set(key, (nodesByNameKind.get(key) ?? 0) + 1);
    }
    expect(nodesByNameKind.get('class::User')).toBe(2);
    expect(nodesByNameKind.get('interface::Node')).toBe(2);
    expect(nodesByNameKind.get('enum::Role')).toBe(2);
    expect(nodesByNameKind.get('type_alias::Animal')).toBe(2);
    expect(nodesByNameKind.get('class::CreateUserInput')).toBe(2);

    // Each extension contributes an `extends` ref to the base type.
    const extendsRefs = r.unresolvedReferences.filter((u) => u.referenceKind === 'extends');
    expect(extendsRefs.map((u) => u.referenceName).sort(byString)).toEqual([
      'Animal',
      'CreateUserInput',
      'Node',
      'Role',
      'User',
    ]);

    // The fields/enum-values/union-members of an extension live
    // under the extension node, not the base — preserving "this
    // field came from this extension" provenance.
    const postsField = r.nodes.find((n) => n.name === 'posts' && n.kind === 'field');
    expect(postsField).toBeDefined();
    const containsPosts = r.edges.find((e) => e.target === postsField!.id && e.kind === 'contains');
    expect(containsPosts).toBeDefined();
    const userExtensionId = r.nodes.find(
      (n) => n.kind === 'class' && n.name === 'User' && n.signature?.startsWith('extend '),
    )?.id;
    expect(userExtensionId).toBeDefined();
    expect(containsPosts!.source).toBe(userExtensionId);

    // OBSERVER goes under the Role extension, not the original Role.
    const observer = r.nodes.find((n) => n.name === 'OBSERVER' && n.kind === 'enum_member');
    expect(observer).toBeDefined();
    const containsObserver = r.edges.find((e) => e.target === observer!.id && e.kind === 'contains');
    const roleExtensionId = r.nodes.find(
      (n) => n.kind === 'enum' && n.name === 'Role' && n.signature?.startsWith('extend '),
    )?.id;
    expect(containsObserver!.source).toBe(roleExtensionId);
  });

  it('signature distinguishes definition vs extension', () => {
    const r = extractFromSource('schema.graphql', 'type User { id: ID! }\nextend type User { posts: [Post!]! }\n');
    const users = r.nodes.filter((n) => n.kind === 'class' && n.name === 'User');
    expect(users).toHaveLength(2);
    const sigs = users.map((u) => u.signature).sort(byString);
    expect(sigs).toEqual(['extend type User', 'type User']);
  });

  it('extension fields surface their type_of references like definition fields', () => {
    const r = extractFromSource('schema.graphql', 'type User { id: ID! }\nextend type User { posts: [Post!]! }\n');
    const typeOfRefs = r.unresolvedReferences.filter((u) => u.referenceKind === 'type_of');
    // Post is the only non-built-in type referenced.
    expect(typeOfRefs.map((u) => u.referenceName)).toContain('Post');
  });
});
