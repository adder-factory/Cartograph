export interface AdminIndexOptions {
  force?: boolean;
  quiet?: boolean;
  verbose?: boolean;
  profile?: boolean;
  clearParseCache?: boolean | string;
  parseWorkers?: string;
  maxFileSize?: string;
}

interface AdminIndexProfile {
  scanMs?: number;
  parseStoreMs?: number;
  retryMs?: number;
  extractionMs?: number;
  resolveMs?: number;
  postHooksMs?: number;
  maintenanceMs?: number;
  postHooksByHook?: Record<string, number>;
}

export interface AdminIndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  errors: Array<{ message: string; filePath?: string; severity: string; code?: string }>;
  durationMs: number;
  profile?: AdminIndexProfile;
}

export interface SyncResult {
  filesAdded: number;
  filesModified: number;
  filesRemoved: number;
  nodesUpdated: number;
  durationMs: number;
}

export type ParseWorkersResult = { ok: true; value: number | undefined } | { ok: false; error: string };
export type MaxFileSizeResult = { ok: true; value: number | undefined } | { ok: false; error: string };

export interface IndexAllOptions {
  summarize: false;
  profile: boolean;
  clearStructural: boolean;
  parseWorkers?: number;
  maxFileSize?: number;
}

export interface SyncResultMessage {
  level: 'info' | 'success';
  message: string;
}

const PHASE_PERCENT_SCALE = 100;
const PHASE_LABEL_WIDTH = 14;
const PHASE_DURATION_WIDTH = 8;
const PHASE_PERCENT_WIDTH = 2;
const POST_HOOK_LABEL_WIDTH = 12;

export function parseParseWorkersValue(raw: string | undefined): ParseWorkersResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n < 1) {
    return { ok: false, error: `--parse-workers must be a positive integer (got "${raw}")` };
  }
  return { ok: true, value: n };
}

export function parseMaxFileSizeValue(raw: string | undefined): MaxFileSizeResult {
  if (raw === undefined) return { ok: true, value: undefined };
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    return { ok: false, error: `--max-file-size must be a positive integer byte count (got "${raw}")` };
  }
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n) || n < 1) {
    return { ok: false, error: `--max-file-size must be a positive integer byte count (got "${raw}")` };
  }
  return { ok: true, value: n };
}

export function indexAllOptions(
  options: Pick<AdminIndexOptions, 'force' | 'profile'>,
  parseWorkers: number | undefined,
  maxFileSize?: number | undefined,
): IndexAllOptions {
  return {
    summarize: false,
    profile: !!options.profile,
    clearStructural: !!options.force,
    ...(parseWorkers !== undefined && { parseWorkers }),
    ...(maxFileSize !== undefined && { maxFileSize }),
  };
}

export function phaseTimingLines(result: AdminIndexResult, deps: { formatDuration: (ms: number) => string }): string[] {
  const p = result.profile;
  if (!p) return [];
  const fmt = (label: string, ms: number | undefined): string => {
    if (ms === undefined) return '';
    const pct = result.durationMs > 0 ? Math.round((ms / result.durationMs) * PHASE_PERCENT_SCALE) : 0;
    return `  ${label.padEnd(PHASE_LABEL_WIDTH)} ${deps.formatDuration(ms).padStart(PHASE_DURATION_WIDTH)}  (${pct.toString().padStart(PHASE_PERCENT_WIDTH)}%)`;
  };
  const lines = [fmt('scan', p.scanMs), fmt('parse+store', p.parseStoreMs)];
  if (p.retryMs && p.retryMs > 0) lines.push(fmt('retry', p.retryMs));
  lines.push(fmt('resolve', p.resolveMs), fmt('postHooks', p.postHooksMs));
  if (p.postHooksByHook && p.postHooksMs && p.postHooksMs > 0) {
    const sorted = Object.entries(p.postHooksByHook).sort((a, b) => b[1] - a[1]);
    for (const [name, ms] of sorted) {
      const pct = p.postHooksMs > 0 ? Math.round((ms / p.postHooksMs) * PHASE_PERCENT_SCALE) : 0;
      lines.push(
        `    ${name.padEnd(POST_HOOK_LABEL_WIDTH)} ${deps.formatDuration(ms).padStart(PHASE_DURATION_WIDTH)}  (${pct.toString().padStart(PHASE_PERCENT_WIDTH)}% of postHooks)`,
      );
    }
  }
  lines.push(fmt('maintenance', p.maintenanceMs), fmt('total', result.durationMs));
  return lines.filter(Boolean);
}

export function syncResultMessages(
  result: SyncResult,
  deps: { formatNumber: (n: number) => string; formatDuration: (ms: number) => string },
): SyncResultMessage[] {
  const totalChanges = result.filesAdded + result.filesModified + result.filesRemoved;
  if (totalChanges === 0) {
    return [{ level: 'info', message: 'Already up to date' }];
  }

  const details: string[] = [];
  if (result.filesAdded > 0) details.push(`Added: ${result.filesAdded}`);
  if (result.filesModified > 0) details.push(`Modified: ${result.filesModified}`);
  if (result.filesRemoved > 0) details.push(`Removed: ${result.filesRemoved}`);

  return [
    { level: 'success', message: `Synced ${deps.formatNumber(totalChanges)} changed files` },
    {
      level: 'info',
      message: `${details.join(', ')} — ${deps.formatNumber(result.nodesUpdated)} nodes in ${deps.formatDuration(result.durationMs)}`,
    },
  ];
}

export function printSyncResult(
  clack: { log: { info: (message: string) => void; success: (message: string) => void } },
  result: SyncResult,
  deps: { formatNumber: (n: number) => string; formatDuration: (ms: number) => string },
): void {
  for (const message of syncResultMessages(result, deps)) {
    clack.log[message.level](message.message);
  }
}
