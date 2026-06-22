import { Worker } from 'node:worker_threads';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseShimmerWorkerReply,
  type ShimmerWorkerData,
  type ShimmerWorkerMessage,
} from './shimmer-worker-contract.js';

const PHASE_NAMES: Record<string, string> = {
  scanning: 'Scanning files',
  parsing: 'Parsing code',
  storing: 'Storing data',
  resolving: 'Resolving refs',
};

interface IndexProgress {
  phase: string;
  current: number;
  total: number;
}

interface ShimmerProgress {
  onProgress: (progress: IndexProgress) => void;
  stop: () => Promise<void>;
}

/** Cadence of the text fallback heartbeat. Smaller floods log redirects;
 *  larger looks hung on slow phases. 5s matches the friction-tracker
 *  empirical "ONE log line and silence" complaint at 90s runs (≈ 18 ticks). */
const TEXT_FALLBACK_HEARTBEAT_MS = 5_000;

/** ms-to-seconds conversion factor for shortDuration. */
const MS_PER_SECOND = 1_000;
/** Boundary where shortDuration switches from `Ns` to `Nm Ns`. */
const SECONDS_PER_MINUTE = 60;

/** Send a graceful stop to the shimmer worker and wait for it to exit. */
function stopShimmerWorker(worker: Worker): Promise<void> {
  return new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      worker.terminate().then(() => resolve());
    }, 2000);

    worker.on('message', (raw: unknown) => {
      try {
        parseShimmerWorkerReply(raw);
        clearTimeout(timeout);
        worker.terminate().then(() => resolve());
      } catch {
        return;
      }
    });

    worker.postMessage({ type: 'stop' } satisfies ShimmerWorkerMessage);
  });
}

/** Sub-second ETAs floor to `<1s` — precision below that adds noise
 *  to a progress line that already shows percent and item count. */
const SUB_SECOND_FLOOR_MS = 1_000;

/** Local mini formatDuration so the fallback doesn't drag in src/bin's
 *  copy. Returns '<1s' / 'Ns' / 'm Ns' shapes for the eta field. */
function shortDuration(ms: number): string {
  const isInvalidDuration = !Number.isFinite(ms) || ms < 0;
  if (isInvalidDuration) return '?';
  const isSubSecond = ms < SUB_SECOND_FLOOR_MS;
  if (isSubSecond) return '<1s';
  const seconds = Math.round(ms / MS_PER_SECOND);
  const isUnderAMinute = seconds < SECONDS_PER_MINUTE;
  if (isUnderAMinute) return `${seconds}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  const rem = seconds % SECONDS_PER_MINUTE;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

/**
 * Plain-text progress fallback. Used when the fancy shimmer worker
 * can't load (running from source via `bun src/bin/cartograph.ts`
 * with no dist/) or when
 * stdout isn't a TTY (`npm run summarize > log.txt`, CI pipes, MCP
 * stdio). Emits a discrete `\n`-terminated line on phase change and
 * every `TEXT_FALLBACK_HEARTBEAT_MS` thereafter, with %, count, and
 * an ETA estimated from elapsed-vs-progress. Writes to stderr so the
 * lines don't mingle with structured stdout output (MCP frames, etc.).
 *
 * @internal — exported only so the unit tests can drive the
 * fallback without monkey-patching `process.stdout.isTTY`.
 */
export function createTextProgressFallback(): ShimmerProgress {
  let lastPhase = '';
  let phaseStart = 0;
  let lastEmit = 0;

  function emit(progress: IndexProgress, force: boolean): void {
    const now = Date.now();
    const phaseChanged = progress.phase !== lastPhase;
    if (phaseChanged) {
      lastPhase = progress.phase;
      phaseStart = now;
    }
    if (!phaseChanged && !force && now - lastEmit < TEXT_FALLBACK_HEARTBEAT_MS) return;
    lastEmit = now;

    const phaseLabel = PHASE_NAMES[progress.phase] ?? progress.phase;
    const elapsed = now - phaseStart;
    let line = `[${phaseLabel}]`;

    if (progress.total > 0) {
      const pct = Math.round((progress.current / progress.total) * 100);
      line += ` ${progress.current.toLocaleString()}/${progress.total.toLocaleString()} (${pct}%)`;
      if (progress.current > 0 && progress.current < progress.total && elapsed > 0) {
        const rate = progress.current / elapsed;
        const remainingMs = (progress.total - progress.current) / rate;
        line += ` — eta ${shortDuration(remainingMs)}`;
      }
    } else if (progress.current > 0) {
      line += ` ${progress.current.toLocaleString()} found`;
    } else {
      line += ' starting…';
    }

    process.stderr.write(`${line}\n`);
  }

  return {
    onProgress(progress) {
      emit(progress, progress.phase !== lastPhase);
    },
    async stop() {
      // Nothing to clean up — no timer, no worker. Matches the
      // worker-mode `stop()` shape so call sites don't branch.
    },
  };
}

export function createShimmerProgress(): ShimmerProgress {
  let lastPhase = '';

  const workerPath = path.join(import.meta.dirname, 'shimmer-worker.js');
  const workerAvailable = fs.existsSync(workerPath);
  // Non-TTY stdout (npm-run pipe, CI log capture, MCP stdio): the
  // shimmer animation's `\r\x1b[K` cursor tricks render as garbage or
  // get swallowed entirely. Fall back to discrete text lines.
  const stdoutIsTTY = process.stdout.isTTY === true;

  if (!workerAvailable || !stdoutIsTTY) {
    return createTextProgressFallback();
  }

  const workerData = { startTime: Date.now() } satisfies ShimmerWorkerData;
  const worker = new Worker(workerPath, { workerData });

  return {
    onProgress(progress: IndexProgress) {
      const phaseName = PHASE_NAMES[progress.phase] || progress.phase;

      if (progress.phase !== lastPhase && lastPhase) {
        worker.postMessage({ type: 'finish-phase' } satisfies ShimmerWorkerMessage);
      }
      lastPhase = progress.phase;

      let percent = -1;
      let count = 0;
      if (progress.total > 0) {
        percent = Math.round((progress.current / progress.total) * 100);
      } else if (progress.current > 0) {
        count = progress.current;
      }

      worker.postMessage({
        type: 'update',
        phase: progress.phase,
        phaseName,
        percent,
        count,
      } satisfies ShimmerWorkerMessage);
    },

    stop() {
      return stopShimmerWorker(worker);
    },
  };
}
