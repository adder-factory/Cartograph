/**
 * LCOV parser — minimal, line-oriented. The records we need:
 * `SF:` (source file), `DA:line,hits` (line execution count),
 * `BRDA:line,block,branch,taken` (branch outcome), and the function
 * hit records `FN:line,name` + `FNDA:hits,name`. The remaining summary
 * records (`BRF:`, `BRH:`, `LF:`, `LH:`) are ignored — we recompute
 * those totals from `DA`/`BRDA` ourselves so the parser stays tolerant
 * of inconsistent or missing summary lines.
 *
 * `FN`/`FNDA` exist to correct a known lcov artifact: bun's and v8's
 * reporters score the *declaration* line of a multi-line single-statement
 * arrow (`const f = (...) => {\n  ...\n}`) as `DA:<sig>,0` even when the
 * function is demonstrably called — the function-hit record (`FNDA`) is
 * the only honest signal there (issue #20). We keep `line → invocation
 * count` so {@link summariseSpan} can treat a declaration line as covered
 * when its function ran.
 *
 * Istanbul's "non-executable line" sentinel `DA:N,-1` is dropped
 * rather than recorded as uncovered: a non-executable line should
 * not count against coverage.
 */

import { parseStrictUnsignedDecimalInteger } from '../strict-numeric.js';

export interface FileCoverage {
  filePath: string;
  /** Line number → execution count. */
  lineHits: Map<number, number>;
  /** Line number → branch rollup for that line. */
  branches: Map<number, { taken: number; total: number }>;
  /** Function declaration line → invocation count, resolved from the
   *  file's `FN:`/`FNDA:` records. A positive count means lcov saw the
   *  function run, which {@link summariseSpan} trusts over a bogus
   *  `DA:<line>,0` on the same declaration line (#20). */
  functionHits: Map<number, number>;
}

interface SpanSummary {
  totalLines: number;
  coveredLines: number;
  totalBranches: number;
  coveredBranches: number;
}

/** A symbol's coverage span. */
export interface SymbolSpan {
  startLine: number;
  endLine: number;
  /** True for function/method/component symbols, whose first line is a
   *  declaration/signature line. lcov reporters disagree on whether that
   *  line "executes" (bun emits no `FN`/`FNDA` at all; v8 names
   *  const-arrows anonymously), so when nothing marks it covered we fold
   *  it out of the denominator rather than count it against the symbol —
   *  the reporter-agnostic generalisation of the `FNDA` lift (#21). */
  isCallable?: boolean;
}

/** `SF:` prefix length — strips the record type marker before the file path. */
const SF_PREFIX_LEN = 3;
/** `DA:` prefix length — strips the marker before the `line,hits` pair. */
const DA_PREFIX_LEN = 3;
/** `BRDA:` prefix length — strips the marker before `line,block,branch,taken`. */
const BRDA_PREFIX_LEN = 5;
/** `FN:` prefix length — strips the marker before `line,name` (or `start,end,name`). */
const FN_PREFIX_LEN = 3;
/** `FNDA:` prefix length — strips the marker before `hits,name`. */
const FNDA_PREFIX_LEN = 5;
/** Minimum comma-split parts for a valid `DA:` body (`line,hits`). */
const DA_MIN_PARTS = 2;
/** Minimum comma-split parts for a valid `BRDA:` body. */
const BRDA_MIN_PARTS = 4;
/** Index of the `taken` field within a `BRDA:` body (0=line, 3=taken). */
const BRDA_TAKEN_IDX = 3;

/** Per-record scratch for resolving `FN`/`FNDA` into `functionHits`.
 *  Two passes are needed because the records arrive separately (and in
 *  either order): `FN` carries name → declaration line, `FNDA` carries
 *  name → invocation count. We join them by name at record close. */
interface FnAccum {
  lineByName: Map<string, number>;
  hitsByName: Map<string, number>;
}

