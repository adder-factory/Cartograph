/**
 * FRICTION-9: cartograph_explore "references:" lines must not contain EdgeKind
 * values as if they were symbol names.
 *
 * Root cause: when an edge's target node is unresolved / anonymous (e.g.
 * field_access to an external property, or a def_use self-loop), the prior
 * code fell back to `edge.kind` as the target name, producing entries like
 * `field_access(field_access)` or `calls(calls)` in the header.
 *
 * Fix: resolve the target via the full DB (not just the subgraph); if still
 * unresolved, skip the edge entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

/** All EdgeKind values that must never appear as a symbol name in references:. */
const EDGE_KIND_VALUES = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
  'decorates',
  'tests',
  'field_access',
  'similar_to',
  'def_use',
];

/**
 * A `name(kind)` token where both name and kind are the same EdgeKind value
 * is the signature of the phantom-symbol bug.
 */
function phantomSymbolPattern(kind: string): RegExp {
  return new RegExp(String.raw`\b${kind}\(${kind}\)`);
}

describe('FRICTION-9 — explore references: must not contain EdgeKind phantom symbols', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-explore-phantom-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });

    // This fixture creates several flavours of edges whose target node is
    // either unresolvable (field_access on `any`-typed arg → field name
    // is an unresolvedReference that cannot be linked to a DB node) or is a
    // self-loop (def_use: source === target === enclosing function node).
    //
    // Prior to the fix, cartograph_explore printed these as phantom entries
    // like `field_access(field_access)` or `def_use(def_use)` in the
    // per-file `references:` header.
    fs.writeFileSync(
      path.join(tempDir, 'src/watcher.ts'),
      [
        '/** Watches a path and reports events. */',
        'export interface WatchOptions { path: string; debounce: number; }',
        'export interface WatchEvent { kind: string; file: string; }',
        '',
        '/** Handle a single file-system event. */',
        'export function handleFileEvent(event: any, opts: WatchOptions): void {',
        '  // field_access edges: event.kind, event.file (unresolvable targets)',
        '  const k = event.kind;',
        '  const f = event.file;',
        '  // def_use self-loop: k and f are locals, source === target === handleFileEvent',
        '  console.log(k, f, opts.debounce);',
        '}',
        '',
        '/** Normalise a raw path string. */',
        'export function normalizePath(p: string): string {',
        String.raw`  return p.replaceAll(/\\/g, "/");`,
        '}',
        '',
        '/** Main class wiring everything together. */',
        'export class FileWatcher {',
        '  private opts: WatchOptions;',
        '  constructor(opts: WatchOptions) { this.opts = opts; }',
        '  start(): void { handleFileEvent({ kind: "add", file: "x" }, this.opts); }',
        '  stop(): void { normalizePath(this.opts.path); }',
        '}',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  it('references: lines contain no EdgeKind-as-name phantom entries', async () => {
    const result = await handler.runHandler('cartograph_explore', {
      query: 'FileWatcher handleFileEvent watcher.ts',
      summary: true,
    });
    const text = textOf(result);

    // The explore output must be well-formed (not an error).
    expect(result.isError).toBeFalsy();
    expect(text).toContain('references:');

    // Check every EdgeKind value — none should appear as `kind(kind)`.
    for (const kind of EDGE_KIND_VALUES) {
      const pat = phantomSymbolPattern(kind);
      expect(text, `phantom entry "${kind}(${kind})" must not appear in explore output`).not.toMatch(pat);
    }
  });

  it('references: still includes real named-symbol edges (calls, type_of to real nodes)', async () => {
    const result = await handler.runHandler('cartograph_explore', {
      query: 'FileWatcher handleFileEvent watcher.ts',
      summary: true,
    });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();

    // handleFileEvent and normalizePath are real named functions; edges TO
    // them (e.g. from FileWatcher.start / stop) must still surface.
    // We can't assert a specific line format here (summary mode shows
    // per-file headers), so we just confirm the symbols appear in the output.
    expect(text).toContain('handleFileEvent');
    expect(text).toContain('normalizePath');
  });

  it('summary mode and non-summary mode both suppress phantom entries', async () => {
    for (const summary of [true, false]) {
      const result = await handler.runHandler('cartograph_explore', {
        query: 'FileWatcher handleFileEvent watcher.ts',
        summary,
        maxFiles: 3,
      });
      const text = textOf(result);
      expect(result.isError).toBeFalsy();

      for (const kind of EDGE_KIND_VALUES) {
        const pat = phantomSymbolPattern(kind);
        expect(text, `[summary=${summary}] phantom entry "${kind}(${kind})" must not appear`).not.toMatch(pat);
      }
    }
  });

  it('relationship map renders each source→target edge at most once per kind', async () => {
    // The subgraph edge list can carry the same logical edge more than
    // once (e.g. surfaced via two traversal paths). The relationship-map
    // renderer must dedupe by source+target+kind so no `A → B` row is
    // printed twice verbatim.
    const result = await handler.runHandler('cartograph_explore', {
      query: 'FileWatcher handleFileEvent normalizePath watcher.ts',
      summary: true,
    });
    const text = textOf(result);
    expect(result.isError).toBeFalsy();

    // Walk the `### Relationships` section, tracking the active `**kind:**`
    // group. A `- A → B` row is keyed by `<kind>|A → B`; no key repeats.
    const lines = text.split('\n');
    let inRelSection = false;
    let currentKind = '';
    const seen = new Set<string>();
    for (const line of lines) {
      if (line.startsWith('### Relationships')) {
        inRelSection = true;
        continue;
      }
      if (inRelSection && line.startsWith('### ')) break; // next top section
      if (!inRelSection) continue;
      const kindMatch = /^\*\*(.+):\*\*$/.exec(line);
      if (kindMatch) {
        currentKind = kindMatch[1]!;
        continue;
      }
      const rowMatch = /^- (.+ → .+)$/.exec(line);
      if (rowMatch && !rowMatch[1]!.startsWith('...')) {
        const key = `${currentKind}|${rowMatch[1]}`;
        expect(seen.has(key), `duplicate relationship row: ${key}`).toBe(false);
        seen.add(key);
      }
    }
  });
});
