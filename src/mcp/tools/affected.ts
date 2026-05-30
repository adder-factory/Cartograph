/**
 * `cartograph_affected` — given a set of changed source files, return
 * the test files that transitively depend on any of them.
 *
 * Mirrors the `cartograph affected` CLI for the agent surface so a
 * post-edit reactive workflow ("which tests should I re-run?") doesn't
 * require shelling out to the CLI. The test-file decision + BFS walk
 * live in the shared `affected-core` module so both surfaces classify
 * identically; this file keeps only the MCP-specific arg-parsing,
 * git-derivation, and markdown formatting.
 */
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { errMsg } from '../../errors.js';
import { globToSafeRegex } from '../../utils.js';
import { editDistance } from '../../text-distance.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type Cartograph from '../../index.js';
import { listChangedFilesSince } from '../../git-utils.js';
import { whatChanged } from '../../change-oracle/index.js';
import {
  type AffectedCoreInput,
  type AffectedTestsResult,
  DEFAULT_DEPTH,
  buildIndexedPathSets,
  findAffectedTests,
} from '../../affected-core.js';

/**
 * Hard ceiling on the BFS `depth` arg. The CLI `--depth` uses
 * `{ min: 1 }` only (no max); a generous 50 max here rejects clearly
 * nonsensical values (negative, zero, runaway) while never trimming a
 * realistic dependents walk — cartograph's deepest indexed projects
 * fan out far below 50 hops.
 */
const MAX_DEPTH = 50;

/**
 * Zod schema for `cartograph_affected`. `depth` is `.int().min(1).max(50)`
 * — an out-of-range or non-integer value is REJECTED at the dispatch
 * boundary (the locked reject-out-of-range decision), never floored /
 * defaulted. The handler therefore drops the old `parseDepth` clamp.
 *
 * `files` stays a plain optional string array — the handler's
 * `parseFiles` keeps the omitted-vs-empty distinction (Friction-Y) and
 * the per-entry non-empty check, so the schema only asserts the array
 * shape and leaves the semantic checks to the handler.
 */
const affectedSchema = z.object({
  files: z
    .array(z.string())
    .optional()
    .describe(
      'Project-relative source paths to find affected tests for. ' +
        'When omitted, the set is derived from `git diff HEAD` (clean tree returns a friendly hint).',
    ),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPTH)
    .default(DEFAULT_DEPTH)
    .describe('Max BFS depth through dependents. Default 5, range 1-50.'),
  filter: z
    .string()
    .optional()
    .describe(
      'Custom glob overriding the default test-file detection. ' +
        'When omitted, common test paths are matched: .spec. / .test. / __tests__/ / tests/ / e2e/ / spec/.',
    ),
  projectPath: projectPathField,
});

type AffectedToolArgs = z.infer<typeof affectedSchema>;

/**
 * Default cap on the affected-test rows rendered in the report. When an
 * edited leaf module re-exports through a public-API barrel the BFS can
 * fan out to ~half the suite; dumping every row uncapped buries the
 * signal. The cap is applied after sorting, with a "showing first N of
 * M" footer so the agent knows the list was trimmed.
 */
const DEFAULT_ROW_LIMIT = 40;

interface AffectedArgs extends AffectedCoreInput {
  /**
   * Input file paths that the index doesn't know about. Preserved on
   * the args bundle so {@link formatResult} can render the warning
   * footer. Empty in the happy-path case.
   */
  missingInputs: string[];
  /**
   * True when `files` was omitted and the set was derived from
   * `git diff HEAD` (working tree vs HEAD, plus untracked). Surfaces
   * in the formatter footer so the agent can see which mode ran.
   * Friction-Y (2026-05-14).
   */
  derivedFromGit: boolean;
}

/**
 * Sentinel returned by parseArgs when `files` was omitted AND the
 * git-derived set is empty. NOT an error — a friendly hint that the
 * caller has nothing to re-test (clean tree). Distinct shape so the
 * handler can short-circuit before BFS.
 */
interface NoUncommittedChanges {
  noUncommittedChanges: true;
}

