/**
 * cartograph_note({action}) family — annotations + bookmarks (#14).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('cartograph_note family (#14)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-note-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/lib.ts'),
      [
        'export function alpha(): number { return 1; }',
        'export function beta(): number { return 2; }',
        // A camelCase compound whose `Processor` token the FTS index
        // can match for a non-exact `processor` query — used to exercise
        // the fuzzy-fallback resolution path.
        'export function alphaProcessor(): number { return 3; }',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (cg) cg.destroy();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  it('add attaches a note to a known symbol', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'add',
        symbol: 'alpha',
        text: 'investigate refactor candidate',
      }),
    );
    expect(text).toMatch(/Note saved/);
    expect(text).toContain('alpha');
    expect(text).toContain('investigate refactor candidate');
  });

  it('add allows free-floating project-scoped notes when symbol omitted', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'add',
        text: 'remember to revisit auth flow',
      }),
    );
    expect(text).toMatch(/Note saved/);
    expect(text).not.toMatch(/on \*\*/);
  });

  it('add with a kind discriminator round-trips on list', async () => {
    await handler.runHandler('cartograph_note', {
      action: 'add',
      symbol: 'alpha',
      text: 'check this later',
      kind: 'followup',
    });
    const text = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'list',
        kind: 'followup',
      }),
    );
    expect(text).toContain('check this later');
    expect(text).toContain('followup');
  });

  it('list filters by symbol', async () => {
    await handler.runHandler('cartograph_note', { action: 'add', symbol: 'alpha', text: 'A1' });
    await handler.runHandler('cartograph_note', { action: 'add', symbol: 'beta', text: 'B1' });
    const text = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'list',
        symbol: 'alpha',
      }),
    );
    expect(text).toContain('A1');
    expect(text).not.toContain('B1');
  });

  it('list returns empty message when nothing matches', async () => {
    const text = textOf(await handler.runHandler('cartograph_note', { action: 'list', symbol: 'alpha' }));
    expect(text).toMatch(/No notes/);
  });

  it('add validates kind enum', async () => {
    const r = await handler.runHandler('cartograph_note', {
      action: 'add',
      symbol: 'alpha',
      text: 'x',
      kind: 'todo',
    });
    // Post-Zod-migration the `kind` enum is rejected at the dispatch
    // boundary; the formatted error names the field + the valid set.
    expect(textOf(r)).toMatch(/kind: must be one of/);
  });

  it('add errors when symbol does not exist', async () => {
    const r = await handler.runHandler('cartograph_note', {
      action: 'add',
      symbol: 'doesNotExist',
      text: 'x',
    });
    expect(textOf(r)).toMatch(/symbol "doesNotExist" not found/);
  });

  it('add surfaces a fuzzy-fallback note when the symbol resolves only approximately', async () => {
    // `processor` is not an exact symbol name — `findSymbol` falls
    // through to the FTS fuzzy path and resolves to a near match
    // (`alphaProcessor`). The add response must carry the disambiguation
    // banner so the agent knows the note landed on a guessed node, not
    // the exact symbol it asked for (audit Group 5 #1).
    const text = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'add',
        symbol: 'processor',
        text: 'fuzzy attach',
      }),
    );
    expect(text).toMatch(/Note saved/);
    // The fuzzy-fallback banner from findSymbol must reach the output.
    expect(text).toMatch(/No exact match for "processor"/);
  });

  it('add does NOT add a fuzzy note for an exact symbol match', async () => {
    const text = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'add',
        symbol: 'alpha',
        text: 'exact attach',
      }),
    );
    expect(text).toMatch(/Note saved/);
    expect(text).not.toMatch(/No exact match/);
  });

  it('delete removes the note by id', async () => {
    const addText = textOf(
      await handler.runHandler('cartograph_note', {
        action: 'add',
        symbol: 'alpha',
        text: 'temp',
      }),
    );
    const idMatch = /Note saved \(id (\d+)\)/.exec(addText);
    expect(idMatch).not.toBeNull();
    const id = Number(idMatch![1]);

    const delText = textOf(await handler.runHandler('cartograph_note', { action: 'delete', id }));
    expect(delText).toMatch(/Deleted note/);

    const listText = textOf(await handler.runHandler('cartograph_note', { action: 'list', symbol: 'alpha' }));
    expect(listText).not.toContain('temp');
  });

  it('delete reports missing note id gracefully', async () => {
    const text = textOf(await handler.runHandler('cartograph_note', { action: 'delete', id: 99999 }));
    expect(text).toMatch(/No note with id/);
  });

  it('rejects unknown actions with a usage hint', async () => {
    const r = await handler.runHandler('cartograph_note', { action: 'whatever' });
    const text = textOf(r);
    // Action names derive from the registered NOTE_ACTIONS Record;
    // we assert each name appears (separator is not part of the
    // contract — could be "or" / "," / "|" depending on the format).
    for (const name of ['add', 'list', 'delete']) {
      expect(text).toContain(`'${name}'`);
    }
  });
});
