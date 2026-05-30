/**
 * `_result-spec.ts` — typed `ResultSpec<TData>` payloads and the shared
 * renderers that turn them into markdown.
 *
 * THE PROBLEM
 * -----------
 * Pre-#32, every MCP tool hand-built its markdown body in the handler:
 * a header string, table separators, row strings, footers — every line
 * a literal in the handler's prose. Three different bug classes traced
 * to this shape:
 *
 *  - **Header / output terminology drift** (bug #17). `find by:'env'`
 *    rendered "Config keys read in this project" because the storage-
 *    layer term ("config_kind") leaked into the user-facing header.
 *    The fix in the bug-hunt sweep was a one-line copy change; the
 *    structural cause — that the header was hand-written prose
 *    duplicated in N handlers — stayed.
 *  - **Output buckets diverging from internal counts** (bug #16).
 *    `summaries action='pending'` exposed `total: 1669` while the
 *    actual data was a mix of drift-stale and never-summarised. The
 *    bucket separation existed inside `pendingSummariesBatch`; the
 *    JSON envelope re-named the buckets by hand.
 *  - **Output silently dropping computed values** (bug #19).
 *    `discover` produced typed stat objects per index but the
 *    renderer mapped them to em-dashes when the reader threw.
 *
 * THE FIX
 * -------
 * Each tool's handler returns a TYPED `ResultSpec` carrying named
 * buckets. A shared renderer reads the spec and emits markdown — the
 * user-facing wording lives ON THE SPEC (`title`, `columns[].header`,
 * `emptyState`) and is reachable from a test that asserts the
 * description and the spec agree.
 *
 * Scope today: {@link MarkdownTableSpec} + {@link renderMarkdownTable}
 * cover the table-rendering case (the pattern that caused #17). Other
 * shapes (single-symbol card, ranked list, composite report) follow
 * the same `{spec, renderer}` skeleton — add a new ResultSpec variant
 * + renderer when the next bug-class warrants it.
 *
 * NOT a replacement for {@link renderToolResponse} — that owns the
 * tail concerns (truncation / footers / freshness ordering). A handler
 * that builds a table now flows: data → MarkdownTableSpec →
 * renderMarkdownTable → renderToolResponse → ToolResult.
 */

/**
 * Column declaration for a markdown table. `header` is what the user
 * sees in the column header row; `align` controls the cell alignment
 * separator (default `'left'`); `cell` extracts the column value from
 * a row and renders it to the cell string.
 */
export interface MarkdownTableColumn<TRow> {
  /** User-facing column header. The spec OWNS this wording — adding a
   *  column with a misleading header is caught by the test that asserts
   *  the table's `title` and column headers agree with the tool's
   *  `.describe()` text. */
  readonly header: string;
  /** Cell alignment in the column separator. `right` is the typical
   *  choice for numeric columns. Default `left`. */
  readonly align?: 'left' | 'right' | 'center';
  /** Map one row's data to one cell's rendered string. */
  readonly cell: (row: TRow) => string;
}

/**
 * The typed payload for a tool that renders a single markdown table
 * (with an optional preamble + footer). Every field that contributes
 * to the rendered output is declared here — the renderer is total in
 * the sense that no user-visible string is hand-assembled outside this
 * spec.
 */
