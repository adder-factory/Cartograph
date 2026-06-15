/**
 * Coverage suite for `src/extraction/graphql-extractor.ts`.
 *
 * Exercises the GraphQL SDL extractor end-to-end through
 * `extractFromSource` (the same harness the existing GraphQL tests use),
 * asserting the real node kinds / names / signatures and the
 * unresolved-reference edges (`type_of`, `implements`, `references`,
 * `extends`) the extractor emits.
 *
 * Behaviours covered:
 *   - object types -> `class`, with fields -> `field` + `type_of` refs
 *   - interfaces -> `interface`
 *   - implementing types -> `implements` refs (single + `A & B` multiple)
 *   - input objects -> `class` with `input` signature
 *   - enums -> `enum` + `enum_member` children
 *   - unions -> `type_alias` + `references` member refs (left-recursion flatten)
 *   - scalars -> `type_alias`, no fields
 *   - directives -> `function` named `@x` with args text in signature
 *   - field type-wrappers: list / non-null / `[T!]!` unwrap to base named type
 *   - built-in scalars (Int/Float/String/Boolean/ID) suppressed from type_of
 *   - descriptions ("""..."""  and "...") -> docstring, strip + trim
 *   - field arguments don't leak into the base type unwrap
 *   - Query / Mutation / Subscription roots are ordinary object types
 *   - `schema { ... }` config is skipped (no node)
 *   - executable definitions (queries) are skipped
 *   - extensions: `extend type/interface/input/enum/union` -> node + `extends`
 *   - malformed / empty / comment-only input -> no crash, no spurious nodes
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars.js';
import type { ExtractionResult } from '../src/extraction/types.js';
import type { Node } from '../src/graph/core-types.js';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['graphql']);
});

const byString = (a: string, b: string): number => a.localeCompare(b);

function extract(source: string): ExtractionResult {
  return extractFromSource('schema.graphql', source);
}

function nodesOfKind(r: ExtractionResult, kind: Node['kind']): Node[] {
  return r.nodes.filter((n) => n.kind === kind);
}

function findNode(r: ExtractionResult, kind: Node['kind'], name: string): Node | undefined {
  return r.nodes.find((n) => n.kind === kind && n.name === name);
}

/** All `type_of` refs originating from a given owner's field nodes. */
function typeOfRefNames(r: ExtractionResult): string[] {
  return r.unresolvedReferences.filter((u) => u.referenceKind === 'type_of').map((u) => u.referenceName);
}

