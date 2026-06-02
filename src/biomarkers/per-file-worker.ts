/**
 * Per-file biomarker COMPUTE worker — runs the parse + walk + rule
 * evaluation for a batch of files on its own bun:sqlite read handle,
 * returns serializable per-file results to the main thread for
 * persistence.
 *
 * B22 (2026-05-24) — per-file biomarker analysis was previously
 * single-threaded (B11 used `streamingDispatch` for I/O overlap but the
 * sync compute still serialized on the event loop). On microsoft/
 * TypeScript the biomarker indexAll cost was ~24.4s; with 6-8 worker
 * threads doing the compute in parallel, expected ~5-6× speedup
 * (~4-5s). Main thread still persists — SQLite writes serialize at the
 * engine level so parallelizing them wouldn't help and adds lock
 * contention.
 *
 * IPC contract:
 *   - Init: `workerData = { dbPath, projectRoot, batch, nowMs }`.
 *   - Reply: `postMessage({ ok: true, results, durationMs })` + exit(0).
 *   - On error: `postMessage({ ok: false, error })` + exit(0).
 *
 * Architecture mirrors G9's `biomarker-worker.ts` (ephemeral one-shot
 * + own DB handle) and B28 v2's `value-ref-edges-worker.ts`. The
 * orchestrator (`per-file-pool.ts`) follows the same G9 resilience
 * shape (settled flag + per-worker timeout + exit-without-message
 * handling).
 *
 * **What the worker does** (mirrors `analyseSingleFile` compute path):
 *
 *   1. Read file.
 *   2. Query DB for analysable nodes.
 *   3. Parse once via tree-sitter (grammars loaded lazily per language).
 *   4. Per analysable node: find AST node, range-mismatch guard,
 *      computeMetrics + evaluateRules.
 *   5. Evaluate constant stale docs (DB read for constants).
 *   6. Evaluate file secrets handling (in-process on source string).
 *
 * **What the worker does NOT do:**
 *
 *   - Cache-hit check + diagnostic-path skip — main thread filters
 *     these out BEFORE dispatching, so workers only receive files that
 *     need real compute.
 *   - Persistence — returns serializable result; main writes via the
 *     existing `persistAnalysisResults` / `persistLocSnapshots` /
 *     `persistNodeMetrics`.
 */

import { parentPort, workerData } from 'node:worker_threads';
import type { Finding } from './types.js';
import type { Language } from '../types.js';
import {
  ANALYSABLE_KINDS,
  ANALYSABLE_MIN_LOC,
  astBodyNodeRangeMismatch,
  isSecretsRuleSelfPath,
  sharedDocstringsAcrossConstants,
} from './per-file-shared.js';

export type PerFileOutcome = 'file-unreadable' | 'no-analysable' | 'unsupported-language' | 'parse-failed' | 'computed';

export interface PerFileMetricsRow {
  loc: number;
  cyclomatic: number;
  maxNesting: number;
  maxConditionalOperands: number;
  paramCount: number;
  magicNumberCount: number;
  hardcodedUrlCount: number;
}

export interface PerFileResult {
  relPath: string;
  /** SHA256 content hash of the file at compute time, for cache update.
   *  Null when the upstream caller didn't supply one (no cache update). */
  currentHash: string | null;
  outcome: PerFileOutcome;
  /** Populated only for outcome='computed'. Maps node id → metric row. */
  metricsByNode?: Map<string, PerFileMetricsRow>;
  /** Populated only for outcome='computed'. Maps node id → LOC value. */
  locByNode?: Map<string, number>;
  /** Populated only for outcome='computed'. Maps node id → findings list. */
  findingsByNode?: Map<string, Finding[]>;
  /** Stats deltas — aggregated by the main thread into the run-totals. */
  statsDelta: {
    symbolsAnalysed: number;
    findingsEmitted: number;
    unsupportedLanguages: number;
    errors: number;
    skippedRangeMismatch: number;
  };
}

interface PerFileWorkerInit {
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly batch: ReadonlyArray<{ relPath: string; currentHash: string | null }>;
  readonly nowMs: number;
}

interface PerFileWorkerReplyOk {
  readonly ok: true;
  readonly results: PerFileResult[];
  readonly durationMs: number;
}

interface PerFileWorkerReplyError {
  readonly ok: false;
  readonly error: string;
}

export type PerFileWorkerReply = PerFileWorkerReplyOk | PerFileWorkerReplyError;

