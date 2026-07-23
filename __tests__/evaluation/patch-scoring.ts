import {
  PatchModeSummarySchema,
  PatchTaskCaseSchema,
  PatchTaskEvalResultSchema,
  PatchTaskObservationSchema,
  type PatchModeSummary,
  type PatchRetrievalMode,
  type PatchTaskCase,
  type PatchTaskEvalResult,
  type PatchTaskObservation,
} from './patch-types.js';

const BYTES_PER_ESTIMATED_TOKEN = 4;

export function scorePatchTaskObservation(
  rawCase: PatchTaskCase,
  mode: PatchRetrievalMode,
  rawObservation: PatchTaskObservation,
  topK: number,
): PatchTaskEvalResult {
  const testCase = PatchTaskCaseSchema.parse(rawCase);
  const observation = PatchTaskObservationSchema.parse(rawObservation);
  const expectedSymbols = normalizedSet(testCase.expectedSymbols);
  const ranked = observation.rankedSymbols.slice(0, topK);
  const foundSymbols = testCase.expectedSymbols.filter((symbol) =>
    ranked.some((candidate) => candidate.name.toLowerCase() === symbol.toLowerCase()),
  );
  const missedSymbols = testCase.expectedSymbols.filter((symbol) => !foundSymbols.includes(symbol));
  const firstRelevantRank = ranked.findIndex((candidate) => expectedSymbols.has(candidate.name.toLowerCase()));
  const shouldAbstain = testCase.shouldAbstain === true;
  const hitAtK = shouldAbstain ? Number(observation.abstained) : Number(firstRelevantRank >= 0);
  const mrr = shouldAbstain ? Number(observation.abstained) : firstRelevantRank >= 0 ? 1 / (firstRelevantRank + 1) : 0;
  const editSitePrecision = precision(observation.predictedEditFiles, testCase.expectedEditFiles);
  const editSiteRecall = recall(observation.predictedEditFiles, testCase.expectedEditFiles);
  const testSelectionRecall =
    testCase.expectedTestFiles.length === 0 ? null : recall(observation.selectedTestFiles, testCase.expectedTestFiles);
  const abstentionCorrect = observation.abstained === shouldAbstain;
  const pass = shouldAbstain
    ? abstentionCorrect
    : !observation.abstained && hitAtK === 1 && editSiteRecall > 0 && (testSelectionRecall ?? 1) >= 0.5;

  return PatchTaskEvalResultSchema.parse({
    caseId: testCase.id,
    mode,
    pass,
    hitAtK,
    mrr,
    editSitePrecision,
    editSiteRecall,
    testSelectionRecall,
    abstentionCorrect,
    latencyMs: observation.latencyMs,
    payloadBytes: observation.payloadBytes,
    estimatedTokens: Math.ceil(observation.payloadBytes / BYTES_PER_ESTIMATED_TOKEN),
    foundSymbols,
    missedSymbols,
    rankedSymbols: observation.rankedSymbols,
    predictedEditFiles: observation.predictedEditFiles,
    selectedTestFiles: observation.selectedTestFiles,
    ...(observation.retrievalStrategy ? { retrievalStrategy: observation.retrievalStrategy } : {}),
    ...(observation.hybridCandidateCount === undefined
      ? {}
      : { hybridCandidateCount: observation.hybridCandidateCount }),
  });
}

export function summarizePatchMode(
  mode: PatchRetrievalMode,
  results: readonly PatchTaskEvalResult[],
): PatchModeSummary {
  const matching = results.filter((result) => result.mode === mode);
  const scored = matching.filter((result) => result.skipped === undefined);
  const testScored = scored.filter((result) => result.testSelectionRecall !== null);
  return PatchModeSummarySchema.parse({
    mode,
    scored: scored.length,
    skipped: matching.length - scored.length,
    passed: scored.filter((result) => result.pass).length,
    meanHitAtK: mean(scored.map((result) => result.hitAtK)),
    meanMrr: mean(scored.map((result) => result.mrr)),
    meanEditSitePrecision: mean(scored.map((result) => result.editSitePrecision)),
    meanEditSiteRecall: mean(scored.map((result) => result.editSiteRecall)),
    meanTestSelectionRecall:
      testScored.length === 0 ? null : mean(testScored.map((result) => result.testSelectionRecall ?? 0)),
    abstentionAccuracy: mean(scored.map((result) => Number(result.abstentionCorrect))),
    medianLatencyMs: percentile(
      scored.map((result) => result.latencyMs),
      0.5,
    ),
    p95LatencyMs: percentile(
      scored.map((result) => result.latencyMs),
      0.95,
    ),
    meanPayloadBytes: mean(scored.map((result) => result.payloadBytes)),
    meanEstimatedTokens: mean(scored.map((result) => result.estimatedTokens)),
  });
}

function normalizedSet(values: readonly string[]): Set<string> {
  return new Set(values.map((value) => value.toLowerCase()));
}

function precision(predicted: readonly string[], expected: readonly string[]): number {
  const predictions = [...normalizedSet(predicted)];
  if (predictions.length === 0) return expected.length === 0 ? 1 : 0;
  const expectedSet = normalizedSet(expected);
  return predictions.filter((value) => expectedSet.has(value)).length / predictions.length;
}

function recall(predicted: readonly string[], expected: readonly string[]): number {
  if (expected.length === 0) return predicted.length === 0 ? 1 : 0;
  const predictedSet = normalizedSet(predicted);
  return [...normalizedSet(expected)].filter((value) => predictedSet.has(value)).length / normalizedSet(expected).size;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.ceil(sorted.length * fraction) - 1);
  return sorted[index] ?? 0;
}