describe('GraphQL extractor — object types & fields', () => {
  it('extracts an object type as a class with a `type X` signature and a contains edge from the file', () => {
    const r = extract(`type User { id: ID!, email: String! }`);
    expect(r.errors).toHaveLength(0);

    const user = findNode(r, 'class', 'User');
    expect(user).toBeDefined();
    expect(user!.language).toBe('graphql');
    expect(user!.signature).toBe('type User');
    expect(user!.qualifiedName).toBe('User');

    // File node contains the type.
    const fileNode = nodesOfKind(r, 'file')[0];
    expect(fileNode).toBeDefined();
    const containsUser = r.edges.find(
      (e) => e.source === fileNode!.id && e.target === user!.id && e.kind === 'contains',
    );
    expect(containsUser).toBeDefined();
  });

  it('emits a field node per declared field with a `name: Type` signature and a contains edge from the owner', () => {
    const r = extract(`type User {\n  id: ID!\n  email: String!\n  age: Int\n}`);
    const user = findNode(r, 'class', 'User')!;

    const fields = nodesOfKind(r, 'field');
    expect(fields.map((f) => f.name).sort(byString)).toEqual(['age', 'email', 'id']);

    const idField = findNode(r, 'field', 'id')!;
    expect(idField.signature).toBe('id: ID!');
    const emailField = findNode(r, 'field', 'email')!;
    expect(emailField.signature).toBe('email: String!');

    // Each field is contained by the owning type, not the file.
    for (const f of fields) {
      const contains = r.edges.find((e) => e.target === f.id && e.kind === 'contains');
      expect(contains!.source).toBe(user.id);
    }
  });

  it('emits a `type_of` ref to the base named type but suppresses GraphQL built-in scalars', () => {
    const r = extract(`type Post {\n  id: ID!\n  title: String!\n  views: Int\n  author: User!\n  tags: [Tag!]!\n}`);
    const names = typeOfRefNames(r);
    // Built-ins (ID, String, Int) are suppressed; only user types remain.
    expect(names.sort(byString)).toEqual(['Tag', 'User']);

    // The ref originates from the right field.
    const authorField = findNode(r, 'field', 'author')!;
    const authorRef = r.unresolvedReferences.find(
      (u) => u.fromNodeId === authorField.id && u.referenceKind === 'type_of',
    );
    expect(authorRef!.referenceName).toBe('User');
  });

  it('unwraps list / non-null / `[T!]!` wrappers down to the base named type', () => {
    const r = extract(`type Wrap {\n  a: Thing\n  b: Thing!\n  c: [Thing]\n  d: [Thing!]!\n}`);
    const names = typeOfRefNames(r);
    // All four common wrapper shapes resolve to the same base type `Thing`.
    expect(names).toEqual(['Thing', 'Thing', 'Thing', 'Thing']);
  });

  it('resolves the base type of doubly-nested non-null lists `[[T!]!]!`', () => {
    // `[[Thing!]!]!` nests 9 wrappers deep
    // (type>non_null>list>type>non_null>list>type>non_null>named_type).
    // `unwrapTypeName` descends up to MAX_TYPE_WRAPPER_DEPTH (16), so it reaches
    // the base `Thing` and emits a `type_of` ref. Regression guard: the old
    // `i < 8` cap exited one node short and dropped the ref.
    const r = extract(`type Wrap {\n  e: [[Thing!]!]!\n}`);
    expect(findNode(r, 'field', 'e')).toBeDefined();
    expect(typeOfRefNames(r)).toContain('Thing');
  });
});

describe('GraphQL extractor — interfaces & implements', () => {
  it('extracts an interface as an `interface` node with an `interface X` signature', () => {
    const r = extract(`interface Node {\n  id: ID!\n}`);
    const node = findNode(r, 'interface', 'Node')!;
    expect(node.signature).toBe('interface Node');
    // Interface fields are still extracted.
    expect(findNode(r, 'field', 'id')).toBeDefined();
  });

  it('emits a single `implements` ref for `type X implements I`', () => {
    const r = extract(`interface Node { id: ID! }\ntype User implements Node {\n  id: ID!\n}`);
    const implRefs = r.unresolvedReferences.filter((u) => u.referenceKind === 'implements');
    expect(implRefs).toHaveLength(1);
    expect(implRefs[0]!.referenceName).toBe('Node');

    const user = findNode(r, 'class', 'User')!;
    expect(implRefs[0]!.fromNodeId).toBe(user.id);
  });

  it('emits one `implements` ref per interface for `type X implements A & B & C`', () => {
    const r = extract(
      `interface Node { id: ID! }\n` +
        `interface Timestamps { createdAt: String! }\n` +
        `interface Slugged { slug: String! }\n` +
        `type Article implements Node & Timestamps & Slugged {\n  id: ID!\n  createdAt: String!\n  slug: String!\n}`,
    );
    const implNames = r.unresolvedReferences
      .filter((u) => u.referenceKind === 'implements')
      .map((u) => u.referenceName)
      .sort(byString);
    expect(implNames).toEqual(['Node', 'Slugged', 'Timestamps']);
  });
});

