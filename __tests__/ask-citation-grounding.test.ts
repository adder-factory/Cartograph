/**
 * Unit tests for the citation-grounding logic in cartograph_ask.
 *
 * Tests four behaviours introduced in Tasks #31 and #32:
 *   1. Distribution-path filtering — when both a source and a dist hit
 *      exist, the grounder picks the source file.
 *   2. All-dist fallback — when the only match is in a dist path, the
 *      citation is recorded with `distPathMatch: true` so the renderer
 *      uses a `?` label instead of `✓`.
 *   3. Field / parameter verification via the secondary `getNodesByName`
 *      pass — a real `parameter` node must not land in the unverified list.
 *   4. Genuine unverified — a name that appears nowhere in the index stays
 *      in the unverified list.
 *
 * Tests drive `groundCitations` and `isDistributionPath` directly (both
 * are now exported). A minimal mock of `Cartograph` — just `{ queries }` —
 * is sufficient because `groundCitations` only ever accesses `cg.queries`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { runMigrations } from '../src/db/migrations.js';
import {
  groundCitations,
  isDistributionPath,
  formatCitationCounter,
  buildCitationReport,
  formatRerankTag,
  buildAskOutput,
} from '../src/features/ask/citations.js';
import type { RerankOutcome } from '../src/cartograph-llm-service.js';
import {
  extractQuestionEntities,
  rerankByQuestionEntities,
  buildEntityMismatchWarning,
  buildEntityAnchorSystemPrompt,
} from '../src/llm/ask.js';
import type { Node, SearchResult } from '../src/types.js';
import type Cartograph from '../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(overrides: Partial<Node> & { id: string; name: string; kind: Node['kind'] }): Node {
  return {
    qualifiedName: overrides.qualifiedName ?? overrides.name,
    filePath: `src/${overrides.name}.ts`,
    language: 'typescript',
    startLine: 1,
    endLine: 10,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

/** Seed `files` rows for each distinct filePath so the FK
 *  nodes.file_path → files(path) (migration 056) doesn't reject the insert. */
function seedFilesForNodes(qb: QueryBuilder, nodes: Node[]): void {
  const stmt = qb.db.prepare(
    `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
     VALUES (?, 'h', 'typescript', 0, 0, 0)`,
  );
  const seen = new Set<string>();
  for (const n of nodes) {
    if (n.filePath && !seen.has(n.filePath)) {
      seen.add(n.filePath);
      stmt.run(n.filePath);
    }
  }
}

/** Wrapper around q.insertNodes that seeds the parent files() rows first. */
function insertNodesWithFiles(qb: QueryBuilder, nodes: Node[]): void {
  seedFilesForNodes(qb, nodes);
  qb.insertNodes(nodes);
}

/** Minimal Cartograph stub — groundCitations only touches `cg.queries`. */
function makeCg(q: QueryBuilder): Pick<Cartograph, 'queries'> {
  return { queries: q } as unknown as Cartograph;
}

// ---------------------------------------------------------------------------
// Fixture setup
// ---------------------------------------------------------------------------

let dir: string;
let db: DatabaseConnection;
let q: QueryBuilder;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ask-citation-'));
  db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  runMigrations(db.getDb());
  q = new QueryBuilder(db.getDb());
});

