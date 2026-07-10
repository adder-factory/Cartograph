/**
 * Eval-report comparison — gate the ranking arc (BACKLOG B #19).
 *
 * Reads two JSON reports produced by `runner.ts` (a baseline and a
 * candidate) and prints a per-case + summary delta. Returns a
 * non-zero exit code when any case regresses beyond `REGRESSION_*`
 * thresholds — that's the CI signal a future ranking change must
 * keep clearing.
 *
 * Used standalone or chained from runner via `--compare <file>`.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EvalReport, EvalResult } from './types.js';

/**
 * A case "regresses" when its recall drops by more than this many
 * absolute points. Tighter than mrr because recall is the headline
 * metric — any 0.10+ recall drop in a single case is worth a
 * non-zero exit. Tunable; if a future ranking arc legitimately
 * trades recall on one case for a big gain elsewhere, the harness
 * caller can override via `--regression-threshold N` on the
 * runner.
 */
const RECALL_REGRESSION_THRESHOLD = 0.1;
/** Mean-recall regression budget across the whole suite. */
const MEAN_RECALL_REGRESSION_THRESHOLD = 0.05;
/**
 * Per-case payload (B5) regression budget — fraction the candidate
 * may exceed the baseline by before flagging. 0.25 = +25% growth
 * trips. Set wider than recall because micro-fluctuations in
 * stringified output (signature whitespace, new optional fields) can
 * legitimately bump a small case 5–10% without indicating regression.
 */
const PAYLOAD_REGRESSION_THRESHOLD = 0.25;
/**
 * Mean-payload regression budget across the whole suite. Tighter than
 * per-case because aggregate growth is the real bite — a single case
 * spiking 30% may be a fixture artefact, but the mean drifting +10%
 * means every query the agent fires is paying more context.
 */
const MEAN_PAYLOAD_REGRESSION_THRESHOLD = 0.1;
/**
 * Skip the per-case payload check when the baseline is below this
 * many bytes — rounding noise on tiny payloads can swing the
 * percentage by 100s without the agent caring. Keeps the gate
 * focused on payloads that actually move the needle.
 */
const PAYLOAD_MIN_BYTES_FOR_CHECK = 200;

interface CaseDelta {
  caseId: string;
  baseline: EvalResult | null;
  candidate: EvalResult | null;
  recallDelta: number;
  mrrDelta: number;
  latencyDelta: number;
  /**
   * Fractional payload growth: `(candidate - baseline) / baseline`.
   * 0 when either side has no `payloadBytes` (legacy report). Used
   * for the per-case regression check + display.
   */
  payloadDelta: number;
  regressed: boolean;
  /** Reason for `regressed=true`. Empty otherwise. */
  reason: string;
}

interface CompareResult {
  perCase: CaseDelta[];
  meanRecallDelta: number;
  meanMrrDelta: number;
  passDelta: number;
  /**
   * Fractional mean-payload delta: `(meanCandidate - meanBaseline) /
   * meanBaseline`. Computed only over cases where BOTH sides have
   * `payloadBytes`. 0 when no qualifying cases.
   */
  meanPayloadDelta: number;
  /** Cases that regressed beyond `RECALL_REGRESSION_THRESHOLD`. */
  regressions: CaseDelta[];
  /** True iff regressions are within budget AND no missing cases. */
  withinBudget: boolean;
}

function payloadDeltaFor(baseline: EvalResult | null, candidate: EvalResult | null): number {
  if (!baseline?.payloadBytes || !candidate?.payloadBytes) return 0;
  return (candidate.payloadBytes - baseline.payloadBytes) / baseline.payloadBytes;
}

function regressionReason(
  baseline: EvalResult | null,
  candidate: EvalResult | null,
  recallDelta: number,
  payloadDelta: number,
): string {
  if (!candidate) return 'case missing from candidate report';
  if (!baseline) return '';
  if (candidate.skipped) return '';
  if (recallDelta < -RECALL_REGRESSION_THRESHOLD) {
    return `recall dropped ${recallDelta.toFixed(2)} (threshold -${RECALL_REGRESSION_THRESHOLD})`;
  }
  const shouldCheckPayload =
    Boolean(baseline.payloadBytes && candidate.payloadBytes) && baseline.payloadBytes! >= PAYLOAD_MIN_BYTES_FOR_CHECK;
  if (shouldCheckPayload && payloadDelta > PAYLOAD_REGRESSION_THRESHOLD) {
    return `payload grew +${(payloadDelta * 100).toFixed(0)}% (threshold +${(PAYLOAD_REGRESSION_THRESHOLD * 100).toFixed(0)}%)`;
  }
  return '';
}

