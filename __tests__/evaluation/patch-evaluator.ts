import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { Cartograph } from '../../src/index.js';
import { prepareBehaviorRetrieval } from '../../src/context/behavior-retrieval.js';
import { getEmbeddingsCount } from '../../src/db/queries-embeddings.js';
import { getEmbeddingModel } from '../../src/llm/provider.js';
import {
  analyzeCodingTask,
  buildContextRoute,
  collectContextIntentSeeds,
  type ContextRoute,
} from '../../src/features/context-route/index.js';
import type { SearchResult } from '../../src/types.js';
import { buildIndexedPathSets, findAffectedTests } from '../../src/features/affected/index.js';
import { scorePatchTaskObservation, summarizePatchMode } from './patch-scoring.js';
import {
  PatchTaskCaseSchema,
  PatchTaskEvalReportSchema,
  PatchTaskEvalResultSchema,
  type PatchEvalSkipReason,
  type PatchRetrievalMode,
  type PatchTaskCase,
  type PatchTaskEvalReport,
  type PatchTaskEvalResult,
  type PatchTaskObservation,
} from './patch-types.js';

export interface RunPatchTaskEvaluationOptions {
  modes: PatchRetrievalMode[];
  topK?: number;
}

const DEFAULT_TOP_K = 5;
const CONTEXT_MAX_NODES = 40;
const CONTEXT_TRAVERSAL_DEPTH = 3;
const CONTEXT_MIN_SCORE = 0.2;
const AFFECTED_TEST_DEPTH = 5;
const INTENT_SEED_LIMIT = 20;

export async function runPatchTaskEvaluation(
  cg: Cartograph,
  rawCases: readonly PatchTaskCase[],
  options: RunPatchTaskEvaluationOptions,
): Promise<PatchTaskEvalReport> {
  const cases = rawCases.map((testCase) => PatchTaskCaseSchema.parse(testCase));
  const topK = options.topK ?? DEFAULT_TOP_K;
  const indexedPaths = buildIndexedPathSets(cg.queries);
  const results: PatchTaskEvalResult[] = [];

  for (const mode of options.modes) {
    for (const testCase of cases) {
      results.push(await evaluatePatchCase(cg, testCase, mode, topK, indexedPaths));
    }
  }

  return PatchTaskEvalReportSchema.parse({
    generatedAt: new Date().toISOString(),
    codebasePath: cg.projectRoot,
    topK,
    caseCount: cases.length,
    caseIds: cases.map((testCase) => testCase.id).sort((a, b) => a.localeCompare(b)),
    corpusFingerprint: patchCorpusFingerprint(cases),
    modes: options.modes.map((mode) => summarizePatchMode(mode, results)),
    results,
  });
}