async function main(): Promise<void> {
  if (!parentPort) throw new Error('per-file-worker must run inside a Worker');
  const init = workerData as PerFileWorkerInit;
  const start = Date.now();
  try {
    // Deliberately NOT importing from './index.js' here — that would
    // create a circular dep (index → per-file-pool → per-file-worker).
    // Shared constants + small helpers live in `per-file-shared.ts`,
    // imported at the top of this file; the worker and in-main paths
    // share that single source of truth so findings can't drift.
    const [
      { createDatabase },
      { QueryBuilder },
      { getPriorLocSnapshots },
      { loadGrammarsForLanguages },
      { computeMetrics, evaluateRules, evaluateStaleDoc, evaluateSecretsHandling, findNodeInTree, parseSource },
      { getLangMap },
      fs,
      path,
    ] = await Promise.all([
      import('../db/sqlite-adapter.js'),
      import('../db/queries.js'),
      import('../db/queries-loc-history.js'),
      import('../extraction/grammars.js'),
      import('./engine.js'),
      import('./lang-map.js'),
      import('node:fs'),
      import('node:path'),
    ]);

    // Preload grammars for the languages present in this batch. The
    // worker hits getParser() inside parseSource and gets null without
    // this — silent metric-emission with zero findings. Same gotcha
    // the main-thread path documents under `preloadBiomarkerGrammars`.
    const { db } = createDatabase(init.dbPath);
    const queries = new QueryBuilder(db);
    try {
      await preloadGrammarsForBatch(init.batch, queries, loadGrammarsForLanguages);
      const results: PerFileResult[] = [];
      for (const item of init.batch) {
        const result = await analyseOneFile({
          relPath: item.relPath,
          currentHash: item.currentHash,
          projectRoot: init.projectRoot,
          nowMs: init.nowMs,
          queries,
          fs,
          path,
          parseSource,
          getLangMap,
          findNodeInTree,
          computeMetrics,
          evaluateRules,
          evaluateStaleDoc,
          evaluateSecretsHandling,
          getPriorLocSnapshots,
        });
        results.push(result);
      }
      parentPort.postMessage({
        ok: true,
        results,
        durationMs: Date.now() - start,
      } satisfies PerFileWorkerReply);
    } finally {
      db.close();
    }
  } catch (err) {
    parentPort.postMessage({
      ok: false,
      error: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err),
    } satisfies PerFileWorkerReply);
  } finally {
    process.exit(0);
  }
}

async function preloadGrammarsForBatch(
  batch: ReadonlyArray<{ relPath: string }>,
  queries: import('../db/queries.js').QueryBuilder,
  loadGrammarsForLanguages: (languages: Language[]) => Promise<void>,
): Promise<void> {
  const supported = new Set<Language>();
  // Sample up to the first 200 files — same heuristic as
  // `preloadBiomarkerGrammars` on main. Beyond that, on-demand
  // loading inside parseSource covers the tail.
  for (const item of batch.slice(0, 200)) {
    const nodes = queries.getNodesByFile(item.relPath);
    if (nodes.length > 0) supported.add(nodes[0]!.language);
  }
  if (supported.size === 0) return;
  try {
    await loadGrammarsForLanguages([...supported]);
  } catch {
    // Soft-fail; per-file analyseOneFile will see null trees and
    // record parse-failed for the affected files.
  }
}

interface AnalyseOneArgs {
  relPath: string;
  currentHash: string | null;
  projectRoot: string;
  nowMs: number;
  queries: import('../db/queries.js').QueryBuilder;
  fs: typeof import('node:fs');
  path: typeof import('node:path');
  parseSource: typeof import('./engine.js').parseSource;
  getLangMap: typeof import('./lang-map.js').getLangMap;
  findNodeInTree: typeof import('./engine.js').findNodeInTree;
  computeMetrics: typeof import('./engine.js').computeMetrics;
  evaluateRules: typeof import('./engine.js').evaluateRules;
  evaluateStaleDoc: typeof import('./engine.js').evaluateStaleDoc;
  evaluateSecretsHandling: typeof import('./engine.js').evaluateSecretsHandling;
  getPriorLocSnapshots: typeof import('../db/queries-loc-history.js').getPriorLocSnapshots;
}

