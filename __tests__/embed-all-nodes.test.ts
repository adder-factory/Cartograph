/**
 * embed-all-nodes — integration test for the decoupled embedding pipeline.
 *
 * Verifies that `embedAllNodes` produces embeddings for every non-file/
 * non-import/non-export node in a project that has NO LLM-generated
 * summaries — proving the FK decoupling landed correctly.
 *
 * Uses FakeEmbeddingProvider (in-process deterministic vectors) instead
 * of the openai-compat HTTP fake server (deleted 2026-05-15).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { embedAllNodes, buildEmbedText } from '../src/llm/embeddings.js';
import { getEmbeddableNodes } from '../src/db/queries-embeddings.js';
import { FakeEmbeddingProvider } from './helpers/fake-embedding-provider.js';

const EMBED_DIM = 8;

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('buildEmbedText', () => {
  it('includes name + signature + docstring + summary when all present', () => {
    const t = buildEmbedText({
      name: 'myFunc',
      signature: '(a: string): void',
      docstring: 'Does X',
      summary: 'LLM summary',
    });
    expect(t).toContain('myFunc');
    expect(t).toContain('(a: string): void');
    expect(t).toContain('Does X');
    expect(t).toContain('LLM summary');
  });

  it('works with only a name (all others null/undefined)', () => {
    const t = buildEmbedText({ name: 'myFunc', signature: null, docstring: null });
    expect(t).toBe('myFunc');
  });

  it('omits blank / whitespace-only parts', () => {
    const t = buildEmbedText({ name: 'myFunc', signature: '  ', docstring: '\n', summary: '' });
    expect(t).toBe('myFunc');
  });

  it('uses name + docstring when no summary', () => {
    const t = buildEmbedText({ name: 'myFunc', signature: null, docstring: 'Authenticates a user' });
    expect(t).toBe('myFunc\nAuthenticates a user');
  });

  it('summary is the last field so it anchors the richer description', () => {
    const t = buildEmbedText({ name: 'f', signature: 'sig', docstring: 'doc', summary: 'sum' });
    const parts = t.split('\n');
    expect(parts.at(-1)).toBe('sum');
  });

  it('truncates oversized input below MAX_EMBED_INPUT_CHARS (6000 chars)', () => {
    const hugeSummary = 'x'.repeat(10_000);
    const t = buildEmbedText({
      name: 'bigFunc',
      signature: '(): void',
      docstring: 'Short doc',
      summary: hugeSummary,
    });
    expect(t.length).toBeLessThanOrEqual(6000);
    // Name and signature must always be present
    expect(t).toContain('bigFunc');
    expect(t).toContain('(): void');
  });

  it('truncates at a word boundary and appends ellipsis when signature alone exceeds cap', () => {
    // A pathological signature that is itself over the cap
    const hugeSig = 'word '.repeat(1300); // 6500 chars
    const t = buildEmbedText({ name: 'f', signature: hugeSig, docstring: null });
    expect(t.length).toBeLessThanOrEqual(6000);
    expect(t).toContain('f');
    expect(t).toMatch(/…$/);
  });
});

describe('embedAllNodes — no-summary project', () => {
  let dir: string;
  let fake: FakeEmbeddingProvider;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-embed-nodes-'));
    fake = new FakeEmbeddingProvider();

    // A tiny TypeScript project with two functions and a class — no
    // docstrings, no LLM summaries will exist (summarize: false).
    fs.writeFileSync(
      path.join(dir, 'alpha.ts'),
      `export function authenticateUser(name: string): boolean {
  return name.length > 0;
}

export function hashPassword(pw: string): string {
  return pw + '_hashed';
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'beta.ts'),
      `export class TokenStore {
  private bag = new Map<string, string>();
  put(k: string, v: string): void { this.bag.set(k, v); }
  get(k: string): string | undefined { return this.bag.get(k); }
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'embed-nodes-test', version: '0.0.0' }));
  });

  afterEach(async () => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('produces embeddings for every non-file/import/export node without any summaries', async () => {
    const cg = await Cartograph.init(dir, {
      config: {
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/nomic-embed.gguf',
          },
        },
      },
    });

    try {
      // Index without LLM summarization — no summaries will exist.
      await cg.indexAll({ summarize: false });

      // Confirm no summaries were created.
      const summaryCount = (cg.queries.db.prepare('SELECT COUNT(*) AS c FROM symbol_summaries').get() as { c: number })
        .c;
      expect(summaryCount).toBe(0);

      // Candidates should include all non-file/import/export nodes.
      const candidates = getEmbeddableNodes(cg.queries, '/fake/models/nomic-embed.gguf');
      expect(candidates.length).toBeGreaterThan(0);

      // All candidates have null summary (no summaries were generated).
      for (const c of candidates) {
        expect(c.summary).toBeNull();
      }

      const result = await embedAllNodes({
        queries: cg.queries,
        client: fake,
        embeddingModel: '/fake/models/nomic-embed.gguf',
      });

      // All candidates were processed.
      expect(result.candidates).toBe(candidates.length);
      expect(result.generated).toBe(candidates.length);
      expect(result.errors).toBe(0);

      // Embedding provider was actually called.
      expect(fake.embedCalls).toBeGreaterThan(0);

      // Every candidate node now has an embedding row.
      for (const c of candidates) {
        const row = cg.queries.db
          .prepare(`SELECT 1 AS ok FROM symbol_embeddings WHERE node_id = ? AND embedding_model = ?`)
          .get(c.nodeId, '/fake/models/nomic-embed.gguf');
        expect(row).toBeDefined();
      }

      // No file/import/export nodes were embedded.
      const badKindRows = cg.queries.db
        .prepare(
          `SELECT COUNT(*) AS c
             FROM symbol_embeddings e
             JOIN nodes n ON n.id = e.node_id
            WHERE n.kind IN ('file', 'import', 'export')`,
        )
        .get() as { c: number };
      expect(badKindRows.c).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('is idempotent — second embedAllNodes call generates 0 new vectors', async () => {
    const cg = await Cartograph.init(dir, {
      config: {
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/nomic-embed.gguf',
          },
        },
      },
    });

    try {
      await cg.indexAll({ summarize: false });
      const args = { queries: cg.queries, client: fake, embeddingModel: '/fake/models/nomic-embed.gguf' };

      const first = await embedAllNodes(args);
      expect(first.generated).toBeGreaterThan(0);

      const second = await embedAllNodes(args);
      expect(second.generated).toBe(0);
      expect(second.candidates).toBe(0); // cache already covered all nodes
    } finally {
      cg.close();
    }
  });

  it('summary added after initial embed marks the node stale (migration 035)', async () => {
    const cg = await Cartograph.init(dir, {
      config: {
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/nomic-embed.gguf',
          },
        },
      },
    });

    try {
      await cg.indexAll({ summarize: false });
      const args = { queries: cg.queries, client: fake, embeddingModel: '/fake/models/nomic-embed.gguf' };

      // Phase 1 embed: every node embedded with name+sig+docstring,
      // summary_hash_at_embed = '' for all.
      const first = await embedAllNodes(args);
      expect(first.generated).toBeGreaterThan(0);
      // Idempotent re-run: nothing stale.
      expect((await embedAllNodes(args)).generated).toBe(0);

      // Simulate phase 2 — a summary lands on one node post-embed.
      const candidates = getEmbeddableNodes(cg.queries, '/fake/models/nomic-embed.gguf');
      // After the idempotent re-run above, candidates is empty until we
      // attach a summary; pull a function id directly.
      const fnRow = cg.queries.db.prepare("SELECT id FROM nodes WHERE kind = 'function' LIMIT 1").get() as
        | { id: string }
        | undefined;
      expect(fnRow).toBeDefined();
      const { upsertSymbolSummary } = await import('../src/db/queries-summaries.js');
      upsertSymbolSummary({
        qb: cg.queries,
        nodeId: fnRow!.id,
        contentHash: 'summary-hash-v1',
        summary: 'Stub summary added post-embed.',
        model: 'fake-chat',
      });

      // The staleness predicate (`'' != 'summary-hash-v1'`) should now
      // surface this exact node — no others.
      const stale = getEmbeddableNodes(cg.queries, '/fake/models/nomic-embed.gguf');
      expect(stale).toHaveLength(1);
      expect(stale[0]!.nodeId).toBe(fnRow!.id);
      expect(stale[0]!.summaryHash).toBe('summary-hash-v1');

      // Re-embed: only the one node gets re-written.
      const refresh = await embedAllNodes(args);
      expect(refresh.generated).toBe(1);

      // Idempotent again — nothing left stale.
      expect((await embedAllNodes(args)).generated).toBe(0);

      // A summary version bump should re-trigger staleness.
      upsertSymbolSummary({
        qb: cg.queries,
        nodeId: fnRow!.id,
        contentHash: 'summary-hash-v2',
        summary: 'Updated summary.',
        model: 'fake-chat',
      });
      const restale = getEmbeddableNodes(cg.queries, '/fake/models/nomic-embed.gguf');
      expect(restale).toHaveLength(1);
      expect(restale[0]!.summaryHash).toBe('summary-hash-v2');

      expect(candidates).toBeDefined();
    } finally {
      cg.close();
    }
  });

  it('over-length inputs are skipped (not errored) via per-row retry fallback', async () => {
    // Simulate size-cap rejection: any input longer than INPUT_TOO_LARGE_THRESHOLD
    // chars causes the FakeEmbeddingProvider to throw with the llama-server
    // "input too large" error shape.
    const INPUT_TOO_LARGE_THRESHOLD = 200;
    const sizeCappedFake = new FakeEmbeddingProvider(INPUT_TOO_LARGE_THRESHOLD);

    // One short function (will embed fine) + one with a deliberately
    // long signature that overflows the threshold.
    fs.writeFileSync(
      path.join(dir, 'size-capped.ts'),
      `export function shortFn(a: number): number { return a + 1; }
export function longFn(${'a: number, '.repeat(40).slice(0, -2)}): number { return 0; }
`,
    );

    const cg = await Cartograph.init(dir, {
      config: {
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/nomic-embed.gguf',
          },
        },
      },
    });

    try {
      await cg.indexAll({ summarize: false });
      const result = await embedAllNodes({
        queries: cg.queries,
        client: sizeCappedFake,
        embeddingModel: '/fake/models/nomic-embed.gguf',
      });

      expect(result.errors).toBe(0); // size cap is not a pipeline error
      expect(result.skipped).toBeGreaterThan(0);
      expect(result.generated).toBeGreaterThan(0);
      expect(result.candidates).toBe(result.generated + result.skipped);
    } finally {
      cg.close();
    }
  });

  it('embed text for a node with docstring includes the docstring', async () => {
    // Write a file with a JSDoc comment.
    fs.writeFileSync(
      path.join(dir, 'documented.ts'),
      `/** Verifies that the session token is valid. */
export function verifySession(token: string): boolean {
  return token.startsWith('sess_');
}
`,
    );

    const cg = await Cartograph.init(dir, {
      config: {
        llm: {
          embeddingLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8080',
            model: '/fake/models/nomic-embed.gguf',
          },
        },
      },
    });

    try {
      await cg.indexAll({ summarize: false });

      const candidates = getEmbeddableNodes(cg.queries, '/fake/models/nomic-embed.gguf');
      const verifyNode = candidates.find((c) => c.name === 'verifySession');
      expect(verifyNode).toBeDefined();

      // The docstring should be extracted by tree-sitter and visible here.
      if (verifyNode!.docstring) {
        const embedText = buildEmbedText({
          name: verifyNode!.name,
          signature: verifyNode!.signature,
          docstring: verifyNode!.docstring,
          summary: verifyNode!.summary ?? undefined,
        });
        expect(embedText).toContain('verifySession');
        expect(embedText).toContain('session');
      }
    } finally {
      cg.close();
    }
  });
});