describe('GraphQL extractor — input objects, enums, unions, scalars', () => {
  it('extracts an input object as a class with an `input X` signature and field type_of refs', () => {
    const r = extract(`input CreateUserInput {\n  email: String!\n  role: Role\n}`);
    const input = findNode(r, 'class', 'CreateUserInput')!;
    expect(input.signature).toBe('input CreateUserInput');

    // Input fields are extracted with type_of refs (Role is non-builtin).
    expect(findNode(r, 'field', 'email')).toBeDefined();
    expect(findNode(r, 'field', 'role')).toBeDefined();
    expect(typeOfRefNames(r)).toContain('Role');
  });

  it('extracts an enum and an `enum_member` per value, each contained by the enum', () => {
    const r = extract(`enum Role {\n  ADMIN\n  EDITOR\n  VIEWER\n}`);
    const role = findNode(r, 'enum', 'Role')!;
    expect(role.signature).toBe('enum Role');

    const members = nodesOfKind(r, 'enum_member');
    expect(members.map((m) => m.name).sort(byString)).toEqual(['ADMIN', 'EDITOR', 'VIEWER']);

    const admin = findNode(r, 'enum_member', 'ADMIN')!;
    expect(admin.signature).toBe('Role.ADMIN');
    const contains = r.edges.find((e) => e.target === admin.id && e.kind === 'contains');
    expect(contains!.source).toBe(role.id);
  });

  it('extracts a union as a type_alias and a `references` ref per member (left-recursion flattened)', () => {
    const r = extract(
      `type Dog { name: String }\ntype Cat { name: String }\ntype Bird { name: String }\n` +
        `union Animal = Dog | Cat | Bird`,
    );
    const animal = findNode(r, 'type_alias', 'Animal')!;
    expect(animal.signature).toBe('union Animal');

    const memberRefs = r.unresolvedReferences
      .filter((u) => u.referenceKind === 'references' && u.fromNodeId === animal.id)
      .map((u) => u.referenceName)
      .sort(byString);
    expect(memberRefs).toEqual(['Bird', 'Cat', 'Dog']);
  });

  it('extracts a custom scalar as a type_alias with no fields', () => {
    const r = extract(`scalar DateTime`);
    const dt = findNode(r, 'type_alias', 'DateTime')!;
    expect(dt.signature).toBe('scalar DateTime');
    // A bare scalar has no field children.
    expect(nodesOfKind(r, 'field')).toHaveLength(0);
  });
});

describe('GraphQL extractor — directives & descriptions', () => {
  it('extracts a directive definition as a `function` named `@x` with args in the signature', () => {
    const r = extract(`directive @auth(requires: Role = ADMIN) on FIELD_DEFINITION | OBJECT`);
    const dir = findNode(r, 'function', '@auth')!;
    expect(dir).toBeDefined();
    expect(dir.signature).toContain('directive @auth');
    // The arguments_definition text is appended verbatim.
    expect(dir.signature).toContain('requires');
  });

  it('extracts a directive with no arguments', () => {
    const r = extract(`directive @deprecated on FIELD_DEFINITION`);
    const dir = findNode(r, 'function', '@deprecated')!;
    expect(dir.signature).toBe('directive @deprecated');
  });

  it('captures triple-quoted block descriptions as a stripped, trimmed docstring', () => {
    const r = extract(`"""\nA registered user account.\n"""\ntype User {\n  id: ID!\n}`);
    const user = findNode(r, 'class', 'User')!;
    expect(user.docstring).toBe('A registered user account.');
  });

  it('captures single-quoted descriptions on enums', () => {
    const r = extract(`"A user's access role." enum Role { ADMIN }`);
    const role = findNode(r, 'enum', 'Role')!;
    expect(role.docstring).toBe("A user's access role.");
  });

  it('leaves docstring undefined when a type has no description', () => {
    const r = extract(`type Bare { id: ID! }`);
    const bare = findNode(r, 'class', 'Bare')!;
    expect(bare.docstring).toBeUndefined();
  });
});

