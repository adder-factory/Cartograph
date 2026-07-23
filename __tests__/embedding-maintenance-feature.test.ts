import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { upsertFile } from '../src/db/queries-files.js';
import { auditEmbeddingStorage, cleanupObsoleteEmbeddings } from '../src/features/embedding-maintenance/index.js';

const ACTIVE_MODEL = 'active-embedding-model';
const LEGACY_MODEL = 'legacy-embedding-model';

function embedding(dim: number): Buffer {
  const bytes = Buffer.alloc(dim * Float32Array.BYTES_PER_ELEMENT);
  for (let i = 0; i < dim; i++) bytes.writeFloatLE((i + 1) / dim, i * Float32Array.BYTES_PER_ELEMENT);
  return bytes;
}

describe('embedding maintenance feature', () => {
  let projectRoot: string;
  let cg: Cartograph;

  beforeEach(async () => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-embedding-maintenance-'));
    cg = await Cartograph.init(projectRoot, {
      config: {
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://127.0.0.1:1',
            model: ACTIVE_MODEL,
          },
        },
      },
    });

    upsertFile(cg.queries, {
      path: 'src/example.ts',
      contentHash: 'file-hash',
      language: 'typescript',
      size: 100,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 2,
    });
    cg.queries.insertNodes([
      {
        id: 'fn:active',
        kind: 'function',
        name: 'activeFunction',
        qualifiedName: 'activeFunction',
        filePath: 'src/example.ts',
        language: 'typescript',
        startLine: 1,
        endLine: 2,
        startColumn: 0,
        endColumn: 1,
        updatedAt: 1,
        bodyHash: 'active-hash',
      },
      {
        id: 'fn:legacy',
        kind: 'function',
        name: 'legacyFunction',
        qualifiedName: 'legacyFunction',
        filePath: 'src/example.ts',
        language: 'typescript',
        startLine: 4,
        endLine: 5,
        startColumn: 0,
        endColumn: 1,
        updatedAt: 1,
        bodyHash: 'legacy-ref',
      },
    ]);

    const db = cg.db.getDb();
    const insertStore = db.prepare(
      `INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at, last_ref_at)
       VALUES (?, ?, 'symbol', ?, 1, 1)`,
    );
    insertStore.run('active-hash', ACTIVE_MODEL, embedding(3));
    insertStore.run('active-orphan', ACTIVE_MODEL, embedding(3));
    insertStore.run('legacy-ref', LEGACY_MODEL, embedding(2));
    insertStore.run('legacy-orphan', LEGACY_MODEL, embedding(4));

    const insertRef = db.prepare(
      `INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
       VALUES (?, ?, ?, 'symbol', '')`,
    );
    insertRef.run('fn:active', 'active-hash', ACTIVE_MODEL);
    // This legacy pointer is superseded by the active-model pointer above.
    // It shares a store row with fn:legacy, whose only pointer is still legacy,
    // so cleanup must detach this ref without deleting the shared store row.
    insertRef.run('fn:active', 'legacy-ref', LEGACY_MODEL);
    insertRef.run('fn:legacy', 'legacy-ref', LEGACY_MODEL);

    const hnsw4 = path.join(projectRoot, '.cartograph', 'hnsw_4.bin');
    fs.writeFileSync(hnsw4, 'obsolete');
    db.prepare(
      `INSERT INTO hnsw_meta (dim, row_count, max_rowid, built_at, file_path)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(4, 1, 4, 1, hnsw4);
  });

  afterEach(() => {
    cg.close();
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reports model, grain, dimension, references, orphans, and mixed-dimension drift', () => {
    const report = auditEmbeddingStorage({
      db: cg.db.getDb(),
      projectRoot,
      activeModel: ACTIVE_MODEL,
    });

    expect(report.activeModel).toBe(ACTIVE_MODEL);
    expect(report.totals).toMatchObject({
      storeRows: 4,
      referencedRows: 2,
      orphanRows: 2,
      safeCleanupRows: 1,
      supersededRefs: 1,
      protectedReferencedRows: 1,
      protectedActiveRows: 2,
    });
    expect(report.buckets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: ACTIVE_MODEL,
          grain: 'symbol',
          dimension: 3,
          storeRows: 2,
          referencedRows: 1,
          orphanRows: 1,
          activeModel: true,
        }),
        expect.objectContaining({
          model: LEGACY_MODEL,
          grain: 'symbol',
          dimension: 2,
          storeRows: 1,
          referencedRows: 1,
          orphanRows: 0,
          activeModel: false,
        }),
        expect.objectContaining({
          model: LEGACY_MODEL,
          grain: 'symbol',
          dimension: 4,
          storeRows: 1,
          referencedRows: 0,
          orphanRows: 1,
          activeModel: false,
        }),
      ]),
    );
    expect(report.mixedDimensions).toContainEqual({
      model: LEGACY_MODEL,
      grain: 'symbol',
      dimensions: [2, 4],
    });
    expect(report.artifacts).toContainEqual(
      expect.objectContaining({ kind: 'hnsw', grain: 'symbol', dimension: 4, state: 'live' }),
    );
  });

  it('defaults to a non-mutating dry run and protects active or referenced rows', () => {
    const result = cleanupObsoleteEmbeddings({
      db: cg.db.getDb(),
      projectRoot,
      activeModel: ACTIVE_MODEL,
      vecLoaded: cg.db.hasVecExtension(),
      confirm: false,
    });

    expect(result).toMatchObject({
      dryRun: true,
      candidateRows: 1,
      candidateRefs: 1,
      deletedRows: 0,
      deletedRefs: 0,
      protectedReferencedRows: 1,
      protectedActiveRows: 2,
      obsoleteDimensionsAfterCleanup: [4],
    });
    expect(cg.db.getDb().prepare('SELECT COUNT(*) AS c FROM embedding_store').get()).toEqual({ c: 4 });
    expect(fs.existsSync(path.join(projectRoot, '.cartograph', 'hnsw_4.bin'))).toBe(true);
  });

  it('deletes only confirmed non-active orphans and removes now-unused dimension artifacts', () => {
    const result = cleanupObsoleteEmbeddings({
      db: cg.db.getDb(),
      projectRoot,
      activeModel: ACTIVE_MODEL,
      vecLoaded: cg.db.hasVecExtension(),
      confirm: true,
    });

    expect(result).toMatchObject({
      dryRun: false,
      candidateRows: 1,
      candidateRefs: 1,
      deletedRows: 1,
      deletedRefs: 1,
      protectedReferencedRows: 1,
      protectedActiveRows: 2,
      obsoleteDimensionsAfterCleanup: [4],
    });
    expect(result.removedArtifacts).toContainEqual(expect.objectContaining({ kind: 'hnsw', dimension: 4 }));
    expect(cg.db.getDb().prepare('SELECT body_hash, model FROM embedding_store ORDER BY body_hash').all()).toEqual([
      { body_hash: 'active-hash', model: ACTIVE_MODEL },
      { body_hash: 'active-orphan', model: ACTIVE_MODEL },
      { body_hash: 'legacy-ref', model: LEGACY_MODEL },
    ]);
    expect(cg.db.getDb().prepare('SELECT COUNT(*) AS c FROM hnsw_meta WHERE dim = 4').get()).toEqual({ c: 0 });
    expect(fs.existsSync(path.join(projectRoot, '.cartograph', 'hnsw_4.bin'))).toBe(false);
    expect(
      cg.db.getDb().prepare(`SELECT node_id FROM embedding_refs WHERE model = ? ORDER BY node_id`).all(LEGACY_MODEL),
    ).toEqual([{ node_id: 'fn:legacy' }]);
  });

  it('refuses cleanup without an active model safety anchor', () => {
    expect(() =>
      cleanupObsoleteEmbeddings({
        db: cg.db.getDb(),
        projectRoot,
        activeModel: undefined,
        vecLoaded: cg.db.hasVecExtension(),
        confirm: true,
      }),
    ).toThrow('active embedding model');
  });

  it('exposes the audit and dry-run cleanup through the consolidated MCP admin family', async () => {
    const handler = new ToolHandler(cg);
    const audit = await handler.execute('cartograph_admin', { action: 'embedding-audit' });
    const auditText = audit.content[0]?.text ?? '';
    expect(audit.isError).not.toBe(true);
    expect(auditText).toContain('## Embedding storage audit');
    expect(auditText).toContain(`Active model: ${ACTIVE_MODEL}`);

    const cleanup = await handler.execute('cartograph_admin', { action: 'embedding-cleanup' });
    const cleanupText = cleanup.content[0]?.text ?? '';
    expect(cleanup.isError).not.toBe(true);
    expect(cleanupText).toContain('## Embedding cleanup dry run');
    expect(cleanupText).toContain('No data was changed');
    expect(cg.db.getDb().prepare('SELECT COUNT(*) AS c FROM embedding_store').get()).toEqual({ c: 4 });
  });
});
