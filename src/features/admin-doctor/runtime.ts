export interface AdminDoctorResult {
  overallStatus: string;
  afterFix?: { overallStatus: string };
}

export interface AdminDoctorOptions {
  projectChecks?: boolean;
  skipProjectChecks?: boolean;
}

export function resolveSkipProjectChecks(options: AdminDoctorOptions): boolean {
  return options.projectChecks === false || options.skipProjectChecks === true;
}

export function finalDoctorStatus(result: AdminDoctorResult): string {
  return result.afterFix?.overallStatus ?? result.overallStatus;
}