/**
 * Parses an explicit `files` argument. Returns `null` when the caller
 * omitted the arg entirely (signal to derive from git in the caller).
 * Returns an error result when the arg was passed but malformed
 * (wrong type, empty array, non-string entries).
 *
 * Distinguishing omitted-vs-empty is deliberate (Friction-Y,
 * 2026-05-14): omitted = "tell me what changed on disk", empty array
 * = "I tried to pass a list but got nothing" which is more likely a
 * caller bug than a clean-tree signal.
 */
function parseFiles(raw: unknown): { ok: true; value: string[] } | { ok: 'omitted' } | { ok: false; error: string } {
  // Treat null as omitted to match MCP clients that serialise
  // omitted-optional as JSON null. JSON Schema's `nullable` interop
  // varies across clients; collapsing null → omitted gives them the
  // git-derivation path instead of a "non-empty string array" error.
  if (raw === undefined || raw === null) return { ok: 'omitted' };
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: '`files` must be a non-empty string array' };
  }
  const out: string[] = [];
  for (const f of raw) {
    if (typeof f !== 'string' || f.length === 0) {
      return { ok: false, error: '`files` entries must be non-empty strings' };
    }
    out.push(f);
  }
  return { ok: true, value: out };
}

/**
 * Derives the changed-file set from `git diff HEAD` (working tree
 * vs HEAD, plus untracked). Filters to files the index knows about
 * so we don't waste BFS work on files cartograph has never seen.
 *
 * Returns `null` when git is unavailable / repo not found (caller
 * surfaces a friendly error instead of "missing arg"). Returns an
 * empty array when git works but the tree is clean.
 *
 * Friction-Y note: deliberately uses the git path rather than
 * `orchestrator.getChangedFiles()` to avoid surfacing the
 * `needs_reextract` heal-flagged file set. Heal-flagged files have
 * no on-disk drift so they don't belong in the affected-tests
 * workflow.
 */
function deriveFilesFromGit(
  cg: Cartograph,
  allIndexedPaths: Set<string>,
): { ok: true; value: string[] } | { ok: false; error: string } {
  const changed = listChangedFilesSince(cg.projectRoot, 'HEAD');
  if (changed === null) {
    return {
      ok: false,
      error:
        'Could not derive changed files from git (git unavailable or no HEAD ref). Pass `files: [...]` explicitly.',
    };
  }
  // Filter to indexed paths only — unindexed working-tree files
  // (e.g. README edits, untracked logs) have no graph edges to walk.
  const filtered = changed.filter((p) => allIndexedPaths.has(p));
  return { ok: true, value: filtered };
}

/**
 * Maximum normalised edit distance (distance / longer-string length) a
 * candidate may have from the input before it stops being a plausible
 * "did you mean". Without this floor `suggestPaths` returned the top-K
 * by RAW distance even when every indexed path was wildly different
 * from the input — suggesting unrelated files for a hopeless typo
 * (audit #24). 0.4 keeps genuine typos (a few wrong chars in a long
 * path) while rejecting same-length-but-unrelated coincidences.
 */
const SUGGEST_MAX_NORM_DISTANCE = 0.4;

/** The basename of a project-relative path (segment after the last `/`). */
function pathBasename(p: string): string {
  const slash = p.lastIndexOf('/');
  return slash >= 0 ? p.slice(slash + 1) : p;
}

/**
 * Top-K nearest paths to a missing input, used when every input is
 * unindexed and we error out. Cheap — only fires on the all-missing
 * degenerate case so we don't pay scan cost on the happy path.
 *
 * Relevance, not just proximity: a candidate must be within
 * {@link SUGGEST_MAX_NORM_DISTANCE} on EITHER the full path OR the
 * basename. Scoring takes the better (lower) of the two normalised
 * distances so `src/a/foo.ts` is still suggested for a `foo.ts` input
 * typed without its directory. Candidates past the floor on both axes
 * are dropped entirely — an empty result yields no misleading "did you
 * mean" line rather than three unrelated paths.
 */
