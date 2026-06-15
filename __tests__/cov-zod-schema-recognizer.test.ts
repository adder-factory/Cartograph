/**
 * Coverage-focused tests for the Zod schema recognizer
 * (`src/extraction/schema-recognizers/zod.ts`).
 *
 * The recognizer runs as a post-extraction pass over a parsed TS/JS
 * tree-sitter tree and synthesizes `struct` / `field` / `enum_member`
 * nodes (+ `contains` edges) for `z.object({...})` schemas, plus
 * `type_of` / `references` consumer edges. These tests drive REAL
 * TypeScript source through `extractFromSource` and assert the exact
 * shape of the synthesized nodes/edges, exercising the recognizer's
 * branches: trailing chains, enums, nested objects (+ depth cap),
 * inline schemas, the consumer pass, and the import detect gate.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Edge, Node } from '../src/types.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const byKind = (nodes: Node[], kind: string): Node[] => nodes.filter((n) => n.kind === kind);
const names = (nodes: Node[]): string[] => nodes.map((n) => n.name).sort((a, b) => a.localeCompare(b));
const containsFrom = (edges: Edge[], sourceId: string): Edge[] =>
  edges.filter((e) => e.kind === 'contains' && e.source === sourceId);
const findByName = (nodes: Node[], kind: string, name: string): Node | undefined =>
  byKind(nodes, kind).find((n) => n.name === name);

// -------------------------------------------------------------------------
// Object schemas + field signatures
// -------------------------------------------------------------------------

describe('zod recognizer — object schemas and field signatures', () => {
  it('synthesizes a struct + a field per property with the leading z.<type> as signature', () => {
    const code = `
      import { z } from 'zod';
      export const Profile = z.object({
        name: z.string(),
        age: z.number().int().positive(),
        active: z.boolean(),
        joined: z.date(),
      });
    `;
    const { nodes } = extractFromSource('profile.ts', code);

    expect(names(byKind(nodes, 'struct'))).toEqual(['Profile']);
    expect(names(byKind(nodes, 'field'))).toEqual(['active', 'age', 'joined', 'name']);

    // The leading Zod method becomes the field signature even through a chain.
    expect(findByName(nodes, 'field', 'name')?.signature).toBe('z.string');
    expect(findByName(nodes, 'field', 'age')?.signature).toBe('z.number');
    expect(findByName(nodes, 'field', 'active')?.signature).toBe('z.boolean');
    expect(findByName(nodes, 'field', 'joined')?.signature).toBe('z.date');

    // The struct itself carries the z.object signature.
    expect(findByName(nodes, 'struct', 'Profile')?.signature).toBe('z.object');
  });

  it('captures z.<type> signatures through optional/nullable/default chains', () => {
    const code = `
      import { z } from 'zod';
      export const Settings = z.object({
        nickname: z.string().optional(),
        score: z.number().default(0),
        bio: z.string().nullable(),
      });
    `;
    const { nodes } = extractFromSource('settings.ts', code);
    expect(findByName(nodes, 'field', 'nickname')?.signature).toBe('z.string');
    expect(findByName(nodes, 'field', 'score')?.signature).toBe('z.number');
    expect(findByName(nodes, 'field', 'bio')?.signature).toBe('z.string');
  });

  it('wires a contains edge from the struct to each of its fields', () => {
    const code = `
      import { z } from 'zod';
      export const Point = z.object({ x: z.number(), y: z.number() });
    `;
    const { nodes, edges } = extractFromSource('point.ts', code);
    const struct = findByName(nodes, 'struct', 'Point')!;
    const fieldsById = new Map(byKind(nodes, 'field').map((n) => [n.id, n.name]));
    const contained = containsFrom(edges, struct.id).map((e) => fieldsById.get(e.target));
    expect([...contained].sort()).toEqual(['x', 'y']);
    // Each contains edge is EXTRACTED-confidence with a 1-based line.
    for (const e of containsFrom(edges, struct.id)) {
      expect(e.confidence).toBe('EXTRACTED');
      expect(e.line).toBeGreaterThan(0);
    }
  });

  it('leaves a field with a non-zod value chain without a z.* signature', () => {
    // `custom` is `someHelper(...)`, not a `z.<...>` chain → zodLeafType null.
    const code = `
      import { z } from 'zod';
      const someHelper = (n: number) => n;
      export const Mixed = z.object({
        real: z.string(),
        custom: someHelper(1),
      });
    `;
    const { nodes } = extractFromSource('mixed.ts', code);
    // Both keys are still fields...
    expect(names(byKind(nodes, 'field'))).toEqual(['custom', 'real']);
    // ...but only the z.* one gets a signature.
    expect(findByName(nodes, 'field', 'real')?.signature).toBe('z.string');
    expect(findByName(nodes, 'field', 'custom')?.signature).toBeUndefined();
  });

  it('handles quoted property keys (unquote)', () => {
    const code = `
      import { z } from 'zod';
      export const Headers = z.object({
        'content-type': z.string(),
        "x-id": z.string(),
      });
    `;
    const { nodes } = extractFromSource('headers.ts', code);
    expect(names(byKind(nodes, 'field'))).toEqual(['content-type', 'x-id']);
  });

  it('emits an empty struct (no fields) for z.object({})', () => {
    const code = `
      import { z } from 'zod';
      export const Empty = z.object({});
    `;
    const { nodes } = extractFromSource('empty.ts', code);
    expect(names(byKind(nodes, 'struct'))).toEqual(['Empty']);
    expect(byKind(nodes, 'field')).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
// Trailing method chains -> base z.object
// -------------------------------------------------------------------------

describe('zod recognizer — chained schema declarations', () => {
  it('descends a trailing chain (.strict().refine()) to the base z.object', () => {
    const code = `
      import { z } from 'zod';
      export const Strict = z.object({ id: z.string() })
        .strict()
        .refine((v) => v.id.length > 0, 'non-empty');
    `;
    const { nodes } = extractFromSource('strict.ts', code);
    expect(names(byKind(nodes, 'struct'))).toEqual(['Strict']);
    expect(names(byKind(nodes, 'field'))).toEqual(['id']);
  });

  it('recognizes a z.object passed through .merge()/.extend() base call', () => {
    const code = `
      import { z } from 'zod';
      export const Base = z.object({ a: z.string() });
      export const Extended = z.object({ a: z.string(), b: z.number() }).extend({});
    `;
    const { nodes } = extractFromSource('extend.ts', code);
    expect(names(byKind(nodes, 'struct'))).toEqual(['Base', 'Extended']);
    // Extended's own z.object body is what gets modelled.
    const extended = findByName(nodes, 'struct', 'Extended')!;
    const { edges } = extractFromSource('extend.ts', code);
    const fieldsById = new Map(byKind(nodes, 'field').map((n) => [n.id, n.name]));
    const contained = containsFrom(edges, extended.id).map((e) => fieldsById.get(e.target));
    expect([...contained].sort()).toEqual(['a', 'b']);
  });
});

// -------------------------------------------------------------------------
// Enums
// -------------------------------------------------------------------------

describe('zod recognizer — z.enum expansion', () => {
  it('expands z.enum([...]) into enum_member nodes + field->member contains edges', () => {
    const code = `
      import { z } from 'zod';
      export const Ticket = z.object({
        status: z.enum(['open', 'closed', 'pending']),
      });
    `;
    const { nodes, edges } = extractFromSource('ticket.ts', code);

    expect(findByName(nodes, 'field', 'status')?.signature).toBe('z.enum');
    expect(names(byKind(nodes, 'enum_member'))).toEqual(['closed', 'open', 'pending']);

    const statusField = findByName(nodes, 'field', 'status')!;
    const memberTargets = containsFrom(edges, statusField.id);
    expect(memberTargets).toHaveLength(3);

    // enum_member qualifiedName is fieldQualifiedName + '.' + member.
    const open = findByName(nodes, 'enum_member', 'open')!;
    expect(open.qualifiedName.endsWith('Ticket.status.open')).toBe(true);
  });

  it('expands a z.enum even through a trailing .optional() chain', () => {
    const code = `
      import { z } from 'zod';
      export const Filter = z.object({
        kind: z.enum(['a', 'b']).optional(),
      });
    `;
    const { nodes } = extractFromSource('filter.ts', code);
    expect(findByName(nodes, 'field', 'kind')?.signature).toBe('z.enum');
    expect(names(byKind(nodes, 'enum_member'))).toEqual(['a', 'b']);
  });

  it('skips non-string elements inside z.enum([...]) array', () => {
    // A z.enum with a non-string element (numeric) — only the string
    // members become enum_member nodes.
    const code = `
      import { z } from 'zod';
      export const Weird = z.object({
        v: z.enum(['ok', 42, 'no']),
      });
    `;
    const { nodes } = extractFromSource('weird.ts', code);
    expect(names(byKind(nodes, 'enum_member'))).toEqual(['no', 'ok']);
  });

  it('emits no enum_member nodes when z.enum has a non-array argument', () => {
    // z.enum(MyTuple) where the arg is an identifier, not an array literal.
    const code = `
      import { z } from 'zod';
      const MyTuple = ['x', 'y'] as const;
      export const Dyn = z.object({
        v: z.enum(MyTuple),
      });
    `;
    const { nodes } = extractFromSource('dyn.ts', code);
    expect(findByName(nodes, 'field', 'v')?.signature).toBe('z.enum');
    expect(byKind(nodes, 'enum_member')).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
// Nested objects + depth cap
// -------------------------------------------------------------------------

describe('zod recognizer — nested z.object fields', () => {
  it('recurses one level: field gains a nested struct populated with inner fields', () => {
    const code = `
      import { z } from 'zod';
      export const Order = z.object({
        id: z.string(),
        address: z.object({
          street: z.string(),
          city: z.string(),
        }),
      });
    `;
    const { nodes, edges } = extractFromSource('order.ts', code);

    expect(names(byKind(nodes, 'struct'))).toEqual(['address', 'Order']);
    const addressStruct = findByName(nodes, 'struct', 'address')!;
    const addressField = findByName(nodes, 'field', 'address')!;
    // field address -> nested struct
    expect(containsFrom(edges, addressField.id).map((e) => e.target)).toContain(addressStruct.id);
    // nested struct -> inner fields
    const fieldsById = new Map(byKind(nodes, 'field').map((n) => [n.id, n.name]));
    const inner = containsFrom(edges, addressStruct.id).map((e) => fieldsById.get(e.target));
    expect([...inner].sort()).toEqual(['city', 'street']);
    // The nested struct's qualifiedName is the dotted owner path.
    expect(addressStruct.qualifiedName.endsWith('Order.address')).toBe(true);
    // The nested struct field signature on the parent field is z.object.
    expect(addressField.signature).toBe('z.object');
  });

  it('recurses multiple levels deep', () => {
    const code = `
      import { z } from 'zod';
      export const Tree = z.object({
        level1: z.object({
          level2: z.object({
            level3: z.object({
              leaf: z.string(),
            }),
          }),
        }),
      });
    `;
    const { nodes } = extractFromSource('tree.ts', code);
    // Tree + level1 + level2 + level3 = 4 structs.
    expect(names(byKind(nodes, 'struct'))).toEqual(['level1', 'level2', 'level3', 'Tree']);
    expect(findByName(nodes, 'field', 'leaf')?.signature).toBe('z.string');
  });

  it('stops synthesizing nested structs at MAX_NEST_DEPTH (8)', () => {
    // Build a chain of nested z.object deeper than the cap (10 levels).
    let inner = 'z.string()';
    for (let i = 10; i >= 1; i--) {
      inner = `z.object({ k${i}: ${inner} })`;
    }
    const code = `
      import { z } from 'zod';
      export const Deep = ${inner};
    `;
    const { nodes } = extractFromSource('deep.ts', code);
    const structs = byKind(nodes, 'struct');
    // Top struct `Deep` (depth 0) recurses into nested z.object fields
    // while `depth < MAX_NEST_DEPTH (8)`. Nested structs are synthesized
    // for k1..k9; the z.object containing k10 sits at depth 8 where the
    // guard stops further struct synthesis. So 1 + 9 = 10 structs.
    expect(names(structs)).toEqual(['Deep', 'k1', 'k2', 'k3', 'k4', 'k5', 'k6', 'k7', 'k8', 'k9']);
    // Every level is still walked for FIELDS (the cap only stops nested
    // struct synthesis, not the field pass), so the deepest leaf field exists.
    const fieldNames = names(byKind(nodes, 'field'));
    expect(fieldNames).toContain('k10');
    // The recognizer terminates on a deep chain (no unbounded recursion).
    expect(structs.length).toBe(10);
  });
});

// -------------------------------------------------------------------------
// Inline schemas (not bound to a const)
// -------------------------------------------------------------------------

describe('zod recognizer — inline schemas', () => {
  it('recognizes an inline z.object named from its enclosing object key', () => {
    const code = `
      import { z } from 'zod';
      function defineTool(spec: unknown) { return spec; }
      export const myTool = defineTool({
        name: 'do_thing',
        schema: z.object({
          target: z.string(),
          count: z.number(),
        }),
      });
    `;
    const { nodes, edges } = extractFromSource('tool.ts', code);
    const struct = findByName(nodes, 'struct', 'schema');
    expect(struct).toBeDefined();
    const fieldsById = new Map(byKind(nodes, 'field').map((n) => [n.id, n.name]));
    const inlineFields = containsFrom(edges, struct!.id).map((e) => fieldsById.get(e.target));
    expect([...inlineFields].sort()).toEqual(['count', 'target']);
  });

  it('does NOT re-model a nested z.object as an inline schema (consumed set)', () => {
    const code = `
      import { z } from 'zod';
      export const Order = z.object({
        address: z.object({ city: z.string() }),
      });
    `;
    const { nodes } = extractFromSource('order2.ts', code);
    // Exactly two structs — Order + nested address, not a third inline one.
    expect(names(byKind(nodes, 'struct'))).toEqual(['address', 'Order']);
  });

  it('does NOT model a bare z.object call with no nameable enclosing context', () => {
    // A bare expression-statement z.object — no enclosing pair, no const.
    const code = `
      import { z } from 'zod';
      z.object({ ghost: z.string() });
    `;
    const { nodes } = extractFromSource('bare.ts', code);
    expect(byKind(nodes, 'struct')).toHaveLength(0);
    expect(byKind(nodes, 'field')).toHaveLength(0);
  });

  it('recognizes an inline z.object inside a deeper enclosing pair', () => {
    const code = `
      import { z } from 'zod';
      function register(cfg: unknown) { return cfg; }
      register({
        routes: {
          body: z.object({ payload: z.string() }),
        },
      });
    `;
    const { nodes } = extractFromSource('register.ts', code);
    // Named from the nearest enclosing pair key — 'body'.
    const struct = findByName(nodes, 'struct', 'body');
    expect(struct).toBeDefined();
    expect(names(byKind(nodes, 'field'))).toEqual(['payload']);
  });
});

// -------------------------------------------------------------------------
// Consumer pass: type_of / references
// -------------------------------------------------------------------------

describe('zod recognizer — consumer edges', () => {
  it('emits a type_of edge from a z.infer<typeof X> alias to the struct', () => {
    const code = `
      import { z } from 'zod';
      export const UserSchema = z.object({ name: z.string() });
      export type User = z.infer<typeof UserSchema>;
    `;
    const { nodes, edges } = extractFromSource('user.ts', code);
    const struct = findByName(nodes, 'struct', 'UserSchema')!;
    const typeOf = edges.filter((e) => e.kind === 'type_of' && e.target === struct.id);
    expect(typeOf.length).toBeGreaterThanOrEqual(1);
    expect(typeOf[0]?.confidence).toBe('EXTRACTED');
  });

  it('emits a references edge from X.shape.<field> to the field node', () => {
    const code = `
      import { z } from 'zod';
      export const UserSchema = z.object({ role: z.string() });
      function check() {
        return UserSchema.shape.role;
      }
    `;
    const { nodes, edges } = extractFromSource('shape.ts', code);
    const roleField = findByName(nodes, 'field', 'role')!;
    const refs = edges.filter((e) => e.kind === 'references' && e.target === roleField.id);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('emits references edges for X.pick({...}) but not for unpicked fields', () => {
    const code = `
      import { z } from 'zod';
      export const Account = z.object({ id: z.string(), email: z.string() });
      export const Public = Account.pick({ id: true });
    `;
    const { nodes, edges } = extractFromSource('account.ts', code);
    const idField = findByName(nodes, 'field', 'id')!;
    const emailField = findByName(nodes, 'field', 'email')!;
    expect(edges.filter((e) => e.kind === 'references' && e.target === idField.id).length).toBeGreaterThanOrEqual(1);
    expect(edges.filter((e) => e.kind === 'references' && e.target === emailField.id)).toHaveLength(0);
  });

  it('emits references edges for X.omit({...}) selections', () => {
    const code = `
      import { z } from 'zod';
      export const Account = z.object({ id: z.string(), secret: z.string() });
      export const Safe = Account.omit({ secret: true });
    `;
    const { nodes, edges } = extractFromSource('omit.ts', code);
    const secretField = findByName(nodes, 'field', 'secret')!;
    expect(edges.filter((e) => e.kind === 'references' && e.target === secretField.id).length).toBeGreaterThanOrEqual(
      1,
    );
  });

  it('de-duplicates consumer edges on source|target|kind', () => {
    // The same field read twice in one function -> a single references edge.
    const code = `
      import { z } from 'zod';
      export const S = z.object({ f: z.string() });
      function use() {
        const a = S.shape.f;
        const b = S.shape.f;
        return [a, b];
      }
    `;
    const { nodes, edges } = extractFromSource('dedup.ts', code);
    const fField = findByName(nodes, 'field', 'f')!;
    const refs = edges.filter((e) => e.kind === 'references' && e.target === fField.id);
    expect(refs).toHaveLength(1);
  });

  it('ignores X.shape.<field> / z.infer referencing an unknown schema', () => {
    const code = `
      import { z } from 'zod';
      export const Known = z.object({ a: z.string() });
      type T = z.infer<typeof Unknown>;
      const r = Unknown.shape.a;
      const p = Unknown.pick({ a: true });
    `;
    const { edges } = extractFromSource('unknown.ts', code);
    // No references/type_of edges should be generated for `Unknown`.
    // Only the Known schema exists; nothing references it.
    expect(edges.filter((e) => e.kind === 'type_of')).toHaveLength(0);
    expect(edges.filter((e) => e.kind === 'references')).toHaveLength(0);
  });

  it('does not run the consumer pass when no named schemas were recognized', () => {
    // Only an inline (unnamed-by-const) schema -> schemas map stays empty,
    // so even a matching consumer shape produces no consumer edges.
    const code = `
      import { z } from 'zod';
      function defineTool(spec: unknown) { return spec; }
      defineTool({ schema: z.object({ a: z.string() }) });
      type T = z.infer<typeof schema>;
    `;
    const { edges } = extractFromSource('noconsumer.ts', code);
    expect(edges.filter((e) => e.kind === 'type_of')).toHaveLength(0);
  });
});

// -------------------------------------------------------------------------
// Detect gate + non-schema declarators
// -------------------------------------------------------------------------

describe('zod recognizer — detect gate and non-schema inputs', () => {
  it('does NOT fire when the file does not import zod', () => {
    const code = `
      const z = { object: (x: unknown) => x };
      export const NotASchema = z.object({ a: 1 });
    `;
    const { nodes } = extractFromSource('plain.ts', code);
    expect(byKind(nodes, 'struct')).toHaveLength(0);
    expect(byKind(nodes, 'enum_member')).toHaveLength(0);
  });

  it('fires when zod is imported with a different specifier shape', () => {
    const code = `
      import * as z from 'zod';
      export const S = z.object({ a: z.string() });
    `;
    const { nodes } = extractFromSource('ns.ts', code);
    expect(names(byKind(nodes, 'struct'))).toEqual(['S']);
  });

  it('ignores const declarators whose value is not a z.object (e.g. z.string())', () => {
    const code = `
      import { z } from 'zod';
      export const Name = z.string();
      export const Count = z.number();
      export const Real = z.object({ a: z.string() });
    `;
    const { nodes } = extractFromSource('nonobj.ts', code);
    // Only `Real` is a struct; z.string()/z.number() top-level are not.
    expect(names(byKind(nodes, 'struct'))).toEqual(['Real']);
  });

  it('returns an empty result for a zod-importing file with no z.object schemas', () => {
    const code = `
      import { z } from 'zod';
      export const justAString = z.string();
      export function helper() { return 1; }
    `;
    const { nodes } = extractFromSource('none.ts', code);
    expect(byKind(nodes, 'struct')).toHaveLength(0);
    expect(byKind(nodes, 'field')).toHaveLength(0);
  });

  it('ignores a destructured/array-pattern declarator (non-identifier name)', () => {
    const code = `
      import { z } from 'zod';
      const [a, b] = [z.object({ x: z.string() }), 2];
      export const Real = z.object({ ok: z.string() });
    `;
    const { nodes } = extractFromSource('destructure.ts', code);
    // The array-pattern declarator yields no struct; only `Real` does.
    expect(names(byKind(nodes, 'struct'))).toEqual(['Real']);
  });
});

// -------------------------------------------------------------------------
// End-to-end realistic fixture
// -------------------------------------------------------------------------

describe('zod recognizer — realistic combined module', () => {
  it('models a module mixing object, enum, nested, infer, pick, and inline schemas', () => {
    const code = `
      import { z } from 'zod';

      export const AddressSchema = z.object({
        street: z.string(),
        city: z.string(),
      });

      export const UserSchema = z.object({
        name: z.string(),
        age: z.number().int(),
        role: z.enum(['admin', 'editor', 'viewer']),
        home: z.object({
          label: z.string(),
        }),
      }).strict();

      export type User = z.infer<typeof UserSchema>;
      export const PublicUser = UserSchema.pick({ name: true });

      function defineTool(spec: unknown) { return spec; }
      defineTool({
        input: z.object({ query: z.string() }),
      });
    `;
    const { nodes, edges } = extractFromSource('combined.ts', code);

    // Structs: two top-level + nested `home` + inline `input`.
    expect(names(byKind(nodes, 'struct'))).toEqual(['AddressSchema', 'home', 'input', 'UserSchema']);

    // Enum members from role.
    expect(names(byKind(nodes, 'enum_member'))).toEqual(['admin', 'editor', 'viewer']);

    // type_of into UserSchema.
    const userStruct = findByName(nodes, 'struct', 'UserSchema')!;
    expect(edges.some((e) => e.kind === 'type_of' && e.target === userStruct.id)).toBe(true);

    // references into the picked `name` field.
    const nameField = byKind(nodes, 'field').find((n) => n.name === 'name' && n.qualifiedName.includes('UserSchema'))!;
    expect(edges.some((e) => e.kind === 'references' && e.target === nameField.id)).toBe(true);

    // The inline `input` struct has its query field.
    const inputStruct = findByName(nodes, 'struct', 'input')!;
    const fieldsById = new Map(byKind(nodes, 'field').map((n) => [n.id, n.name]));
    expect(containsFrom(edges, inputStruct.id).map((e) => fieldsById.get(e.target))).toEqual(['query']);
  });
});
