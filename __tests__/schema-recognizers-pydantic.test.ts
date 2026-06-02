/**
 * Tests for the B2 Pydantic schema recognizer — the post-extraction
 * pass that synthesizes `struct` / `field` / `enum_member` nodes (+
 * `contains` edges) for `class X(BaseModel)` data models whose typed
 * class-body attributes the base Python extractor doesn't surface.
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

describe('Pydantic schema recognizer (B2)', () => {
  it('synthesizes struct + field + enum_member nodes for a BaseModel class', () => {
    const code = `
from pydantic import BaseModel
from typing import Literal

class User(BaseModel):
    name: str
    age: int = 0
    role: Literal['admin', 'editor', 'viewer']
`;
    const result = extractFromSource('models.py', code);

    const structs = byKind(result.nodes, 'struct');
    expect(structs.map((n) => n.name)).toContain('User');

    const fields = byKind(result.nodes, 'field');
    expect(fields.map((n) => n.name).sort(byName)).toEqual(['age', 'name', 'role']);
    // The annotation text is captured as the field signature.
    expect(fields.find((f) => f.name === 'name')?.signature).toBe('str');
    expect(fields.find((f) => f.name === 'age')?.signature).toBe('int');

    const members = byKind(result.nodes, 'enum_member');
    expect(members.map((n) => n.name).sort(byName)).toEqual(['admin', 'editor', 'viewer']);
  });

  it('wires contains edges struct→field and field→enum_member', () => {
    const code = `
from pydantic import BaseModel
from typing import Literal

class Pet(BaseModel):
    species: Literal['cat', 'dog']
`;
    const result = extractFromSource('pet.py', code);
    const struct = byKind(result.nodes, 'struct').find((n) => n.name === 'Pet');
    const speciesField = byKind(result.nodes, 'field').find((n) => n.name === 'species');
    expect(struct).toBeDefined();
    expect(speciesField).toBeDefined();

    // struct → field
    expect(containsFrom(result.edges, struct!.id).map((e) => e.target)).toContain(speciesField!.id);
    // field → enum_member (cat, dog)
    expect(containsFrom(result.edges, speciesField!.id)).toHaveLength(2);
  });

  it('recognizes a pydantic.BaseModel-qualified base class', () => {
    const code = `
import pydantic

class Account(pydantic.BaseModel):
    id: str
`;
    const result = extractFromSource('account.py', code);
    expect(byKind(result.nodes, 'struct').map((n) => n.name)).toContain('Account');
    expect(byKind(result.nodes, 'field').map((n) => n.name)).toContain('id');
  });

  it('skips ClassVar attributes — they are not Pydantic fields', () => {
    const code = `
from pydantic import BaseModel
from typing import ClassVar

class Config(BaseModel):
    version: ClassVar[int]
    name: str
`;
    const result = extractFromSource('config.py', code);
    const fields = byKind(result.nodes, 'field').map((n) => n.name);
    expect(fields).toContain('name');
    expect(fields).not.toContain('version');
  });

  it('does NOT treat a non-BaseModel class as a model', () => {
    const code = `
from pydantic import BaseModel

class Helper:
    x: int

class Real(BaseModel):
    y: str
`;
    const result = extractFromSource('mixed.py', code);
    // Only Real is a model — Helper has no Pydantic base.
    expect(byKind(result.nodes, 'struct').map((n) => n.name)).toEqual(['Real']);
    const fields = byKind(result.nodes, 'field').map((n) => n.name);
    expect(fields).toEqual(['y']);
  });

  it('extracts the realistic Pydantic fixture file end to end', () => {
    const fixture = path.join(__dirname, 'fixtures', 'schema-recognizers', 'pydantic.py');
    const result = extractFromSource('pydantic.py', fs.readFileSync(fixture, 'utf-8'));

    // BaseModel ×2 + BaseSettings ×1 → three structs.
    expect(
      byKind(result.nodes, 'struct')
        .map((n) => n.name)
        .sort(byName),
    ).toEqual(['Address', 'AppSettings', 'User']);
    // Literal members across User.role + AppSettings.region.
    expect(
      byKind(result.nodes, 'enum_member')
        .map((n) => n.name)
        .sort(byName),
    ).toEqual(['admin', 'editor', 'eu', 'us', 'viewer']);

    // The User model carries every declared field, including the
    // model-typed `home`.
    const userStruct = byKind(result.nodes, 'struct').find((n) => n.name === 'User')!;
    const fieldsById = new Map(byKind(result.nodes, 'field').map((n) => [n.id, n.name]));
    const userFields = containsFrom(result.edges, userStruct.id).map((e) => fieldsById.get(e.target));
    const sortedUserFields = [...userFields];
    sortedUserFields.sort(byName);
    expect(sortedUserFields).toEqual(['age', 'home', 'name', 'role']);
  });

  it('does NOT fire on a file that does not import pydantic (detect gate)', () => {
    const code = `
class BaseModel:
    pass

class NotAModel(BaseModel):
    a: int
`;
    const result = extractFromSource('plain.py', code);
    expect(byKind(result.nodes, 'struct')).toHaveLength(0);
    expect(byKind(result.nodes, 'field')).toHaveLength(0);
  });
});