function suggestPaths(target: string, indexed: ReadonlyArray<string>, k: number): string[] {
  const tl = target.toLowerCase();
  const tlBase = pathBasename(tl);
  const scored: Array<{ p: string; score: number }> = [];
  for (const p of indexed) {
    const pl = p.toLowerCase();
    const fullNorm = normalisedEditDistance(tl, pl);
    const baseNorm = normalisedEditDistance(tlBase, pathBasename(pl));
    const score = Math.min(fullNorm, baseNorm);
    if (score > SUGGEST_MAX_NORM_DISTANCE) continue;
    scored.push({ p, score });
  }
  scored.sort((a, b) => a.score - b.score || a.p.localeCompare(b.p));
  return scored.slice(0, k).map((s) => s.p);
}

/** Levenshtein distance normalised to [0, 1] by the longer string's
 *  length — so a 2-char typo in a 40-char path scores far closer than
 *  a 2-char typo in a 5-char path. */
function normalisedEditDistance(a: string, b: string): number {
  const longer = Math.max(a.length, b.length);
  if (longer === 0) return 0;
  return editDistance(a, b) / longer;
}

/**
 * Conservative structural sanity check for a glob. `globToSafeRegex`
 * escapes every regex metacharacter — including `[` `]` `(` `)` `{` `}`
 * — so a malformed glob like `[bad(glob` compiles to a literal regex
 * that silently matches nothing instead of erroring. Reject the
 * unambiguously-broken case (unbalanced brackets / parens / braces)
 * so the caller gets a signal rather than a no-op filter (audit-4
 * group-3 #8). Returns the reason when malformed, or null when ok.
 */
function malformedGlobReason(glob: string): string | null {
  const pairs: ReadonlyArray<[string, string]> = [
    ['[', ']'],
    ['(', ')'],
    ['{', '}'],
  ];
  for (const [open, close] of pairs) {
    let depth = 0;
    for (const ch of glob) {
      if (ch === open) depth++;
      else if (ch === close) depth--;
      if (depth < 0) return `unbalanced '${close}'`;
    }
    if (depth > 0) return `unbalanced '${open}'`;
  }
  return null;
}

/**
 * Parse and validate the `filter` glob arg. Returns the compiled
 * RegExp on success, `null` when the arg is absent, or an error
 * string when the glob is present but unsafe.
 */
function parseFilterGlob(raw: unknown): { ok: true; value: RegExp | null } | { ok: false; error: string } {
  const hasFilterGlob = typeof raw === 'string' && raw.length > 0;
  if (!hasFilterGlob) return { ok: true, value: null };
  const glob = raw as string;
  const malformed = malformedGlobReason(glob);
  if (malformed !== null) return { ok: false, error: `invalid filter glob: ${glob} (${malformed})` };
  const regexBody = globToSafeRegex(glob);
  if (regexBody === null) return { ok: false, error: `invalid filter glob: ${glob}` };
  return { ok: true, value: new RegExp(regexBody) };
}

/**
 * Resolve the effective input file list. When `files` was omitted
 * (`filesParsed.ok === 'omitted'`) derives from git. Returns the
 * resolved list + `derivedFromGit` flag on success, or an error
 * string / NoUncommittedChanges sentinel.
 */
function resolveInputFiles(
  filesParsed: { ok: true; value: string[] } | { ok: 'omitted' },
  cg: Cartograph,
  allIndexedPaths: Set<string>,
): { ok: true; inputFiles: string[]; derivedFromGit: boolean } | NoUncommittedChanges | { error: string } {
  if (filesParsed.ok !== 'omitted') {
    return { ok: true, inputFiles: filesParsed.value, derivedFromGit: false };
  }
  // Friction-Y (2026-05-14): derive from `git diff HEAD`. Empty
  // derived set is the clean-tree happy path — short-circuit.
  const derived = deriveFilesFromGit(cg, allIndexedPaths);
  if (!derived.ok) return { error: derived.error };
  if (derived.value.length === 0) return { noUncommittedChanges: true };
  return { ok: true, inputFiles: derived.value, derivedFromGit: true };
}

/**
 * When ALL input files are unindexed, build an edit-distance error
 * message with up-to-3 suggestions per input so the caller can
 * correct typos without a separate cartograph_files lookup.
 */
