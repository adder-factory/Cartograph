export interface DoctorOptions {
  projectChecks?: boolean;
  skipProjectChecks?: boolean;
  fix?: boolean;
  json?: boolean;
}

export interface DoctorResult {
  overallStatus: string;
  afterFix?: { overallStatus: string };
}

export interface DoctorRunOptions {
  projectPath?: string;
  skipProjectChecks: boolean;
  fix: boolean;
}

export function resolveSkipProjectChecks(options: DoctorOptions): boolean {
  return options.projectChecks === false || options.skipProjectChecks === true;
}

export function finalDoctorStatus(result: DoctorResult): string {
  return result.afterFix?.overallStatus ?? result.overallStatus;
}

export function doctorRunOptions(pathArg: string | undefined, options: DoctorOptions): DoctorRunOptions {
  return {
    ...(pathArg ? { projectPath: pathArg } : {}),
    skipProjectChecks: resolveSkipProjectChecks(options),
    fix: options.fix === true,
  };
}