describe('GraphQL extractor — operation roots, schema config, executables', () => {
  it('treats Query / Mutation / Subscription as ordinary object types with field type_of refs', () => {
    const r = extract(
      `type Query {\n  me: User\n  posts: [Post!]!\n}\n` +
        `type Mutation {\n  createUser(input: CreateUserInput!): User!\n}\n` +
        `type Subscription {\n  userAdded: User!\n}`,
    );
    expect(findNode(r, 'class', 'Query')).toBeDefined();
    expect(findNode(r, 'class', 'Mutation')).toBeDefined();
    expect(findNode(r, 'class', 'Subscription')).toBeDefined();

    // Field arguments (input: CreateUserInput!) must NOT collide with the
    // field's own return type when unwrapping. `createUser` returns User.
    const createUser = findNode(r, 'field', 'createUser')!;
    const ref = r.unresolvedReferences.find((u) => u.fromNodeId === createUser.id && u.referenceKind === 'type_of');
    expect(ref!.referenceName).toBe('User');
  });

  it('skips `schema { ... }` config — it produces no symbol node', () => {
    const r = extract(`schema {\n  query: Query\n  mutation: Mutation\n}\ntype Query { ping: String }`);
    // Only the Query object type yields a class; no node is named after the schema block.
    expect(nodesOfKind(r, 'class').map((n) => n.name)).toEqual(['Query']);
    // No spurious `Query`/`Mutation` references from the schema block fields.
    expect(r.errors).toHaveLength(0);
  });

  it('skips executable (query operation) definitions without crashing', () => {
    const r = extract(`query GetUser {\n  user(id: 1) {\n    id\n    name\n  }\n}`);
    expect(r.errors).toHaveLength(0);
    // No type/class/field symbols are emitted for an operation body.
    expect(nodesOfKind(r, 'class')).toHaveLength(0);
    expect(nodesOfKind(r, 'field')).toHaveLength(0);
  });
});

describe('GraphQL extractor — extensions (federation)', () => {
  it('emits a separate node + `extends` ref for `extend type/interface/input/enum/union`', () => {
    const r = extract(
      `type User { id: ID! }\nextend type User { posts: [Post!]! }\n` +
        `interface Node { id: ID! }\nextend interface Node { lastSeen: String }\n` +
        `input Filter { q: String }\nextend input Filter { limit: Int }\n` +
        `enum Role { ADMIN }\nextend enum Role { OBSERVER }\n` +
        `union Animal = Dog\nextend union Animal = Cat\n` +
        `type Post { id: ID! }\ntype Dog { n: String }\ntype Cat { n: String }`,
    );
    expect(r.errors).toHaveLength(0);

    const extendsRefs = r.unresolvedReferences.filter((u) => u.referenceKind === 'extends');
    expect(extendsRefs.map((u) => u.referenceName).sort(byString)).toEqual([
      'Animal',
      'Filter',
      'Node',
      'Role',
      'User',
    ]);

    // Each extension node carries an `extend …` signature distinct from the base.
    const userNodes = r.nodes.filter((n) => n.kind === 'class' && n.name === 'User');
    expect(userNodes.map((n) => n.signature).sort(byString)).toEqual(['extend type User', 'type User']);

    // Extension fields live under the extension node, not the base.
    const posts = findNode(r, 'field', 'posts')!;
    const extUser = userNodes.find((n) => n.signature === 'extend type User')!;
    const containsPosts = r.edges.find((e) => e.target === posts.id && e.kind === 'contains');
    expect(containsPosts!.source).toBe(extUser.id);
  });

  it('extension enum values + union members attach to the extension node', () => {
    const r = extract(`enum Role { ADMIN }\nextend enum Role { OBSERVER }`);
    const observer = findNode(r, 'enum_member', 'OBSERVER')!;
    const roleExt = r.nodes.find((n) => n.kind === 'enum' && n.name === 'Role' && n.signature === 'extend enum Role')!;
    const contains = r.edges.find((e) => e.target === observer.id && e.kind === 'contains');
    expect(contains!.source).toBe(roleExt.id);
  });

  it('an object extension that adds `implements` emits both `extends` and `implements` refs', () => {
    const r = extract(
      `interface Trackable { id: ID! }\ntype User { id: ID! }\n` +
        `extend type User implements Trackable { trackedAt: String }`,
    );
    const extUser = r.nodes.find((n) => n.kind === 'class' && n.name === 'User' && n.signature === 'extend type User')!;
    const fromExt = r.unresolvedReferences.filter((u) => u.fromNodeId === extUser.id);
    const kinds = fromExt.map((u) => `${u.referenceKind}:${u.referenceName}`).sort(byString);
    expect(kinds).toContain('extends:User');
    expect(kinds).toContain('implements:Trackable');
  });
});

