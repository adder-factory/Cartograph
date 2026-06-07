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
  checkDatabaseStorage,
  checkConfiguredModelFiles,
  checkModels,
  checkProjectConfig,
  checkProjectInit,
  readLlmFromConfig,
} from './model-checks.js';
import { activeCartographProcessesCheck } from './processes.js';

interface ProjectDoctorChecks {
  checks: CheckResult[];
  llm: Record<string, unknown> | null;
  projectPathForChecks: string | null;
}

/** Pure-check pass: the body of `runDoctor` minus the `fix` branch. */
export async function runDoctorChecks(opts: RunDoctorOptions): Promise<DoctorResult> {
  const checks: CheckResult[] = [];
  checks.push(checkBunRuntime());

  const projectChecks = await runProjectDoctorChecks(opts);
  checks.push(...projectChecks.checks);
  const llm = projectChecks.llm;

  checks.push(await checkModels(llm));

  const detected = await detectBackends(configuredEndpointsFromLlm(llm));
  checks.push(detectedBackendsCheck(detected));
  const embeddingLlm = llm?.['embeddingLlm'] as Record<string, unknown> | null | undefined;
  const projectPathForChecks = projectChecks.projectPathForChecks;
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

async function runProjectDoctorChecks(opts: RunDoctorOptions): Promise<ProjectDoctorChecks> {
  if (opts.skipProjectChecks) {
    return {
      checks: [
        {
          id: 'project-checks',
          name: 'Project checks',
          status: 'ok',
          detail: 'Skipped project init/config checks by request.',
        },
      ],
      llm: null,
      projectPathForChecks: null,
    };
  }

  const projectPath = path.resolve(opts.projectPath ?? process.cwd());
  const checks: CheckResult[] = [];
  const initCheck = await checkProjectInit(projectPath);
  checks.push(initCheck);
  if (initCheck.status !== 'ok') return { checks, llm: null, projectPathForChecks: projectPath };

  const configCheck = await checkProjectConfig(projectPath);
  checks.push(configCheck);
  if (configCheck.status !== 'fail') checks.push(await checkDatabaseStorage(projectPath));

  const llm = await readLlmFromConfig(projectPath);
  const modelFileCheck = await checkConfiguredModelFiles(llm);
  if (modelFileCheck) checks.push(modelFileCheck);
  return { checks, llm, projectPathForChecks: projectPath };
}