async function analyseOneFile(args: AnalyseOneArgs): Promise<PerFileResult> {
  const stats: PerFileResult['statsDelta'] = {
    symbolsAnalysed: 0,
    findingsEmitted: 0,
    unsupportedLanguages: 0,
    errors: 0,
    skippedRangeMismatch: 0,
  };
  const prep = await prepareFileAnalysis(args, stats);
  if (prep.kind === 'early-return') {
    return { relPath: args.relPath, currentHash: args.currentHash, outcome: prep.outcome, statsDelta: stats };
  }

  const { src, allNodes, analysable, tree, language } = prep;
  const priorByNode = args.getPriorLocSnapshots(
    args.queries,
    analysable.map((n) => n.id),
    args.nowMs,
  );
  const findingsByNode = new Map<string, Finding[]>();
  const locByNode = new Map<string, number>();
  const metricsByNode = new Map<string, PerFileMetricsRow>();

  evaluateAnalysableNodesInline({
    analysable,
    tree,
    language,
    priorByNode,
    nowMs: args.nowMs,
    findingsByNode,
    locByNode,
    metricsByNode,
    stats,
    findNodeInTree: args.findNodeInTree,
    computeMetrics: args.computeMetrics,
    evaluateRules: args.evaluateRules,
  });
  evaluateConstantsInline({ allNodes, findingsByNode, stats, evaluateStaleDoc: args.evaluateStaleDoc });
  evaluateSecretsInline({
    allNodes,
    relPath: args.relPath,
    src,
    findingsByNode,
    stats,
    evaluateSecretsHandling: args.evaluateSecretsHandling,
  });

  return {
    relPath: args.relPath,
    currentHash: args.currentHash,
    outcome: 'computed',
    findingsByNode,
    locByNode,
    metricsByNode,
    statsDelta: stats,
  };
}

type FileAnalysisPrep =
  | {
      kind: 'ready';
      src: string;
      allNodes: ReadonlyArray<import('../types.js').Node>;
      analysable: ReadonlyArray<import('../types.js').Node>;
      tree: NonNullable<ReturnType<AnalyseOneArgs['parseSource']>>;
      language: Language;
    }
  | { kind: 'early-return'; outcome: PerFileOutcome };

/**
 * Read the source, fetch nodes, validate the language is supported,
 * parse the tree. Returns either a `ready` envelope (the caller
 * proceeds with rule evaluation) or an `early-return` outcome the
 * caller forwards verbatim to its finalize step.
 *
 * B33 (2026-05-24) — fetch nodes for this file ONCE. Pre-B33 the
 * worker called `getNodesByFile(relPath)` three times per file
 * (analysable filter / constants / secrets); on a 39K-file corpus
 * × 6 workers that was ~700K DB queries all contending on the same
 * sqlite WAL. Now: 1 query, three in-memory filters.
 *
 * null tree is "no parser loaded" (parseSource returns null when the
 * grammar isn't available, see `biomarkers/engine.ts:parseSource`)
 * — a benign skip, NOT an error. Matches the main-thread parity at
 * `biomarkers/index.ts:parseAnalysableSource`, which also bumps
 * `stats.errors` only in the catch path and treats the null return
 * as a silent skip. Don't promote the null path to `errors` here
 * without changing the main-thread side in lockstep.
 */
async function prepareFileAnalysis(
  args: AnalyseOneArgs,
  stats: PerFileResult['statsDelta'],
): Promise<FileAnalysisPrep> {
  let src: string;
  try {
    src = await args.fs.promises.readFile(args.path.join(args.projectRoot, args.relPath), 'utf-8');
  } catch {
    return { kind: 'early-return', outcome: 'file-unreadable' };
  }
  const allNodes = args.queries.getNodesByFile(args.relPath);
  const analysable = allNodes.filter((n) => ANALYSABLE_KINDS.has(n.kind));
  if (analysable.length === 0) return { kind: 'early-return', outcome: 'no-analysable' };
  const language = analysable[0]!.language;
  if (!args.getLangMap(language)) {
    stats.unsupportedLanguages++;
    return { kind: 'early-return', outcome: 'unsupported-language' };
  }
  let tree: ReturnType<typeof args.parseSource>;
  try {
    tree = args.parseSource(src, language);
  } catch {
    stats.errors++;
    return { kind: 'early-return', outcome: 'parse-failed' };
  }
  if (!tree) return { kind: 'early-return', outcome: 'parse-failed' };
  return { kind: 'ready', src, allNodes, analysable, tree, language };
}

interface ConstantsInlineArgs {
  /** B33 — pre-fetched node list. Filtered in-memory for kind ===
   *  'constant' instead of re-querying `getNodesByFile`. */
  allNodes: ReadonlyArray<import('../types.js').Node>;
  findingsByNode: Map<string, Finding[]>;
  stats: PerFileResult['statsDelta'];
  evaluateStaleDoc: typeof import('./engine.js').evaluateStaleDoc;
}

function evaluateConstantsInline(args: ConstantsInlineArgs): void {
  const constants = args.allNodes.filter((n) => n.kind === 'constant');
  const sharedDocstrings = sharedDocstringsAcrossConstants(constants);
  for (const c of constants) {
    try {
      if (c.docstring && sharedDocstrings.has(c.docstring)) continue;
      const finding = args.evaluateStaleDoc({ id: c.id, docstring: c.docstring, signature: c.signature });
      if (!finding) continue;
      const existing = args.findingsByNode.get(c.id);
      if (existing) existing.push(finding);
      else args.findingsByNode.set(c.id, [finding]);
      args.stats.findingsEmitted++;
    } catch {
      args.stats.errors++;
    }
  }
}

