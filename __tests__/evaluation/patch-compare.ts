import type { PatchModeSummary, PatchTaskEvalReport } from './patch-types.js';

export interface PatchEvalComparison {
  withinBudget: boolean;
  regressions: string[];
}

const CORRECTNESS_DROP_BUDGET = 0.1;
const PAYLOAD_GROWTH_BUDGET = 0.25;
const PAYLOAD_NOISE_FLOOR = 200;

export function comparePatchReports(
  baseline: PatchTaskEvalReport,
  candidate: PatchTaskEvalReport,
): PatchEvalComparison {
  const regressions: string[] = [];
  compareEvaluationContract(baseline, candidate, regressions);
  const candidateByMode = new Map(candidate.modes.map((summary) => [summary.mode, summary] as const));
  for (const prior of baseline.modes) {
    const current = candidateByMode.get(prior.mode);
    if (!current) continue;
    if (current.scored !== prior.scored) continue;
    if (current.scored === 0) continue;
    compareCorrectness(prior, current, regressions);
    if (
      prior.meanPayloadBytes >= PAYLOAD_NOISE_FLOOR &&
      current.meanPayloadBytes > prior.meanPayloadBytes * (1 + PAYLOAD_GROWTH_BUDGET)
    ) {
      const growth = ((current.meanPayloadBytes / prior.meanPayloadBytes - 1) * 100).toFixed(0);
      regressions.push(`${current.mode}: mean payload grew ${growth}%`);
    }
  }
  return { withinBudget: regressions.length === 0, regressions };
}

function compareEvaluationContract(
  baseline: PatchTaskEvalReport,
  candidate: PatchTaskEvalReport,
  regressions: string[],
): void {
  if (candidate.topK !== baseline.topK) {
    regressions.push(`evaluation contract: topK changed (${baseline.topK} → ${candidate.topK})`);
  }
  if (candidate.caseCount !== baseline.caseCount) {
    regressions.push(`evaluation contract: caseCount changed (${baseline.caseCount} → ${candidate.caseCount})`);
  }
  const baselineCaseIds = [...baseline.caseIds].sort((a, b) => a.localeCompare(b));
  const candidateCaseIds = [...candidate.caseIds].sort((a, b) => a.localeCompare(b));
  if (baselineCaseIds.join('\u0000') !== candidateCaseIds.join('\u0000')) {
    regressions.push('evaluation contract: case identities changed');
  }
  if (candidate.corpusFingerprint !== baseline.corpusFingerprint) {
    regressions.push('evaluation contract: case definitions changed');
  }
  const candidateByMode = new Map(candidate.modes.map((summary) => [summary.mode, summary] as const));
  for (const prior of baseline.modes) {
    const current = candidateByMode.get(prior.mode);
    if (!current) {
      regressions.push(`evaluation contract: required mode ${prior.mode} is missing`);
      continue;
    }
    if (current.scored !== prior.scored) {
      regressions.push(`evaluation contract: ${prior.mode} scored count changed (${prior.scored} → ${current.scored})`);
    }
  }
}

function compareCorrectness(prior: PatchModeSummary, current: PatchModeSummary, regressions: string[]): void {
  const metrics: Array<readonly [string, number, number]> = [
    ['hit@k', prior.meanHitAtK, current.meanHitAtK],
    ['MRR', prior.meanMrr, current.meanMrr],
    ['edit precision', prior.meanEditSitePrecision, current.meanEditSitePrecision],
    ['edit recall', prior.meanEditSiteRecall, current.meanEditSiteRecall],
    ['abstention accuracy', prior.abstentionAccuracy, current.abstentionAccuracy],
  ];
  if (prior.meanTestSelectionRecall !== null && current.meanTestSelectionRecall !== null) {
    metrics.push(['test recall', prior.meanTestSelectionRecall, current.meanTestSelectionRecall]);
  }
  for (const [label, before, after] of metrics) {
    const drop = before - after;
    if (drop > CORRECTNESS_DROP_BUDGET) {
      regressions.push(
        `${current.mode}: ${label} dropped ${drop.toFixed(2)} (${before.toFixed(2)} → ${after.toFixed(2)})`,
      );
    }
  }
}
