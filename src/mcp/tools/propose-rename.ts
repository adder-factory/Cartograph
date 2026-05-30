/**
 * `cartograph_propose_rename({symbol, newName})` — half of #17 (the
 * rename half; extract was descoped). Pure query wrapper that
 * collects every site that needs to change when renaming a symbol,
 * stamping per-site confidence so the agent knows which edits are
 * safe to apply mechanically vs need a human eye.
 *
 * Output sections:
 *
 *  1. **Call sites (graph edges)** — every incoming edge from
 *     callers / type-users / instantiators. Confidence comes from
 *     the new edges.confidence column (#8 / B8): EXTRACTED rows
 *     are concrete imports, INFERRED rows are heuristic same-name
 *     matches, AMBIGUOUS rows had a tied runner-up. EXTRACTED
 *     rows can be renamed mechanically; INFERRED needs a glance;
 *     AMBIGUOUS needs a careful look.
 *
 *  2. **Doc / comment / string mentions** — `\bname\b` regex grep
 *     across the indexed file set, attributed to enclosing symbol.
 *     These don't have edge-confidence (they're not graph edges)
 *     so they're labelled as "textual" — agent should review case-
 *     by-case (renaming a variable named `id` would also touch
 *     unrelated `id` mentions in JSDoc).
 *
 *  3. **Definition site(s)** — the symbol's own declaration. If
 *     multiple definitions resolve to the same name (overloads,
 *     re-exports), all are listed.
 *
 *  4. **Validation** — `newName` is checked for collision with an
 *     existing symbol AND for valid-identifier shape. Both warn
 *     (don't fail) so the agent can decide.
 *
 * No file I/O for the rename itself — this is a PLAN, not an
 * executor. The caller (agent or human) reads the plan and applies
 * the edits with whatever tool they prefer.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type { Edge, Node } from '../../types.js';
import { identifierBoundaryRegex, validatePathWithinRootReal } from '../../utils.js';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getAllFiles } from '../../db/queries-files.js';
import { renderToolResponse } from './_response.js';
import { findAllSymbols, notFoundMessage } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/** Cap on rendered call-site rows. Higher would drown the agent. */
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;

/** Cap on rendered doc/comment hit rows (each typically less actionable than a graph edge). */
const DEFAULT_DOC_LIMIT = 30;

/** Skip files larger than this when scanning for textual mentions. */
const MAX_FILE_BYTES = 1_000_000; // 1 MiB

interface CallSite {
  callerNode: Node;
  edge: Edge;
}

interface DocHit {
  file: string;
  line: number;
  enclosing: string | null;
  text: string;
}

/**
 * Word-boundary identifier check. Most languages we index treat
 * identifiers as `[A-Za-z_][A-Za-z0-9_]*`; the validator is
 * permissive (allow Unicode letters / `$` for JS) so a perfectly
 * valid Python class name like `Élément` doesn't false-positive.
 * Returns the reason when invalid, or null when ok.
 */
function validateIdentifier(name: string): string | null {
  if (name.length === 0) return 'newName must be non-empty';
  if (name.length > 200) return 'newName looks suspiciously long (> 200 chars)';
  // First char: letter / underscore / dollar / unicode letter.
  // Subsequent: same plus digit. Whitespace / punctuation always rejected.
  if (!/^[A-Za-z_$\p{L}][\w$\p{L}\p{N}]*$/u.test(name)) {
    return `newName "${name}" is not a valid identifier (must start with letter/underscore/$, contain only letters/digits/underscore)`;
  }
  return null;
}

/** Identifier-token regex over the symbol name (global). Escapes
 *  metachars and uses `$`-safe boundaries so a name ending in `$`
 *  (RxJS `data$`) still matches every call site. */
function buildWordBoundaryRegex(name: string): RegExp {
  return identifierBoundaryRegex(name, 'g');
}

/** Ordering for confidence-first call-site sort. */
const CONF_RANK = { EXTRACTED: 2, INFERRED: 1, AMBIGUOUS: 0 } as const;

/**
 * Build the warnings list for a rename: invalid-identifier shape and
 * collision with an existing indexed symbol. Both are advisory — they
 * don't block the rename, just surface in the report header.
 */
function buildRenameWarnings(
  cg: import('../../index.js').default,
  newName: string,
  refIds: import('./_id-cache.js').RefIdCache | undefined,
): string[] {
  const warnings: string[] = [];
  const idError = validateIdentifier(newName);
  if (idError) warnings.push(`⚠ ${idError}`);
  const existingWithNewName = findAllSymbols(cg, newName, refIds);
  if (existingWithNewName.nodes.length > 0) {
    const sample = existingWithNewName.nodes
      .slice(0, 3)
      .map((n) => `\`${n.filePath}:${n.startLine}\` (${n.kind})`)
      .join(', ');
    warnings.push(
      `⚠ \`${newName}\` already exists as ${existingWithNewName.nodes.length} symbol(s): ${sample}. ` +
        'Renaming would collide; consider a different name or accept the shadow.',
    );
  }
  return warnings;
}

