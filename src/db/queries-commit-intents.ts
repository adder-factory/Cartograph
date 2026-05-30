/**
 * Persistence helpers for the `commit_intents` table (migration 045,
 * Stage 7 #2). Caches the heuristic classifier output keyed by SHA
 * so downstream queries (history breakdown, hotspots intent filter)
 * don't re-parse the same message on every read.
 *
 * Writes: `recordCommitIntents` (batch upsert).
 * Reads:  `getCommitIntent` / `getCommitIntents` (multi-SHA fetch).
 * Maintenance: `clearCommitIntents` (drop all — used by cochange
 * full-rescan path).
 *
 * Re-classification is upsert-on-conflict so re-running on a known
 * SHA is idempotent. The `seen_at` column records when the row was
 * last updated for diagnostic / orphan-pruning purposes.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import type { CommitIntent } from '../llm/commit-intent.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

export interface CommitIntentRow {
  sha: string;
  intent: CommitIntent;
  score: number;
  seenAt: number;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const upsertCommitIntentQuery = defineQuery({
  sql: `INSERT INTO commit_intents (sha, intent, score, seen_at)
     VALUES (@sha, @intent, @score, @seenAt)
     ON CONFLICT(sha) DO UPDATE SET
       intent = excluded.intent,
       score  = excluded.score,
       seen_at = excluded.seen_at`,
  params: z.object({
    sha: z.string(),
    intent: z.string(),
    score: z.number(),
    seenAt: z.number(),
  }),
  row: z.never(),
});

const getCommitIntentQuery = defineQuery({
  sql: `SELECT sha, intent, score, seen_at AS seenAt
         FROM commit_intents
        WHERE sha = @sha`,
  params: z.object({ sha: z.string() }),
  row: z.object({
    sha: z.string(),
    intent: z.string(),
    score: z.number(),
    seenAt: z.number(),
  }),
});

const getUnknownCommitShasQuery = defineQuery({
  sql: `SELECT sha FROM commit_intents WHERE intent = 'unknown'`,
  params: z.object({}),
  row: z.object({ sha: z.string() }),
});

// Pattern A — variable IN-list via `json_each(@shasJson)`.
const getCommitIntentsByShasQuery = defineQuery({
  sql: `SELECT sha, intent, score, seen_at AS seenAt
       FROM commit_intents
      WHERE sha IN (SELECT value FROM json_each(@shasJson))`,
  params: z.object({ shasJson: z.string() }),
  row: z.object({
    sha: z.string(),
    intent: z.string(),
    score: z.number(),
    seenAt: z.number(),
  }),
});

const aggregateIntentByShasQuery = defineQuery({
  sql: `SELECT intent, COUNT(*) AS c
       FROM commit_intents
      WHERE sha IN (SELECT value FROM json_each(@shasJson))
      GROUP BY intent`,
  params: z.object({ shasJson: z.string() }),
  row: z.object({ intent: z.string(), c: z.number() }),
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    upsertCommitIntent?: TypedQuery<{ sha: string; intent: string; score: number; seenAt: number }, never>;
    getCommitIntent?: TypedQuery<{ sha: string }, { sha: string; intent: string; score: number; seenAt: number }>;
    getUnknownCommitShas?: TypedQuery<Record<string, never>, { sha: string }>;
    getCommitIntentsByShas?: TypedQuery<
      { shasJson: string },
      { sha: string; intent: string; score: number; seenAt: number }
    >;
    aggregateIntentByShas?: TypedQuery<{ shasJson: string }, { intent: string; c: number }>;
  }
}

/**
 * Batch upsert — used by the cochange miner / classify-commits pass
 * to persist many SHAs at once. Wraps in a transaction for atomicity
 * and ~30× throughput vs per-row upsert on large batches.
 */
export function recordCommitIntents(
  qb: QueryBuilder,
  rows: ReadonlyArray<{ sha: string; intent: CommitIntent; score: number }>,
): void {
  if (rows.length === 0) return;
  qb.queries.upsertCommitIntent ??= upsertCommitIntentQuery(qb.db);
  const stmt = qb.queries.upsertCommitIntent;
  const now = Date.now();
  qb.db.transaction(() => {
    for (const r of rows) stmt.run({ sha: r.sha, intent: r.intent, score: r.score, seenAt: now });
  })();
}

/** Single-row read. Returns null when the SHA isn't classified yet. */
export function getCommitIntent(qb: QueryBuilder, sha: string): CommitIntentRow | null {
  qb.queries.getCommitIntent ??= getCommitIntentQuery(qb.db);
  const row = qb.queries.getCommitIntent.get({ sha });
  if (!row) return null;
  return { sha: row.sha, intent: row.intent as CommitIntent, score: row.score, seenAt: row.seenAt };
}

/**
 * Multi-SHA batch read. Returns a Map for O(1) lookup. Missing SHAs
 * are absent from the map (caller decides how to handle — typically
 * "treat as unknown").
 *
 * Pattern A — variable IN-list via `json_each(@shasJson)` keeps the
 * SQL static so `defineQuery` can wrap it.
 */
export function getCommitIntents(qb: QueryBuilder, shas: readonly string[]): Map<string, CommitIntentRow> {
  if (shas.length === 0) return new Map();
  qb.queries.getCommitIntentsByShas ??= getCommitIntentsByShasQuery(qb.db);
  const rows = qb.queries.getCommitIntentsByShas.all({ shasJson: JSON.stringify(shas) });
  const out = new Map<string, CommitIntentRow>();
  for (const r of rows) {
    out.set(r.sha, { sha: r.sha, intent: r.intent as CommitIntent, score: r.score, seenAt: r.seenAt });
  }
  return out;
}

/**
 * Aggregate intent breakdown for a SHA set — useful for cartograph_history
 * "what kinds of changes touched this file?" style queries. Unknown /
 * absent SHAs aren't counted.
 *
 * Pattern A — variable IN-list via `json_each(@shasJson)` keeps the SQL
 * static.
 */
export function aggregateIntentBreakdown(qb: QueryBuilder, shas: readonly string[]): Record<CommitIntent, number> {
  const empty: Record<CommitIntent, number> = {
    feat: 0,
    fix: 0,
    refactor: 0,
    perf: 0,
    test: 0,
    docs: 0,
    chore: 0,
    unknown: 0,
  };
  if (shas.length === 0) return empty;
  qb.queries.aggregateIntentByShas ??= aggregateIntentByShasQuery(qb.db);
  const rows = qb.queries.aggregateIntentByShas.all({ shasJson: JSON.stringify(shas) });
  const out = { ...empty };
  for (const r of rows) {
    if (r.intent in out) {
      out[r.intent as CommitIntent] = r.c;
    }
  }
  return out;
}

/** Drop every row — used by the cochange full-rescan path so stale
 *  branch data doesn't pollute the new history. */
export function clearCommitIntents(qb: QueryBuilder): void {
  qb.db.exec('DELETE FROM commit_intents');
}

/**
 * SHAs the heuristic classifier couldn't label (`intent = 'unknown'`).
 * The background LLM residue pass re-classifies these — the heuristic
 * fires on conventional-commit prefixes / keyword cues, so the residue
 * is the prefix-less, keyword-less commits an LLM reading the subject
 * can still place. Backed by `idx_commit_intents_intent`.
 */
export function getUnknownCommitShas(qb: QueryBuilder): string[] {
  qb.queries.getUnknownCommitShas ??= getUnknownCommitShasQuery(qb.db);
  return qb.queries.getUnknownCommitShas.all({}).map((r) => r.sha);
}