export interface MarkdownTableSpec<TRow> {
  /** Top-level heading — the H2 (or H3, when `headingLevel: 3` is
   *  set) the agent reads first. Example:
   *  `"Environment variables read in this project (top 10)"`. */
  readonly title: string;
  /** Heading level for {@link title}. Default `2` (renders as `## `).
   *  Set to `3` for sub-section tables embedded in a larger report
   *  (e.g. the three sub-rollups inside `cartograph_biomarkers
   *  mode='stats'`). The composing handler still owns the H2 title
   *  + intro lines + freshness footer above each H3 table. */
  readonly headingLevel?: 2 | 3;
  /** Optional lines inserted between the title and the table — the
   *  "what this section means" prose that ranked-list tools typically
   *  print. Example for coverage ranked: `"High-impact untested code
   *  = high centrality + low coverage. Tests for these protect the
   *  most callers per line of test written."`. Each entry becomes one
   *  rendered line; rendered with a trailing blank line before the
   *  table header so the existing one-blank-line separator stays
   *  byte-identical for migrated callers. The spec OWNS this wording
   *  — pre-migration handlers put the same text directly in the
   *  hand-built lines array. */
  readonly preamble?: ReadonlyArray<string>;
  /** Columns, declaration order — drives both the header row and the
   *  per-row cell extraction. */
  readonly columns: ReadonlyArray<MarkdownTableColumn<TRow>>;
  /** Rows, presentation order. Empty array → the renderer emits the
   *  `emptyState` message instead. */
  readonly rows: ReadonlyArray<TRow>;
  /** Markdown shown when `rows.length === 0`. The spec OWNS this
   *  wording too — an empty-result message is part of the user-facing
   *  contract and must not drift from the description. */
  readonly emptyState: string;
  /** Footer lines appended after the table (e.g. "_test-only entries
   *  hidden_", "Pass `key` to see exact sites"). Optional. */
  readonly footers?: ReadonlyArray<string>;
}

/**
 * Render a {@link MarkdownTableSpec} to markdown. The shape:
 *
 *   ## <title>
 *
 *   <preamble line 1>
 *   <preamble line 2>
 *
 *   | <col1.header> | <col2.header> | … |
 *   |---|---:| … |
 *   | <cell> | <cell> | … |
 *   …
 *
 *   <footer line 1>
 *   <footer line 2>
 *
 * The preamble block is omitted entirely (no trailing blank line)
 * when `preamble` is undefined / empty. Same for footers. Alignment
 * uses the minimal-form separator tokens: `---` for left / default,
 * `---:` for right, `:-:` for center (no leading colon on left,
 * since markdown defaults to left-align — keeps separator rows
 * short).
 *
 * Empty rows → returns the `emptyState` message verbatim (no table,
 * no preamble, no footers). Same one-blank-line separator between
 * body chunks every pre-#32 hand-built table used, so migrated
 * callers' output is byte-identical for the happy path.
 */
export function renderMarkdownTable<TRow>(spec: MarkdownTableSpec<TRow>): string {
  if (spec.rows.length === 0) return spec.emptyState;

  const headerRow = `| ${spec.columns.map((c) => c.header).join(' | ')} |`;
  const sepRow = `|${spec.columns.map((c) => alignSeparator(c.align)).join('|')}|`;
  const bodyRows = spec.rows.map((r) => `| ${spec.columns.map((c) => c.cell(r)).join(' | ')} |`);
  const preamble = spec.preamble && spec.preamble.length > 0 ? [...spec.preamble, ''] : [];
  const footers = spec.footers && spec.footers.length > 0 ? ['', ...spec.footers] : [];
  const heading = (spec.headingLevel ?? 2) === 3 ? `### ${spec.title}` : `## ${spec.title}`;
  return [heading, '', ...preamble, headerRow, sepRow, ...bodyRows, ...footers].join('\n');
}

/**
 * Build the column-separator cell for a given alignment. Returns the
 * minimal-form separator tokens: `---` for left/default, `---:` for
 * right, `:-:` for center. Markdown defaults the absence of a leading
 * colon to left-align, so the left form skips it — keeps the separator
 * row visually short on wide tables.
 */
function alignSeparator(align: MarkdownTableColumn<unknown>['align']): string {
  if (align === 'right') return '---:';
  if (align === 'center') return ':-:';
  return '---';
}

/**
 * Collect every user-facing string the spec exposes — used by the
 * structural lint test that asserts a tool's `.describe()` and the
 * spec's user-visible wording agree. Returns title, every preamble
 * line, every column header, the empty-state message, and every
 * footer line. Order matches the rendered output (title → preamble →
 * headers → emptyState → footers) so a lint that walks the array
 * doesn't have to map back to source position.
 */