function buildAllMissingError(inputFiles: string[], allIndexedPaths: Set<string>): string {
  const indexedList = Array.from(allIndexedPaths);
  const perInput = inputFiles.map((input) => ({
    input,
    suggestions: suggestPaths(input, indexedList, 3),
  }));
  const hintLines = perInput
    .filter((entry) => entry.suggestions.length > 0)
    .map((entry) => `  \`${entry.input}\` → ${entry.suggestions.map((s) => `\`${s}\``).join(', ')}`);
  const suggestionHint = hintLines.length > 0 ? `\nDid you mean:\n${hintLines.join('\n')}` : '';
  return `None of the ${inputFiles.length} input file${inputFiles.length === 1 ? '' : 's'} match indexed paths.${suggestionHint}`;
}

function parseArgs(args: AffectedToolArgs, cg: Cartograph): AffectedArgs | NoUncommittedChanges | { error: string } {
  const filesParsed = parseFiles(args.files);
  if (filesParsed.ok === false) return { error: filesParsed.error };

  // `depth` is already an integer in [1, 50] — Zod's `.int().min().max()`
  // rejected anything else at the dispatch boundary. No clamp / default
  // needed (the `.default()` supplies DEFAULT_DEPTH for an omitted arg).
  const depth = args.depth;

  const filterResult = parseFilterGlob(args.filter);
  if (!filterResult.ok) return { error: filterResult.error };
  const customFilter = filterResult.value;

  const { isTestByIndex, allIndexedPaths, filesWithTestCases } = buildIndexedPathSets(cg.queries);

  const resolved = resolveInputFiles(filesParsed, cg, allIndexedPaths);
  if ('error' in resolved) return { error: resolved.error };
  if ('noUncommittedChanges' in resolved) return { noUncommittedChanges: true };
  const { inputFiles, derivedFromGit } = resolved;

  // F-H: detect inputs the index doesn't know about. Skipped on the
  // git-derived path because deriveFilesFromGit already filtered to
  // indexed paths only — nothing to warn about.
  const missingInputs = derivedFromGit ? [] : inputFiles.filter((p) => !allIndexedPaths.has(p));
  const resolvedInputs = derivedFromGit ? inputFiles : inputFiles.filter((p) => allIndexedPaths.has(p));

  if (resolvedInputs.length === 0) {
    return { error: buildAllMissingError(inputFiles, allIndexedPaths) };
  }

  return {
    files: resolvedInputs,
    depth,
    customFilter,
    isTestByIndex,
    allIndexedPaths,
    filesWithTestCases,
    missingInputs,
    derivedFromGit,
  };
}

interface FormatResultArgs {
  files: string[];
  result: AffectedTestsResult;
  missingInputs: string[];
  derivedFromGit: boolean;
}

/**
 * Build the `{ body, footers }` spec for the affected-tests report.
 *
 * The body is header + (optional git-changed lines) + the capped test-
 * file list. The footers — "showing first N of M" cap note, unindexed-
 * input warnings, traversal count, barrel hint — are returned in render
 * order so {@link renderToolResponse} appends them AFTER body truncation
 * (the cap note + barrel hint are load-bearing; a wide list can't push
 * them off the budget).
 */
function buildResultSpec(fmtArgs: FormatResultArgs): { body: string; footers: string[] } {
  const { files, result, missingInputs, derivedFromGit } = fmtArgs;
  const sorted = Array.from(result.affectedTests).sort();
  const lines: string[] = [];
  const sourceLabel = derivedFromGit ? ' (from `git diff HEAD`)' : '';
  lines.push(
    `## Affected test files (${sorted.length}) — ${files.length} input file${files.length === 1 ? '' : 's'}${sourceLabel}`,
  );
  lines.push('');
  // Friction-Y: when the set came from git, show the agent which
  // files cartograph treated as changed so it can spot drift between
  // "what I think I edited" and "what git sees as changed."
  if (derivedFromGit) {
    for (const f of files) lines.push(`> changed: \`${f}\``);
    lines.push('');
  }
  const footers: string[] = [];
  if (sorted.length === 0) {
    lines.push('_No test files affected by the input set._');
  } else {
    // Cap the rendered rows. An edited leaf module re-exported through
    // a barrel can pull in ~half the suite — dumping every row uncapped
    // buries the signal. Show the first N (sorted) with a count footer.
    const shown = sorted.slice(0, DEFAULT_ROW_LIMIT);
    for (const t of shown) lines.push(`- \`${t}\``);
    if (sorted.length > DEFAULT_ROW_LIMIT) {
      footers.push(
        `_Showing first ${shown.length} of ${sorted.length} affected test files (sorted). Pass a custom \`filter\` glob or narrow your input set to see fewer._`,
      );
    }
  }
  // F-H: surface unindexed inputs before the traversal stats so the
  // agent sees them BEFORE the "we found nothing" footer. Each missing
  // input gets its own line — three typos in a 10-file input set is a
  // helpful signal, not noise.
  if (missingInputs.length > 0) {
    footers.push(missingInputs.map((m) => `> ⚠ Input file not indexed: \`${m}\``).join('\n'));
  }
  footers.push(`_Traversed ${result.totalDependents} dependents total._`);
  // Barrel hint: when the BFS passed through a public-API barrel the
  // blast radius is the project's whole public surface and a file-level
  // answer stops being actionable. Point the agent at the symbol-level
  // tool instead.
  if (result.barrelsReached.length > 0) {
    const barrelList = result.barrelsReached.map((b) => `\`${b}\``).join(', ');
    footers.push(
      `> ⚠ Traversal reached the public-API barrel (${barrelList}) — the blast radius is most of the suite. ` +
        `Narrow with \`cartograph_tests_for\` for symbol-level test discovery.`,
    );
  }
  return { body: lines.join('\n'), footers };
}

