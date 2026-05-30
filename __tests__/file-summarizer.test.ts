/**
 * Tests for the file-level summary tier:
 *   - buildFileSummaryUserPrompt  (pure helper)
 *   - summarizeAllFiles           (integration: cache-hit, generation)
 *   - pruneOrphanFileSummaries    (GC: removes rows whose file_path is not in files)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { buildFileSummaryUserPrompt, summarizeAllFiles, type FileGroupItem } from '../src/llm/file-summarizer.js';
import { getFileSummary, upsertFileSummary, pruneOrphanFileSummaries } from '../src/db/queries-file-summaries.js';
import { createFakeLlmClient } from './helpers/fake-chat-client.js';

// ---------------------------------------------------------------------------
// Shared seed helpers
// ---------------------------------------------------------------------------

function seedFileRow(db: DatabaseConnection, fpath: string): void {
  db.getDb()
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'ch-' + fpath, 'typescript', 0, 0, 0);
}

function addNode(
  db: DatabaseConnection,
  qb: QueryBuilder,
  id: string,
  name: string,
  kind: string,
  filePath: string,
): void {
  seedFileRow(db, filePath);
  qb.insertNode({
    id,
    kind,
    name,
    qualifiedName: name,
    filePath,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  });
}

function addSymbolSummary(db: DatabaseConnection, nodeId: string, summary: string): void {
  db.getDb()
    .prepare(
      `INSERT OR REPLACE INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(nodeId, 'sch-' + nodeId, summary, 'test-model', Date.now());
}

/**
 * Plant an orphan `file_summaries` row directly — bypassing the
 * `upsertFileSummary` FK-EXISTS guard — so the prune tests have a row
 * whose `file_path` has no parent in `files`. FK enforcement is toggled
 * off around the raw INSERT (the row itself violates the cascade FK).
 * This is exactly the situation `pruneOrphanFileSummaries` exists to
 * clean: a row written on a connection that had FK enforcement off.
 */
