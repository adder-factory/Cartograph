/**
 * Cross-file biomarker WORKER POOL — parity + fail-safe guards.
 *
 * Two invariants the dispatch optimisation (G9 Phase 2C) must hold, and
 * which an empirical one-off check can't lock in:
 *
 *  1. **Parity** — running the 6 cross-file rules in worker_threads (each
 *     on a fresh `createDatabase` handle) returns the byte-identical
 *     Finding SET as running them serially on the host indexing
 *     connection. This is exercised with a fixture that emits BOTH a
 *     `god_class` ERROR (≥60 members) and a `duplicate_code` WARNING
 *     (exact clone) — the gate-relevant severities. If a future rule
 *     introduces connection-local state (a TEMP table, a registered SQL
 *     function, an ATTACHed DB) that a fresh worker handle lacks, OR a
 *     structuredClone-hostile `detail` payload, this test goes red.
 *
 *  2. **Fail-safe on error** — a worker error/timeout must PRESERVE that
 *     rule's prior-pass findings, never silently clear them. Clearing
 *     would make a transient 60s-timeout (most likely on the heaviest
 *     rule, `duplicate_code`, which emits warnings) indistinguishable
 *     from "the rule found nothing" — wiping real warning/error rows a
 *     code-health gate would then read as clean. See
 *     `reconcileCrossFileRuleResult` in `src/biomarkers/index.ts`.
 *
 * Background: a 2026-05-29 audit confirmed the worker SUCCESS path is
 * provably read-equivalent to serial (all 6 rules read only persistent
 * on-disk tables; no connection-local SQL state). The residual risk was
 * the orchestration error branch — these tests lock both halves.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import Cartograph from '../src/index.js';
import { CROSS_FILE_RULES, reconcileCrossFileRuleResult } from '../src/biomarkers/index.js';
import { runRulesInWorkers } from '../src/biomarkers/worker-pool.js';
import { getDatabasePath } from '../src/db/index.js';
import type { Finding } from '../src/biomarkers/types.js';

/** A class with `n` trivial 1-line methods. n>=60 -> god_class `error`
 *  (T_GOD_ERR). 1-line bodies stay under DUP_MIN_LOC so the methods
 *  don't themselves trip `duplicate_code`. */
function godClassSource(n: number): string {
  let s = 'export class HugeService {\n';
  for (let i = 0; i < n; i++) s += `  m${i}(): number { return ${i}; }\n`;
  return `${s}}\n`;
}

/** A 7-line function (clears DUP_MIN_LOC=6). Written byte-identically to
 *  two production files -> Tier-1 exact clone -> `warning`. */
const CLONE_BODY =
  'export function processItem(input: string): string {\n' +
  '  const trimmed = input.trim();\n' +
  '  const upper = trimmed.toUpperCase();\n' +
  "  const prefixed = 'ITEM:' + upper;\n" +
  "  const suffixed = prefixed + ':END';\n" +
  '  return suffixed;\n' +
  '}\n';

function setupFixture(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-worker-parity-'));
  fs.writeFileSync(path.join(dir, 'huge.ts'), godClassSource(62));
  fs.writeFileSync(path.join(dir, 'clone-a.ts'), CLONE_BODY);
  fs.writeFileSync(path.join(dir, 'clone-b.ts'), CLONE_BODY);
  return dir;
}

/** Finding identity used for set comparison — excludes `detail` (which
 *  legitimately round-trips through structuredClone on the worker path). */
function key(f: Finding): string {
  return `${f.biomarker}|${f.severity}|${f.nodeId}|${f.metric}`;
}

function hasSeverity(findings: Finding[], severity: string): boolean {
  return findings.some((f) => f.severity === severity);
}

