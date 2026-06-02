/**
 * Stale-handle FK safety — Section A #2 from BACKLOG.md.
 *
 * Regression for the "MCP holds a QueryBuilder open across a file
 * edit, FK constraints fire on stale node ids" bug. Captures a node
 * id, deletes the file, runs sync (which removes the node), then
 * attempts to write a summary + embedding referencing the now-stale
 * id. Pre-fix this raised SqliteError: FOREIGN KEY constraint failed;
 * post-fix the upsert is a no-op and returns false.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { upsertSymbolSummary, getSymbolSummary } from '../src/db/queries-summaries.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import { getNodesByKind } from '../src/db/queries.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('FK safety on stale node ids', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fk-stale-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha() { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fk-stale', version: '0.0.0' }));
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('upsertSymbolSummary silently no-ops when the node was deleted', async () => {
    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'alpha');
    expect(node).toBeDefined();
    const staleId = node!.id;

    fs.unlinkSync(path.join(dir, 'src', 'a.ts'));
    await cg.sync({ summarize: false });
    expect(cg.queries.getNodeById(staleId)).toBeNull();

    // No throw — the WHERE EXISTS gate skips the row.
    const wrote = upsertSymbolSummary({
      qb: cg.queries,
      nodeId: staleId,
      contentHash: 'h',
      summary: 'A test',
      model: 'm',
    });
    expect(wrote).toBe(false);
    expect(getSymbolSummary(cg.queries, staleId)).toBeNull();
  });

  it('upsertSymbolEmbedding silently no-ops when the node has been deleted', async () => {
    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'alpha');
    const staleId = node!.id;
    fs.unlinkSync(path.join(dir, 'src', 'a.ts'));
    await cg.sync({ summarize: false });
    // Node is gone — the WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)
    // gate should produce a no-op rather than an FK constraint error.
    const wrote = upsertSymbolEmbedding({
      qb: cg.queries,
      nodeId: staleId,
      embedding: Buffer.alloc(8),
      model: 'm',
      summaryHashAtEmbed: '',
    });
    expect(wrote).toBe(false);
  });

  it('upsertSymbolSummary writes normally when the node exists', () => {
    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'alpha');
    const id = node!.id;
    const wrote = upsertSymbolSummary({ qb: cg.queries, nodeId: id, contentHash: 'h', summary: 'A test', model: 'm' });
    expect(wrote).toBe(true);
    expect(getSymbolSummary(cg.queries, id)).not.toBeNull();
  });

  it('upsertSymbolEmbedding writes normally when the node exists (no summary required)', () => {
    // Since migration 033, embeddings only need the node to exist — not a summary.
    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'alpha');
    const id = node!.id;
    const wrote = upsertSymbolEmbedding({
      qb: cg.queries,
      nodeId: id,
      embedding: Buffer.alloc(8),
      model: 'm',
      summaryHashAtEmbed: '',
    });
    expect(wrote).toBe(true);
  });
});