function plantOrphanFileSummary(db: DatabaseConnection, filePath: string): void {
  const rawDb = db.getDb();
  rawDb.exec('PRAGMA foreign_keys = OFF');
  rawDb
    .prepare(
      `INSERT INTO file_summaries (file_path, summary, content_hash, model, generated_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(filePath, 'orphan summary', 'orphanhash', 'fake-model', Date.now());
  rawDb.exec('PRAGMA foreign_keys = ON');
}

// ---------------------------------------------------------------------------
// 1. buildFileSummaryUserPrompt — pure helper tests
// ---------------------------------------------------------------------------

describe('buildFileSummaryUserPrompt', () => {
  it('includes the File: <path> header line', () => {
    const group = {
      filePath: 'src/auth/token.ts',
      items: [{ name: 'createToken', kind: 'function', summary: 'Creates a JWT token.' }],
    };
    const out = buildFileSummaryUserPrompt(group, '');
    expect(out).toContain('File: src/auth/token.ts');
  });

  it('includes each symbol as "- name (kind): summary" row', () => {
    const group = {
      filePath: 'src/util/helpers.ts',
      items: [
        { name: 'formatDate', kind: 'function', summary: 'Formats a date object.' },
        { name: 'clamp', kind: 'function', summary: 'Clamps a number to a range.' },
        { name: 'MAX_SIZE', kind: 'constant', summary: 'The maximum allowed size.' },
      ],
    };
    const out = buildFileSummaryUserPrompt(group, '');
    expect(out).toContain('- formatDate (function): Formats a date object.');
    expect(out).toContain('- clamp (function): Clamps a number to a range.');
    expect(out).toContain('- MAX_SIZE (constant): The maximum allowed size.');
  });

  it('ends with "File summary:" as the prompt continuation anchor', () => {
    const group = {
      filePath: 'src/db/queries.ts',
      items: [{ name: 'QueryBuilder', kind: 'class', summary: 'Wraps prepared statements.' }],
    };
    const out = buildFileSummaryUserPrompt(group, '');
    expect(out.trimEnd()).toMatch(/File summary:$/);
  });

  it('includes "... and N more" overflow line when given >50 items', () => {
    // Build 60 items — the cap is MAX_SYMBOLS_IN_PROMPT = 50.
    const total = 60;
    const items: FileGroupItem[] = Array.from({ length: total }, (_, i) => ({
      name: `sym${i}`,
      kind: 'function',
      summary: `Does thing ${i}.`,
    }));
    const group = { filePath: 'src/big/file.ts', items };
    const out = buildFileSummaryUserPrompt(group, '');

    // The first 50 symbols must appear.
    expect(out).toContain('- sym0 (function): Does thing 0.');
    expect(out).toContain('- sym49 (function): Does thing 49.');

    // Symbol 51 must NOT appear as a regular row.
    expect(out).not.toContain('- sym50 (function)');

    // The overflow line must report the remaining 10.
    expect(out).toContain('- ... and 10 more');
  });

  it('does NOT include an overflow line when items are exactly at the cap', () => {
    const items: FileGroupItem[] = Array.from({ length: 50 }, (_, i) => ({
      name: `fn${i}`,
      kind: 'function',
      summary: `Summary ${i}.`,
    }));
    const group = { filePath: 'src/exact/fifty.ts', items };
    const out = buildFileSummaryUserPrompt(group, '');
    expect(out).not.toContain('... and');
  });

  // Handoff #9 sub-b: file-summary prose hallucinated acronym
  // expansions (MCP -> Microcontroller Platform / Minecraft Code
  // Platform / etc.). The project-identity anchor grounds the model
  // against the project's own description so it can't fabricate.
  it('prepends the "## Project Overview" anchor block when anchorText is non-empty', () => {
    const group = {
      filePath: 'src/mcp/tools/find.ts',
      items: [{ name: 'handleFind', kind: 'function', summary: 'Dispatches the find call.' }],
    };
    const anchor = 'Cartograph is a local-first code intelligence system.\n\nMCP = Model Context Protocol.';
    const out = buildFileSummaryUserPrompt(group, anchor);
    expect(out).toContain('## Project Overview');
    expect(out).toContain('Cartograph is a local-first code intelligence system');
    expect(out).toContain('MCP = Model Context Protocol');
    // The anchor must come BEFORE the file-specific section.
    const anchorIdx = out.indexOf('## Project Overview');
    const fileIdx = out.indexOf('File: src/mcp/tools/find.ts');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(fileIdx).toBeGreaterThan(anchorIdx);
  });

  it('omits the "## Project Overview" anchor block when anchorText is empty', () => {
    const group = {
      filePath: 'src/util.ts',
      items: [{ name: 'helper', kind: 'function', summary: 'Helps.' }],
    };
    const out = buildFileSummaryUserPrompt(group, '');
    expect(out).not.toContain('## Project Overview');
    // The bare-File: header is still the first content line.
    expect(out.startsWith('File: src/util.ts')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2–3. summarizeAllFiles — integration: generation + cache-hit
// ---------------------------------------------------------------------------

describe('summarizeAllFiles', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-file-summarizer-'));
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('generates a file_summaries row on the first pass', async () => {
    const filePath = 'src/auth/token.ts';
    addNode(db, qb, 'n:1', 'createToken', 'function', filePath);
    addNode(db, qb, 'n:2', 'verifyToken', 'function', filePath);
    addSymbolSummary(db, 'n:1', 'Creates a signed JWT token for a user.');
    addSymbolSummary(db, 'n:2', 'Verifies a token and returns whether it is valid.');

    const stubText = 'This file defines the JWT token lifecycle for auth.';
    const client = createFakeLlmClient(() => stubText);

    const result = await summarizeAllFiles({
      queries: qb,
      client,
      modelLabel: 'fake-model',
    });

    expect(result.candidates).toBe(1);
    expect(result.generated).toBe(1);
    expect(result.cacheHits).toBe(0);
    expect(result.errors).toBe(0);

    const stored = getFileSummary(qb, filePath);
    expect(stored).not.toBeNull();
    // The stub text is short and well-formed — tidyLlmEnding + truncateAtBoundary pass it through.
    expect(stored!.summary).toBe(stubText);
    expect(stored!.model).toBe('fake-model');
  });

  it('reports a cacheHit on the second pass when symbol summaries are unchanged', async () => {
    const filePath = 'src/util/helpers.ts';
    addNode(db, qb, 'n:3', 'formatDate', 'function', filePath);
    addSymbolSummary(db, 'n:3', 'Formats a Date into YYYY-MM-DD string.');

    const stubText = 'Provides date formatting utilities.';
    let callCount = 0;
    const client = createFakeLlmClient(() => {
      callCount++;
      return stubText;
    });

    // First pass — should generate.
    const first = await summarizeAllFiles({ queries: qb, client, modelLabel: 'fake-model' });
    expect(first.generated).toBe(1);
    expect(first.cacheHits).toBe(0);
    expect(callCount).toBe(1);

    // Second pass — nothing changed, must be a cache hit.
    const second = await summarizeAllFiles({ queries: qb, client, modelLabel: 'fake-model' });
    expect(second.candidates).toBe(1);
    expect(second.cacheHits).toBe(1);
    expect(second.generated).toBe(0);
    expect(second.errors).toBe(0);
    // LLM must NOT have been called again.
    expect(callCount).toBe(1);
  });

  // Handoff #9 cache-invalidation contract: a CLAUDE.md edit changes
  // the project-identity anchor, which must invalidate cached file
  // summaries — otherwise the post-edit anchor never reaches the LLM
  // for previously-summarised files. Mirrors the dir-summarizer's
  // same contract (hashDirContent folds in anchorText too).
  it('regenerates when the anchor text changes even if symbol summaries are identical', async () => {
    const filePath = 'src/mcp/tools/find.ts';
    addNode(db, qb, 'n:anchor1', 'handleFind', 'function', filePath);
    addSymbolSummary(db, 'n:anchor1', 'Dispatches the find call.');

    const { _resetProjectAnchorCache } = await import('../src/llm/dir-summarizer.js');

    let callCount = 0;
    const client = createFakeLlmClient(() => {
      callCount++;
      return `Anchored summary ${callCount}.`;
    });

    // Two temp project dirs with different CLAUDE.md anchors. The
    // try/finally guarantees both are cleaned up even when an `expect`
    // assertion fails mid-pass (otherwise OS tmpdir grows).
    const projA = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-a-'));
    const projB = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-anchor-b-'));
    try {
      fs.writeFileSync(
        path.join(projA, 'CLAUDE.md'),
        '# Project\n\n## Project Overview\n\nInitial description: tool A.\n',
      );
      fs.writeFileSync(
        path.join(projB, 'CLAUDE.md'),
        '# Project\n\n## Project Overview\n\nRevised description: tool B with new acronym definitions.\n',
      );

      // First pass — anchor from projA.
      const first = await summarizeAllFiles({
        projectRoot: projA,
        queries: qb,
        client,
        modelLabel: 'fake-model',
      });
      expect(first.generated).toBe(1);
      expect(callCount).toBe(1);

      // Reset the per-projectRoot anchor cache so the second pass re-reads
      // the (different) CLAUDE.md file from a fresh projectRoot.
      _resetProjectAnchorCache();

      // Second pass with the DIFFERENT anchor — must produce a cache MISS.
      const second = await summarizeAllFiles({
        projectRoot: projB,
        queries: qb,
        client,
        modelLabel: 'fake-model',
      });
      expect(second.generated).toBe(1);
      expect(second.cacheHits).toBe(0);
      expect(callCount).toBe(2);
    } finally {
      if (fs.existsSync(projA)) fs.rmSync(projA, { recursive: true, force: true });
      if (fs.existsSync(projB)) fs.rmSync(projB, { recursive: true, force: true });
    }
  });

  it('regenerates when the model label changes even if symbol summaries are identical', async () => {
    const filePath = 'src/db/queries.ts';
    addNode(db, qb, 'n:4', 'QueryBuilder', 'class', filePath);
    addSymbolSummary(db, 'n:4', 'Wraps SQLite prepared statements.');

    let callCount = 0;
    const client = createFakeLlmClient(() => {
      callCount++;
      return `Summary from model ${callCount}.`;
    });

    await summarizeAllFiles({ queries: qb, client, modelLabel: 'model-v1' });
    expect(callCount).toBe(1);

    // Different modelLabel → not a cache hit.
    const second = await summarizeAllFiles({ queries: qb, client, modelLabel: 'model-v2' });
    expect(second.generated).toBe(1);
    expect(second.cacheHits).toBe(0);
    expect(callCount).toBe(2);
  });

  it('handles multiple files with independent cache state', async () => {
    const fileA = 'src/a/module.ts';
    const fileB = 'src/b/module.ts';

    addNode(db, qb, 'n:a1', 'doA', 'function', fileA);
    addNode(db, qb, 'n:b1', 'doB', 'function', fileB);
    addSymbolSummary(db, 'n:a1', 'Handles the A-path logic.');
    addSymbolSummary(db, 'n:b1', 'Handles the B-path logic.');

    let callCount = 0;
    const client = createFakeLlmClient(() => {
      callCount++;
      return `File summary ${callCount}.`;
    });

    // First pass: two files, two generations.
    const first = await summarizeAllFiles({ queries: qb, client, modelLabel: 'fake-model' });
    expect(first.candidates).toBe(2);
    expect(first.generated).toBe(2);
    expect(callCount).toBe(2);

    // Second pass: both files are cache hits.
    const second = await summarizeAllFiles({ queries: qb, client, modelLabel: 'fake-model' });
    expect(second.cacheHits).toBe(2);
    expect(second.generated).toBe(0);
    expect(callCount).toBe(2); // no new calls
  });

  it('candidate count is 0 when no symbol summaries exist', async () => {
    // A file with nodes but no symbol_summaries rows → getSummarisedSymbolsByDir returns nothing.
    const filePath = 'src/empty/no-summaries.ts';
    addNode(db, qb, 'n:e1', 'orphanFn', 'function', filePath);
    // Deliberately NO addSymbolSummary call.

    const client = createFakeLlmClient(() => 'Should not be called.');
    const result = await summarizeAllFiles({ queries: qb, client, modelLabel: 'fake-model' });
    expect(result.candidates).toBe(0);
    expect(result.generated).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. pruneOrphanFileSummaries
// ---------------------------------------------------------------------------

describe('pruneOrphanFileSummaries', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-prune-file-summaries-'));
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('deletes a file_summaries row whose file_path has no matching files row', () => {
    // Plant an orphan summary for a path that is NOT in the files table.
    const orphanPath = 'src/deleted/gone.ts';
    plantOrphanFileSummary(db, orphanPath);

    // Verify the orphan row landed.
    const before = db.getDb().prepare('SELECT COUNT(*) AS c FROM file_summaries').get() as { c: number };
    expect(before.c).toBe(1);

    // Prune should remove the orphan.
    const { fileSummariesDeleted } = pruneOrphanFileSummaries(qb);
    expect(fileSummariesDeleted).toBe(1);

    // The row must be gone.
    expect(getFileSummary(qb, orphanPath)).toBeNull();
  });

  it('preserves file_summaries rows whose file_path IS in the files table', () => {
    const livePath = 'src/live/present.ts';
    // Seed a real files row.
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(livePath, 'ch-live', 'typescript', 0, 0, 0);

    upsertFileSummary({
      qb,
      filePath: livePath,
      contentHash: 'aabbccdd',
      summary: 'Still alive.',
      model: 'fake-model',
    });

    const { fileSummariesDeleted } = pruneOrphanFileSummaries(qb);
    expect(fileSummariesDeleted).toBe(0);

    // Row must still exist.
    expect(getFileSummary(qb, livePath)).not.toBeNull();
  });

  it('returns 0 when there are no file_summaries rows at all', () => {
    const { fileSummariesDeleted } = pruneOrphanFileSummaries(qb);
    expect(fileSummariesDeleted).toBe(0);
  });

  it('upsertFileSummary is FK-safe: no-ops and returns false when the parent files row is absent', () => {
    const missingPath = 'src/never/indexed.ts';
    // No `files` row for this path — the FK-EXISTS guard must reject the write.
    const wrote = upsertFileSummary({
      qb,
      filePath: missingPath,
      contentHash: 'cc',
      summary: 'Should not persist.',
      model: 'fake-model',
    });
    expect(wrote).toBe(false);
    expect(getFileSummary(qb, missingPath)).toBeNull();

    // Once the parent files row exists, the same call writes and returns true.
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(missingPath, 'ch', 'typescript', 0, 0, 0);
    const wrote2 = upsertFileSummary({
      qb,
      filePath: missingPath,
      contentHash: 'cc',
      summary: 'Now it persists.',
      model: 'fake-model',
    });
    expect(wrote2).toBe(true);
    expect(getFileSummary(qb, missingPath)?.summary).toBe('Now it persists.');
  });

  it('selectively deletes orphans while preserving live rows', () => {
    const livePath = 'src/kept/file.ts';
    const orphanPath = 'src/gone/file.ts';

    // Seed a real files row for the live path only.
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(livePath, 'ch-kept', 'typescript', 0, 0, 0);

    upsertFileSummary({ qb, filePath: livePath, contentHash: 'aa', summary: 'Kept.', model: 'fake-model' });
    plantOrphanFileSummary(db, orphanPath);

    const { fileSummariesDeleted } = pruneOrphanFileSummaries(qb);
    expect(fileSummariesDeleted).toBe(1);

    expect(getFileSummary(qb, livePath)).not.toBeNull();
    expect(getFileSummary(qb, orphanPath)).toBeNull();
  });
});
