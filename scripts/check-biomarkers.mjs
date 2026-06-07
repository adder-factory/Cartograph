#!/usr/bin/env bun
/**
 * Biomarker floor gate (Live-queue #3, 2026-05-29).
 *
 * The project's bar is **0 error / 0 warning** biomarker findings, with a
 * small intentional info floor (see CLAUDE.md "Biomarker conventions"). Until
 * this gate existed nothing gated biomarkers: CI ran only typecheck + biome,
 * and the per-commit discipline ran tests but not the biomarker floor — so
 * findings could silently accumulate (the 2026-05-28 drift to 5 err / 37 warn,
 * baseline 65, went undetected for exactly this reason).
 *
 * This script (re)indexes the repo structurally and fails non-zero if ANY
 * error or warning finding exists. INFO is reported but NOT gated: per-symbol
 * info counts (e.g. `forof_await`) fluctuate across reindexes (a known
 * tool-reliability quirk — see project_stale_mcp_server_biomarker_clobber), so
 * gating info would be flaky; the stable, meaningful signal is err/warn, which
 * is the documented bar.
 *
 * It ALSO fails closed when the cross-file biomarker pass reported any rule
 * error/timeout (the `biomarker_cross_file_errors` metadata key, set by
 * `analyseProject`). The cross-file rules are deterministic pure reads, so a
 * healthy full pass produces 0; a non-zero count means a rule crashed or a
 * worker timed out and its findings were preserved-but-stale rather than
 * refreshed — so an apparently-clean `code_health_findings` table can't be
 * trusted (a silent false-negative the severity count alone can't catch).
 * Per-file analysis errors are NOT yet gated (their healthy count on this repo
 * is unverified — a future tightening once confirmed 0).
 *
 * Accepted gap: if a project sets `enableBiomarkers: false`, the analysis hook
 * never runs, the sentinel key is never written, and the gate takes the
 * absent-key (note, don't fail) path — correct, since a project that disables
 * biomarkers has nothing to gate. This repo keeps biomarkers enabled, so the
 * gate's own `--force` full pass always writes the key.
 *
 * Runs under Bun (needs `bun:sqlite` + the indexer's `bun:ffi`/grammars). The
 * index runs with `CARTOGRAPH_BIOMARKER_SERIAL=1`, which serializes the
 * cross-file biomarker rules (their >10k-node worker pool — this repo crosses
 * that). The per-file biomarker pool is gated by its own (higher) file-count
 * threshold this repo is under, so the gate's index runs effectively serial:
 * deterministic AND the worker spawns (suspected source of the full-suite Bun
 * bus-error) are avoided here. Usage: `npm run check:biomarkers` (local or CI).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Database } from 'bun:sqlite';

const root = process.cwd();
const CLI = 'src/bin/cartograph.ts';
const dbPath = path.join(root, '.cartograph', 'cartograph.db');
const DB_OPEN_ATTEMPTS = 5;
const DB_OPEN_RETRY_MS = 200;

/** Run a cartograph CLI subcommand; abort the gate on a non-zero exit. */
function runCli(args, label) {
  const res = spawnSync('bun', [CLI, ...args], {
    stdio: 'inherit',
    cwd: root,
    env: { ...process.env, CARTOGRAPH_BIOMARKER_SERIAL: '1' },
  });
  if (res.status !== 0) {
    console.error(`\nbiomarker-gate: \`${label}\` failed (exit ${res.status ?? 'signal ' + res.signal}).`);
    process.exit(1);
  }
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isRetryableSqliteOpenError(error) {
  return error?.code === 'SQLITE_CANTOPEN' || error?.errno === 14;
}

function readBiomarkerGateStateAttempt(databasePath) {
  if (!existsSync(databasePath)) {
    return { ok: false, error: new Error(`${databasePath} does not exist after indexing`) };
  }
  try {
    return { ok: true, state: readBiomarkerGateState(databasePath) };
  } catch (error) {
    if (!isRetryableSqliteOpenError(error)) throw error;
    return { ok: false, error };
  }
}

function readBiomarkerGateState(databasePath) {
  const db = new Database(databasePath, { readonly: true, create: false });
  try {
    const counts = { error: 0, warning: 0, info: 0 };
    for (const row of db.query('SELECT severity, COUNT(*) AS n FROM code_health_findings GROUP BY severity').all()) {
      counts[row.severity] = row.n;
    }
    const offenders =
      counts.error + counts.warning > 0
        ? db
            .query(
              `SELECT f.biomarker AS biomarker, f.severity AS severity, n.name AS name, n.file_path AS filePath
               FROM code_health_findings f JOIN nodes n ON n.id = f.node_id
               WHERE f.severity IN ('error', 'warning')
               ORDER BY f.severity DESC, n.file_path, n.start_line`,
            )
            .all()
        : [];
    const cfRaw =
      db.query("SELECT value FROM project_metadata WHERE key = 'biomarker_cross_file_errors'").get()?.value ?? null;
    return { counts, offenders, cfRaw };
  } finally {
    db.close();
  }
}

function sleepBeforeNextDbReadAttempt(attempt) {
  if (attempt < DB_OPEN_ATTEMPTS) sleepMs(DB_OPEN_RETRY_MS * attempt);
}

function readBiomarkerGateStateWithRetry(databasePath) {
  let lastError = null;
  for (let attempt = 1; attempt <= DB_OPEN_ATTEMPTS; attempt++) {
    const result = readBiomarkerGateStateAttempt(databasePath);
    if (result.ok) return result.state;
    lastError = result.error;
    sleepBeforeNextDbReadAttempt(attempt);
  }
  throw lastError ?? new Error(`Unable to open ${databasePath}`);
}

// 1. Index the repo structurally. `admin init` first when there's no index
//    yet (the CI checkout has no committed `.cartograph/`); `--force` so the
//    findings reflect the CURRENT source, `--quiet` to skip the LLM tail
//    (biomarkers are AST-based — no LLM needed).
if (!existsSync(dbPath)) runCli(['admin', 'init'], 'admin init');
runCli(['admin', 'index', '--force', '--quiet'], 'admin index --force --quiet');

// 2. Count findings by severity straight off the table (no markdown parsing).
// Cross-file rule-error sentinel (key must match `setMetadata(...,
// 'biomarker_cross_file_errors', ...)` in src/biomarkers/index.ts). The
// writer always stores `String(<non-negative integer>)`, so the gate passes
// ONLY when the value is exactly integer 0; any other PRESENT value (>0, or a
// corrupt/non-integer string) fails closed. An ABSENT key is treated as
// unknown (note, don't fail) to stay non-brittle — but see the JSDoc caveat:
// `enableBiomarkers: false` is the one config where absent legitimately means
// "nothing to gate."
const { counts, offenders, cfRaw } = readBiomarkerGateStateWithRetry(dbPath);
const crossFileErrors = cfRaw === null ? null : Number(cfRaw);

console.log(`\nbiomarker floor: ${counts.error} error / ${counts.warning} warning / ${counts.info} info`);
console.log(`cross-file rule errors: ${cfRaw === null ? '(not recorded — full-pass sentinel absent)' : cfRaw}`);

const crossFileClean = crossFileErrors === null || (Number.isInteger(crossFileErrors) && crossFileErrors === 0);
if (!crossFileClean) {
  const detail =
    Number.isInteger(crossFileErrors) && crossFileErrors > 0
      ? `${crossFileErrors} cross-file biomarker rule(s) errored/timed-out during indexing`
      : `the cross-file error sentinel holds an unexpected value (${JSON.stringify(cfRaw)})`;
  console.error(
    `\nbiomarker-gate FAILED — ${detail}.\n` +
      'Affected findings were preserved-but-stale (not refreshed), so the 0 error / 0 warning count above\n' +
      'cannot be trusted. Check the indexer log for "cross-file rule \'<kind>\' failed" WARN lines, fix the\n' +
      'rule (or the timeout), and re-run. See src/biomarkers/index.ts reconcileCrossFileRuleResult.',
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('\nbiomarker-gate FAILED — the floor is 0 error / 0 warning. Offending findings:');
  for (const o of offenders) {
    console.error(`  [${o.severity}] ${o.biomarker} — ${o.name}  (${o.filePath})`);
  }
  console.error(
    '\nFix the code (extract helpers, named consts, etc.) — never raise a threshold or suppress.\n' +
      'See CLAUDE.md "Biomarker conventions". Info findings are intentional-by-design and not gated.',
  );
  process.exit(1);
}

console.log('biomarker-gate OK — 0 error / 0 warning.');
