/**
 * `cartograph doctor` diagnoses install state and returns structured
 * remediation data for CLI, MCP, and future UI surfaces.
 */

import { runDoctorChecks } from './doctor/checks.js';
import type { DoctorResultWithFix, RemediationStep, RunDoctorOptions } from './doctor/contract.js';
import { worstStatus } from './doctor/contract.js';
import { applyRemediations, isAutoFixable } from './doctor/remediation.js';

export type {
  CheckId,
  CheckResult,
  CheckStatus,
  DoctorResult,
  DoctorResultWithFix,
  RemediationStep,
  RunDoctorOptions,
} from './doctor/contract.js';
export { formatDoctorJson, formatDoctorReport } from './doctor/report.js';
export { parseCartographProcessList } from './doctor/processes.js';

const MAX_FIX_ITERATIONS = 3;

export async function runDoctor(opts: RunDoctorOptions = {}): Promise<DoctorResultWithFix> {
  const initial = await runDoctorChecks(opts);
  if (!opts.fix) return initial;

  const allRemediations: RemediationStep[] = [];
  let lastChecks = initial.checks;
  for (let i = 0; i < MAX_FIX_ITERATIONS; i++) {
    const round = await applyRemediations(lastChecks, opts);
    if (round.length === 0) break;
    allRemediations.push(...round);

    const recheck = await runDoctorChecks(opts);
    const stillFixable = recheck.checks.some((c) => isAutoFixable(c.id, c.status));
    lastChecks = recheck.checks;
    if (!stillFixable) break;
  }

  return {
    ...initial,
    remediations: allRemediations,
    afterFix: {
      checks: lastChecks,
      overallStatus: worstStatus(lastChecks),
      ...(opts.skipProjectChecks ? { projectChecksSkipped: true } : {}),
    },
  };
}
