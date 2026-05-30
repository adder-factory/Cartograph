/**
 * Agent annotations + bookmarks (#14). CRUD over the `agent_notes`
 * table — symbol-scoped or free-floating notes the agent leaves for
 * future-me.
 *
 * No FTS / no embeddings on note text in v1: list-and-filter queries
 * carry the load; full-text search arrives only if the agent ever
 * accumulates enough notes that scrolling them becomes expensive.
 */
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

export type NoteKind = 'note' | 'question' | 'followup' | 'bookmark';

export interface NoteRow {
  id: number;
  nodeId: string | null;
  author: string;
  ts: number;
  text: string;
  kind: NoteKind;
}

interface AddNoteInput {
  nodeId?: string | null;
  author: string;
  ts: number;
  text: string;
  kind: NoteKind;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const addNoteQuery = defineQuery({
  sql: `INSERT INTO agent_notes (node_id, author, ts, text, kind)
         VALUES (@nodeId, @author, @ts, @text, @kind)`,
  params: z.object({
    nodeId: z.string().nullable(),
    author: z.string(),
    ts: z.number(),
    text: z.string(),
    kind: z.enum(['note', 'question', 'followup', 'bookmark']),
  }),
  row: z.never(),
});

const deleteNoteQuery = defineQuery({
  sql: 'DELETE FROM agent_notes WHERE id = @id',
  params: z.object({ id: z.number() }),
  row: z.never(),
});

// Pattern B — sentinel `(@p IS NULL OR col = @p)` for each of the
// three optional filters. `agent_notes` is small (bookmark-scale), so
// the loss of index-driven planning on `idx_agent_notes_node` /
// `idx_agent_notes_kind_ts` is dwarfed by the table size; collapsing
// to one static SQL string avoids the 8-variant Pattern C explosion.
const NoteRowDbSchema = z.object({
  id: z.number(),
  node_id: z.string().nullable(),
  author: z.string(),
  ts: z.number(),
  text: z.string(),
  kind: z.string(),
});

const listNotesQuery = defineQuery({
  sql: `SELECT id, node_id, author, ts, text, kind
       FROM agent_notes
      WHERE (@nodeId IS NULL OR node_id = @nodeId)
        AND (@kind   IS NULL OR kind    = @kind)
        AND (@since  IS NULL OR ts     >= @since)
      ORDER BY ts DESC
      LIMIT @limit`,
  params: z.object({
    nodeId: z.string().nullable(),
    kind: z.enum(['note', 'question', 'followup', 'bookmark']).nullable(),
    since: z.number().nullable(),
    limit: z.number(),
  }),
  row: NoteRowDbSchema,
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    addNote?: TypedQuery<{ nodeId: string | null; author: string; ts: number; text: string; kind: NoteKind }, never>;
    deleteNote?: TypedQuery<{ id: number }, never>;
    listNotes?: TypedQuery<
      {
        nodeId: string | null;
        kind: NoteKind | null;
        since: number | null;
        limit: number;
      },
      {
        id: number;
        node_id: string | null;
        author: string;
        ts: number;
        text: string;
        kind: string;
      }
    >;
  }
}

export function addNote(qb: QueryBuilder, input: AddNoteInput): number {
  qb.queries.addNote ??= addNoteQuery(qb.db);
  const res = qb.queries.addNote.run({
    nodeId: input.nodeId ?? null,
    author: input.author,
    ts: input.ts,
    text: input.text,
    kind: input.kind,
  });
  return Number(res.lastInsertRowid);
}

interface ListNotesFilter {
  nodeId?: string | undefined;
  kind?: NoteKind | undefined;
  since?: number | undefined;
  limit?: number | undefined;
}

export function listNotes(qb: QueryBuilder, filter: ListNotesFilter = {}): NoteRow[] {
  // Pattern B — one static SQL with sentinel `(@p IS NULL OR col = @p)`
  // clauses for each optional filter. See the typed-query comment above
  // for why Pattern B is preferred over Pattern C here.
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
  qb.queries.listNotes ??= listNotesQuery(qb.db);
  const rows = qb.queries.listNotes.all({
    nodeId: filter.nodeId ?? null,
    kind: filter.kind ?? null,
    since: typeof filter.since === 'number' ? filter.since : null,
    limit,
  });
  return rows.map((r) => ({
    id: r.id,
    nodeId: r.node_id,
    author: r.author,
    ts: r.ts,
    text: r.text,
    kind: r.kind as NoteKind,
  }));
}

export function deleteNote(qb: QueryBuilder, id: number): boolean {
  qb.queries.deleteNote ??= deleteNoteQuery(qb.db);
  const r = qb.queries.deleteNote.run({ id });
  return r.changes > 0;
}