async function handleAffected(ctx: ToolCtx, args: AffectedToolArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const parsed = parseArgs(args, cg);
  if ('error' in parsed) return err(parsed.error);
  if ('noUncommittedChanges' in parsed) {
    const lines: string[] = [
      '## Affected test files',
      '',
      '_No uncommitted changes — nothing to re-test._',
      '',
      'Pass `files: [...]` explicitly, or commit / stage your changes and try again.',
    ];
    // Cross-ref hint: `affected` answers the `gitDiff` facet of "is X
    // changed?". `cartograph_changed_since` answers `contentDrift` (the
    // index-vs-disk SHA compare). The two facets can disagree on the
    // same tree — a committed file rewritten by a formatter after
    // indexing is clean-on-git but drifted-on-hash. Route through the
    // ChangeOracle so this tool stays commensurable with the same
    // facet definition the status banner uses.
    const oracle = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['contentDrift']) });
    const drifted = oracle.contentDrift.size;
    if (drifted > 0) {
      lines.push(
        '',
        `_Note: \`cartograph_changed_since\` reports ${drifted} file${drifted === 1 ? '' : 's'} content-drifted on disk vs the index (committed but the index lags). \`affected\` reflects \`git diff HEAD\` only — for the drifted set, see \`cartograph_changed_since\`._`,
      );
    }
    return ok(textResult(lines.join('\n')));
  }
  try {
    const result = findAffectedTests(cg.internals.graphManager, parsed);
    return ok(
      renderToolResponse(
        buildResultSpec({
          files: parsed.files,
          result,
          missingInputs: parsed.missingInputs,
          derivedFromGit: parsed.derivedFromGit,
        }),
      ),
    );
  } catch (caught) {
    return err(`affected failed: ${errMsg(caught)}`);
  }
}

export const AFFECTED_TOOL = defineTool({
  name: 'cartograph_affected',
  description:
    'File-driven test discovery — "I edited these files; which tests should I re-run?".\n\n' +
    'BFS-walks `imports`/`references` up to `depth` (default 5), filtering to test files by path pattern (`.spec.`/`.test.`/`__tests__/`/`tests/`/`e2e/`/`spec/`) or a custom `filter` glob. ' +
    'Only files with runnable cases are reported; test-flagged support modules with no mined cases are excluded. ' +
    'When `files` is omitted, the changed set comes from `git diff HEAD` — a clean tree returns a friendly hint, not an error.',
  schema: affectedSchema,
  handle: handleAffected,
});