/**
 * Walk every match's incoming edges, dedup by (caller, target, kind,
 * line), and sort confidence-first so EXTRACTED rows lead the report.
 *
 * Filters out two classes of noise that are NOT rename edit sites:
 *  - `contains` edges (file → symbol parent edge; structural, not a call).
 *  - Self-loops (source === target) — typically intra-procedural
 *    `def_use` data-flow edges where the symbol's own body references
 *    itself; renaming the def already covers the source code, there's
 *    no separate call site to edit.
 */
function collectCallSites(cg: import('../../index.js').default, matches: readonly Node[]): CallSite[] {
  const callSites: CallSite[] = [];
  const seenCallerKey = new Set<string>();
  for (const node of matches) {
    for (const edge of getIncomingEdges(cg.queries, node.id)) {
      if (edge.kind === 'contains') continue;
      if (edge.source === edge.target) continue;
      const caller = cg.queries.getNodeById(edge.source);
      if (!caller) continue;
      const key = `${caller.id}:${node.id}:${edge.kind}:${edge.line ?? 0}`;
      if (seenCallerKey.has(key)) continue;
      seenCallerKey.add(key);
      callSites.push({ callerNode: caller, edge });
    }
  }
  callSites.sort((a, b) => {
    const ca = CONF_RANK[a.edge.confidence ?? 'EXTRACTED'];
    const cb = CONF_RANK[b.edge.confidence ?? 'EXTRACTED'];
    if (ca !== cb) return cb - ca;
    return a.callerNode.filePath.localeCompare(b.callerNode.filePath);
  });
  return callSites;
}

/**
 * Word-boundary regex grep across indexed files for a symbol mention.
 * Bounded by `docLimit`. Skips the symbol's own definition lines (the
 * report's "Definitions" section already covers them) and files
 * larger than {@link MAX_FILE_BYTES}.
 */
interface ScanFileMentionsArgs {
  cg: import('../../index.js').default;
  filePath: string;
  src: string;
  regex: RegExp;
  matches: readonly Node[];
  scopes: Array<{ id: string; start: number; end: number }>;
  findEnclosingNode: (scopes: Array<{ id: string; start: number; end: number }>, line: number) => string | null;
  out: DocHit[];
  docLimit: number;
}

/** Walk one file's lines and append qualifying mentions to `out`.
 *  Returns true when the global doc-limit is hit (caller short-circuits
 *  the outer file loop). Pulled out of {@link scanDocMentions} so the
 *  per-file IO + line walk don't pile complexity into the outer
 *  function. */
function scanFileForMentions(args: ScanFileMentionsArgs): boolean {
  const { cg, filePath, src, regex, matches, scopes, findEnclosingNode, out, docLimit } = args;
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    regex.lastIndex = 0;
    if (!regex.test(line)) continue;
    // Skip the symbol's own definition lines — the report's
    // "Definitions" section already covers them.
    if (
      matches.some(
        (n) => n.filePath === filePath && i + 1 >= n.startLine && i + 1 <= n.endLine && n.startLine === i + 1,
      )
    ) {
      continue;
    }
    const enclosingId = findEnclosingNode(scopes, i + 1);
    const enclosingName = enclosingId ? (cg.queries.getNodeById(enclosingId)?.name ?? null) : null;
    const snippet = line.length > 200 ? line.slice(0, 200) + ' …' : line;
    out.push({
      file: filePath,
      line: i + 1,
      enclosing: enclosingName,
      text: snippet.trim(),
    });
    if (out.length >= docLimit) return true;
  }
  return false;
}

interface ScanDocMentionsArgs {
  cg: import('../../index.js').default;
  symbol: string;
  matches: readonly Node[];
  docLimit: number;
}