afterEach(() => {
  db.close();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// isDistributionPath unit tests
// ---------------------------------------------------------------------------

describe('isDistributionPath', () => {
  it('returns true for publish.js at root', () => {
    expect(isDistributionPath('publish.js')).toBe(true);
  });

  it('returns true for publish.js in a subdirectory', () => {
    expect(isDistributionPath('scripts/publish.js')).toBe(true);
  });

  it('returns true for paths under dist/', () => {
    expect(isDistributionPath('dist/index.js')).toBe(true);
    expect(isDistributionPath('dist/cjs/ask.js')).toBe(true);
  });

  it('returns true for paths under build/', () => {
    expect(isDistributionPath('build/ask.js')).toBe(true);
  });

  it('returns true for paths under bin/ at the project root', () => {
    expect(isDistributionPath('bin/cli.js')).toBe(true);
  });

  it('returns false for src/bin/ — canonical CLI source layout', () => {
    // cartograph itself keeps `src/bin/cartograph.ts` as the CLI entry
    // point; that's source, not a build artifact. The bin/ pattern
    // must anchor to the project root only.
    expect(isDistributionPath('src/bin/cartograph.ts')).toBe(false);
    expect(isDistributionPath('packages/foo/src/bin/cli.ts')).toBe(false);
  });

  it('returns true for paths under out/', () => {
    expect(isDistributionPath('out/ask.js')).toBe(true);
  });

  it('returns true for .min.js files', () => {
    expect(isDistributionPath('vendor/lib.min.js')).toBe(true);
  });

  it('returns true for .bundle.js files', () => {
    expect(isDistributionPath('public/app.bundle.js')).toBe(true);
  });

  it('returns false for normal source paths', () => {
    expect(isDistributionPath('src/mcp/tools/ask.ts')).toBe(false);
    expect(isDistributionPath('src/utils.ts')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groundCitations — Task #31: distribution-path filtering
// ---------------------------------------------------------------------------

describe('groundCitations — distribution-path filtering (#31)', () => {
  it('prefers the source-file hit when both src/ and publish.js match', () => {
    // Two nodes with the same name: one in source, one in publish.js.
    insertNodesWithFiles(q, [
      makeNode({
        id: 'src-ask',
        name: 'ask',
        kind: 'function',
        filePath: 'src/mcp/tools/ask.ts',
        qualifiedName: 'src/mcp/tools/ask.ts::ask',
      }),
      makeNode({
        id: 'dist-ask',
        name: 'ask',
        kind: 'function',
        filePath: 'publish.js',
        qualifiedName: 'publish.js::ask',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `ask` function handles requests.');

    // Must be verified (has a node).
    const askCite = cited.find((c) => c.name === 'ask');
    expect(askCite).toBeDefined();
    expect(askCite?.node).toBeDefined();
    expect(askCite?.node?.filePath).toBe('src/mcp/tools/ask.ts');
    // Must NOT be flagged as a dist-path match.
    expect(askCite?.distPathMatch).toBeFalsy();
  });

  it('also prefers src hit when dist path is under dist/', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'src-run',
        name: 'run',
        kind: 'function',
        filePath: 'src/runner.ts',
        qualifiedName: 'src/runner.ts::run',
      }),
      makeNode({
        id: 'dist-run',
        name: 'run',
        kind: 'function',
        filePath: 'dist/runner.js',
        qualifiedName: 'dist/runner.js::run',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'Call `run` to start.');
    const runCite = cited.find((c) => c.name === 'run');
    expect(runCite?.node?.filePath).toBe('src/runner.ts');
    expect(runCite?.distPathMatch).toBeFalsy();
  });
});

// ---------------------------------------------------------------------------
// groundCitations — Task #31: all-dist fallback
// ---------------------------------------------------------------------------

describe('groundCitations — all-dist fallback (#31)', () => {
  it('records the citation with distPathMatch=true when only a publish.js hit exists', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'pub-ask',
        name: 'ask',
        kind: 'function',
        filePath: 'publish.js',
        qualifiedName: 'publish.js::ask',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `ask` function is here.');

    const askCite = cited.find((c) => c.name === 'ask');
    expect(askCite).toBeDefined();
    // Still verified (has a node).
    expect(askCite?.node).toBeDefined();
    // But flagged so the renderer can use the softer `?` label.
    expect(askCite?.distPathMatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groundCitations — F#21: PascalCase production-path preference
// ---------------------------------------------------------------------------

describe('groundCitations — production-path preference for PascalCase names', () => {
  it('picks the production JoinHandle over the test-mock JoinHandle', () => {
    // Real-world repro from the tokio bug-hunt: `tokio/src/runtime/task/join.rs`
    // (production) and `tokio/src/fs/mocks.rs` (test mock) both define
    // `JoinHandle`. The verifier previously picked the mock because the
    // `productionOnly` filter only fired for parameter-shaped names.
    insertNodesWithFiles(q, [
      makeNode({
        id: 'prod-jh',
        name: 'JoinHandle',
        kind: 'struct',
        filePath: 'src/runtime/task/join.rs',
        qualifiedName: 'src/runtime/task/join.rs::JoinHandle',
      }),
      makeNode({
        id: 'mock-jh',
        name: 'JoinHandle',
        kind: 'struct',
        filePath: 'src/fs/mocks.rs',
        qualifiedName: 'src/fs/mocks.rs::JoinHandle',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `JoinHandle` type wraps a spawned task.');

    const jhCite = cited.find((c) => c.name === 'JoinHandle');
    expect(jhCite?.node?.filePath).toBe('src/runtime/task/join.rs');
    expect(jhCite?.weakNonProdMatch).toBeFalsy();
  });

  it('flags weakNonProdMatch for PascalCase when the only hit is non-production', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'mock-only-jh',
        name: 'JoinHandle',
        kind: 'struct',
        filePath: 'src/fs/mocks.rs',
        qualifiedName: 'src/fs/mocks.rs::JoinHandle',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `JoinHandle` type is defined here.');

    const jhCite = cited.find((c) => c.name === 'JoinHandle');
    expect(jhCite?.node?.filePath).toBe('src/fs/mocks.rs');
    // Renderer should print `?` instead of `✓` since no production
    // candidate exists — the entire top-5 was non-production.
    expect(jhCite?.weakNonProdMatch).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// groundCitations — Task #32: field / parameter verification
// ---------------------------------------------------------------------------

describe('groundCitations — field/parameter verification (#32)', () => {
  it('verifies a parameter-kind node via the secondary pass', () => {
    // useAskModel is a parameter on `chat` — it won't surface via the
    // primary FTS/LIKE pipeline, but getNodesByName finds it.
    insertNodesWithFiles(q, [
      makeNode({
        id: 'param-useAskModel',
        name: 'useAskModel',
        kind: 'parameter',
        filePath: 'src/llm/client.ts',
        startLine: 108,
        endLine: 108,
        qualifiedName: 'src/llm/client.ts::LlmClient.chat.useAskModel',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'Pass `useAskModel` to route to the ask model.');

    const cite = cited.find((c) => c.name === 'useAskModel');
    expect(cite).toBeDefined();
    // Must be in the verified bucket (has node).
    expect(cite?.node).toBeDefined();
    expect(cite?.node?.filePath).toBe('src/llm/client.ts');
    expect(cite?.node?.startLine).toBe(108);
    expect(cite?.node?.kind).toBe('parameter');
    // parentSymbol extracted from qualifiedName: "LlmClient.chat" → "chat"
    // (best-effort; the last dot-segment before the member name).
    expect(cite?.node?.parentSymbol).toBeDefined();
  });

  it('verifies a field-kind node via the secondary pass', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'field-summaryBatchSize',
        name: 'summaryBatchSize',
        kind: 'field',
        filePath: 'src/llm/config.ts',
        startLine: 42,
        endLine: 42,
        qualifiedName: 'src/llm/config.ts::ChatProviderConfig.summaryBatchSize',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'Use `summaryBatchSize` to tune batching.');

    const cite = cited.find((c) => c.name === 'summaryBatchSize');
    expect(cite).toBeDefined();
    expect(cite?.node).toBeDefined();
    expect(cite?.node?.kind).toBe('field');
    expect(cite?.node?.filePath).toBe('src/llm/config.ts');
  });
});

// ---------------------------------------------------------------------------
// groundCitations — Task #43: import / file nodes never ground a citation
// ---------------------------------------------------------------------------

describe('groundCitations — import/file nodes are not definitions (#43)', () => {
  it('does not verify a cite against an `import` node when no real definition exists', () => {
    // An `import { helper }` node carries the name `helper` but does
    // NOT define it. Grounding a cite to it would mis-attribute the
    // citation to a re-export shell — it must stay unverified.
    insertNodesWithFiles(q, [
      makeNode({
        id: 'import-helper',
        name: 'helper',
        kind: 'import',
        filePath: 'src/consumer.ts',
        startLine: 1,
        endLine: 1,
        qualifiedName: 'src/consumer.ts::helper',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `helper` does the work.');
    const cite = cited.find((c) => c.name === 'helper');
    expect(cite).toBeDefined();
    // No real definition node — the import hit must be ignored.
    expect(cite?.node).toBeUndefined();
  });

  it('grounds the real definition, not the import, when both exist', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'import-doThing',
        name: 'doThing',
        kind: 'import',
        filePath: 'src/consumer.ts',
        startLine: 1,
        endLine: 1,
      }),
      makeNode({
        id: 'fn-doThing',
        name: 'doThing',
        kind: 'function',
        filePath: 'src/impl.ts',
        startLine: 20,
        endLine: 30,
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'Call `doThing` to run it.');
    const cite = cited.find((c) => c.name === 'doThing');
    expect(cite).toBeDefined();
    expect(cite?.node).toBeDefined();
    // The resolved node must be the function definition, not the import.
    expect(cite?.node?.kind).toBe('function');
    expect(cite?.node?.filePath).toBe('src/impl.ts');
  });
});

// ---------------------------------------------------------------------------
// groundCitations — Task #32: genuine unverified
// ---------------------------------------------------------------------------

describe('groundCitations — genuine unverified', () => {
  it('leaves a completely unknown name in the unverified bucket', () => {
    // Insert an unrelated node so the DB is non-empty.
    insertNodesWithFiles(q, [
      makeNode({
        id: 'n1',
        name: 'realFunction',
        kind: 'function',
        filePath: 'src/real.ts',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'This answer mentions `definitelyDoesNotExist`.');

    const cite = cited.find((c) => c.name === 'definitelyDoesNotExist');
    expect(cite).toBeDefined();
    // No node — should land in unverified.
    expect(cite?.node).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// groundCitations — language literals are not citations
// ---------------------------------------------------------------------------

describe('groundCitations — language literals', () => {
  it('does not flag `null` or other language literals as unverified mentions', () => {
    // Regression (2026-05-15 tool-sweep): an LLM answer routinely wraps
    // language literals in backticks ("the function returns `null`").
    // The citation verifier treated every backtick token as a symbol,
    // so `null` landed in the "⚠ Unverified mentions" list — noise.
    insertNodesWithFiles(q, [
      makeNode({ id: 'n1', name: 'inferRoleOnDemand', kind: 'function', filePath: 'src/role.ts' }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(
      cg as Cartograph,
      'The function `inferRoleOnDemand` returns `null` when the score is below ' +
        'the floor; callers also see `undefined` and a `true` / `false` flag, ' +
        'and Python paths return `None`.',
    );

    // The genuine symbol is still verified.
    expect(cited.find((c) => c.name === 'inferRoleOnDemand')?.node).toBeDefined();
    // Language literals are filtered before extraction — they never
    // appear in the cited list at all, neither verified nor unverified.
    for (const lit of ['null', 'undefined', 'true', 'false', 'None']) {
      expect(cited.some((c) => c.name === lit)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// groundCitations — signature-token fallback (the `via` parameter gap)
// ---------------------------------------------------------------------------

describe('groundCitations — signature-token fallback', () => {
  it('classifies a parameter found in a signature as real code, not an unverified mention', () => {
    // Regression (2026-05-15 tool-sweep): cartograph indexes only
    // top-level symbols as nodes — function parameters / destructured
    // locals never become nodes. `via` (a real parameter of
    // inferRoleOnDemand) therefore failed both grounding passes and
    // landed in the "⚠ Unverified mentions — could be hallucinated"
    // bucket. The tertiary pass recognises it via the owner's signature.
    insertNodesWithFiles(q, [
      makeNode({
        id: 'fn-infer',
        name: 'inferRoleOnDemand',
        kind: 'function',
        filePath: 'src/mcp/tools/role.ts',
        startLine: 170,
        endLine: 195,
        signature: '(args: { nodeId: string; via: RoleVia }): InferRoleResult | null',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(
      cg as Cartograph,
      'The `inferRoleOnDemand` function returns null unless `via` selects the head path.',
    );

    // The function itself is a verified node.
    expect(cited.find((c) => c.name === 'inferRoleOnDemand')?.node).toBeDefined();

    // `via` is not its own node, but appears in a signature — it must be
    // a signatureOwner match, NOT an unverified/suspect mention.
    const viaCite = cited.find((c) => c.name === 'via');
    expect(viaCite).toBeDefined();
    expect(viaCite?.node).toBeUndefined();
    expect(viaCite?.signatureOwner).toBeDefined();
    expect(viaCite?.signatureOwner?.name).toBe('inferRoleOnDemand');
    expect(viaCite?.signatureOwner?.filePath).toBe('src/mcp/tools/role.ts');
  });

  it('still flags an identifier absent from every node and signature as unverified', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'fn-real',
        name: 'realFunction',
        kind: 'function',
        filePath: 'src/real.ts',
        signature: '(count: number): void',
      }),
    ]);

    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'It delegates to `totallyMadeUpSymbol` for the heavy lifting.');

    const cite = cited.find((c) => c.name === 'totallyMadeUpSymbol');
    expect(cite).toBeDefined();
    expect(cite?.node).toBeUndefined();
    expect(cite?.signatureOwner).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// formatCitationCounter — 3-way split (confirmed / uncertain / unverified)
// ---------------------------------------------------------------------------

describe('formatCitationCounter', () => {
  it('renders the 3-way split with the right pluralisation', () => {
    expect(formatCitationCounter(2, 1, 0)).toBe('2 confirmed, 1 uncertain, 0 unverified citations');
    expect(formatCitationCounter(1, 0, 0)).toBe('1 confirmed, 0 uncertain, 0 unverified citation');
  });

  it('uses singular only when the total is exactly 1', () => {
    expect(formatCitationCounter(0, 1, 0)).toBe('0 confirmed, 1 uncertain, 0 unverified citation');
    expect(formatCitationCounter(0, 0, 1)).toBe('0 confirmed, 0 uncertain, 1 unverified citation');
    expect(formatCitationCounter(1, 1, 0)).toBe('1 confirmed, 1 uncertain, 0 unverified citations');
  });

  it('returns "no symbol citations" when the answer mentioned no backtick symbols (#54)', () => {
    expect(formatCitationCounter(0, 0, 0)).toBe('no symbol citations');
  });
});

// ---------------------------------------------------------------------------
// F-K: extractQuestionEntities — identifier-shape extraction
// ---------------------------------------------------------------------------

/** Build a SearchResult quickly for re-rank tests. */
function makeSR(name: string, score: number, kind: Node['kind'] = 'function'): SearchResult {
  return {
    node: makeNode({ id: `n-${name}`, name, kind }),
    score,
  };
}

describe('extractQuestionEntities (F-K)', () => {
  it('finds SCREAMING_SNAKE_CASE constants', () => {
    const out = extractQuestionEntities('What triggers an EXTRACTION_LOGIC_VERSION bump?');
    expect(out).toContain('EXTRACTION_LOGIC_VERSION');
  });

  it('finds multiple SCREAMING_SNAKE constants', () => {
    const out = extractQuestionEntities(
      'Compare PAYLOAD_VERSION and EXTRACTION_LOGIC_VERSION and BIOMARKER_CACHE_KEY.',
    );
    expect(out).toEqual(expect.arrayContaining(['PAYLOAD_VERSION', 'EXTRACTION_LOGIC_VERSION', 'BIOMARKER_CACHE_KEY']));
  });

  it('finds camelCase identifiers with an interior capital', () => {
    const out = extractQuestionEntities('How does applyExtractionLogicVersionHeal interact with runMigration?');
    expect(out).toContain('applyExtractionLogicVersionHeal');
    expect(out).toContain('runMigration');
  });

  it('finds PascalCase compound types', () => {
    const out = extractQuestionEntities('When is QueryBuilder used inside ToolModule?');
    expect(out).toContain('QueryBuilder');
    expect(out).toContain('ToolModule');
  });

  it('de-duplicates repeated entities', () => {
    const out = extractQuestionEntities('PAYLOAD_VERSION matters because PAYLOAD_VERSION drives cache misses.');
    const hits = out.filter((e) => e === 'PAYLOAD_VERSION');
    expect(hits.length).toBe(1);
  });

  it('rejects short SCREAMING tokens that could be English (e.g. NO, OK)', () => {
    // `OK`, `NO`, `AND` are <4 chars OR don't meet the {3,} tail; should
    // NOT be picked up as identifiers.
    const out = extractQuestionEntities('Is the build OK and ready to ship?');
    expect(out).not.toContain('OK');
    expect(out).not.toContain('AND');
    expect(out).not.toContain('IS');
  });

  it('rejects plain English words even when they look word-like', () => {
    // Single-word PascalCase like `Hello`, `Question` must NOT match —
    // the pattern requires at least one secondary internal capital.
    const out = extractQuestionEntities('Hello, what is the Question about the answer?');
    expect(out).not.toContain('Hello');
    expect(out).not.toContain('Question');
    expect(out).not.toContain('What');
  });

  it('rejects lowercase-only words (no camelCase shape)', () => {
    const out = extractQuestionEntities('how does the cache version drift test work in practice');
    // No identifier-shaped tokens here — all lowercase prose.
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F-K: rerankByQuestionEntities — pool re-rank by entity match
// ---------------------------------------------------------------------------

describe('rerankByQuestionEntities (F-K, hard-pin)', () => {
  it('hard-pins a lower-scored exact-name match above an unrelated higher-scored row', () => {
    // The bug scenario: PAYLOAD_VERSION buried EXTRACTION_LOGIC_VERSION
    // even though the question literally names the latter. Round-3
    // switched from 1.5× soft boost to hard pinning, so the matched
    // row lands at index 0 regardless of base score.
    const pool: SearchResult[] = [makeSR('PAYLOAD_VERSION', 0.9), makeSR('EXTRACTION_LOGIC_VERSION', 0.7)];
    const { reranked, entities } = rerankByQuestionEntities(pool, 'What triggers an EXTRACTION_LOGIC_VERSION bump?');
    expect(entities).toContain('EXTRACTION_LOGIC_VERSION');
    expect(reranked[0]!.node.name).toBe('EXTRACTION_LOGIC_VERSION');
    // Hard pin preserves the original score — no boost applied.
    expect(reranked[0]!.score).toBe(0.7);
    // The non-matching row falls in behind, keeping its score.
    expect(reranked[1]!.node.name).toBe('PAYLOAD_VERSION');
    expect(reranked[1]!.score).toBe(0.9);
  });

  it('hard-pin wins even at an extreme score margin (soft-boost would have failed)', () => {
    // Stress: matched row at 0.001, rival at 0.999. A 1.5× boost
    // would still leave the rival on top (0.001 × 1.5 = 0.0015 < 0.999).
    // Hard pinning ignores scores entirely once an entity match fires.
    const pool: SearchResult[] = [
      makeSR('competitorWithVerboseDocstring', 0.999),
      makeSR('EXTRACTION_LOGIC_VERSION', 0.001),
    ];
    const { reranked } = rerankByQuestionEntities(pool, 'Explain EXTRACTION_LOGIC_VERSION bump policy.');
    expect(reranked[0]!.node.name).toBe('EXTRACTION_LOGIC_VERSION');
    expect(reranked[1]!.node.name).toBe('competitorWithVerboseDocstring');
  });

  it('preserves relative order among multiple pinned matches', () => {
    // When the question names two entities and both are in the pool,
    // pinned rows keep their original relative order.
    const pool: SearchResult[] = [
      makeSR('PAYLOAD_VERSION', 0.9),
      makeSR('EXTRACTION_LOGIC_VERSION', 0.7),
      makeSR('unrelated', 0.5),
    ];
    const { reranked } = rerankByQuestionEntities(pool, 'Compare PAYLOAD_VERSION and EXTRACTION_LOGIC_VERSION.');
    // PAYLOAD_VERSION came first in the pool, so it stays first
    // among the pinned set even though both match the question.
    expect(reranked[0]!.node.name).toBe('PAYLOAD_VERSION');
    expect(reranked[1]!.node.name).toBe('EXTRACTION_LOGIC_VERSION');
    expect(reranked[2]!.node.name).toBe('unrelated');
  });

  it('leaves the pool unchanged when no entities are extracted from the question', () => {
    const pool: SearchResult[] = [makeSR('foo', 0.9), makeSR('bar', 0.5)];
    const { reranked, entities } = rerankByQuestionEntities(pool, 'how does the cache work');
    expect(entities).toEqual([]);
    expect(reranked[0]!.node.name).toBe('foo');
    expect(reranked[1]!.node.name).toBe('bar');
    expect(reranked[0]!.score).toBe(0.9);
  });

  it('leaves the pool unchanged when entities extract but none match a candidate', () => {
    const pool: SearchResult[] = [makeSR('unrelatedSymbol', 0.9), makeSR('alsoUnrelated', 0.5)];
    const { reranked } = rerankByQuestionEntities(pool, 'What about EXTRACTION_LOGIC_VERSION?');
    expect(reranked[0]!.node.name).toBe('unrelatedSymbol');
    expect(reranked[0]!.score).toBe(0.9);
    expect(reranked[1]!.score).toBe(0.5);
  });

  it('case-insensitively matches entity names against node names', () => {
    const pool: SearchResult[] = [
      makeSR('runMigration', 0.4), // camelCase entity in the question.
      makeSR('other', 0.9),
    ];
    const { reranked } = rerankByQuestionEntities(pool, 'How does runMigration choose its target?');
    // Hard pin: runMigration goes to position 0 despite its lower score.
    expect(reranked[0]!.node.name).toBe('runMigration');
    expect(reranked[1]!.node.name).toBe('other');
  });
});

// ---------------------------------------------------------------------------
// F-K: buildEntityAnchorSystemPrompt — round-3 system-message anchor
// ---------------------------------------------------------------------------

describe('buildEntityAnchorSystemPrompt (F-K, round-3)', () => {
  it('substitutes a single entity into the template', () => {
    const prompt = buildEntityAnchorSystemPrompt(['EXTRACTION_LOGIC_VERSION']);
    expect(prompt).toContain('EXTRACTION_LOGIC_VERSION');
    expect(prompt).toContain('Anchor your answer on those specific symbols');
    expect(prompt).not.toContain('{ENTITIES}');
  });

  it('joins multiple entities with a comma + space', () => {
    const prompt = buildEntityAnchorSystemPrompt(['EXTRACTION_LOGIC_VERSION', 'PAYLOAD_VERSION']);
    expect(prompt).toContain('EXTRACTION_LOGIC_VERSION, PAYLOAD_VERSION');
  });

  it('mentions the F-K conflation hazard so the model knows to disambiguate', () => {
    const prompt = buildEntityAnchorSystemPrompt(['EXTRACTION_LOGIC_VERSION']);
    expect(prompt).toMatch(/PAYLOAD_VERSION.*EXTRACTION_LOGIC_VERSION|EXTRACTION_LOGIC_VERSION.*PAYLOAD_VERSION/);
  });
});

// ---------------------------------------------------------------------------
// F-K: buildEntityMismatchWarning — citation-verification footer
// ---------------------------------------------------------------------------

describe('buildEntityMismatchWarning (F-K)', () => {
  it('returns empty when no entities were extracted', () => {
    expect(buildEntityMismatchWarning([], 'some answer text')).toBe('');
  });

  it('returns empty when the answer mentions the entity', () => {
    const w = buildEntityMismatchWarning(
      ['EXTRACTION_LOGIC_VERSION'],
      'The bump is triggered when EXTRACTION_LOGIC_VERSION changes.',
    );
    expect(w).toBe('');
  });

  it('returns a warning when none of the entities appear in the answer', () => {
    // Classic F-K bug: question names EXTRACTION_LOGIC_VERSION, model
    // answered entirely about PAYLOAD_VERSION.
    const w = buildEntityMismatchWarning(
      ['EXTRACTION_LOGIC_VERSION'],
      'The PAYLOAD_VERSION constant is bumped when the cache schema changes.',
    );
    expect(w).toContain('EXTRACTION_LOGIC_VERSION');
    expect(w).toContain('anchored on a related-but-different symbol');
    expect(w.startsWith('\n\n>')).toBe(true);
  });

  it('matches case-insensitively (model lowercased the constant in prose)', () => {
    const w = buildEntityMismatchWarning(
      ['EXTRACTION_LOGIC_VERSION'],
      'The bump fires when extraction_logic_version changes.',
    );
    // Lowercase mention should count as "the model anchored on it".
    expect(w).toBe('');
  });

  it('does NOT warn when at least one entity was mentioned (partial ground)', () => {
    // If the model named one of two entities, it likely partially
    // grounded — a warning would be noisier than informative.
    const w = buildEntityMismatchWarning(
      ['EXTRACTION_LOGIC_VERSION', 'PAYLOAD_VERSION'],
      'PAYLOAD_VERSION bumps on cache-schema changes.',
    );
    expect(w).toBe('');
  });
});

// ---------------------------------------------------------------------------
// buildCitationReport — shared MCP/CLI citation renderer (#33)
// ---------------------------------------------------------------------------

describe('buildCitationReport — shared MCP/CLI renderer (#33)', () => {
  it('renders a Verified citations section + confirmed counter for a source-tree hit', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'src-ask',
        name: 'ask',
        kind: 'function',
        filePath: 'src/mcp/tools/ask.ts',
        qualifiedName: 'src/mcp/tools/ask.ts::ask',
      }),
    ]);
    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `ask` function handles requests.');
    const report = buildCitationReport(cited);

    expect(report.confirmed).toBe(1);
    expect(report.uncertain).toBe(0);
    expect(report.unverified).toBe(0);
    expect(report.counter).toBe('1 confirmed, 0 uncertain, 0 unverified citation');
    expect(report.sections.join('\n')).toContain('## Verified citations (resolved against the index)');
    expect(report.sections.join('\n')).toContain('✓ `ask`');
  });

  it('counts a distribution-path-only hit as uncertain', () => {
    insertNodesWithFiles(q, [
      makeNode({
        id: 'pub-ask',
        name: 'ask',
        kind: 'function',
        filePath: 'publish.js',
        qualifiedName: 'publish.js::ask',
      }),
    ]);
    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `ask` function is here.');
    const report = buildCitationReport(cited);

    expect(report.confirmed).toBe(0);
    expect(report.uncertain).toBe(1);
    expect(report.counter).toContain('1 uncertain');
  });

  it('flags an identifier that resolves to no node as unverified', () => {
    const cg = makeCg(q);
    const cited = groundCitations(cg as Cartograph, 'The `totallyMadeUpSymbol` does the work.');
    const report = buildCitationReport(cited);

    expect(report.unverified).toBe(1);
    expect(report.sections.join('\n')).toContain('## ⚠ Unverified mentions (not found in the index)');
  });

  it('returns no sections and the "no symbol citations" counter for an answer with no cites', () => {
    const cg = makeCg(q);
    const report = buildCitationReport(groundCitations(cg as Cartograph, 'A plain answer with no backticks.'));

    expect(report.sections).toEqual([]);
    expect(report.confirmed + report.uncertain + report.unverified).toBe(0);
    expect(report.counter).toBe('no symbol citations');
  });
});

// ---------------------------------------------------------------------------
// F#23: formatRerankTag — reranker observability footer segment
// ---------------------------------------------------------------------------

describe('formatRerankTag (F#23 — reranker observability)', () => {
  it('returns empty string when rerankOutcome is undefined', () => {
    expect(formatRerankTag(undefined)).toBe('');
  });

  it('formats a fired outcome with count and duration', () => {
    const ro: RerankOutcome = { kind: 'fired', durationMs: 42, rerankedCount: 10, skippedCount: 2 };
    const tag = formatRerankTag(ro);
    expect(tag).toContain('rerank 42ms');
    expect(tag).toContain('10 reranked');
    expect(tag).toContain('2 skipped');
  });

  it('omits skipped clause when skippedCount is 0', () => {
    const ro: RerankOutcome = { kind: 'fired', durationMs: 10, rerankedCount: 5, skippedCount: 0 };
    const tag = formatRerankTag(ro);
    expect(tag).toContain('5 reranked');
    expect(tag).not.toContain('skipped');
  });

  it('formats skipped-no-config', () => {
    const tag = formatRerankTag({ kind: 'skipped-no-config' });
    expect(tag).toContain('reranker not configured');
  });

  it('formats skipped-no-hits', () => {
    const tag = formatRerankTag({ kind: 'skipped-no-hits' });
    expect(tag).toContain('rerank skipped');
    expect(tag).toContain('no hits');
  });

  it('formats skipped-no-text', () => {
    const tag = formatRerankTag({ kind: 'skipped-no-text' });
    expect(tag).toContain('rerank skipped');
    expect(tag).toContain('empty candidates');
  });

  it('formats a failed outcome with the error message', () => {
    const ro: RerankOutcome = { kind: 'failed', error: 'connect ECONNREFUSED', durationMs: 150 };
    const tag = formatRerankTag(ro);
    expect(tag).toContain('rerank failed');
    expect(tag).toContain('connect ECONNREFUSED');
  });
});

describe('isDistributionPath — source vs build artifact boundaries', () => {
  it('treats root bin and built assets as distribution paths', () => {
    expect(isDistributionPath('bin/cartograph.js')).toBe(true);
    expect(isDistributionPath('packages/api/dist/index.js')).toBe(true);
    expect(isDistributionPath('public/app.bundle.js')).toBe(true);
    expect(isDistributionPath('publish.min.js')).toBe(true);
  });

  it('does not misclassify source-layout bin directories', () => {
    expect(isDistributionPath('src/bin/cartograph.ts')).toBe(false);
    expect(isDistributionPath('packages/cli/src/bin/run.ts')).toBe(false);
  });
});

describe('formatCitationCounter — count wording', () => {
  it('uses the no-citation label for all-zero counts', () => {
    expect(formatCitationCounter(0, 0, 0)).toBe('no symbol citations');
  });

  it('uses singular citation wording for one total citation', () => {
    expect(formatCitationCounter(1, 0, 0)).toBe('1 confirmed, 0 uncertain, 0 unverified citation');
    expect(formatCitationCounter(0, 1, 0)).toBe('0 confirmed, 1 uncertain, 0 unverified citation');
    expect(formatCitationCounter(0, 0, 1)).toBe('0 confirmed, 0 uncertain, 1 unverified citation');
  });
});

// ---------------------------------------------------------------------------
// F#23: buildAskOutput — reranker failure warning prepended above citations
// ---------------------------------------------------------------------------

/** Build a minimal AskResult for buildAskOutput tests. */
function makeAskResult(
  overrides: Partial<import('../src/llm/ask.js').AskResult> = {},
): import('../src/llm/ask.js').AskResult {
  return {
    answer: 'Test answer.',
    citations: [],
    chatMs: 100,
    retrieveMs: 5,
    ...overrides,
  };
}

describe('buildAskOutput — reranker warning (F#23)', () => {
  it('prepends a reranker-unavailable warning when rerankOutcome.kind === "failed"', () => {
    const result = makeAskResult({
      rerankOutcome: { kind: 'failed', error: 'ECONNREFUSED localhost:8083', durationMs: 200 },
    });
    const output = buildAskOutput(result, [], 'test-model-7b');
    // Warning must appear BEFORE the ## Answer heading so it's visible at the top.
    const warnIdx = output.indexOf('Reranker unavailable');
    const answerIdx = output.indexOf('## Answer');
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeLessThan(answerIdx);
    expect(output).toContain('cartograph_admin doctor');
  });

  it('does NOT prepend a warning when rerankOutcome.kind === "fired"', () => {
    const result = makeAskResult({
      rerankOutcome: { kind: 'fired', durationMs: 30, rerankedCount: 8, skippedCount: 0 },
    });
    const output = buildAskOutput(result, [], 'test-model-7b');
    expect(output).not.toContain('Reranker unavailable');
    // Fired outcome shows timing in the footer
    expect(output).toContain('rerank 30ms');
  });

  it('does NOT prepend a warning when rerankOutcome is undefined', () => {
    const result = makeAskResult();
    const output = buildAskOutput(result, [], 'test-model-7b');
    expect(output).not.toContain('Reranker unavailable');
  });

  it('includes the footer timing line with rerank info for fired outcome', () => {
    const result = makeAskResult({
      rerankOutcome: { kind: 'fired', durationMs: 55, rerankedCount: 12, skippedCount: 1 },
      retrieveMs: 8,
      chatMs: 200,
    });
    const output = buildAskOutput(result, [], 'some-model');
    const footer = output.split('\n').find((l) => l.startsWith('_Retrieved'));
    expect(footer).toBeDefined();
    expect(footer).toContain('Retrieved 0 symbols in 8ms');
    expect(footer).toContain('rerank 55ms');
    expect(footer).toContain('12 reranked');
    expect(footer).toContain('1 skipped');
    expect(footer).toContain('chat 200ms');
  });

  it('includes "reranker not configured" in the footer when skipped-no-config', () => {
    const result = makeAskResult({
      rerankOutcome: { kind: 'skipped-no-config' },
    });
    const output = buildAskOutput(result, [], 'some-model');
    const footer = output.split('\n').find((l) => l.startsWith('_Retrieved'));
    expect(footer).toContain('reranker not configured');
  });

  it('includes skipped reranker reasons in the retrieval footer', () => {
    const noHits = buildAskOutput(makeAskResult({ rerankOutcome: { kind: 'skipped-no-hits' } }), [], 'some-model');
    expect(noHits).toContain('rerank skipped (no hits)');

    const emptyCandidates = buildAskOutput(
      makeAskResult({ rerankOutcome: { kind: 'skipped-no-text' } }),
      [],
      'some-model',
    );
    expect(emptyCandidates).toContain('rerank skipped (empty candidates)');
  });

  it('warns when a sub-3B ask model produces a near-empty answer', () => {
    const output = buildAskOutput(makeAskResult({ answer: 'symbol only' }), [], '/models/qwen-3b.gguf');
    expect(output).toContain('is small');
    expect(output).toContain('qwen-3b.gguf');
  });
});
