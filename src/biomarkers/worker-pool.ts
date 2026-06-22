/**
 * Biomarker rule pool — spawns one worker_thread per cross-file rule,
 * collects `Finding[]` results in parallel, and surfaces per-rule
 * errors back to the caller (so a single bad rule doesn't fail the
 * whole pass).
 *
 * G9 Phase 2C: replaces the serial `for (const rule of CROSS_FILE_RULES)`
 * loop in {@link './index.ts'} runCrossFileBiomarkers}. Wall-clock
 * shape changes from `sum(per-rule cost)` to
 * `~spawn_cost + max(per-rule cost)`. On the cartograph repo this is
 * a meaningful drop because two rules (duplicate_code + low_coverage)
 * dominate the pass cost; running them concurrently with the four
 * lighter rules collapses serial 6× wait to 1× wait at the long pole.
 *
 * The READ phase runs in workers (each on its own bun:sqlite
 * connection); the WRITE phase (clearFindingsByKind + appendFindings)
 * still runs on the host's connection because SQLite serializes writes
 * at the engine level — parallelising writes would just queue at the
 * write lock with no gain.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { logDebug, errMsg } from '../errors.js';
import type { CrossFileBiomarkerName, Finding } from './types.js';
import { parseBiomarkerWorkerReply, type BiomarkerWorkerInit } from './biomarker-worker-contract.js';

export interface BiomarkerWorkerLike {
  once(eventName: 'message', listener: (raw: unknown) => void): this;
  once(eventName: 'error', listener: (err: Error) => void): this;
  once(eventName: 'exit', listener: (code: number) => void): this;
  terminate(): Promise<number>;
}

export type BiomarkerWorkerClass = new (
  filename: string,
  options: { workerData: BiomarkerWorkerInit },
) => BiomarkerWorkerLike;

export interface BiomarkerRuleResult {
  readonly ruleKind: CrossFileBiomarkerName;
  readonly findings: Finding[];
  readonly durationMs: number;
  /** Defined when the worker reported an error or crashed; the caller decides whether to surface it as a pass-level error. */
  readonly error?: string;
}

export interface RunRulesInWorkersArgs {
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly ruleKinds: ReadonlyArray<CrossFileBiomarkerName>;
  readonly WorkerClass?: BiomarkerWorkerClass;
  /**
   * Per-worker wall-clock budget (ms). A worker that blocks past this
   * is terminated and surfaced as an error result. Defaults to the
   * hook timeout's per-rule slice — generous enough for the heaviest
   * rule (duplicate_code) on a large repo, tight enough that an
   * actually-hung worker doesn't pin the host indefinitely.
   */
  readonly perRuleTimeoutMs?: number;
}

const DEFAULT_PER_RULE_TIMEOUT_MS = 60_000;

function workerEntryUrl(): URL {
  // Resolved relative to THIS module's URL so it works under both
  // `bun src/...` (uncompiled) and the published dist build.
  return new URL('./biomarker-worker.ts', import.meta.url);
}

/**
 * Run each rule in its own worker_thread in parallel. Returns one
 * `BiomarkerRuleResult` per requested kind, in `ruleKinds` order. A
 * per-worker error (or timeout) becomes a result with `findings: []`
 * and a populated `error` field. The caller
 * (`reconcileCrossFileRuleResult` in `./index.ts`) treats `error` as
 * "unknown, don't touch": it PRESERVES that kind's prior-pass rows
 * rather than clearing them, so a transient worker failure can't
 * silently wipe real warning/error findings. Only a successful run
 * (`error` undefined) clear-then-appends.
 */
export async function runRulesInWorkers(args: RunRulesInWorkersArgs): Promise<BiomarkerRuleResult[]> {
  const timeoutMs = args.perRuleTimeoutMs ?? DEFAULT_PER_RULE_TIMEOUT_MS;
  const WorkerClass = args.WorkerClass ?? Worker;
  const tasks = args.ruleKinds.map((ruleKind) =>
    runOneRuleInWorker({
      dbPath: args.dbPath,
      projectRoot: args.projectRoot,
      ruleKind,
      timeoutMs,
      WorkerClass,
    }),
  );
  return Promise.all(tasks);
}

interface RunOneRuleArgs {
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly ruleKind: CrossFileBiomarkerName;
  readonly timeoutMs: number;
  readonly WorkerClass: BiomarkerWorkerClass;
}

function runOneRuleInWorker(args: RunOneRuleArgs): Promise<BiomarkerRuleResult> {
  return new Promise((resolve) => {
    const start = Date.now();
    const entry = workerEntryUrl();
    const worker = new args.WorkerClass(fileURLToPath(entry), {
      workerData: {
        dbPath: args.dbPath,
        projectRoot: args.projectRoot,
        ruleKind: args.ruleKind,
      } satisfies BiomarkerWorkerInit,
    });
    let settled = false;
    const settle = (result: BiomarkerRuleResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const timer = setTimeout(() => {
      logDebug(`Biomarkers: worker for '${args.ruleKind}' exceeded ${args.timeoutMs}ms budget; terminating`);
      void worker.terminate();
      settle({
        ruleKind: args.ruleKind,
        findings: [],
        durationMs: Date.now() - start,
        error: `worker timeout after ${args.timeoutMs}ms`,
      });
    }, args.timeoutMs);
    worker.once('message', (raw: unknown) => {
      clearTimeout(timer);
      let msg: ReturnType<typeof parseBiomarkerWorkerReply>;
      try {
        msg = parseBiomarkerWorkerReply(raw);
      } catch (err) {
        settle({
          ruleKind: args.ruleKind,
          findings: [],
          durationMs: Date.now() - start,
          error: errMsg(err),
        });
        return;
      }
      if (msg.ok) {
        settle({ ruleKind: msg.ruleKind, findings: msg.findings, durationMs: msg.durationMs });
      } else {
        settle({ ruleKind: msg.ruleKind, findings: [], durationMs: Date.now() - start, error: msg.error });
      }
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      settle({
        ruleKind: args.ruleKind,
        findings: [],
        durationMs: Date.now() - start,
        error: errMsg(err),
      });
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0 && !settled) {
        settle({
          ruleKind: args.ruleKind,
          findings: [],
          durationMs: Date.now() - start,
          error: `worker exited with code ${code} before posting a result`,
        });
      }
    });
  });
}