export function specStrings<TRow>(spec: MarkdownTableSpec<TRow>): string[] {
  return [
    spec.title,
    ...(spec.preamble ?? []),
    ...spec.columns.map((c) => c.header),
    spec.emptyState,
    ...(spec.footers ?? []),
  ];
}

/**
 * Typed payload for a tool that renders a `### Title (N)` heading
 * followed by a bullet list — the shape `cartograph_entry_points`
 * and `cartograph_tests-for` symbol mode use for each sub-section.
 * The per-row format is owned by a `formatRow` callback so the spec
 * stays generic; the wording-lint walks {@link bulletListSpecStrings}
 * for the user-visible strings (title / preamble / emptyState /
 * emptyNote / footers).
 *
 * Renderer is {@link renderMarkdownBulletList}; output shape is
 * byte-identical to the pre-migration hand-built lines arrays
 * `appendBucket(...)` and `appendTestRow(...)` produced.
 *
 * Why a sibling spec instead of MarkdownTableSpec: the entry-points
 * row shape (`- **name** (kind) — file:line \`signature\``) and the
 * tests-for nested-bullet shape (`- file` then `  - Lline: "desc"`)
 * don't decompose cleanly into named columns. A single-column table
 * would force every formatter through one cell; a multi-column table
 * fragments the dense bullet form into wider rows. The bullet spec
 * keeps the existing format AND captures the user-visible wording
 * on a typed shape.
 */
export interface MarkdownBulletListSpec<TRow> {
  /** Heading text — same role as {@link MarkdownTableSpec.title}. */
  readonly title: string;
  /** Heading level — default 2 (`## `); set to 3 for sub-section
   *  lists composed under a larger H2 report (entry-points buckets,
   *  tests-for sub-sections). */
  readonly headingLevel?: 2 | 3;
  /** Prose lines between heading and bullets. Same trailing-blank-line
   *  rendering as the table spec's preamble. */
  readonly preamble?: ReadonlyArray<string>;
  /** Rows, presentation order. Empty → `emptyState` is emitted (or
   *  `emptyNote` when set; see field doc). */
  readonly rows: ReadonlyArray<TRow>;
  /** Per-row → markdown. Return one string for a single line; return
   *  `string[]` to emit multiple lines (the tests-for shape uses this
   *  for inline `  - Lline: "desc"` sub-bullets). */
  readonly formatRow: (row: TRow) => string | string[];
  /** Verbatim message when `rows` is empty AND `emptyNote` is unset.
   *  No heading, no chrome — same as the table spec's emptyState. */
  readonly emptyState: string;
  /** When the bucket is empty but the section title should still
   *  render (e.g. "Routes (0)" with a one-line "_routes: none in
   *  production source..._" hint). Mutually exclusive with the
   *  `rows.length > 0` path; ignored when `rows` is non-empty. The
   *  pre-migration `appendBucket` carried this as `emptyNote ?? null`
   *  — same semantics here. */
  readonly emptyNote?: string | null;
  /** Footer lines appended after the last bullet, separated by one
   *  blank line. Same rendering as the table spec's footers. */
  readonly footers?: ReadonlyArray<string>;
}

/**
 * Render a {@link MarkdownBulletListSpec} to markdown. Output shape:
 *
 *   ## <title>   (or `###` when headingLevel: 3)
 *
 *   <preamble lines>
 *
 *   - <row 1>
 *   - <row 2>
 *     - <row 2 sub-bullet>
 *   …
 *
 *   <footer lines>
 *
 * Empty rows + `emptyNote` set → heading + `emptyNote` + trailing
 * blank line (matches the pre-migration `appendBucket` empty-bucket
 * path). Empty rows + no `emptyNote` → returns `emptyState` verbatim
 * with no chrome.
 */
