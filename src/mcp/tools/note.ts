/**
 * `cartograph_note({action})` — agent annotations + bookmarks (#14).
 *
 * Five actions on the consolidated family pattern from #7:
 *
 *   - `add    ({symbol?, text, kind?, author?})`  attach a note
 *   - `list   ({symbol?, kind?, since?, limit?})` list notes (newest-first)
 *   - `delete ({id})`                              drop one note
 *
 * `kind` ∈ `note | question | followup | bookmark`. Default `note`.
 *
 * `symbol` is resolved via the existing `findSymbol` helper, which
 * means it accepts a name, an `n_xxxxxxxx` UID from a prior tool
 * result (cf. #15), or a raw `kind:hash` node id (cf. #34). Omitting
 * `symbol` creates a free-floating
 * project-scoped note (no node_id), useful for "remember to revisit
 * the auth flow" style reminders that aren't tied to one symbol.
 *
 * Notes attached to a symbol are CASCADE-deleted when the underlying
 * node is dropped (re-index of the file). Free-floating notes
 * survive forever — author can prune via `delete({id})`.
 *
 * SCHEMA (structural campaign P4): a FLAT `z.object` where `action` is
 * a `z.enum` and every per-action field is `.optional()` — this mirrors
 * the prior hand-written JSON `inputSchema`, which only required
 * `action`. The per-action requirement checks (e.g. `add` needs `text`,
 * `delete` needs `id`) stay in the per-action handlers exactly as
 * before — Zod enforces field SHAPE, not per-action presence.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { addNote, listNotes, deleteNote, type NoteKind, type NoteRow } from '../../db/queries-notes.js';
import { textResult, truncateOutput, validateStringOutcome } from './shared.js';
import { findSymbol, withDisambiguationBanner } from './symbol-resolver.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type { ToolCtx } from './types.js';

const DEFAULT_AUTHOR = 'agent';

/** The four note discriminators. Literal tuple so `z.enum` rejects an
 *  unknown `kind` at the dispatch boundary; kept in sync with
 *  `NOTE_KINDS` in `db/queries-notes.ts`. */
const NOTE_KIND_VALUES = ['note', 'question', 'followup', 'bookmark'] as const;

function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 16);
}

/* ---------- add ---------- */

function handleAdd(ctx: ToolCtx, args: NoteArgs): ToolOutcome {
  const text = validateStringOutcome({ value: args.text, name: 'text' });
  if (typeof text !== 'string') return text;
  // `kind` is a validated enum (Zod rejected anything else); default to
  // `note` when the caller omitted it.
  const kind: NoteKind = args.kind ?? 'note';
  const hasAuthor = typeof args.author === 'string' && args.author.length > 0;
  const author = hasAuthor ? args.author! : DEFAULT_AUTHOR;
  const cg = ctx.getCartograph(args.projectPath);

  let nodeId: string | null = null;
  let nodeLabel = '';
  // `resolutionNote` carries `findSymbol`'s disambiguation / fuzzy-fallback
  // banner so the caller is never silently shown one of N matches — or,
  // worse, an unrelated `import` node guessed by FTS for a name no symbol
  // actually has (the `runIndex` → `./index-hooks/registry.js` case).
  let resolutionNote = '';
  const symbol = args.symbol;
  if (typeof symbol === 'string' && symbol) {
    const match = findSymbol(cg, symbol, ctx.refIds);
    if (!match) {
      return err(
        `add: symbol "${symbol}" not found. Pass an existing symbol name, ` +
          `omit \`symbol\` for a project-scoped note, or run cartograph_find (by='name') first.`,
      );
    }
    nodeId = match.node.id;
    nodeLabel = ` on **${match.node.name}** (${match.node.kind}) — ${match.node.filePath}`;
    resolutionNote = match.note;
  }

  const now = Date.now();
  const id = addNote(cg.queries, {
    nodeId,
    author,
    ts: now,
    text,
    kind,
  });
  // Banner-at-top convention (structural fix #30): the disambiguation
  // note belongs ABOVE the "Note saved" header so the user can spot a
  // wrong-symbol pick before treating the note as authoritatively
  // attached. Pre-#30 the note appeared after the quoted text where
  // an agent would miss it.
  const body =
    `## Note saved (id ${id})${nodeLabel}\n\n` +
    `- **kind:** ${kind}\n` +
    `- **author:** ${author}\n` +
    `- **at:** ${fmtTs(now)}\n\n` +
    `> ${text}`;
  return ok(textResult(withDisambiguationBanner(resolutionNote, body)));
}

/* ---------- list ---------- */

function renderRow(n: NoteRow, symbolLabel: string | null): string {
  const meta = `${fmtTs(n.ts)} • ${n.author} • ${n.kind}`;
  const node = symbolLabel ? ` • ${symbolLabel}` : '';
  return `- **${n.id}** — ${meta}${node}\n  > ${n.text}`;
}