describe('cross-file biomarker worker pool parity + fail-safe', () => {
  it('worker pool produces the identical finding set as the serial host path, incl. warning + error severities', async () => {
    const dir = setupFixture();
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });

      // Serial truth — rules run on the PRODUCTION host indexing connection.
      const serial: Finding[] = [];
      for (const rule of CROSS_FILE_RULES) serial.push(...rule.produce(cg.queries, dir));

      // Worker pool — one worker per rule on its own fresh createDatabase handle.
      const ruleKinds = CROSS_FILE_RULES.map((r) => r.kind);
      const results = await runRulesInWorkers({ dbPath: getDatabasePath(dir), projectRoot: dir, ruleKinds });
      expect(results.every((r) => r.error === undefined)).toBe(true);
      const worker: Finding[] = results.flatMap((r) => r.findings);

      // Identical finding SET (order-independent).
      const sKeys = new Set(serial.map(key));
      const wKeys = new Set(worker.map(key));
      expect([...wKeys].filter((k) => !sKeys.has(k))).toEqual([]);
      expect([...sKeys].filter((k) => !wKeys.has(k))).toEqual([]);

      // The fixture MUST exercise the gate-relevant severities in BOTH
      // paths — otherwise an all-info parity proves nothing about
      // warning/error drop safety.
      expect(hasSeverity(serial, 'error')).toBe(true); // god_class >= 60 members
      expect(hasSeverity(serial, 'warning')).toBe(true); // duplicate_code exact clone
      expect(hasSeverity(worker, 'error')).toBe(true);
      expect(hasSeverity(worker, 'warning')).toBe(true);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('preserves a rule prior-pass findings on error (worker timeout/crash) and clears only on success', async () => {
    const dir = setupFixture();
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const countKind = (k: string): number =>
        (
          cg.queries.db.prepare('SELECT COUNT(*) AS n FROM code_health_findings WHERE biomarker = ?').get(k) as {
            n: number;
          }
        ).n;

      const before = countKind('god_class');
      expect(before).toBeGreaterThan(0);

      // Worker error/timeout -> PRESERVE prior rows (the fix). Clearing
      // here was the silent-drop bug.
      const errRes = reconcileCrossFileRuleResult({
        queries: cg.queries,
        kind: 'god_class',
        passKind: 'full-pass',
        outcome: { ok: false, error: 'simulated worker timeout after 60000ms' },
        source: 'worker',
      });
      expect(errRes).toEqual({ findingsEmitted: 0, errored: true });
      expect(countKind('god_class')).toBe(before); // preserved, not wiped

      // A SUCCESSFUL empty result still clears — converges to current truth.
      const okEmpty = reconcileCrossFileRuleResult({
        queries: cg.queries,
        kind: 'god_class',
        passKind: 'full-pass',
        outcome: { ok: true, raw: [] },
        source: 'serial',
      });
      expect(okEmpty).toEqual({ findingsEmitted: 0, errored: false });
      expect(countKind('god_class')).toBe(0); // cleared on success
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a per-rule timeout surfaces as an error result — never ok:true with fewer findings', async () => {
    const dir = setupFixture();
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const ruleKinds = CROSS_FILE_RULES.map((r) => r.kind);
      // 1ms budget is far below worker cold-start (~50-200ms): every rule
      // times out (or fast-crashes) with a populated error — the contract
      // the host's preserve-on-error branch depends on. (If a worker ever
      // posted a result in <1ms it would arrive as ok:true with findings,
      // failing the assertions below — that would be a test-environment
      // artifact, not a production regression.)
      const results = await runRulesInWorkers({
        dbPath: getDatabasePath(dir),
        projectRoot: dir,
        ruleKinds,
        perRuleTimeoutMs: 1,
      });
      expect(results.length).toBe(ruleKinds.length);
      expect(results.every((r) => r.error !== undefined)).toBe(true);
      expect(results.every((r) => r.findings.length === 0)).toBe(true);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('persists biomarker_cross_file_errors = 0 after a clean full pass (the CI fail-closed sentinel)', async () => {
    const dir = setupFixture();
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      // Read the exact key + table `scripts/check-biomarkers.mjs` reads — a
      // typo'd key or un-wired persistence (the real failure modes) shows here.
      const row = cg.queries.db
        .prepare("SELECT value FROM project_metadata WHERE key = 'biomarker_cross_file_errors'")
        .get() as { value: string } | undefined;
      expect(row?.value).toBe('0');
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