function patchCorpusFingerprint(cases: readonly PatchTaskCase[]): string {
  const canonicalCases = cases
    .map((testCase) => ({
      id: testCase.id,
      task: testCase.task,
      expectedSymbols: [...testCase.expectedSymbols].sort((a, b) => a.localeCompare(b)),
      expectedEditFiles: [...testCase.expectedEditFiles].sort((a, b) => a.localeCompare(b)),
      expectedTestFiles: [...testCase.expectedTestFiles].sort((a, b) => a.localeCompare(b)),
      shouldAbstain: testCase.shouldAbstain === true,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return createHash('sha256').update(JSON.stringify(canonicalCases)).digest('hex');
}

async function evaluatePatchCase(
  cg: Cartograph,
  testCase: PatchTaskCase,
  mode: PatchRetrievalMode,
  topK: number,
  indexedPaths: ReturnType<typeof buildIndexedPathSets>,
): Promise<PatchTaskEvalResult> {
  const start = performance.now();
  if (mode === 'hybrid' && !(await hasActiveEmbeddings(cg))) {
    return skippedResult(testCase, mode, 'no-embeddings', performance.now() - start, 'no active embedding rows');
  }

  const behavior = await prepareBehaviorRetrieval({
    search: cg.llm,
    task: testCase.task,
    maxNodes: CONTEXT_MAX_NODES,
    retrievalMode: mode,
  });
  if (mode === 'hybrid' && behavior.trace.reason === 'hybrid-failed') {
    return skippedResult(
      testCase,
      mode,
      'endpoint-unavailable',
      performance.now() - start,
      'hybrid candidate fetch failed; deterministic and auto modes remain scored',
    );
  }

  const taskAnalysis = analyzeCodingTask(testCase.task);
  const intentSeeds = collectContextIntentSeeds({
    clauses: taskAnalysis.clauses,
    queries: cg.queries,
    limit: INTENT_SEED_LIMIT,
  });

  const subgraph = await cg.internals.contextBuilder.findRelevantContext(testCase.task, {
    searchLimit: 8,
    traversalDepth: CONTEXT_TRAVERSAL_DEPTH,
    maxNodes: CONTEXT_MAX_NODES,
    minScore: CONTEXT_MIN_SCORE,
    ...behavior,
    extraCandidates: mergeCandidates(intentSeeds.candidates, behavior.extraCandidates),
  });
  const route = buildContextRoute({
    task: testCase.task,
    nodes: [...subgraph.nodes.values()],
    intentEvidenceByNodeId: intentSeeds.evidenceByNodeId,
    intentSpecificityByNodeId: intentSeeds.specificityByNodeId,
  });
  const rankedSymbols = route.candidates
    .filter((candidate) => candidate.bucket === 'edit-site')
    .map((candidate) => ({ name: candidate.name, filePath: candidate.filePath }));
  const predictedEditFiles = predictedFiles(route, topK);
  const selectedTestFiles =
    predictedEditFiles.length === 0
      ? []
      : findAffectedTests(cg.internals.graphManager, {
          ...indexedPaths,
          files: predictedEditFiles,
          depth: AFFECTED_TEST_DEPTH,
          customFilter: null,
        }).candidates.map((candidate) => candidate.path);
  const payload = {
    retrieval: behavior.trace,
    intent: intentSeeds.metadata,
    rankedSymbols,
    route,
    predictedEditFiles,
    selectedTestFiles,
  };
  const observation: PatchTaskObservation = {
    rankedSymbols,
    predictedEditFiles,
    selectedTestFiles,
    abstained: route.status === 'abstained',
    latencyMs: performance.now() - start,
    payloadBytes: Buffer.byteLength(JSON.stringify(payload), 'utf8'),
    retrievalStrategy: behavior.trace.strategy,
    hybridCandidateCount: behavior.trace.hybridCandidateCount,
  };
  return scorePatchTaskObservation(testCase, mode, observation, topK);
}

async function hasActiveEmbeddings(cg: Cartograph): Promise<boolean> {
  const llmConfig = await cg.llm.config.getEffectiveLlmConfig();
  const model = getEmbeddingModel(llmConfig);
  return model !== undefined && getEmbeddingsCount(cg.queries, model) > 0;
}

function predictedFiles(route: ContextRoute, topK: number): string[] {
  if (route.status === 'abstained') return [];
  const ordered = route.candidates.filter(
    (candidate) => candidate.bucket === 'edit-site' && candidate.confidence !== 'low',
  );
  return [...new Set(ordered.map((candidate) => candidate.filePath))].slice(0, topK);
}

function mergeCandidates(...channels: ReadonlyArray<readonly SearchResult[]>): SearchResult[] {
  const merged = new Map<string, SearchResult>();
  for (const channel of channels) {
    for (const candidate of channel) {
      if (!merged.has(candidate.node.id)) merged.set(candidate.node.id, candidate);
    }
  }
  return [...merged.values()];
}

function skippedResult(
  testCase: PatchTaskCase,
  mode: PatchRetrievalMode,
  skipped: PatchEvalSkipReason,
  latencyMs: number,
  skipDetail: string,
): PatchTaskEvalResult {
  return PatchTaskEvalResultSchema.parse({
    caseId: testCase.id,
    mode,
    pass: true,
    hitAtK: 0,
    mrr: 0,
    editSitePrecision: 0,
    editSiteRecall: 0,
    testSelectionRecall: testCase.expectedTestFiles.length === 0 ? null : 0,
    abstentionCorrect: false,
    latencyMs,
    payloadBytes: 0,
    estimatedTokens: 0,
    foundSymbols: [],
    missedSymbols: testCase.expectedSymbols,
    rankedSymbols: [],
    predictedEditFiles: [],
    selectedTestFiles: [],
    skipped,
    skipDetail,
  });
}