interface SecretsInlineArgs {
  /** B33 — pre-fetched node list. Filtered in-memory for
   *  ANALYSABLE_KINDS instead of re-querying `getNodesByFile`. */
  allNodes: ReadonlyArray<import('../types.js').Node>;
  relPath: string;
  src: string;
  findingsByNode: Map<string, Finding[]>;
  stats: PerFileResult['statsDelta'];
  evaluateSecretsHandling: typeof import('./engine.js').evaluateSecretsHandling;
}

function sliceBody(src: string, startLine: number, endLine: number): string {
  if (!src || endLine < startLine) return '';
  const lines = src.split('\n');
  const start = Math.max(0, startLine - 1);
  const end = Math.min(lines.length, endLine);
  if (start >= end) return '';
  return lines.slice(start, end).join('\n');
}

function evaluateSecretsInline(args: SecretsInlineArgs): void {
  if (isSecretsRuleSelfPath(args.relPath)) return;
  const nodes = args.allNodes.filter((n) => ANALYSABLE_KINDS.has(n.kind));
  for (const n of nodes) {
    try {
      const body = sliceBody(args.src, n.startLine, n.endLine);
      const finding = args.evaluateSecretsHandling({
        id: n.id,
        name: n.name,
        signature: n.signature ?? null,
        docstring: n.docstring ?? null,
        summary: null,
        body,
      });
      if (!finding) continue;
      const existing = args.findingsByNode.get(n.id);
      if (existing) existing.push(finding);
      else args.findingsByNode.set(n.id, [finding]);
      args.stats.findingsEmitted++;
    } catch {
      args.stats.errors++;
    }
  }
}

interface EvaluateAnalysableArgs {
  analysable: ReadonlyArray<import('../types.js').Node>;
  tree: NonNullable<ReturnType<typeof import('./engine.js').parseSource>>;
  language: Language;
  priorByNode: ReadonlyMap<string, { loc: number; ts: number }>;
  nowMs: number;
  findingsByNode: Map<string, Finding[]>;
  locByNode: Map<string, number>;
  metricsByNode: Map<string, PerFileMetricsRow>;
  stats: PerFileResult['statsDelta'];
  findNodeInTree: typeof import('./engine.js').findNodeInTree;
  computeMetrics: typeof import('./engine.js').computeMetrics;
  evaluateRules: typeof import('./engine.js').evaluateRules;
}

/** Per-symbol AST resolution + range-mismatch guard + metrics + rule
 *  evaluation. Extracted from `analyseOneFile` to keep the parent
 *  function under the `large_method` 100-LOC warning threshold. */
function evaluateAnalysableNodesInline(args: EvaluateAnalysableArgs): void {
  for (const n of args.analysable) {
    // B22 reviewer fix — match the in-main `evaluateAnalysableNodes`
    // tiny-symbol skip (index.ts uses the same `ANALYSABLE_MIN_LOC`
    // constant). Without this the worker computed metrics + rules on
    // getters / one-liners that the in-main path skips, inflating
    // `symbolsAnalysed` and emitting findings the host wouldn't have.
    if (n.endLine - n.startLine + 1 < ANALYSABLE_MIN_LOC) continue;
    try {
      const astNode = args.findNodeInTree(args.tree, n.startLine, n.startColumn);
      if (!astNode) continue;
      if (
        astBodyNodeRangeMismatch({
          dbStartLine: n.startLine,
          dbEndLine: n.endLine,
          astStartRow: astNode.startPosition.row,
          astEndRow: astNode.endPosition.row,
        })
      ) {
        args.stats.skippedRangeMismatch++;
        continue;
      }
      const metrics = args.computeMetrics({
        bodyNode: astNode,
        language: args.language,
        startLine: n.startLine,
        endLine: n.endLine,
      });
      args.locByNode.set(n.id, metrics.loc);
      args.metricsByNode.set(n.id, metrics);
      const findings = args.evaluateRules({
        nodeId: n.id,
        language: args.language,
        metrics,
        prior: args.priorByNode.get(n.id),
        nowMs: args.nowMs,
      });
      if (findings.length > 0) {
        args.findingsByNode.set(n.id, findings);
        args.stats.findingsEmitted += findings.length;
      }
      args.stats.symbolsAnalysed++;
    } catch {
      args.stats.errors++;
    }
  }
}

await main();
