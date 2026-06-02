import { execFileSync } from 'node:child_process';
import { clamp, compact } from '../../utils.js';
import { textResult, truncateOutput, validateStringOutcome } from './shared.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type { ToolCtx } from './types.js';
import { buildReviewContext } from '../../review/index.js';
import type Cartograph from '../../index.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';

/**
 * Preamble blockquote that frames the "Co-change warnings" section.
 * Exported so the wording-lint can pin the load-bearing phrasing
 * ("historically change together … NOT touched in this diff") that
 * defines what the section means — a refactor that loses this phrase
 * silently degrades the agent's understanding of why these rows
 * matter.
 */
export const REVIEW_CONTEXT_COCHANGE_PREAMBLE =
  '> Files that historically change together with a changed file but were NOT touched in this diff.';

/**
 * Max input diff size (1 MB). Real PR diffs routinely exceed the
 * default 4 KB validateStringOutcome cap; 1 MB covers any practical PR
 * while still bounding accidental megabyte-flood inputs.
 */
const MAX_DIFF_BYTES = 1_048_576;

/** Clamp ceiling for `maxCallersPerSymbol` / `maxCalleesPerSymbol`. */
const MAX_CALLERS_CALLEES_PER_SYMBOL = 50;

/** Clamp ceiling for `maxCoChangeWarnings`. */
const MAX_COCHANGE_WARNINGS = 20;

/** Clamp ceiling for `minDiffMagnitude`. Friction-29 gate — above this
 *  ceiling the gate becomes silly (a "real" PR usually trips it). */
const MAX_DIFF_MAGNITUDE = 100_000;

// ---------------------------------------------------------------------------
// Markdown renderer (Friction-21) — every other `cartograph_review` mode
// emits markdown; `context` historically emitted a raw JSON blob with
// opaque `symbolId` hashes. This renders the same structured context as
// a compact markdown report (callers/callees/impact/co-change as bullets).
// ---------------------------------------------------------------------------

/** A reference to another symbol — caller, callee, or broken incoming ref. */
interface MdSymbolRef {
  name: string;
  filePath: string;
  line?: number;
}

interface MdAffectedSymbol {
  name: string;
  kind: string;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature?: string;
  callers: MdSymbolRef[];
  callees: MdSymbolRef[];
  impactCount: number;
  /** When set, this affected entry is a module-level-edit fallback —
   *  the hunks fell outside every symbol body, so the file-kind node
   *  is surfaced with a sibling note. Renderer reads this directly. */
  moduleLevelEditNote?: string;
}

interface MdReviewedFile {
  path: string;
  status: string;
  oldPath?: string;
  affectedSymbols: MdAffectedSymbol[];
  tests: string[];
  brokenIncomingRefs?: MdSymbolRef[];
}

interface MdCoChangeWarning {
  changedFile: string;
  expectedToChange: string;
  jaccard: number;
  anchorRatio?: number;
  historicalCount: number;
  note: string;
}

/** Structural shape of `buildReviewContext`'s return value, as
 *  consumed by {@link renderReviewContextMarkdown}. Exported for tests. */
export interface MdReviewContext {
  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    filesRenamed: number;
    symbolsAffected: number;
    coChangeWarnings: number;
  };
  files: MdReviewedFile[];
  coChangeWarnings: MdCoChangeWarning[];
}

/** Render a `name (path:line)` reference; line is omitted when absent. */
function fmtRef(r: MdSymbolRef): string {
  const loc = r.line == null ? '' : `:${r.line}`;
  return `\`${r.name}\` (${r.filePath}${loc})`;
}

/** Render a capped, comma-joined bullet of callers/callees. */
function fmtRefList(label: string, refs: MdSymbolRef[]): string | null {
  if (refs.length === 0) return null;
  return `  - ${label}: ${refs.map(fmtRef).join(', ')}`;
}

/** Render one affected symbol as a markdown sub-section. */
function renderAffectedSymbol(s: MdAffectedSymbol): string[] {
  const lines: string[] = [];
  const sig = s.signature ? ` — \`${s.signature}\`` : '';
  lines.push(`- **${s.name}** (${s.kind}) — lines ${s.startLine}-${s.endLine}${sig}`);
  if (s.moduleLevelEditNote) lines.push(`  - _${s.moduleLevelEditNote}_`);
  const callers = fmtRefList(`callers (${s.callers.length})`, s.callers);
  if (callers) lines.push(callers);
  const callees = fmtRefList(`callees (${s.callees.length})`, s.callees);
  if (callees) lines.push(callees);
  if (s.impactCount > 0) lines.push(`  - impact radius: ${s.impactCount} symbol${s.impactCount === 1 ? '' : 's'}`);
  return lines;
}

