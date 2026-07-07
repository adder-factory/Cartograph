#!/usr/bin/env bun
/**
 * Biomarker floor gate (Live-queue #3, 2026-05-29).
 *
 * The project's bar is **0 error / 0 warning / 0 info** biomarker findings.
 * Until this gate existed nothing gated biomarkers: CI ran only typecheck +
 * biome, and the per-commit discipline ran tests but not the biomarker floor
 * — so findings could silently accumulate (the 2026-05-28 drift to 5 err /
 * 37 warn, baseline 65, went undetected for exactly this reason).
 *
 * This script brings the index current (incremental sync + a full biomarker
 * refresh; first run or BIOMARKER_GATE_FORCE=1 does a full structural index)
 * and fails non-zero if ANY biomarker finding exists, including info-level
 * findings. If info counts fluctuate, treat that as detector/indexing drift
 * to fix rather than a gate exception.
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
import { loadConfig } from '../src/config.ts';
import { DatabaseConnection } from '../src/db/index.ts';

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
  const config = loadConfig(root);
  let conn = null;
  try {
    conn = DatabaseConnection.open(databasePath, { database: config.database });
    return { ok: true, state: readBiomarkerGateState(conn.getDb()) };
  } catch (error) {
    if (!isRetryableSqliteOpenError(error)) throw error;
    return { ok: false, error };
  } finally {
    if (conn !== null) conn.close();
  }
}

// Biomarkers excluded from the structural floor gate. `low_coverage` is
// the only coverage-DEPENDENT biomarker: it reads `node_coverage`, which
// is populated by an external `cartograph coverage --mode load`, not by
// indexing. Its findings are real test-gap signals (surfaced in
// `cartograph_biomarkers` / `digest` / `review`), but they are NOT
// structural code-health drift — and counting them here would make the
// gate flip based purely on whether lcov happened to be loaded into the
// index (green on a fresh CI checkout with no coverage, red on a dev box
// that loaded coverage), which is not the deterministic structural floor
// this gate exists to hold. See src/biomarkers/low-coverage.ts.
const GATE_EXCLUDED_BIOMARKERS = ['low_coverage'];

function readBiomarkerGateState(db) {
  const excludedList = GATE_EXCLUDED_BIOMARKERS.map((b) => `'${b}'`).join(', ');
  const excludeClause = `biomarker NOT IN (${excludedList})`;
  const counts = { error: 0, warning: 0, info: 0 };
  for (const row of db
    .prepare(`SELECT severity, COUNT(*) AS n FROM code_health_findings WHERE ${excludeClause} GROUP BY severity`)
    .all()) {
    counts[row.severity] = row.n;
  }
  const offenders =
    counts.error + counts.warning + counts.info > 0
      ? db
          .prepare(
            `SELECT f.biomarker AS biomarker, f.severity AS severity, n.name AS name, n.file_path AS filePath
             FROM code_health_findings f JOIN nodes n ON n.id = f.node_id
             WHERE f.severity IN ('error', 'warning', 'info') AND f.${excludeClause}
             ORDER BY CASE f.severity WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END,
                      n.file_path, n.start_line`,
          )
          .all()
      : [];
  const cfRaw =
    db.prepare("SELECT value FROM project_metadata WHERE key = 'biomarker_cross_file_errors'").get()?.value ?? null;
  return { counts, offenders, cfRaw };
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

function makeWalDatabaseReadable(databasePath) {
  const config = loadConfig(root);
  const conn = DatabaseConnection.open(databasePath, { database: config.database });
  try {
    if (conn.getBackend() === 'postgres') return;
    const db = conn.getDb();
    db.exec('PRAGMA busy_timeout=1000');
    db.exec('PRAGMA wal_checkpoint(PASSIVE)');
  } finally {
    conn.close();
  }
}

// 1. Bring the findings to full-pass authority against CURRENT source.
//    Fresh checkout (CI): init + full index. Existing index (local dev
//    loop): `admin sync` (re-extracts only changed files) + `admin
//    biomarkers-refresh` (full per-file + cross-file findings pass on
//    the current index) — same end state as the old `index --force`
//    without re-extracting an unchanged repo on every gate run.
//    BIOMARKER_GATE_FORCE=1 restores the full wipe-and-reindex path.
//    `--quiet` skips the LLM tail (biomarkers are AST-based).
if (!existsSync(dbPath)) {
  runCli(['admin', 'init'], 'admin init');
  runCli(['admin', 'index', '--quiet'], 'admin index --quiet');
} else if (process.env.BIOMARKER_GATE_FORCE === '1') {
  runCli(['admin', 'index', '--force', '--quiet'], 'admin index --force --quiet');
} else {
  runCli(['admin', 'sync', '--quiet'], 'admin sync --quiet');
  runCli(['admin', 'biomarkers-refresh', '--quiet'], 'admin biomarkers-refresh --quiet');
}

// 2. Count findings by severity straight off the table (no markdown parsing).
// Cross-file rule-error sentinel (key must match `setMetadata(...,
// 'biomarker_cross_file_errors', ...)` in src/biomarkers/index.ts). The
// writer always stores `String(<non-negative integer>)`, so the gate passes
// ONLY when the value is exactly integer 0; any other PRESENT value (>0, or a
// corrupt/non-integer string) fails closed. An ABSENT key is treated as
// unknown (note, don't fail) to stay non-brittle — but see the JSDoc caveat:
// `enableBiomarkers: false` is the one config where absent legitimately means
// "nothing to gate."
makeWalDatabaseReadable(dbPath);
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
      'Affected findings were preserved-but-stale (not refreshed), so the 0/0/0 count above\n' +
      'cannot be trusted. Check the indexer log for "cross-file rule \'<kind>\' failed" WARN lines, fix the\n' +
      'rule (or the timeout), and re-run. See src/biomarkers/index.ts reconcileCrossFileRuleResult.',
  );
  process.exit(1);
}

if (offenders.length > 0) {
  console.error('\nbiomarker-gate FAILED — the floor is 0 error / 0 warning / 0 info. Offending findings:');
  for (const o of offenders) {
    console.error(`  [${o.severity}] ${o.biomarker} — ${o.name}  (${o.filePath})`);
  }
  console.error(
    '\nFix the code (extract helpers, named consts, etc.) — never raise a threshold or suppress.\n' +
      'See docs/ARCHITECTURE.md for the biomarker floor.',
  );
  process.exit(1);
}

console.log('biomarker-gate OK — 0 error / 0 warning / 0 info.');