function handleList(ctx: ToolCtx, args: NoteArgs): ToolOutcome {
  const cg = ctx.getCartograph(args.projectPath);

  let nodeId: string | undefined;
  let symbolHeader = '';
  const symbol = args.symbol;
  if (typeof symbol === 'string' && symbol) {
    const match = findSymbol(cg, symbol, ctx.refIds);
    if (!match) {
      // `list` is a pure read — filtering by a symbol that isn't in
      // the index is not an error the way `add` against a missing
      // symbol is; it just means "no notes". Return an empty result so
      // an agent probing "does this symbol have notes?" reads a clean
      // empty list instead of special-casing a not-found error
      // (friction audit-4 #8).
      return ok(textResult(`_No notes — symbol "${symbol}" is not in the index (or has no notes)._`));
    }
    nodeId = match.node.id;
    symbolHeader = ` for ${match.node.name}`;
  }

  // `kind` is a validated enum — only filter when the caller explicitly
  // passed one (omitting it lists every kind).
  const explicitKind: NoteKind | undefined = args.kind;

  const since = args.since;
  // `limit` is a Zod-validated integer in [1, 500] with a default of
  // 50 — no in-handler clamp needed.
  const limit = args.limit;

  const rows = listNotes(cg.queries, { nodeId, kind: explicitKind, since, limit });
  if (rows.length === 0) {
    return ok(textResult(`_No notes${symbolHeader}._`));
  }
  const lines: string[] = [`## Notes${symbolHeader} (${rows.length})`, ''];
  for (const r of rows) {
    // When listing unscoped (no symbol filter), resolve each note's nodeId to
    // a human name so the agent sees "alpha (function)" instead of "n_xxxxxxxx".
    let symbolLabel: string | null = null;
    if (!nodeId && r.nodeId) {
      const resolvedNode = cg.queries.getNodeById(r.nodeId);
      if (resolvedNode) {
        symbolLabel = `**${resolvedNode.name}** (${resolvedNode.kind}) — ${resolvedNode.filePath}`;
      } else {
        // Node was deleted (cascade would have removed the note, but handle
        // the orphan case defensively so we don't silently drop the note).
        symbolLabel = `\`${r.nodeId}\``;
      }
    }
    lines.push(renderRow(r, symbolLabel));
  }
  return ok(textResult(truncateOutput(lines.join('\n'))));
}

/* ---------- delete ---------- */

function handleDelete(ctx: ToolCtx, args: NoteArgs): ToolOutcome {
  const id = args.id;
  // `delete` requires `id` — the flat schema marks it `.optional()`
  // (per-action requirements aren't expressed in the schema), so the
  // presence + positivity check stays here. Zod already guaranteed
  // any provided value is a positive integer.
  if (id === undefined) {
    return err(`'id' must be a positive integer note id.`);
  }
  const cg = ctx.getCartograph(args.projectPath);
  const removed = deleteNote(cg.queries, id);
  // A no-op delete (no row by that id) is a caller error, not a
  // success — return the `err` arm so the CLI exits non-zero, consistent
  // with `session resume <bad-id>` / `role --symbol <bad-name>`.
  if (!removed) return err(`No note with id ${id}.`);
  return ok(textResult(`Deleted note ${id}.`));
}

/* ---------- dispatch ---------- */

/**
 * Zod schema for `cartograph_note`.
 *
 * `limit` is `.int().min(1).max(500).default(50)` — under the locked
 * reject-out-of-range policy a zero / negative / over-cap value is
 * REJECTED at the dispatch boundary, so the old `clampInt` is gone.
 * `id` is `.int().positive()` — a non-integer / non-positive id is
 * rejected, replacing the in-handler `Number.isFinite && id > 0` check.
 * `kind` is a `z.enum` so an unknown kind is rejected, replacing the
 * old `kindArg` validator.
 */
const noteSchema = z.object({
  action: z.enum(['add', 'list', 'delete']).describe('Note action to perform.'),
  symbol: z
    .string()
    .optional()
    .describe(
      '(add/list) Symbol the note attaches to. Accepts a name, an `n_xxxxxxxx` UID, or a `kind:hash` node id. ' +
        'Omit on add for a project-scoped note; omit on list to see every note.',
    ),
  text: z.string().optional().describe('(add) Note body; markdown supported.'),
  kind: z
    .enum(NOTE_KIND_VALUES)
    .optional()
    .describe('(add/list) Discriminator. Defaults to `note` on add; omit on list to match all kinds.'),
  author: z.string().optional().describe('(add) Free-form author tag (default `agent`).'),
  since: z.number().optional().describe('(list) Only return notes with ts >= this epoch-ms.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe('(list) Max notes to return; integer in [1, 500], default 50.'),
  id: z.number().int().positive().optional().describe('(delete) Positive-integer note id returned by `add`.'),
  projectPath: projectPathField,
});

type NoteArgs = z.infer<typeof noteSchema>;

type NoteActionHandler = (ctx: ToolCtx, args: NoteArgs) => ToolOutcome;

/** Single source of truth for note actions. The schema's `action`
 *  enum and this table are kept in sync — adding a handler here plus
 *  an enum value above is the only edit needed to register a new
 *  action. */
const NOTE_ACTIONS: Record<NoteArgs['action'], NoteActionHandler> = {
  add: handleAdd,
  list: handleList,
  delete: handleDelete,
};

async function handleNote(ctx: ToolCtx, args: NoteArgs): Promise<ToolOutcome> {
  // `action` is a validated enum — Zod rejected anything outside the
  // set at the dispatch boundary, so the table lookup is total.
  return NOTE_ACTIONS[args.action](ctx, args);
}

export const NOTE_TOOL = defineTool({
  name: 'cartograph_note',
  description:
    'Persistent annotations + bookmarks on symbols (or project-wide); survives sessions and re-indexes.\n\n' +
    'Actions: `add` (attach a `symbol` or omit) / `list` (filter by symbol/kind/since) / `delete` (by id). ' +
    '`kind`: `note`|`question`|`followup`|`bookmark`. Symbol notes cascade-delete when the node drops; project-scoped notes survive.',
  schema: noteSchema,
  handle: handleNote,
  bypassFreshnessGate: true,
  isWriteTool: true,
});
