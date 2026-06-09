import type { DetectionResult, Location } from '../../installer/targets/types.js';

export interface HostDiagnosticTarget {
  id: string;
  displayName: string;
  location: Location;
  installed: boolean;
  alreadyConfigured: boolean;
  configPath?: string | undefined;
}

export interface HostDiagnosticsReport {
  profile: string;
  writeToolsEnabled: boolean;
  lowTokensDefault: boolean;
  allRegisteredToolsAdvertised: boolean;
  advertisedTools: string[];
  sessionToolAvailable: boolean;
  sourceHeavyGuidanceVisible: boolean;
  targets: HostDiagnosticTarget[];
  notes: string[];
}

export interface BuildHostDiagnosticsArgs {
  profile: string;
  writeToolsEnabled: boolean;
  lowTokensDefault: boolean;
  allRegisteredToolsAdvertised?: boolean | undefined;
  advertisedTools: string[];
  targets: HostDiagnosticTarget[];
}

export function toHostDiagnosticTarget(input: {
  id: string;
  displayName: string;
  location: Location;
  detection: DetectionResult;
}): HostDiagnosticTarget {
  return {
    id: input.id,
    displayName: input.displayName,
    location: input.location,
    installed: input.detection.installed,
    alreadyConfigured: input.detection.alreadyConfigured,
    configPath: input.detection.configPath,
  };
}

export function buildHostDiagnostics(args: BuildHostDiagnosticsArgs): HostDiagnosticsReport {
  const advertised = [...args.advertisedTools].sort((a, b) => a.localeCompare(b));
  const sessionToolAvailable = advertised.includes('cartograph_session');
  const sourceHeavyGuidanceVisible =
    advertised.includes('cartograph_context') && advertised.includes('cartograph_explore');
  const notes: string[] = [];
  if (!sessionToolAvailable) {
    notes.push('Session analytics are not advertised in this MCP profile; use `--profile core` or `--profile full`.');
  }
  if (!sourceHeavyGuidanceVisible) {
    notes.push('Context/explore guidance is not fully visible in this profile.');
  }
  if (args.targets.length === 0) {
    notes.push('Install-target detection was skipped.');
  } else if (!args.targets.some((target) => target.alreadyConfigured)) {
    notes.push('No inspected host config currently reports Cartograph as already configured.');
  }
  notes.push(
    'Sub-agent tool visibility is host-specific; this report can verify config/profile signals, not remote model behavior.',
  );

  return {
    profile: args.profile,
    writeToolsEnabled: args.writeToolsEnabled,
    lowTokensDefault: args.lowTokensDefault,
    allRegisteredToolsAdvertised: args.allRegisteredToolsAdvertised === true,
    advertisedTools: advertised,
    sessionToolAvailable,
    sourceHeavyGuidanceVisible,
    targets: args.targets,
    notes,
  };
}

export function renderHostDiagnostics(report: HostDiagnosticsReport): string {
  return renderMarkdownHostDiagnostics(report);
}

export function renderHostDiagnosticsCompact(report: HostDiagnosticsReport): string {
  const configured = report.targets
    .filter((target) => target.alreadyConfigured)
    .map((target) => `${target.id}:${target.location}`);
  return [
    `host profile=${report.profile} writeTools=${onOff(report.writeToolsEnabled)} lowTokens=${onOff(report.lowTokensDefault)} tools=${compactToolCountLabel(report)}`,
    `session=${yesNo(report.sessionToolAvailable)} sourceHeavyGuidance=${yesNo(report.sourceHeavyGuidanceVisible)}`,
    `configured=${configured.length > 0 ? configured.join(',') : 'none'}`,
    ...report.notes.map((note) => `note ${note}`),
  ].join('\n');
}

function renderMarkdownHostDiagnostics(report: HostDiagnosticsReport): string {
  const lines = [
    '## Host Diagnostics',
    '',
    `- **profile:** \`${report.profile}\``,
    `- **write tools:** ${enabledDisabled(report.writeToolsEnabled)}`,
    `- **lowTokens default:** ${enabledDisabled(report.lowTokensDefault)}`,
    `- **advertised tools:** ${markdownToolCountLabel(report)}`,
    `- **session analytics visible:** ${yesNo(report.sessionToolAvailable)}`,
    `- **source-heavy guidance visible:** ${yesNo(report.sourceHeavyGuidanceVisible)}`,
    '',
    '### Install Targets',
    '',
  ];
  return [
    ...lines,
    ...renderInstallTargetLines(report.targets),
    '',
    '### Notes',
    '',
    ...report.notes.map((note) => `- ${note}`),
  ].join('\n');
}

function renderInstallTargetLines(targets: readonly HostDiagnosticTarget[]): string[] {
  if (targets.length === 0) return ['_Skipped._'];
  return [
    '| Target | Location | Installed | Configured | Config Path |',
    '| --- | --- | ---: | ---: | --- |',
    ...targets.map(renderInstallTargetRow),
  ];
}

function renderInstallTargetRow(target: HostDiagnosticTarget): string {
  return `| ${target.displayName} (\`${target.id}\`) | ${target.location} | ${yesNo(target.installed)} | ${yesNo(target.alreadyConfigured)} | ${target.configPath ?? '-'} |`;
}

function compactToolCountLabel(report: HostDiagnosticsReport): string | number {
  return report.allRegisteredToolsAdvertised ? 'all' : report.advertisedTools.length;
}

function markdownToolCountLabel(report: HostDiagnosticsReport): string | number {
  return report.allRegisteredToolsAdvertised ? 'all registered tools' : report.advertisedTools.length;
}

function onOff(value: boolean): 'on' | 'off' {
  return value ? 'on' : 'off';
}

function enabledDisabled(value: boolean): 'enabled' | 'disabled' {
  return value ? 'enabled' : 'disabled';
}

function yesNo(value: boolean): 'yes' | 'no' {
  return value ? 'yes' : 'no';
}
