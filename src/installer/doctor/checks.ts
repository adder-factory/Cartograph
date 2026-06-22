import * as path from 'node:path';
import { configuredEndpointsFromLlm } from '../../features/backend/index.js';
import { inspectGitHooksLiveness } from '../../features/git-hooks/index.js';
import { asJsonObject } from '../../json-object.js';
import {
  backendLifecycleCheck,
  backendStartCommandsCheck,
  chatContextBudgetCheck,
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

function ownObjectField(record: Record<string, unknown> | null, key: string): Record<string, unknown> | null {
  if (!record || !Object.hasOwn(record, key)) return null;
  return asJsonObject(record[key]);
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
  const embeddingLlm = ownObjectField(llm, 'embeddingLlm');
  const projectPathForChecks = projectChecks.projectPathForChecks;
  const reachability = checkEmbeddingReachability({ embeddingLlm, detected, projectPath: projectPathForChecks, llm });
  if (reachability) checks.push(reachability);

  checks.push(recommendedTuningCheck());
  const ctxBudget = await chatContextBudgetCheck(llm);
  if (ctxBudget) checks.push(ctxBudget);
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

  const hooksCheck = checkGitHooksLiveness(projectPath);
  if (hooksCheck) checks.push(hooksCheck);

  const llm = await readLlmFromConfig(projectPath);
  const modelFileCheck = await checkConfiguredModelFiles(llm);
  if (modelFileCheck) checks.push(modelFileCheck);
  return { checks, llm, projectPathForChecks: projectPath };
}

/**
 * Hook LIVENESS, not just presence: managed blocks stranded in
 * `.git/hooks` while `core.hooksPath` redirects execution (husky,
 * lefthook, …) report "installed" everywhere else but never fire
 * (issue #4). Null when the project is not a git worktree — nothing
 * to check.
 */
function checkGitHooksLiveness(projectPath: string): CheckResult | null {
  const liveness = inspectGitHooksLiveness(projectPath);
  if (!liveness) return null;
  if (liveness.dead.length > 0) {
    return {
      id: 'git-hooks',
      name: 'Git hooks',
      status: 'warn',
      detail: `Managed blocks for ${liveness.dead.join(', ')} sit in .git/hooks, but core.hooksPath routes execution to ${liveness.effectiveDir} — they never fire.`,
      remediation: 'Re-run `cartograph install-hooks` to write the blocks where git actually executes hooks.',
    };
  }
  if (liveness.live.length === 0) {
    return {
      id: 'git-hooks',
      name: 'Git hooks',
      status: 'ok',
      detail:
        'Managed git hooks not installed (optional — `cartograph install-hooks` adds background sync on pull/checkout/rebase).',
    };
  }
  let sourceSuffix = '';
  if (liveness.source === 'husky') sourceSuffix = ' via core.hooksPath (husky)';
  else if (liveness.source === 'core.hooksPath') sourceSuffix = ' via core.hooksPath';
  return {
    id: 'git-hooks',
    name: 'Git hooks',
    status: 'ok',
    detail: `${liveness.live.join(', ')} live in ${liveness.effectiveDir}${sourceSuffix}.`,
  };
}
