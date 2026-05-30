/**
 * `getSymbolNeighborhood` — the graph-derived structural context that
 * enriches the role-classifier's LLM prompt (supertypes + members).
 *
 * Indexes a tiny TypeScript fixture and asserts the query reads
 * `extends` / `implements` / `contains` edges into the right shape.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { getSymbolNeighborhood } from '../src/db/queries-roles.js';

const FIXTURE = `export class BaseEntity {
  id: string = '';
}

export interface Greeter {
  greet(): string;
}

export class User extends BaseEntity implements Greeter {
  name: string = '';
  greet(): string { return 'hi ' + this.name; }
  rename(next: string): void { this.name = next; }
}

export function freeStanding(n: number): number {
  return n * 2;
}
`;

describe('getSymbolNeighborhood', () => {
  let dir: string;
  let cg: Cartograph | null = null;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-roles-nbhd-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'model.ts'), FIXTURE);
    cg = await Cartograph.init(dir);
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) {
      try {
        cg.close();
      } catch {
        /* noop */
      }
      cg = null;
    }
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function nodeId(name: string, kind: string): string {
    const row = cg!.db.getDb().prepare('SELECT id FROM nodes WHERE name = ? AND kind = ?').get(name, kind) as
      | { id: string }
      | undefined;
    expect(row, `node ${name} (${kind}) should exist`).toBeTruthy();
    return row!.id;
  }

  it('captures extends + implements supertypes for a class', () => {
    const nbhd = getSymbolNeighborhood(cg!.queries);
    const user = nbhd.get(nodeId('User', 'class'));
    expect(user).toBeTruthy();
    expect(user!.supertypes.sort()).toEqual(['BaseEntity', 'Greeter']);
  });

  it('captures member methods/fields of a class', () => {
    const nbhd = getSymbolNeighborhood(cg!.queries);
    const user = nbhd.get(nodeId('User', 'class'))!;
    // Members come from `contains` edges to method/field/property kinds.
    expect(user.members).toEqual(expect.arrayContaining(['greet', 'rename', 'name']));
  });

  it('leaves a free-standing function out of the neighbourhood map', () => {
    const nbhd = getSymbolNeighborhood(cg!.queries);
    // No extends/implements, and `contains` fan-out is scoped to
    // class-like sources — a plain function has no neighbourhood row.
    expect(nbhd.has(nodeId('freeStanding', 'function'))).toBe(false);
  });
});
