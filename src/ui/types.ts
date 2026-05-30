/** Messages from main thread to worker */
export type ShimmerWorkerMessage =
  | { type: 'update'; phase: string; phaseName: string; percent: number; count: number }
  | { type: 'finish-phase' }
  | { type: 'stop' };
