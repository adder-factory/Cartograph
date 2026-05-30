/**
 * @internal — call-id footer split, for the P5 response-envelope
 * chokepoint.
 *
 * `appendCallIdFooter` in `shared.ts` builds two things into one
 * string: it PREPENDS a delta-summary header (`> **Delta vs …**` / the
 * stale-UID warning) and APPENDS the `> _call: c_xxxxxxxx_` marker.
 * Under the `renderToolResponse` chokepoint those two pieces land in
 * different slots — the header is part of the BODY (it describes the
 * rows that follow), the marker is a FOOTER (placed after truncation
 * so a wide body can't push it off the budget).
 *
 * `splitCallIdFooter` runs the real `appendCallIdFooter` against a
 * sentinel body and slices the two halves back off, so the marker /
 * delta-summary WORDING stays single-sourced in `shared.ts` — there is
 * no verbatim copy here that could silently drift. Every delta-aware
 * tool (`_search` / `_grep` / `explore` / `_callers` / `_callees`)
 * uses this one helper; it is not registered and not a public surface.
 */

import { appendCallIdFooter, type DeltaSummary } from './shared.js';

/** Sentinel body — `appendCallIdFooter` brackets it with header + marker. */
const CALL_ID_SENTINEL = ' callid-sentinel ';

/**
 * Split `appendCallIdFooter`'s output into its two P5 placement
 * classes:
 *
 *  - `header` — the optional delta-summary line(s). Rides in the
 *    response BODY, BEFORE truncation, because it describes the rows.
 *    Carries its own trailing blank line, so `header + body` is the
 *    correct composition; it is `''` when there is no `since` cursor.
 *  - `marker` — the `> _call: c_xxxx_` line. A FOOTER, placed AFTER
 *    truncation so a wide body can't bury the agent's pagination
 *    handle.
 *
 * Implemented by running `appendCallIdFooter` against a sentinel body
 * and slicing the halves back off — the wording stays single-sourced
 * in `shared.ts`.
 */
export function splitCallIdFooter(newCallId: string, delta?: DeltaSummary): { header: string; marker: string } {
  const rendered = appendCallIdFooter(CALL_ID_SENTINEL, newCallId, delta);
  const idx = rendered.indexOf(CALL_ID_SENTINEL);
  const header = rendered.slice(0, idx);
  // Everything after the sentinel is `\n\n` + marker — drop the joiner.
  const marker = rendered.slice(idx + CALL_ID_SENTINEL.length).replace(/^\n\n/, '');
  return { header, marker };
}