async function scanDocMentions(args: ScanDocMentionsArgs): Promise<DocHit[]> {
  const { cg, symbol, matches, docLimit } = args;
  const docHits: DocHit[] = [];
  if (docLimit <= 0) return docHits;
  const { readFile, stat } = await import('node:fs/promises');
  const { findEnclosingNode, sortScopesBySpan } = await import('../../index-hooks/enclosing.js');
  const regex = buildWordBoundaryRegex(symbol);
  const enclosingCache = new Map<string, Array<{ id: string; start: number; end: number }>>();

  for (const f of getAllFiles(cg.queries)) {
    const absPath = validatePathWithinRootReal(cg.projectRoot, f.path);
    if (!absPath) continue;
    let src: string;
    try {
      const fileStat = await stat(absPath);
      if (fileStat.size > MAX_FILE_BYTES) continue;
      src = await readFile(absPath, 'utf8');
    } catch {
      continue;
    }
    if (!src.includes(symbol)) continue;

    let scopes = enclosingCache.get(f.path);
    if (!scopes) {
      scopes = sortScopesBySpan(
        cg.queries
          .getNodesByFile(f.path)
          .filter((n) => ['function', 'method', 'class', 'interface'].includes(n.kind))
          .map((n) => ({ id: n.id, start: n.startLine, end: n.endLine })),
      );
      enclosingCache.set(f.path, scopes);
    }

    const reachedLimit = scanFileForMentions({
      cg,
      filePath: f.path,
      src,
      regex,
      matches,
      scopes,
      findEnclosingNode,
      out: docHits,
      docLimit,
    });
    if (reachedLimit) break;
  }
  return docHits;
}

/**
 * Drop doc hits whose `(file, line)` collides with a graph call site
 * — graph edges are the higher-quality signal, so surfacing the same
 * line in both sections wastes context.
 */
function filterDocHitsAgainstCallSites(docHits: readonly DocHit[], callSites: readonly CallSite[]): DocHit[] {
  const callSiteKeys = new Set(callSites.map((c) => `${c.callerNode.filePath}:${c.edge.line ?? 0}`));
  return docHits.filter((h) => !callSiteKeys.has(`${h.file}:${h.line}`));
}

/**
 * Zod schema for `cartograph_propose_rename`.
 *
 * `limit` (`.int().min(1).max(500)`) and `docLimit` (`.int().min(0).max(500)`)
 * are REJECTED out of range at the dispatch boundary (locked
 * reject-out-of-range decision) — so the handler's old `clamp` calls
 * and the "requested N, capped at MAX" notices are gone. `docLimit`'s
 * floor is 0 (the documented "pass 0 to skip the doc scan" shape).
 */
const proposeRenameSchema = z.object({
  symbol: z.string().describe('Current symbol name to rename.'),
  newName: z
    .string()
    .describe(
      'Proposed new name. Checked for identifier shape + collisions with existing symbols (warnings, not blocks).',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_LIMIT)
    .default(DEFAULT_LIMIT)
    .describe(
      'Max call sites to render (default 50, max 500). Sorted EXTRACTED-first so truncation drops lowest-confidence last.',
    ),
  docLimit: z
    .number()
    .int()
    .min(0)
    .max(MAX_LIMIT)
    .default(DEFAULT_DOC_LIMIT)
    .describe('Max textual mentions to render (default 30, max 500). Pass 0 to skip the doc scan.'),
  projectPath: projectPathField,
});

type ProposeRenameArgs = z.infer<typeof proposeRenameSchema>;

async function handleProposeRename(ctx: ToolCtx, args: ProposeRenameArgs): Promise<ToolOutcome> {
  const { symbol, newName } = args;
  const cg = ctx.getCartograph(args.projectPath);
  // `limit` / `docLimit` are already in range — Zod's `.int().min().max()`
  // rejected anything else at the dispatch boundary. No clamp needed.
  const limit = args.limit;
  const docLimit = args.docLimit;

  if (symbol === newName) {
    return err(`symbol === newName ("${symbol}") — no rename to plan.`);
  }

  const matches = findAllSymbols(cg, symbol, ctx.refIds);
  if (matches.nodes.length === 0) {
    // err arm (not the ok/textResult arm) so runViaMCP flips the CLI exit
    // code to 1 — "printed an error" ⇒ "exited non-zero" (audit-4 group-3 #3).
    return err(notFoundMessage(cg, symbol));
  }

  const warnings = buildRenameWarnings(cg, newName, ctx.refIds);
  const callSites = collectCallSites(cg, matches.nodes);
  const docHits = await scanDocMentions({ cg, symbol, matches: matches.nodes, docLimit });
  const filteredDocHits = filterDocHitsAgainstCallSites(docHits, callSites);

  return ok(
    renderToolResponse({
      body: formatReport({
        symbol,
        newName,
        defs: matches.nodes,
        callSites,
        docHits: filteredDocHits,
        warnings,
        limit,
        docLimit,
      }),
    }),
  );
}

interface FormatReportOpts {
  symbol: string;
  newName: string;
  defs: readonly Node[];
  callSites: readonly CallSite[];
  docHits: readonly DocHit[];
  warnings: readonly string[];
  limit: number;
  docLimit: number;
}

function appendWarningsSection(out: string[], warnings: readonly string[]): void {
  if (warnings.length === 0) return;
  out.push('### Warnings', '');
  for (const w of warnings) out.push(`- ${w}`);
  out.push('');
}