export function renderMarkdownBulletList<TRow>(spec: MarkdownBulletListSpec<TRow>): string {
  const heading = (spec.headingLevel ?? 2) === 3 ? `### ${spec.title}` : `## ${spec.title}`;
  if (spec.rows.length === 0) {
    if (spec.emptyNote != null && spec.emptyNote !== '') {
      // Trailing blank line matches `appendBucket`'s empty-bucket
      // emission: `[heading, emptyNote, '']`. The trailing `''` joins
      // with the outer composer's `\n` separator to produce the
      // standard one-blank-line inter-section gap.
      return [heading, spec.emptyNote, ''].join('\n');
    }
    return spec.emptyState;
  }
  // Byte-parity contract with the pre-migration `appendBucket`:
  // heading is directly followed by the first bullet (NO blank line
  // between them — markdown bullet lists in this codebase use that
  // tight shape), and the section ends with a trailing `''` so the
  // outer composer's `\n` join produces a one-blank-line gap before
  // the next section. The trailing-blank invariant is what callers
  // that push the spec output into a wider `lines: string[]` rely
  // on; pre-migration `appendBucket` ended every non-empty bucket
  // with `lines.push('')`.
  const out: string[] = [heading];
  if (spec.preamble && spec.preamble.length > 0) {
    // Preamble sits between heading and bullets with a blank line on
    // either side (matches the table-spec preamble convention).
    out.push('', ...spec.preamble, '');
  }
  for (const r of spec.rows) {
    const formatted = spec.formatRow(r);
    if (typeof formatted === 'string') out.push(formatted);
    else out.push(...formatted);
  }
  if (spec.footers && spec.footers.length > 0) {
    out.push('', ...spec.footers);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Collect every user-facing string a {@link MarkdownBulletListSpec}
 * exposes. Mirrors {@link specStrings} for the table-spec shape so
 * the wording-alignment lint can call either form uniformly. Excludes
 * the per-row output (dynamic data) and includes only the static
 * surface: title, preamble, emptyState, emptyNote (when set), and
 * every footer.
 */
export function bulletListSpecStrings<TRow>(spec: MarkdownBulletListSpec<TRow>): string[] {
  return [
    spec.title,
    ...(spec.preamble ?? []),
    spec.emptyState,
    ...(spec.emptyNote != null && spec.emptyNote !== '' ? [spec.emptyNote] : []),
    ...(spec.footers ?? []),
  ];
}

/**
 * Typed payload for a tool that renders a `## Title` heading followed
 * by N "cards" — each card being its own H3 heading + body lines.
 * Used by tools whose per-row presentation is too rich for a bullet
 * shape: search-result tools (`_search-fuzzy`, `_search-semantic`),
 * LLM-judge results in `dead-code`, and the digest-style cached
 * directory summaries in `module` list-all mode.
 *
 * Renderer is {@link renderMarkdownCardList}; output shape is
 * byte-parity (modulo one trailing `\n` from the spec's built-in
 * trailing blank, same convention as {@link renderMarkdownBulletList})
 * with the pre-migration hand-built `lines: string[]` arrays.
 *
 * Why a sibling spec instead of MarkdownBulletListSpec: a card's
 * `### heading` line is structurally part of the rendered output, not
 * a flat bullet, and its content (`name (kind) — score 0.823`,
 * `[VERDICT 87%] foo (function)`, etc.) is dynamic enough that
 * embedding it into a bullet's `formatRow` return blurs the contract
 * (bullets render with leading `-`; card headings don't). Splitting
 * the shape keeps each spec's contract honest, and `cardListSpecStrings`
 * stays parallel to `specStrings` / `bulletListSpecStrings`.
 */
export interface MarkdownCardListSpec<TRow> {
  /** Outer heading text — the H2 (or H3 when `headingLevel: 3`) that
   *  introduces the whole list. The spec OWNS this wording. */
  readonly title: string;
  /** Heading level for {@link title}. Default `2` (renders as `## `);
   *  set to `3` for embedded sub-sections. */
  readonly headingLevel?: 2 | 3;
  /** Optional prose lines between title and the first card, emitted
   *  with a trailing blank line to separate from the first card's
   *  heading. Same convention as the table-spec and bullet-list-spec
   *  preamble. */
  readonly preamble?: ReadonlyArray<string>;
  /** Rows, presentation order. Empty → renderer returns `emptyState`
   *  verbatim. */
  readonly rows: ReadonlyArray<TRow>;
  /** Per-row → the heading text (the part AFTER the `### ` prefix).
   *  Example: `(r) => \`${r.name} (${r.kind}) — score ${r.score}\``.
   *  No leading hash; the renderer prepends the correct heading level
   *  based on {@link rowHeadingLevel}. */
  readonly rowHeading: (row: TRow) => string;
  /** Per-row → body lines under the row heading. Return `[]` for a
   *  heading-only card; return multiple entries for the typical
   *  `file:line` + optional `\`signature\`` / `> description` shape.
   *  Each entry becomes one rendered line; no leading hash. */
  readonly rowBody: (row: TRow) => ReadonlyArray<string>;
  /** Heading level for per-row headings. Default `3` (`### `); set to
   *  `4` (`#### `) when the outer spec is at `headingLevel: 3` so the
   *  rendered output stays hierarchically correct.
   *
   *  **Caller responsibility:** must be strictly greater than
   *  {@link headingLevel}. The renderer doesn't enforce this — it
   *  emits whatever marker count the spec asks for — but the only
   *  invalid combo is `(headingLevel: 3, rowHeadingLevel: 3)` (same
   *  level), which produces an invalid heading hierarchy. The valid
   *  combos are: outer 2 + row 3 (default), outer 2 + row 4, outer 3
   *  + row 4. */
  readonly rowHeadingLevel?: 3 | 4;
  /** Verbatim message when `rows.length === 0`. The spec OWNS this
   *  wording too — empty-result messages drift just like populated
   *  ones. */
  readonly emptyState: string;
  /** Footer lines appended after the last card, with a blank-line
   *  separator. Same rendering as the table-spec and bullet-list-spec
   *  footers. */
  readonly footers?: ReadonlyArray<string>;
}

/** Default outer-heading level for a card list — renders `## `. Matches
 *  {@link MarkdownCardListSpec.headingLevel}'s `2` default. */
const DEFAULT_OUTER_HEADING_LEVEL = 2;
/** Embedded-section outer-heading level — renders `### `. The non-default
 *  `headingLevel` value, used when the list nests under another section. */
const EMBEDDED_OUTER_HEADING_LEVEL = 3;
/** Default per-row heading level — renders `### `. Matches
 *  {@link MarkdownCardListSpec.rowHeadingLevel}'s `3` default. */
const DEFAULT_ROW_HEADING_LEVEL = 3;
/** Deep per-row heading level — renders `#### `. Used when the outer
 *  section is itself at H3 so the heading hierarchy stays valid. */
const DEEP_ROW_HEADING_LEVEL = 4;

/**
 * Render a {@link MarkdownCardListSpec} to markdown. Output shape:
 *
 *   ## <title>      (or `###` when `headingLevel: 3`)
 *
 *   <preamble line 1>
 *   <preamble line 2>
 *
 *   ### <rowHeading(row 0)>      (or `####` when `rowHeadingLevel: 4`)
 *   <rowBody(row 0) line 1>
 *   <rowBody(row 0) line 2>
 *
 *   ### <rowHeading(row 1)>
 *   <rowBody(row 1) line 1>
 *
 *   <footer line 1>
 *   <footer line 2>
 *
 * Empty rows → returns the `emptyState` message verbatim (no title,
 * no chrome). Cards are separated by one blank line (the trailing
 * `''` after each card's body). The final card's trailing `''` plus
 * the outer `\n` separator of any composing handler produces the
 * one-blank-line inter-section gap that pre-migration hand-built
 * arrays produced.
 */
export function renderMarkdownCardList<TRow>(spec: MarkdownCardListSpec<TRow>): string {
  if (spec.rows.length === 0) return spec.emptyState;
  const titleMark = (spec.headingLevel ?? DEFAULT_OUTER_HEADING_LEVEL) === EMBEDDED_OUTER_HEADING_LEVEL ? '###' : '##';
  const rowMark = (spec.rowHeadingLevel ?? DEFAULT_ROW_HEADING_LEVEL) === DEEP_ROW_HEADING_LEVEL ? '####' : '###';
  const out: string[] = [`${titleMark} ${spec.title}`, ''];
  if (spec.preamble && spec.preamble.length > 0) {
    out.push(...spec.preamble, '');
  }
  for (const r of spec.rows) {
    out.push(`${rowMark} ${spec.rowHeading(r)}`, ...spec.rowBody(r), '');
  }
  if (spec.footers && spec.footers.length > 0) {
    out.push(...spec.footers, '');
  }
  return out.join('\n');
}

/**
 * Collect every user-facing string a {@link MarkdownCardListSpec}
 * exposes. Mirrors {@link specStrings} / {@link bulletListSpecStrings}
 * so the wording-alignment lint can call any form uniformly. Excludes
 * the per-row output (dynamic data — `rowHeading` and `rowBody` see
 * each row's data and are NOT static wording) and includes only the
 * static surface: title, preamble, emptyState, and every footer.
 */
export function cardListSpecStrings<TRow>(spec: MarkdownCardListSpec<TRow>): string[] {
  return [spec.title, ...(spec.preamble ?? []), spec.emptyState, ...(spec.footers ?? [])];
}

/** One key-value row consumed by {@link MarkdownKeyValueCardSpec}.
 *  `label` is the static, user-facing field name (caught by the
 *  wording-lint); `value` is dynamic data (may contain inline
 *  markdown like backticks, asterisks, links — the renderer emits
 *  it verbatim with no escaping). */
export interface KeyValueCardRow {
  readonly label: string;
  readonly value: string;
}

/**
 * Typed payload for a tool that renders a `## Title` heading followed
 * by N flush `**Label:** value` rows — the bold-prefix KeyValue card
 * shape used by `module.ts` per-dir, `status.ts` composite card,
 * `session.ts` create/resume cards, and similar dense diagnostic
 * surfaces.
 *
 * Renderer is {@link renderMarkdownKeyValueCard}; output shape is
 * byte-parity (modulo one trailing `\n` from the spec's built-in
 * trailing blank, same convention as {@link renderMarkdownBulletList}
 * and {@link renderMarkdownCardList}) with the pre-migration hand-
 * built `lines.push('**Label:** value')` arrays.
 *
 * Why a sibling spec instead of overloading another shape: KV rows
 * are flush (NO blank line between rows — markdown renders them as a
 * compact metadata block), while bullet-list rows are visually
 * bulleted and card-list rows have per-row headings. Same separation-
 * of-shapes rationale that gave the card-list its own spec in
 * commit `5521fc0`.
 *
 * Pattern NOT supported: inline-`•`-separated KV pairs on ONE line
 * (e.g. `**started:** X  •  **last activity:** Y`). The single
 * consumer (`session.ts > formatResumeReport`) can keep its
 * hand-built one-liner — the lint payoff of splitting that line into
 * three spec rows isn't worth the visual-shape mismatch (it'd render
 * as three vertically-stacked rows, changing the user-visible
 * layout). Migrate only when a second consumer needs the same shape.
 */
export interface MarkdownKeyValueCardSpec {
  /** Top-level heading text — the H2 (or H3 when `headingLevel: 3`)
   *  the agent reads first. The spec OWNS this wording. */
  readonly title: string;
  /** Heading level for {@link title}. Default `2` (renders as `## `).
   *  Set to `3` for embedded sub-section cards composed under a larger
   *  H2 report. */
  readonly headingLevel?: 2 | 3;
  /** Optional prose lines between title and the first KV row — the
   *  "what this card is about" preamble (a paragraph of context, an
   *  italic disclaimer, etc.). Each entry becomes one rendered line;
   *  the renderer adds a trailing blank line before the rows so the
   *  preamble is visually separated. */
  readonly preamble?: ReadonlyArray<string>;
  /** Ordered key-value pairs, presentation order. Each renders as
   *  `**${label}:** ${value}` flush (NO blank between rows). The
   *  caller filters out conditional rows BEFORE constructing the
   *  array — the renderer has no "skip empty value" logic. Empty
   *  array → renderer returns `emptyState` verbatim. */
  readonly rows: ReadonlyArray<KeyValueCardRow>;
  /** Verbatim message when `rows.length === 0`. No heading, no
   *  chrome. The spec OWNS this wording. Pass `''` only when the
   *  caller short-circuits the empty path upstream. */
  readonly emptyState: string;
  /** Footer lines appended after the last KV row, separated by one
   *  blank line. Same rendering convention as the table-spec and
   *  bullet-list-spec footers. Typical use: an italic `_Quoted ..._`
   *  hint or a `> Note: ..._` blockquote pointing at follow-up
   *  actions. */
  readonly footers?: ReadonlyArray<string>;
}

/**
 * Render a {@link MarkdownKeyValueCardSpec} to markdown. Output shape:
 *
 *   ## <title>      (or `###` when `headingLevel: 3`)
 *
 *   <preamble line 1>
 *   <preamble line 2>
 *
 *   **<row 0 label>:** <row 0 value>
 *   **<row 1 label>:** <row 1 value>
 *   …
 *
 *   <footer line 1>
 *   <footer line 2>
 *
 * Empty rows → returns `emptyState` verbatim (no title, no chrome).
 * Rows are flush — no blank between them (the KV block is a compact
 * metadata card, NOT a bullet list). The preamble block is omitted
 * entirely when `preamble` is undefined/empty; same for footers.
 * Trailing `''` (rendered as a trailing newline) matches the outer-
 * composition convention of the bullet-list and card-list renderers.
 */
export function renderMarkdownKeyValueCard(spec: MarkdownKeyValueCardSpec): string {
  if (spec.rows.length === 0) return spec.emptyState;
  const titleMark = (spec.headingLevel ?? 2) === 3 ? '###' : '##';
  const out: string[] = [`${titleMark} ${spec.title}`, ''];
  if (spec.preamble && spec.preamble.length > 0) {
    out.push(...spec.preamble, '');
  }
  for (const r of spec.rows) {
    out.push(`**${r.label}:** ${r.value}`);
  }
  if (spec.footers && spec.footers.length > 0) {
    out.push('', ...spec.footers);
  }
  out.push('');
  return out.join('\n');
}

/**
 * Collect every user-facing string a {@link MarkdownKeyValueCardSpec}
 * exposes. Mirrors {@link specStrings} / {@link bulletListSpecStrings}
 * / {@link cardListSpecStrings} so the wording-alignment lint can
 * call any form uniformly. Includes the static surface: title,
 * preamble, each ROW LABEL (labels are user-facing wording — refactor
 * that renames "Files" to "File count" should fail the lint),
 * emptyState, and every footer. Excludes the row VALUES (dynamic
 * data — counts, lists, formatted strings).
 */
export function keyValueCardSpecStrings(spec: MarkdownKeyValueCardSpec): string[] {
  return [
    spec.title,
    ...(spec.preamble ?? []),
    ...spec.rows.map((r) => r.label),
    spec.emptyState,
    ...(spec.footers ?? []),
  ];
}