function meanPayloadDeltaFor(perCase: CaseDelta[]): number {
  const paired = perCase.filter(
    (entry) =>
      !entry.baseline?.skipped &&
      !entry.candidate?.skipped &&
      entry.baseline?.payloadBytes &&
      entry.candidate?.payloadBytes,
  );
  const meanBaselinePayload =
    paired.length > 0 ? paired.reduce((s, e) => s + (e.baseline!.payloadBytes ?? 0), 0) / paired.length : 0;
  const meanCandidatePayload =
    paired.length > 0 ? paired.reduce((s, e) => s + (e.candidate!.payloadBytes ?? 0), 0) / paired.length : 0;
  return meanBaselinePayload > 0 ? (meanCandidatePayload - meanBaselinePayload) / meanBaselinePayload : 0;
}

function meanMetricDeltaFor(perCase: CaseDelta[], metric: 'recall' | 'mrr'): number {
  let baselineTotal = 0;
  let candidateTotal = 0;
  let count = 0;
  for (const entry of perCase) {
    if (!entry.baseline || !entry.candidate || entry.baseline.skipped || entry.candidate.skipped) continue;
    baselineTotal += entry.baseline[metric];
    candidateTotal += entry.candidate[metric];
    count++;
  }
  return count === 0 ? 0 : candidateTotal / count - baselineTotal / count;
}

function comparisonFlag(entry: CaseDelta): string {
  if (entry.candidate?.skipped) return ` (skipped: ${entry.candidate.skipped})`;
  return entry.regressed ? ` ⚠ ${entry.reason}` : '';
}

export function compareReports(baseline: EvalReport, candidate: EvalReport): CompareResult {
  const baselineByCase = new Map(baseline.results.map((r) => [r.caseId, r]));
  const candidateByCase = new Map(candidate.results.map((r) => [r.caseId, r]));
  const allCaseIds = new Set([...baselineByCase.keys(), ...candidateByCase.keys()]);
  const perCase: CaseDelta[] = [];
  const regressions: CaseDelta[] = [];

  for (const id of allCaseIds) {
    const b = baselineByCase.get(id) ?? null;
    const c = candidateByCase.get(id) ?? null;
    const candidateSkipped = c?.skipped !== undefined;
    const recallDelta = candidateSkipped ? 0 : (c?.recall ?? 0) - (b?.recall ?? 0);
    const mrrDelta = candidateSkipped ? 0 : (c?.mrr ?? 0) - (b?.mrr ?? 0);
    const latencyDelta = (c?.latencyMs ?? 0) - (b?.latencyMs ?? 0);
    // Payload delta as a fraction of the baseline. Skip when either
    // side lacks payloadBytes (legacy report) — payloadDelta=0 there
    // means "no signal", not "no change". The regression check below
    // only fires when both sides report and the baseline is above
    // PAYLOAD_MIN_BYTES_FOR_CHECK to avoid noise on tiny payloads.
    const payloadDelta = candidateSkipped ? 0 : payloadDeltaFor(b, c);
    const reason = regressionReason(b, c, recallDelta, payloadDelta);
    const regressed = reason !== '';
    const entry: CaseDelta = {
      caseId: id,
      baseline: b,
      candidate: c,
      recallDelta,
      mrrDelta,
      latencyDelta,
      payloadDelta,
      regressed,
      reason,
    };
    perCase.push(entry);
    if (regressed) regressions.push(entry);
  }

  const meanRecallDelta = meanMetricDeltaFor(perCase, 'recall');
  const meanMrrDelta = meanMetricDeltaFor(perCase, 'mrr');
  const passDelta = candidate.summary.passed - baseline.summary.passed;

  // Mean payload across cases that have payloadBytes on BOTH sides.
  const meanPayloadDelta = meanPayloadDeltaFor(perCase);

  const meanRecallRegressed = meanRecallDelta < -MEAN_RECALL_REGRESSION_THRESHOLD;
  const meanPayloadRegressed = meanPayloadDelta > MEAN_PAYLOAD_REGRESSION_THRESHOLD;
  const withinBudget = regressions.length === 0 && !meanRecallRegressed && !meanPayloadRegressed;

  return { perCase, meanRecallDelta, meanMrrDelta, passDelta, meanPayloadDelta, regressions, withinBudget };
}

