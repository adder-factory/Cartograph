/**
 * @internal Spec builders + format helpers for `cartograph_session`.
 *
 * Split out of `session.ts` so a direct importer (e.g. the wording-lint
 * test) gets the spec builders without `session.ts`'s heavier handler
 * surface. (The former session.ts → registry.ts → session.ts runtime
 * cycle for `getToolModule` is gone — session.ts now reads the leaf
 * `_tool-lookup.ts` instead of the registry.)
 *
 * `session.ts` re-imports `fmtTs` from this file so the
 * timestamp format stays a single source of truth.
 */

import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';
import type { SessionRow } from '../../db/queries-trace.js';

/** Length of the `YYYY-MM-DD HH:MM` slice taken from an ISO timestamp. */
const ISO_DATE_HOUR_MINUTE_LENGTH = 16;

/** Format an epoch-ms timestamp as `YYYY-MM-DD HH:MM` UTC (compact, sortable). */
export function fmtTs(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, ISO_DATE_HOUR_MINUTE_LENGTH);
}

/**
 * Empty-state message for `handleList` (`cartograph_session({action: 'list'})`)
 * when the trace logger hasn't recorded any sessions yet. Italic markdown
 * convention matches the empty notes of other list tools.
 */
export const SESSIONS_EMPTY_NOTE = '_No sessions recorded yet._';

/**
 * Empty-state message for `handleMacroList`
 * (`cartograph_session({action: 'macro_list'})`) when no macros have been
 * saved. Same italic-markdown convention as {@link SESSIONS_EMPTY_NOTE}.
 */
export const MACROS_EMPTY_NOTE = '_No saved macros._';

/**
 * Build the "Recent sessions" H2 bullet-list spec. Title interpolates
 * `(showing N of M)` when the list is capped, else just `(N)` —
 * pre-migration distinction kept verbatim because `(N)` alone against
 * a 70+ row history reads as "N total sessions" rather than "20
 * most-recent" (friction noted in the surrounding code comment).
 *
 * Empty `sessions` → renderer emits {@link SESSIONS_EMPTY_NOTE}
 * verbatim, byte-identical to the pre-migration
 * `textResult('_No sessions recorded yet._')` short-circuit.
 *
 * Truncation footer (`_N older sessions not shown — raise \`limit\`
 * (cap 100) to see more._`) fires only when `sessions.length < total`.
 */
export function buildSessionRecentSpec(args: {
  sessions: ReadonlyArray<SessionRow>;
  total: number;
}): MarkdownBulletListSpec<SessionRow> {
  const { sessions, total } = args;
  const overflow = total - sessions.length;
  return {
    title:
      overflow > 0
        ? `Recent sessions (showing ${sessions.length} of ${total})`
        : `Recent sessions (${sessions.length})`,
    rows: sessions,
    formatRow: (s) => {
      const labelPart = s.label ? ` \`${s.label}\`` : '';
      return `- ${fmtTs(s.startedTs)} — \`${s.id}\`${labelPart} • ${s.toolCount} call${s.toolCount === 1 ? '' : 's'}`;
    },
    emptyState: SESSIONS_EMPTY_NOTE,
    ...(overflow > 0
      ? {
          footers: [
            `_${overflow} older session${overflow === 1 ? '' : 's'} not shown — raise \`limit\` (cap 100) to see more._`,
          ],
        }
      : {}),
  };
}

/** One row consumed by {@link buildSavedMacrosSpec}. Mirrors the
 *  shape returned by `listMacros` without re-exporting the private
 *  `MacroRow` interface from queries-macros.ts. */
export interface SavedMacroRow {
  name: string;
  steps: ReadonlyArray<unknown>;
  createdTs: number;
  lastRunTs: number | null;
}

/**
 * Build the "Saved macros" H2 bullet-list spec. Title interpolates
 * the macro count; formatRow renders each macro as
 * `- \`${name}\` — N step(s), created ${ts}, last run ${ts | 'never run'}`
 * (pre-migration shape preserved verbatim).
 *
 * Empty `macros` → renderer emits {@link MACROS_EMPTY_NOTE} verbatim,
 * byte-identical to the pre-migration `textResult('_No saved
 * macros._')` short-circuit.
 */
export function buildSavedMacrosSpec(args: {
  macros: ReadonlyArray<SavedMacroRow>;
}): MarkdownBulletListSpec<SavedMacroRow> {
  const { macros } = args;
  return {
    title: `Saved macros (${macros.length})`,
    rows: macros,
    formatRow: (m) => {
      const last = m.lastRunTs ? `last run ${fmtTs(m.lastRunTs)}` : 'never run';
      return `- \`${m.name}\` — ${m.steps.length} step${m.steps.length === 1 ? '' : 's'}, created ${fmtTs(m.createdTs)}, ${last}`;
    },
    emptyState: MACROS_EMPTY_NOTE,
  };
}

/** Convenience: render the recent-sessions spec. Re-exported so
 *  `session.ts` doesn't need to import the renderer separately. */
export function renderSessionRecent(args: { sessions: ReadonlyArray<SessionRow>; total: number }): string {
  return renderMarkdownBulletList(buildSessionRecentSpec(args));
}

/** Convenience: render the saved-macros spec. */
export function renderSavedMacros(args: { macros: ReadonlyArray<SavedMacroRow> }): string {
  return renderMarkdownBulletList(buildSavedMacrosSpec(args));
}
