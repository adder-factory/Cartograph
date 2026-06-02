/**
 * Tests for the B2 Zod schema recognizer — the post-extraction pass
 * that synthesizes `struct` / `field` / `enum_member` nodes (+ `contains`
 * edges) for `z.object({...})` schemas the language extractor sees only
 * as an opaque call chain.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFromSource } from '../src/extraction/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Node, Edge } from '../src/types.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

const byKind = (nodes: Node[], kind: string): Node[] => nodes.filter((n) => n.kind === kind);
const containsFrom = (edges: Edge[], sourceId: string): Edge[] =>
  edges.filter((e) => e.kind === 'contains' && e.source === sourceId);
const byName = (a: string, b: string): number => a.localeCompare(b);

describe('Zod schema recognizer (B2)', () => {
  it('synthesizes struct + field + enum_member nodes for a z.object schema', () => {
    const code = `
      import { z } from 'zod';
      export const UserSchema = z.object({
        name: z.string(),
        age: z.number().int(),
        role: z.enum(['admin', 'editor', 'viewer']),
      });
    `;
    const result = extractFromSource('user.ts', code);

    const structs = byKind(result.nodes, 'struct');
    expect(structs.map((n) => n.name)).toContain('UserSchema');

    const fields = byKind(result.nodes, 'field');
    expect(fields.map((n) => n.name).sort(byName)).toEqual(['age', 'name', 'role']);
    // The leading Zod method is captured as the field signature.
    expect(fields.find((f) => f.name === 'name')?.signature).toBe('z.string');
    expect(fields.find((f) => f.name === 'role')?.signature).toBe('z.enum');

    const members = byKind(result.nodes, 'enum_member');
    expect(members.map((n) => n.name).sort(byName)).toEqual(['admin', 'editor', 'viewer']);
  });

  it('wires contains edges struct→field and field→enum_member', () => {
    const code = `
      import { z } from 'zod';
      export const Pet = z.object({
        species: z.enum(['cat', 'dog']),
      });
    `;
    const result = extractFromSource('pet.ts', code);
    const struct = byKind(result.nodes, 'struct').find((n) => n.name === 'Pet');
    const speciesField = byKind(result.nodes, 'field').find((n) => n.name === 'species');
    expect(struct).toBeDefined();
    expect(speciesField).toBeDefined();

    // struct → field
    expect(containsFrom(result.edges, struct!.id).map((e) => e.target)).toContain(speciesField!.id);
    // field → enum_member (cat, dog)
    const memberTargets = containsFrom(result.edges, speciesField!.id).map((e) => e.target);
    expect(memberTargets).toHaveLength(2);
  });

  it('unwraps a trailing method chain to find the base z.object', () => {
    const code = `
      import { z } from 'zod';
      export const Strict = z.object({ id: z.string() }).strict();
    `;
    const result = extractFromSource('strict.ts', code);
    expect(byKind(result.nodes, 'struct').map((n) => n.name)).toContain('Strict');
    expect(byKind(result.nodes, 'field').map((n) => n.name)).toContain('id');
  });

  it('emits a type_of edge from a z.infer<typeof X> alias to the struct', () => {
    const code = `
      import { z } from 'zod';
      export const UserSchema = z.object({
        name: z.string(),
        role: z.enum(['admin', 'viewer']),
      });
      export type User = z.infer<typeof UserSchema>;
      function check(u: User) {
        return UserSchema.shape.role;
      }
    `;
    const result = extractFromSource('user.ts', code);
    const struct = byKind(result.nodes, 'struct').find((n) => n.name === 'UserSchema');
    const roleField = byKind(result.nodes, 'field').find((n) => n.name === 'role');
    expect(struct).toBeDefined();
    expect(roleField).toBeDefined();

    // z.infer<typeof UserSchema> → type_of edge into the struct
    const typeOf = result.edges.filter((e) => e.kind === 'type_of' && e.target === struct!.id);
    expect(typeOf.length).toBeGreaterThanOrEqual(1);

    // UserSchema.shape.role → references edge into the role field
    const refs = result.edges.filter((e) => e.kind === 'references' && e.target === roleField!.id);
    expect(refs.length).toBeGreaterThanOrEqual(1);
  });

  it('emits references edges for X.pick({...}) field selections', () => {
    const code = `
      import { z } from 'zod';
      export const Account = z.object({ id: z.string(), email: z.string() });
      export const Public = Account.pick({ id: true });
    `;
    const result = extractFromSource('account.ts', code);
    const idField = byKind(result.nodes, 'field').find((n) => n.name === 'id');
    const emailField = byKind(result.nodes, 'field').find((n) => n.name === 'email');
    expect(idField).toBeDefined();

    const idRefs = result.edges.filter((e) => e.kind === 'references' && e.target === idField!.id);
    expect(idRefs.length).toBeGreaterThanOrEqual(1);
    // email was not picked — no reference edge.
    const emailRefs = result.edges.filter((e) => e.kind === 'references' && e.target === emailField!.id);
    expect(emailRefs).toHaveLength(0);
  });

  it('emits references edges for X.omit({...}) field selections', () => {
    const code = `
      import { z } from 'zod';
      export const Account = z.object({ id: z.string(), secret: z.string() });
      export const Safe = Account.omit({ secret: true });
    `;
    const result = extractFromSource('account-omit.ts', code);
    const secretField = byKind(result.nodes, 'field').find((n) => n.name === 'secret');
    expect(secretField).toBeDefined();
    const secretRefs = result.edges.filter((e) => e.kind === 'references' && e.target === secretField!.id);
    expect(secretRefs.length).toBeGreaterThanOrEqual(1);
  });

  it('recurses into a nested z.object field (v2 step 2)', () => {
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
    const result = extractFromSource('order.ts', code);

    // Top-level struct + a nested struct for the `address` field.
    const structs = byKind(result.nodes, 'struct');
    expect(structs.map((n) => n.name).sort(byName)).toEqual(['address', 'Order']);

    const addressStruct = structs.find((n) => n.name === 'address')!;
    const addressField = byKind(result.nodes, 'field').find((n) => n.name === 'address')!;
    // field `address` → nested struct (contains)
    expect(containsFrom(result.edges, addressField.id).map((e) => e.target)).toContain(addressStruct.id);

    // The nested struct contains its own inner fields.
    const fieldsById = new Map(byKind(result.nodes, 'field').map((n) => [n.id, n.name]));
    const nested = containsFrom(result.edges, addressStruct.id).map((e) => fieldsById.get(e.target));
    const sortedNested = [...nested];
    sortedNested.sort(byName);
    expect(sortedNested).toEqual(['city', 'street']);
  });

  it('recognizes an inline z.object schema passed as a call argument (v2 step 3)', () => {
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
    const result = extractFromSource('tool.ts', code);

    // The inline schema is named from its enclosing object key.
    const struct = byKind(result.nodes, 'struct').find((n) => n.name === 'schema');
    expect(struct).toBeDefined();

    const fieldsById = new Map(byKind(result.nodes, 'field').map((n) => [n.id, n.name]));
    const inlineFields = containsFrom(result.edges, struct!.id).map((e) => fieldsById.get(e.target));
    const sortedInlineFields = [...inlineFields];
    sortedInlineFields.sort(byName);
    expect(sortedInlineFields).toEqual(['count', 'target']);
  });

  it('does not double-count a nested z.object as an inline schema', () => {
    const code = `
      import { z } from 'zod';
      export const Order = z.object({
        address: z.object({ city: z.string() }),
      });
    `;
    const result = extractFromSource('order2.ts', code);
    // Exactly two structs — Order + the nested address — not a third
    // from the inline pass re-claiming the nested z.object.
    expect(
      byKind(result.nodes, 'struct')
        .map((n) => n.name)
        .sort(byName),
    ).toEqual(['address', 'Order']);
  });

  it('extracts the realistic Zod fixture file end to end', () => {
    const fixture = path.join(__dirname, 'fixtures', 'schema-recognizers', 'zod.ts');
    const result = extractFromSource('zod.ts', fs.readFileSync(fixture, 'utf-8'));

    // Two top-level schemas + the nested `home` object → three structs.
    expect(
      byKind(result.nodes, 'struct')
        .map((n) => n.name)
        .sort(byName),
    ).toEqual(['AddressSchema', 'home', 'UserSchema']);
    expect(
      byKind(result.nodes, 'enum_member')
        .map((n) => n.name)
        .sort(byName),
    ).toEqual(['admin', 'editor', 'viewer']);

    // z.infer<typeof UserSchema> → type_of edge into the UserSchema struct.
    const userStruct = byKind(result.nodes, 'struct').find((n) => n.name === 'UserSchema')!;
    expect(result.edges.some((e) => e.kind === 'type_of' && e.target === userStruct.id)).toBe(true);

    // UserSchema.pick({ name: true }) → references edge into the name field.
    const nameField = byKind(result.nodes, 'field').find((n) => n.name === 'name')!;
    expect(result.edges.some((e) => e.kind === 'references' && e.target === nameField.id)).toBe(true);
  });

  it('does NOT fire on a file that does not import zod (detect gate)', () => {
    const code = `
      const z = { object: (x: unknown) => x };
      export const NotASchema = z.object({ a: 1 });
    `;
    const result = extractFromSource('plain.ts', code);
    expect(byKind(result.nodes, 'struct')).toHaveLength(0);
    expect(byKind(result.nodes, 'enum_member')).toHaveLength(0);
  });
});