/**
 * Format the comparison as a human-readable table for stdout. Used
 * by the runner's `--compare` mode and by the standalone CLI entry
 * point at the bottom of this file.
 */
export function formatComparison(baseline: EvalReport, candidate: EvalReport, cmp: CompareResult): string {
  const lines: string[] = [
    `Eval comparison`,
    `  baseline  ${baseline.cartographSha} @ ${baseline.timestamp}`,
    `  candidate ${candidate.cartographSha} @ ${candidate.timestamp}`,
    '',
  ];
  const idLen = Math.max(...cmp.perCase.map((e) => e.caseId.length));
  lines.push(`  ${'case'.padEnd(idLen)}  recallΔ    mrrΔ    latΔ  payloadΔ`);
  for (const e of [...cmp.perCase].sort((a, b) => a.caseId.localeCompare(b.caseId))) {
    const id = e.caseId.padEnd(idLen);
    const recall = signed(e.recallDelta, 2).padStart(7);
    const mrr = signed(e.mrrDelta, 2).padStart(7);
    const lat = `${signed(e.latencyDelta, 0)}ms`.padStart(7);
    // Payload column is "—" when one side lacks the field (legacy
    // baseline) so the column is honest about no-signal vs no-change.
    const payload =
      e.baseline?.payloadBytes && e.candidate?.payloadBytes
        ? `${signed(e.payloadDelta * 100, 0)}%`.padStart(8)
        : '       —';
    const flag = comparisonFlag(e);
    lines.push(`  ${id}  ${recall}  ${mrr}  ${lat}  ${payload}${flag}`);
  }
  lines.push(
    '',
    `  summary: meanRecallΔ ${signed(cmp.meanRecallDelta, 3)}, meanMrrΔ ${signed(cmp.meanMrrDelta, 3)}, ` +
      `meanPayloadΔ ${signed(cmp.meanPayloadDelta * 100, 1)}%, passΔ ${signed(cmp.passDelta, 0)}`,
    '',
  );
  if (cmp.withinBudget) {
    lines.push(
      `  ✓ within regression budget (${cmp.regressions.length} per-case regressions, mean recall within ${MEAN_RECALL_REGRESSION_THRESHOLD}, mean payload within ${MEAN_PAYLOAD_REGRESSION_THRESHOLD * 100}%)`,
    );
  } else {
    lines.push(`  ✗ regression budget exceeded`);
    if (cmp.regressions.length > 0) {
      lines.push(`    per-case regressions: ${cmp.regressions.map((r) => r.caseId).join(', ')}`);
    }
    if (cmp.meanRecallDelta < -MEAN_RECALL_REGRESSION_THRESHOLD) {
      lines.push(
        `    mean recall dropped ${cmp.meanRecallDelta.toFixed(3)} (threshold -${MEAN_RECALL_REGRESSION_THRESHOLD})`,
      );
    }
    if (cmp.meanPayloadDelta > MEAN_PAYLOAD_REGRESSION_THRESHOLD) {
      lines.push(
        `    mean payload grew +${(cmp.meanPayloadDelta * 100).toFixed(1)}% (threshold +${MEAN_PAYLOAD_REGRESSION_THRESHOLD * 100}%)`,
      );
    }
  }
  return lines.join('\n');
}

function signed(n: number, decimals: number): string {
  const v = n.toFixed(decimals);
  return n >= 0 ? `+${v}` : v;
}

function loadReport(filePath: string): EvalReport {
  const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
  return JSON.parse(raw) as EvalReport;
}

// CLI entry — `bun __tests__/evaluation/compare.ts <baseline> <candidate>`.
// Skipped when the file is imported as a module.
if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , baselinePath, candidatePath] = process.argv;
  if (!baselinePath || !candidatePath) {
    console.error('Usage: bun __tests__/evaluation/compare.ts <baseline.json> <candidate.json>');
    process.exit(2);
  }
  const baseline = loadReport(baselinePath);
  const candidate = loadReport(candidatePath);
  const cmp = compareReports(baseline, candidate);
  console.log(formatComparison(baseline, candidate, cmp));
  process.exit(cmp.withinBudget ? 0 : 1);
}