function newFnAccum(): FnAccum {
  return { lineByName: new Map(), hitsByName: new Map() };
}

function parseSfRecord(line: string): FileCoverage {
  return {
    filePath: line.slice(SF_PREFIX_LEN),
    lineHits: new Map(),
    branches: new Map(),
    functionHits: new Map(),
  };
}

function parseDaRecord(line: string, current: FileCoverage): void {
  const parts = line.slice(DA_PREFIX_LEN).split(',');
  if (parts.length < DA_MIN_PARTS) return;
  const lineNum = parseStrictUnsignedDecimalInteger(parts[0]!);
  // The unsigned parser rejects negatives, so Istanbul's `DA:N,-1`
  // non-executable sentinel returns null here and is dropped (not
  // recorded as uncovered) — see the module docstring.
  const hits = parseStrictUnsignedDecimalInteger(parts[1]!);
  if (lineNum === null || hits === null) return;
  current.lineHits.set(lineNum, hits);
}

function parseBrdaRecord(line: string, current: FileCoverage): void {
  const parts = line.slice(BRDA_PREFIX_LEN).split(',');
  if (parts.length < BRDA_MIN_PARTS) return;
  const lineNum = parseStrictUnsignedDecimalInteger(parts[0]!);
  if (lineNum === null) return;
  const takenStr = parts[BRDA_TAKEN_IDX]!;
  // `-` means the branch was never reached at all (counted in total,
  // but not as taken). Numeric 0 means reached but not taken on this
  // side — same effect for our rollup.
  const taken = takenStr === '-' ? 0 : parseStrictUnsignedDecimalInteger(takenStr);
  if (taken === null) return;
  const existing = current.branches.get(lineNum) ?? { taken: 0, total: 0 };
  existing.total += 1;
  if (taken > 0) existing.taken += 1;
  current.branches.set(lineNum, existing);
}

/**
 * `FN:<line>,<name>` (classic) or `FN:<start>,<end>,<name>` (LCOV 2.0).
 * We only want the declaration (start) line, keyed by the function's
 * name so the later `FNDA` can attach its hit count. Function names are
 * JS identifiers (or synthetic `(anonymous_N)` labels) — never start
 * with a digit — so a numeric second field is unambiguously the end
 * line of the 3-field form, not the name.
 */
function parseFnRecord(line: string, accum: FnAccum): void {
  const body = line.slice(FN_PREFIX_LEN);
  const firstComma = body.indexOf(',');
  if (firstComma < 0) return;
  const startLine = parseStrictUnsignedDecimalInteger(body.slice(0, firstComma));
  if (startLine === null) return;
  let name = body.slice(firstComma + 1);
  const secondComma = name.indexOf(',');
  if (secondComma >= 0 && parseStrictUnsignedDecimalInteger(name.slice(0, secondComma)) !== null) {
    name = name.slice(secondComma + 1); // drop the end-line field of `start,end,name`
  }
  if (name.length === 0) return;
  accum.lineByName.set(name, startLine);
}

/** `FNDA:<hits>,<name>` — invocation count for a named function. The
 *  name (everything after the first comma) may itself contain commas
 *  for exotic synthetic labels, so we split only on the first. */
function parseFndaRecord(line: string, accum: FnAccum): void {
  const body = line.slice(FNDA_PREFIX_LEN);
  const firstComma = body.indexOf(',');
  if (firstComma < 0) return;
  const hits = parseStrictUnsignedDecimalInteger(body.slice(0, firstComma));
  if (hits === null) return;
  const name = body.slice(firstComma + 1);
  if (name.length === 0) return;
  accum.hitsByName.set(name, hits);
}

/** Join the record's `FN` (name → line) and `FNDA` (name → hits) maps
 *  into `functionHits` (line → hits). Multiple functions can share a
 *  declaration line in minified/generated code; keep the max. */