function appendDefinitionsSection(out: string[], defs: readonly Node[]): void {
  out.push('### Definitions', '');
  for (const d of defs) {
    const loc = d.startLine ? `:${d.startLine}` : '';
    out.push(`- \`${d.filePath}${loc}\` (${d.kind})`);
  }
  out.push('');
}

const CALL_SITE_CONFIDENCE_NOUN: Record<string, string> = {
  EXTRACTED: '*concrete; safe to rename mechanically*',
  INFERRED: '*heuristic; glance before applying*',
  AMBIGUOUS: '*ambiguous; verify the target before renaming*',
};

/** Render the `:N` line suffix for a call-site link, falling back to the
 *  caller's start-line when the edge has no line (older indexes). */
function formatCallSiteLoc(c: CallSite): string {
  const edgeLine = c.edge.line;
  if (edgeLine) return `:${edgeLine}`;
  const callerLine = c.callerNode.startLine;
  if (callerLine) return `:${callerLine}`;
  return '';
}

function appendCallSitesSection(out: string[], callSites: readonly CallSite[], limit: number): void {
  if (callSites.length === 0) {
    out.push('### Call sites', '', '_No call sites found in the indexed graph._', '');
    return;
  }
  out.push('### Call sites', '');
  const shown = callSites.slice(0, limit);
  let lastConf: string | null = null;
  for (const c of shown) {
    const conf = (c.edge.confidence ?? 'EXTRACTED') as string;
    if (conf !== lastConf) {
      const noun = CALL_SITE_CONFIDENCE_NOUN[conf] ?? CALL_SITE_CONFIDENCE_NOUN['AMBIGUOUS']!;
      out.push(`#### ${conf} ${noun}`, '');
      lastConf = conf;
    }
    const loc = formatCallSiteLoc(c);
    out.push(
      `- \`${c.callerNode.filePath}${loc}\` — \`${c.callerNode.name}\` (${c.callerNode.kind}) via \`${c.edge.kind}\``,
    );
  }
  if (callSites.length > limit) {
    out.push(
      '',
      `> _Showing ${shown.length} of ${callSites.length} call sites — ${callSites.length - limit} elided. Pass a higher \`limit\` to see them all._`,
    );
  }
  out.push('');
}

function appendDocHitsSection(out: string[], docHits: readonly DocHit[], docLimit: number): void {
  if (docHits.length === 0) return;
  out.push('### Textual mentions (doc / comment / strings)', '');
  out.push(
    '_These are word-boundary regex matches outside the graph edges above — JSDoc references, ' +
      'string literals, comment mentions. Review case-by-case: not every match is the same symbol._',
    '',
  );
  const shown = docHits.slice(0, docLimit);
  for (const h of shown) {
    const where = h.enclosing ? ` in \`${h.enclosing}\`` : '';
    out.push(`- \`${h.file}:${h.line}\`${where}: \`${h.text}\``);
  }
  if (docHits.length > docLimit) {
    out.push(
      '',
      `> _${docHits.length - docLimit} more textual mentions elided. Pass a higher \`docLimit\` to see them._`,
    );
  }
  out.push('');
}

function formatReport(opts: FormatReportOpts): string {
  const { symbol, newName, defs, callSites, docHits, warnings, limit, docLimit } = opts;
  const lines: string[] = [
    `## Rename plan: \`${symbol}\` → \`${newName}\``,
    '',
    `- **Definitions:** ${defs.length}`,
    `- **Call sites (graph edges):** ${callSites.length}`,
    `- **Textual mentions (doc/comment/strings):** ${docHits.length}`,
    '',
  ];

  appendWarningsSection(lines, warnings);
  appendDefinitionsSection(lines, defs);
  appendCallSitesSection(lines, callSites, limit);
  appendDocHitsSection(lines, docHits, docLimit);

  // Suggested workflow footer.
  lines.push(
    '---',
    '',
    `> **Suggested workflow:** apply EXTRACTED edits mechanically (Edit tool with replace_all=false ` +
      `per file or sed for bulk), review INFERRED / AMBIGUOUS edits per-line, then read each textual ` +
      `mention to confirm it's the same symbol before renaming. Re-run \`cartograph_propose_rename\` ` +
      `after applying to confirm zero remaining call sites.`,
  );

  return lines.join('\n');
}

export const PROPOSE_RENAME_TOOL = defineTool({
  name: 'cartograph_propose_rename',
  description:
    'Plan a symbol rename — call sites, doc/string mentions, definitions. Returns a plan, does NOT edit.\n\n' +
    'Sites grouped `EXTRACTED` (mechanical) / `INFERRED` (verify) / `AMBIGUOUS` (review); doc mentions are word-boundary regex (review-required). ' +
    'Validates `newName` for collisions + identifier shape (non-blocking warnings).',
  schema: proposeRenameSchema,
  handle: handleProposeRename,
});