/** Render one reviewed file as a markdown section. */
function renderReviewedFile(f: MdReviewedFile): string[] {
  const lines: string[] = [];
  const renamed = f.oldPath ? ` (was \`${f.oldPath}\`)` : '';
  lines.push(`### \`${f.path}\` — ${f.status}${renamed}`);
  if (f.affectedSymbols.length === 0) {
    lines.push("_No indexed symbols overlap this file's hunks._");
  } else {
    for (const s of f.affectedSymbols) lines.push(...renderAffectedSymbol(s));
  }
  if (f.tests.length > 0) {
    const testList = f.tests.map((t) => `\`${t}\``).join(', ');
    lines.push(`- _Covering tests: ${testList}_`);
  }
  if (f.brokenIncomingRefs && f.brokenIncomingRefs.length > 0) {
    lines.push(`- ⚠ Broken incoming refs (symbols vanish on delete): ${f.brokenIncomingRefs.map(fmtRef).join(', ')}`);
  }
  lines.push('');
  return lines;
}

/**
 * Build the "Co-change warnings" H2 bullet-list spec. Each warning
 * renders as `- \`expectedToChange\` — co-changes with
 * \`changedFile\` (jaccard X.XX[, anchor-ratio X.XX], N shared
 * commit(s))` with an optional indented `  - ${note}` continuation
 * when the upstream warning carries a per-row note.
 *
 * Caller (`renderReviewContextMarkdown`'s spreader) short-circuits
 * with an empty array when `warnings.length === 0` BEFORE invoking
 * this builder, so the spec's `emptyState: ''` is the never-rendered
 * empty string.
 *
 * NOTE: the per-file `renderReviewedFile` section in this file is
 * shape-disqualified for the existing card-list spec — each file
 * carries its own H3 heading but the pre-migration shape has NO
 * outer H2 container (files sit directly under the # Review
 * context H1). Same family of disqualifier as `_walk.ts`'s
 * flat-text-header; queued for a future spec extension.
 */
export function buildReviewContextCoChangeWarningsSpec(
  warnings: ReadonlyArray<MdCoChangeWarning>,
): MarkdownBulletListSpec<MdCoChangeWarning> {
  return {
    title: 'Co-change warnings',
    preamble: [REVIEW_CONTEXT_COCHANGE_PREAMBLE],
    rows: warnings,
    formatRow: (w) => {
      const anchor = w.anchorRatio == null ? '' : `, anchor-ratio ${w.anchorRatio.toFixed(2)}`;
      const bullet =
        `- \`${w.expectedToChange}\` — co-changes with \`${w.changedFile}\` ` +
        `(jaccard ${w.jaccard.toFixed(2)}${anchor}, ${w.historicalCount} shared commit${w.historicalCount === 1 ? '' : 's'})`;
      return w.note ? [bullet, `  - ${w.note}`] : bullet;
    },
    emptyState: '',
  };
}

/** Render the co-change warnings section. */
function renderCoChangeWarnings(warnings: MdCoChangeWarning[]): string[] {
  if (warnings.length === 0) return [];
  return [renderMarkdownBulletList(buildReviewContextCoChangeWarningsSpec(warnings))];
}

/** Render the structured review context as a markdown report.
 *  Exported for unit testing. */
