export type CheckStatus = 'ok' | 'warn' | 'fail';

export type CheckId =
  | 'bun-runtime'
  | 'llm-models'
  | 'project-init'
  | 'project-config'
  | 'database-storage'
  | 'configured-model-files'
  | 'detected-llm-backends'
  | 'embedding-endpoint'
  | 'recommended-tuning'
  | 'backend-start-commands'
  | 'backend-lifecycle'
  | 'project-checks'
  | 'git-hooks'
  | 'cartograph-processes';

export interface CheckResult {
  /** Stable machine-readable check identity for JSON consumers and internal control flow. */
  id: CheckId;
  /** Short human-readable name shown in the report header line. */
  name: string;
  status: CheckStatus;
  /** One-line summary of what was found. */
  detail: string;
  /** Concrete next-step the user can run to remediate, when status is `warn` or `fail`. */
  remediation?: string;
}

export interface DoctorResult {
  checks: CheckResult[];
  /** Worst status across all checks. */
  overallStatus: CheckStatus;
  /** True when project init/config checks were intentionally skipped. */
  projectChecksSkipped?: boolean;
}

export interface RunDoctorOptions {
  /** Project directory to run init / config checks against. */
  projectPath?: string;
  /** Skip project-init + config checks when no project context applies. */
  skipProjectChecks?: boolean;
  /** Auto-apply remediations for fixable gaps after running the checks. */
  fix?: boolean;
}

/** Per-gap remediation outcome. */
export interface RemediationStep {
  readonly check: string;
  readonly action: 'ran-init' | 'ran-llm-apply' | 'ran-install-models' | 'skipped' | 'failed';
  readonly detail: string;
}

export interface DoctorResultWithFix extends DoctorResult {
  /** Set only when `runDoctor({fix: true})`. */
  readonly remediations?: ReadonlyArray<RemediationStep>;
  /** Post-fix DoctorResult when a fix pass re-ran the checks. */
  readonly afterFix?: DoctorResult;
}

export function worstStatus(checks: readonly CheckResult[]): CheckStatus {
  if (checks.some((c) => c.status === 'fail')) return 'fail';
  if (checks.some((c) => c.status === 'warn')) return 'warn';
  return 'ok';
}
