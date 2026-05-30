/**
 * MCP server boot-time catch-up sync (B1).
 *
 * The file watcher only fires on LIVE filesystem events; edits made
 * while the MCP server was down don't backfill on watcher start.
 * Without this helper, the index can sit `🔴 very_stale` for the
 * whole session even though the status banner reports "auto-sync is
 * active". Running one `cg.sync()` between `open` and `startWatching`
 * closes the gap — sync is incremental and finishes in well under a
 * second on typical drift (a 99-file backlog took 0.6s in repro).
 *
 * Best-effort: any failure logs to stderr but does NOT block boot.
 * The agent can still query the (stale) index, and the per-tool
 * freshness banner still surfaces drift inline.
 */
import type Cartograph from '../index.js';
import { errMsg } from '../errors.js';
import { checkSchemaCompat, formatSchemaMismatch } from './schema-guard.js';

interface StartupSyncOptions {
  /** Skip the sync entirely. CLI flag: `--no-startup-sync`. */
  disabled?: boolean;
  /** Log sink. Production passes a stderr writer; tests capture it. */
  log: (line: string) => void;
}

export async function runStartupSync(cg: Cartograph, options: StartupSyncOptions): Promise<void> {
  if (options.disabled) return;
  // B4 guard: don't sync into a DB whose schema this code doesn't
  // understand — the sync would just drop rows silently like the
  // watcher would. Surface the warning so the operator knows to
  // restart instead of silently absorbing the cost.
  const compat = checkSchemaCompat(cg);
  if (!compat.ok) {
    options.log(`[Cartograph MCP] ${formatSchemaMismatch(compat)} Startup sync skipped.\n`);
    return;
  }
  const t0 = Date.now();
  try {
    const result = await cg.sync();
    if (result.lockContention) {
      options.log(
        `[Cartograph MCP] Startup sync skipped (another process holds the index lock) — ` +
          `the watcher will catch up on the next live event\n`,
      );
      return;
    }
    const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
    if (filesChanged > 0) {
      const dur = Date.now() - t0;
      options.log(
        `[Cartograph MCP] Startup sync caught up ${filesChanged} file(s) ` +
          `(+${result.filesAdded} ~${result.filesModified} -${result.filesRemoved}) in ${dur}ms\n`,
      );
    }
  } catch (err) {
    options.log(`[Cartograph MCP] Startup sync error: ${errMsg(err)}\n`);
  }
}