export function renderReviewContextMarkdown(context: MdReviewContext): string {
  const { summary } = context;
  const lines: string[] = ['# Review context', ''];
  const fileCount = summary.filesAdded + summary.filesModified + summary.filesDeleted + summary.filesRenamed;
  // The add/modify/delete/rename counts are FILE counts, not a
  // breakdown of `symbolsAffected`. Bracket them under an explicit
  // "across N changed files" label so the line can't be misread as a
  // symbol breakdown that doesn't sum (audit-4 group-3 #6).
  lines.push(
    `**${summary.symbolsAffected}** symbol${summary.symbolsAffected === 1 ? '' : 's'} affected ` +
      `across **${fileCount}** changed file${fileCount === 1 ? '' : 's'} ` +
      `(${summary.filesAdded} added · ${summary.filesModified} modified · ` +
      `${summary.filesDeleted} deleted · ${summary.filesRenamed} renamed) · ` +
      `${summary.coChangeWarnings} co-change warning${summary.coChangeWarnings === 1 ? '' : 's'}.`,
  );
  // "0 symbols affected · 1 modified" reads as a contradiction on its
  // own (audit #27). It is NOT a bug — the diff's hunks fell entirely
  // outside any indexed symbol body (comment / import / blank-line
  // edits, or files the index doesn't cover). Spell that out so the
  // headline isn't read as inconsistent with the file count below.
  if (summary.symbolsAffected === 0 && fileCount > 0) {
    lines.push(
      '',
      `_0 symbols affected despite ${fileCount} changed file${fileCount === 1 ? '' : 's'}: ` +
        'the diff hunks fall outside any indexed symbol body (comment / import / whitespace edits, ' +
        'or files not covered by the index). See the per-file sections below._',
    );
  }
  lines.push('');
  for (const f of context.files) lines.push(...renderReviewedFile(f));
  lines.push(...renderCoChangeWarnings(context.coChangeWarnings));
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * Derive a unified diff from `git diff HEAD` (working tree vs HEAD)
 * when the caller omitted `diff`. Mirrors the git-derivation fallback
 * `cartograph_affected` / `cartograph_tests_for` already do for their
 * `files` arg — `review context` is the natural "review my working
 * changes" tool and should not hard-error on a missing `diff`.
 *
 * Returns the diff text (possibly empty on a clean tree) on success,
 * or `null` when git is unavailable / there is no HEAD ref.
 */
function deriveDiffFromGit(rootDir: string): string | null {
  try {
    return execFileSync('git', ['diff', 'HEAD'], {
      cwd: rootDir,
      encoding: 'utf-8',
      timeout: 10_000,
      maxBuffer: MAX_DIFF_BYTES,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

/** Resolve the effective diff. Returns the diff string, or a
 *  {@link ToolOutcome} carrying an actionable message when the diff is
 *  unavailable (omitted + clean tree, omitted + no git, malformed). */
function resolveDiff(args: Record<string, unknown>, cg: Cartograph): string | ToolOutcome {
  const raw = args['diff'];
  // Treat omitted / null / blank as "derive from git" — the CLI mirror
  // pipes an empty stdin string through when no diff-file is given, so
  // a whitespace-only diff is the same omitted signal.
  const omitted = raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
  if (omitted) {
    const derived = deriveDiffFromGit(cg.projectRoot);
    if (derived === null) {
      return err(
        'No `diff` was passed and `git diff HEAD` could not be run (git unavailable or no HEAD ref). ' +
          'Pass `diff:` — e.g. the output of `git diff` or `gh pr diff <n>`.',
      );
    }
    if (derived.trim() === '') {
      return ok(
        textResult(
          '## Review context\n\n' +
            '_No uncommitted changes — nothing to review._\n\n' +
            'Pass `diff:` explicitly (e.g. `git diff HEAD~1` or `gh pr diff <n>`), or edit / stage changes and try again.',
        ),
      );
    }
    return derived;
  }
  // diff was passed — validate it the normal way.
  const validated = validateStringOutcome({ value: raw, name: 'diff', maxLength: MAX_DIFF_BYTES });
  return validated;
}

export async function handleReviewContext(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);

  // Friction-22: `diff` is optional — when omitted, derive it from
  // `git diff HEAD`, matching `cartograph_affected` / `_tests_for`.
  const resolved = resolveDiff(args, cg);
  if (typeof resolved !== 'string') return resolved;
  const diff = resolved;

  const context = buildReviewContext(
    diff,
    { queries: cg.queries, traverser: cg.internals.traverser },
    compact({
      maxCallersPerSymbol:
        args['maxCallersPerSymbol'] == null
          ? undefined
          : clamp(Number(args['maxCallersPerSymbol']), 0, MAX_CALLERS_CALLEES_PER_SYMBOL),
      maxCalleesPerSymbol:
        args['maxCalleesPerSymbol'] == null
          ? undefined
          : clamp(Number(args['maxCalleesPerSymbol']), 0, MAX_CALLERS_CALLEES_PER_SYMBOL),
      maxCoChangeWarnings:
        args['maxCoChangeWarnings'] == null
          ? undefined
          : clamp(Number(args['maxCoChangeWarnings']), 0, MAX_COCHANGE_WARNINGS),
      minCoChangeJaccard:
        args['minCoChangeJaccard'] == null ? undefined : clamp(Number(args['minCoChangeJaccard']), 0, 1),
      minDiffMagnitude:
        args['minDiffMagnitude'] == null ? undefined : clamp(Number(args['minDiffMagnitude']), 0, MAX_DIFF_MAGNITUDE),
    }),
  );

  if (context.summary.symbolsAffected === 0 && context.files.length === 0) {
    return ok(
      textResult(
        'No indexed symbols overlap the diff hunks. Either the affected files are not indexed, the diff is empty, or it touches files that were added/deleted entirely.',
      ),
    );
  }

  // Friction-21: render markdown like every other `cartograph_review`
  // mode (`risk`, `neighbors`) instead of a raw JSON blob.
  return ok(textResult(truncateOutput(renderReviewContextMarkdown(context as MdReviewContext))));
}
