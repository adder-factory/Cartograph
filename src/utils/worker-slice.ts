import { Worker } from 'node:worker_threads';
import { errMsg, logDebug } from '../errors.js';

export interface RunWorkerSliceArgs<TReply> {
  readonly workerPath: string;
  readonly workerData: unknown;
  readonly timeoutMs: number;
  readonly sliceLabel: string;
  readonly logPrefix: string;
  readonly makeErrorReply: (error: string) => TReply;
}

export function runWorkerSlice<TReply>(args: RunWorkerSliceArgs<TReply>): Promise<TReply> {
  return new Promise((resolve) => {
    const start = Date.now();
    const worker = new Worker(args.workerPath, { workerData: args.workerData });
    let settled = false;
    const settle = (reply: TReply): void => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };
    const timer = setTimeout(() => {
      logDebug(`${args.logPrefix} worker ${args.sliceLabel} exceeded ${args.timeoutMs}ms budget; terminating`);
      void worker.terminate();
      settle(args.makeErrorReply(`worker ${args.sliceLabel} timeout after ${args.timeoutMs}ms`));
    }, args.timeoutMs);
    worker.once('message', (raw: TReply) => {
      clearTimeout(timer);
      settle(raw);
    });
    worker.once('error', (err) => {
      clearTimeout(timer);
      settle(args.makeErrorReply(`worker ${args.sliceLabel} error after ${Date.now() - start}ms: ${errMsg(err)}`));
    });
    worker.once('exit', (code) => {
      clearTimeout(timer);
      if (!settled) {
        settle(
          args.makeErrorReply(
            `worker ${args.sliceLabel} exited with code ${code} after ${Date.now() - start}ms before posting a result`,
          ),
        );
      }
    });
  });
}
