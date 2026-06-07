import * as path from 'node:path';
import { configuredEndpointsFromLlm } from '../../features/backend/index.js';
import {
  backendLifecycleCheck,
  backendStartCommandsCheck,
  checkEmbeddingReachability,
  detectBackends,
  detectedBackendsCheck,
  recommendedTuningCheck,
} from './backend-checks.js';
import type { CheckResult, DoctorResult, RunDoctorOptions } from './contract.js';
import { worstStatus } from './contract.js';
import {
  checkBunRuntime,
  checkConfiguredModelFiles,
  checkModels,
  checkProjectConfig,
  checkProjectInit,
  readLlmFromConfig,
} from './model-checks.js';
import { activeCartographProcessesCheck } from './processes.js';

/** Pure-check pass: the body of `runDoctor` minus the `fix` branch. */
export async function runDoctorChecks(opts: RunDoctorOptions): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  checks.push(checkBunRuntime());

  let llm: Record<string, unknown> | null = null;
  if (opts.skipProjectChecks) {
    checks.push({
      id: 'project-checks',
      name: 'Project checks',
      status: 'ok',
      detail: 'Skipped project init/config checks by request.',
    });
  } else {
    const projectPath = path.resolve(opts.projectPath ?? process.cwd());
    const initCheck = await checkProjectInit(projectPath);
    checks.push(initCheck);
    if (initCheck.status === 'ok') {
      const configCheck = await checkProjectConfig(projectPath);
      checks.push(configCheck);
      llm = await readLlmFromConfig(projectPath);
      const modelFileCheck = await checkConfiguredModelFiles(llm);
      if (modelFileCheck) checks.push(modelFileCheck);
    }
  }

  checks.push(await checkModels(llm));

  const detected = await detectBackends(configuredEndpointsFromLlm(llm));
  checks.push(detectedBackendsCheck(detected));
  const embeddingLlm = llm?.['embeddingLlm'] as Record<string, unknown> | null | undefined;
  const projectPathForChecks = opts.skipProjectChecks ? null : path.resolve(opts.projectPath ?? process.cwd());
  const reachability = checkEmbeddingReachability({ embeddingLlm, detected, projectPath: projectPathForChecks, llm });
  if (reachability) checks.push(reachability);

  checks.push(recommendedTuningCheck());
  const backendCommands = backendStartCommandsCheck(llm);
  if (backendCommands) checks.push(backendCommands);

  if (projectPathForChecks) {
    const lifecycle = await backendLifecycleCheck(projectPathForChecks, llm);
    if (lifecycle) checks.push(lifecycle);
  }
  if (!opts.skipProjectChecks) {
    checks.push(await activeCartographProcessesCheck(path.resolve(opts.projectPath ?? process.cwd())));
  }

  return {
    checks,
    overallStatus: worstStatus(checks),
    ...(opts.skipProjectChecks ? { projectChecksSkipped: true } : {}),
  };
}
