/**
 * LCOV parser — minimal, line-oriented. Only the records we need:
 * `SF:` (source file), `DA:line,hits` (line execution count),
 * `BRDA:line,block,branch,taken` (branch outcome). Other records
 * (`FN:`, `FNDA:`, `BRF:`, `BRH:`, `LF:`, `LH:`) are ignored — we
 * recompute totals from `DA`/`BRDA` ourselves so the parser stays
 * tolerant of inconsistent or missing summary lines.
 *
 * Istanbul's "non-executable line" sentinel `DA:N,-1` is dropped
 * rather than recorded as uncovered: a non-executable line should
 * not count against coverage.
 */

export interface FileCoverage {
  filePath: string;
  /** Line number → execution count. */
  lineHits: Map<number, number>;
  /** Line number → branch rollup for that line. */
  branches: Map<number, { taken: number; total: number }>;
}

interface SpanSummary {
  totalLines: number;
  coveredLines: number;
  totalBranches: number;
  coveredBranches: number;
}

/** `SF:` prefix length — strips the record type marker before the file path. */
const SF_PREFIX_LEN = 3;
/** `DA:` prefix length — strips the marker before the `line,hits` pair. */
const DA_PREFIX_LEN = 3;
/** `BRDA:` prefix length — strips the marker before `line,block,branch,taken`. */
const BRDA_PREFIX_LEN = 5;
/** Minimum comma-split parts for a valid `DA:` body (`line,hits`). */
const DA_MIN_PARTS = 2;
/** Minimum comma-split parts for a valid `BRDA:` body. */
const BRDA_MIN_PARTS = 4;
/** Index of the `taken` field within a `BRDA:` body (0=line, 3=taken). */
const BRDA_TAKEN_IDX = 3;

function parseSfRecord(line: string): FileCoverage {
  return {
    filePath: line.slice(SF_PREFIX_LEN),
    lineHits: new Map(),
    branches: new Map(),
  };
}

function parseDaRecord(line: string, current: FileCoverage): void {
  const parts = line.slice(DA_PREFIX_LEN).split(',');
  if (parts.length < DA_MIN_PARTS) return;
  const lineNum = parseInt(parts[0]!, 10);
  const hits = parseInt(parts[1]!, 10);
  if (!Number.isFinite(lineNum) || !Number.isFinite(hits)) return;
  if (hits < 0) return;
  current.lineHits.set(lineNum, hits);
}

function parseBrdaRecord(line: string, current: FileCoverage): void {
  const parts = line.slice(BRDA_PREFIX_LEN).split(',');
  if (parts.length < BRDA_MIN_PARTS) return;
  const lineNum = parseInt(parts[0]!, 10);
  if (!Number.isFinite(lineNum)) return;
  const takenStr = parts[BRDA_TAKEN_IDX]!;
  // `-` means the branch was never reached at all (counted in total,
  // but not as taken). Numeric 0 means reached but not taken on this
  // side — same effect for our rollup.
  const taken = takenStr === '-' ? 0 : parseInt(takenStr, 10);
  if (!Number.isFinite(taken)) return;
  const existing = current.branches.get(lineNum) ?? { taken: 0, total: 0 };
  existing.total += 1;
  if (taken > 0) existing.taken += 1;
  current.branches.set(lineNum, existing);
}

export function parseLcov(body: string): FileCoverage[] {
  const records: FileCoverage[] = [];
  let current: FileCoverage | null = null;

  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('SF:')) {
      current = parseSfRecord(line);
      records.push(current);
      continue;
    }
    if (!current) continue;
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (line.startsWith('DA:')) {
      parseDaRecord(line, current);
      continue;
    }
    if (line.startsWith('BRDA:')) {
      parseBrdaRecord(line, current);
    }
  }

  return records;
}

/**
 * Roll up a file's coverage into a single symbol's [startLine, endLine]
 * span. Lines outside the span are ignored entirely — a non-executable
 * line outside the span doesn't drag a symbol's denominator down, and
 * a heavily-hit line outside doesn't inflate it.
 */
export function summariseSpan(fc: FileCoverage, startLine: number, endLine: number): SpanSummary {
  let totalLines = 0;
  let coveredLines = 0;
  let totalBranches = 0;
  let coveredBranches = 0;

  for (const [line, hits] of fc.lineHits) {
    if (line < startLine || line > endLine) continue;
    totalLines += 1;
    if (hits > 0) coveredLines += 1;
  }

  for (const [line, br] of fc.branches) {
    if (line < startLine || line > endLine) continue;
    totalBranches += br.total;
    coveredBranches += br.taken;
  }

  return { totalLines, coveredLines, totalBranches, coveredBranches };
}
