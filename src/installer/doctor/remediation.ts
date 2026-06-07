import * as path from 'node:path';
import type { CheckId, CheckResult, CheckStatus, RemediationStep, RunDoctorOptions } from './contract.js';
import { resolveModelsDir } from './model-checks.js';

const AUTO_FIXABLE_CHECK_IDS = new Set<CheckId>(['project-init', 'llm-models', 'project-config']);

export function isAutoFixable(id: CheckId, status: CheckStatus): boolean {
  if (status === 'ok') return false;
  return AUTO_FIXABLE_CHECK_IDS.has(id);
}

/** Auto-apply fixes for gaps the doctor knows how to handle. */
export async function applyRemediations(checks: CheckResult[], opts: RunDoctorOptions): Promise<RemediationStep[]> {
  const steps: RemediationStep[] = [];
  const projectPath = path.resolve(opts.projectPath ?? process.cwd());

  const initCheck = checks.find((c) => c.id === 'project-init' && c.status !== 'ok');
  if (initCheck) steps.push(await applyProjectInitRemediation(projectPath));

  const modelsCheck = checks.find((c) => c.id === 'llm-models' && c.status !== 'ok');
  if (modelsCheck) steps.push(await applyModelInstallRemediation());

  const configCheck = checks.find((c) => c.id === 'project-config' && c.status !== 'ok');
  if (configCheck) steps.push(await applyProjectConfigRemediation(projectPath));

  const embCheck = checks.find((c) => c.id === 'embedding-endpoint' && c.status !== 'ok');
  if (embCheck) {
    steps.push({
      check: 'Embedding endpoint',
      action: 'skipped',
      detail: `Cannot auto-start a backend. ${embCheck.remediation ?? embCheck.detail}`,
    });
  }

  return steps;
}

async function applyProjectInitRemediation(projectPath: string): Promise<RemediationStep> {
  try {
    const { createDirectory } = await import('../../directory.js');
    createDirectory(projectPath);
    return { check: 'Project init', action: 'ran-init', detail: `Created ${projectPath}/.cartograph/` };
  } catch (err) {
    return {
      check: 'Project init',
      action: 'failed',
      detail: `createDirectory failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function applyModelInstallRemediation(): Promise<RemediationStep> {
  try {
    const { installRecommendedModels } = await import('../install-models.js');
    const { RECOMMENDED_MODELS } = await import('../../llm/recommended-models.js');
    const result = await installRecommendedModels({ models: RECOMMENDED_MODELS, dir: resolveModelsDir() });
    return {
      check: 'LLM models',
      action: 'ran-install-models',
      detail: `Downloaded ${result.downloaded.length} model(s); ${result.skipped.length} already present.`,
    };
  } catch (err) {
    return {
      check: 'LLM models',
      action: 'failed',
      detail: `install-models failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function applyProjectConfigRemediation(projectPath: string): Promise<RemediationStep> {
  try {
    const { planLlmSetup, applyLlmSetupChoice } = await import('../llm-setup-plan.js');
    const plan = await planLlmSetup();
    const result = await applyLlmSetupChoice({ projectRoot: projectPath, preset: plan.recommendedPresetId });
    const next = result.nextSteps.length > 0 ? ` Next: ${result.nextSteps.join(' ; ')}` : '';
    return {
      check: 'Project config',
      action: 'ran-llm-apply',
      detail: `Applied preset \`${result.preset}\` → ${result.configPath ?? '(no write)'}.${next}`,
    };
  } catch (err) {
    return {
      check: 'Project config',
      action: 'failed',
      detail: `llm-plan/apply failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