function resolveFunctionHits(current: FileCoverage, accum: FnAccum): void {
  for (const [name, declLine] of accum.lineByName) {
    const hits = accum.hitsByName.get(name) ?? 0;
    const prev = current.functionHits.get(declLine);
    // Record the count even when it is 0 (an FN with no/zero FNDA), so
    // the line's invocation state is explicit; keep the max when several
    // functions share a declaration line.
    if (prev === undefined || hits > prev) current.functionHits.set(declLine, hits);
  }
}

/** Dispatch a non-boundary record (`DA`/`BRDA`/`FN`/`FNDA`) to its
 *  parser. `FNDA:` is tested before `FN:` because the former has the
 *  latter as a string prefix. */
function parseDataRecord(line: string, current: FileCoverage, fnAccum: FnAccum): void {
  if (line.startsWith('DA:')) parseDaRecord(line, current);
  else if (line.startsWith('BRDA:')) parseBrdaRecord(line, current);
  else if (line.startsWith('FNDA:')) parseFndaRecord(line, fnAccum);
  else if (line.startsWith('FN:')) parseFnRecord(line, fnAccum);
}

export function parseLcov(body: string): FileCoverage[] {
  const records: FileCoverage[] = [];
  let current: FileCoverage | null = null;
  // `FN`/`FNDA` for the current record, joined into `functionHits` when
  // the record closes (`end_of_record`, a new `SF:`, or EOF).
  let fnAccum: FnAccum = newFnAccum();
  const closeRecord = (): void => {
    if (current) resolveFunctionHits(current, fnAccum);
    fnAccum = newFnAccum();
  };

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('SF:')) {
      closeRecord(); // flush a prior record lacking an end_of_record
      current = parseSfRecord(line);
      records.push(current);
    } else if (!current) {
      // no open record — ignore stray lines before the first SF:
    } else if (line === 'end_of_record') {
      closeRecord();
      current = null;
    } else {
      parseDataRecord(line, current, fnAccum);
    }
  }
  closeRecord(); // final record may omit end_of_record

  return records;
}

/**
 * Roll up a file's coverage into a single symbol's [startLine, endLine]
 * span. Lines outside the span are ignored entirely — a non-executable
 * line outside the span doesn't drag a symbol's denominator down, and
 * a heavily-hit line outside doesn't inflate it.
 */
export function summariseSpan(fc: FileCoverage, span: SymbolSpan): SpanSummary {
  const { startLine, endLine, isCallable = false } = span;
  // The first line of a multi-line callable is its signature line; the
  // structural fold below only applies when there's more than one line.
  const multiLine = endLine > startLine;
  let totalLines = 0;
  let coveredLines = 0;
  let totalBranches = 0;
  let coveredBranches = 0;

  for (const [line, hits] of fc.lineHits) {
    if (line < startLine || line > endLine) continue;
    // A line counts as covered when its own `DA` hit count is positive,
    // OR an `FNDA` function-hit record shows the function declared there
    // ran — the declaration line executes whenever the function is
    // entered, so a positive function-hit overrides a bogus `DA:<line>,0`
    // (#20).
    const covered = hits > 0 || (fc.functionHits.get(line) ?? 0) > 0;
    // Reporter-agnostic signature-line fold (#21): the leading line of a
    // multi-line function/method/component is its declaration line.
    // Reporters disagree on whether it "executes" — bun emits no
    // `FN`/`FNDA` at all, v8 names const-arrows anonymously — so when
    // nothing marks it covered, fold it OUT of the denominator instead of
    // counting it against the symbol. A positively-covered declaration
    // line still counts. Real gaps in the body keep their own `DA` counts.
    if (isCallable && multiLine && line === startLine && !covered) continue;
    totalLines += 1;
    if (covered) coveredLines += 1;
  }

  for (const [line, br] of fc.branches) {
    if (line < startLine || line > endLine) continue;
    totalBranches += br.total;
    coveredBranches += br.taken;
  }

  return { totalLines, coveredLines, totalBranches, coveredBranches };
}