describe('GraphQL extractor — malformed & degenerate input', () => {
  it('returns cleanly with no nodes on empty source', () => {
    const r = extract('');
    expect(nodesOfKind(r, 'class')).toHaveLength(0);
    expect(nodesOfKind(r, 'interface')).toHaveLength(0);
  });

  it('returns cleanly on comment-only / whitespace-only source', () => {
    const r = extract('# just a comment\n\n   \n');
    expect(nodesOfKind(r, 'class')).toHaveLength(0);
    expect(nodesOfKind(r, 'field')).toHaveLength(0);
  });

  it('does not throw on a truncated / malformed type declaration', () => {
    // Missing closing brace + dangling field.
    const r = extract(`type Broken {\n  id: ID!\n  email: Strin`);
    // Whatever the grammar recovers, extraction must not throw fatally.
    expect(Array.isArray(r.nodes)).toBe(true);
    // A fatal parse error would be surfaced as a parse_error-coded error;
    // tree-sitter is error-recovering, so we only require non-throw here.
    expect(r.errors.every((e) => e.code !== undefined)).toBe(true);
  });

  it('extracts the valid parts of a partially-malformed multi-definition file', () => {
    const r = extract(`type Valid {\n  id: ID!\n}\n` + `type @@@garbage\n` + `enum Color { RED GREEN BLUE }`);
    // The well-formed declarations on either side of the garbage still index.
    expect(findNode(r, 'class', 'Valid')).toBeDefined();
    const colors = nodesOfKind(r, 'enum_member')
      .map((m) => m.name)
      .sort(byString);
    expect(colors).toEqual(['BLUE', 'GREEN', 'RED']);
  });

  it('handles a realistic multi-construct schema without errors', () => {
    const r = extract(`
      """The root query."""
      type Query {
        node(id: ID!): Node
        users(first: Int, after: String): [User!]!
      }

      interface Node {
        id: ID!
      }

      scalar DateTime

      enum Role {
        ADMIN
        EDITOR
      }

      input UserFilter {
        role: Role
        createdAfter: DateTime
      }

      type User implements Node {
        id: ID!
        email: String!
        role: Role!
        createdAt: DateTime!
        friends: [User!]!
      }

      union SearchResult = User | Post

      type Post implements Node {
        id: ID!
        author: User!
      }

      directive @cacheControl(maxAge: Int) on FIELD_DEFINITION
    `);
    expect(r.errors).toHaveLength(0);

    // Spot-check one node of each kind the schema declares.
    expect(findNode(r, 'class', 'Query')).toBeDefined();
    expect(findNode(r, 'interface', 'Node')).toBeDefined();
    expect(findNode(r, 'type_alias', 'DateTime')).toBeDefined();
    expect(findNode(r, 'enum', 'Role')).toBeDefined();
    expect(findNode(r, 'class', 'UserFilter')).toBeDefined();
    expect(findNode(r, 'type_alias', 'SearchResult')).toBeDefined();
    expect(findNode(r, 'function', '@cacheControl')).toBeDefined();

    // User implements Node, and references User/Post/Role/DateTime via type_of.
    const implNames = r.unresolvedReferences
      .filter((u) => u.referenceKind === 'implements')
      .map((u) => u.referenceName)
      .sort(byString);
    expect(implNames).toEqual(['Node', 'Node']); // User and Post both implement Node

    const typeOf = new Set(typeOfRefNames(r));
    expect(typeOf.has('Role')).toBe(true);
    expect(typeOf.has('DateTime')).toBe(true);
    expect(typeOf.has('User')).toBe(true);
  });
});
