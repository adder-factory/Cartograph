/**
 * Regression test for the cascade-aware `--fix` loop.
 *
 * The cascade case: a fresh project (no `.cartograph/`) has the project
 * init check failing. That short-circuits the config check (no point
 * verifying config.json under a dir that doesn't exist). When
 * `--fix` creates `.cartograph/`, the config check NOW reports
 * missing-config — a gap the initial check pass couldn't see.
 * Pre-cascade-loop behaviour stopped after one remediation pass,
 * leaving the user with a half-fixed install (`.cartograph/` exists
 * but no config). The current implementation iterates up to
 * `MAX_FIX_ITERATIONS = 3` rounds, re-running checks after each
 * round so cascaded gaps land in the same `--fix` invocation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { runDoctor } from '../src/installer/doctor.js';
import { isolateBunInstall } from './support/bun-install-isolation.js';

describe('runDoctor({fix: true}) — cascade-aware fix loop', () => {
  // Full `runDoctor` runs — keep the host's real `bun link` state out of
  // the doctor result (issue #68 global-link check).
  isolateBunInstall();

  let projectPath: string;

  beforeEach(async () => {
    projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'cg-doctor-fix-cascade-'));
    // Note: do NOT create .cartograph/ — the fresh-project case is
    // exactly what triggers the init→config cascade.
  });

  afterEach(async () => {
    if (fs.existsSync(projectPath)) await fsp.rm(projectPath, { recursive: true, force: true });
  });

  it('resolves project-init + project-config in one --fix call (the cascade)', async () => {
    // Pre-fix: project init is missing → config check is short-circuited.
    expect(fs.existsSync(path.join(projectPath, '.cartograph'))).toBe(false);

    const result = await runDoctor({ projectPath, fix: true });

    // The fix loop should have run BOTH remediations:
    //   round 1: project init (createDirectory)
    //   round 2: project config (after init unmasks the missing-config check)
    //            → runs the llm-apply path with the recommended preset
    expect(result.remediations).toBeDefined();
    const remediationNames = result.remediations!.map((r) => r.check);
    expect(remediationNames).toContain('Project init');
    expect(remediationNames).toContain('Project config');

    // Init must have run successfully.
    const initStep = result.remediations!.find((r) => r.check === 'Project init')!;
    expect(initStep.action).toBe('ran-init');

    // Config must have been applied via llm-apply (NOT failed/skipped).
    const configStep = result.remediations!.find((r) => r.check === 'Project config')!;
    expect(configStep.action).toBe('ran-llm-apply');

    // After-fix state: .cartograph/ exists AND config.json was written.
    expect(fs.existsSync(path.join(projectPath, '.cartograph'))).toBe(true);
    expect(fs.existsSync(path.join(projectPath, '.cartograph', 'config.json'))).toBe(true);

    // The afterFix report should reflect the LAST re-check — both
    // Project init and Project config should be ✓.
    expect(result.afterFix).toBeDefined();
    const afterInit = result.afterFix!.checks.find((c) => c.name === 'Project init');
    const afterConfig = result.afterFix!.checks.find((c) => c.name === 'Project config');
    expect(afterInit?.status).toBe('ok');
    expect(afterConfig?.status).toBe('ok');
  });

  it('does not loop forever — caps at MAX_FIX_ITERATIONS (=3) rounds', async () => {
    // Even on a fully-healable cascade, the loop bound MUST hold.
    // We don't have a way to count actual iterations without
    // instrumentation; the proxy assertion is that the call returns
    // in bounded time (well under a 10s timeout) and the remediations
    // list has finite length (no duplicate entries from infinite
    // looping).
    const startMs = Date.now();
    const result = await runDoctor({ projectPath, fix: true });
    const elapsedMs = Date.now() - startMs;
    expect(elapsedMs).toBeLessThan(10_000);
    // No remediation should appear more than once per check name.
    const names = result.remediations!.map((r) => r.check);
    const dedup = new Set(names);
    expect(names.length).toBe(dedup.size);
  });

  it('skips backend-not-running gaps cleanly (no infinite loop on un-fixable warnings)', async () => {
    // Pre-create the project so init + config are already ok, then
    // pass --fix. The unreachable embedding endpoint produces a
    // `skipped` RemediationStep (cartograph doesn't manage backend
    // processes), but `isAutoFixable` returns false for the
    // Embedding endpoint check — so the loop should break after
    // the first round instead of retrying the un-fixable skipped
    // step forever.
    await fsp.mkdir(path.join(projectPath, '.cartograph'));
    await fsp.writeFile(
      path.join(projectPath, '.cartograph', 'config.json'),
      JSON.stringify({
        llm: {
          embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:1', model: 'm' },
        },
      }),
    );

    const result = await runDoctor({ projectPath, fix: true });

    // Exactly ONE remediation step should fire — the skipped
    // embedding-endpoint warning. No duplicates (which would indicate
    // the loop ran the same step twice).
    expect(result.remediations).toHaveLength(1);
    expect(result.remediations![0]!.check).toBe('Embedding endpoint');
    expect(result.remediations![0]!.action).toBe('skipped');

    // afterFix re-check should still report the endpoint as warn
    // (cartograph didn't actually fix it).
    expect(result.afterFix).toBeDefined();
    const afterEmb = result.afterFix!.checks.find((c) => c.name === 'Embedding endpoint');
    expect(afterEmb?.status).toBe('warn');
  });
});
