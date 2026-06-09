import type { CheckStatus, DoctorResult, DoctorResultWithFix, RemediationStep } from './contract.js';

const CHECK_STATUS_ICON: Record<CheckStatus, string> = { ok: '✓', warn: '⚠', fail: '✗' };
const REMEDIATION_ACTION_ICON: Record<RemediationStep['action'], string> = {
  'ran-init': '✓',
  'ran-llm-apply': '✓',
  'ran-install-models': '✓',
  skipped: '⏭',
  failed: '✗',
};
const OVERALL_STATUS_BLURB: Record<DoctorResult['overallStatus'], string> = {
  ok: '_All checks passed. cartograph is ready to use._',
  warn: '_Doctor found non-blocking gaps. The checks below suggest next steps._',
  fail: '_Doctor found blocking gaps. Fix the `✗` items below before using Cartograph._',
};

function overallStatusBlurb(result: DoctorResult): string {
  if (result.overallStatus === 'ok' && result.projectChecksSkipped) {
    return '_Checks completed. Project init/config checks were skipped._';
  }
  return OVERALL_STATUS_BLURB[result.overallStatus];
}

export function formatDoctorReport(result: DoctorResultWithFix): string {
  const lines: string[] = ['## cartograph doctor', ''];
  const summaryResult = result.afterFix ?? result;
  appendStatusSummary(lines, summaryResult);
  appendNextSteps(lines, summaryResult);
  lines.push('', result.afterFix ? '## Initial checks' : '## Checks', '');
  appendCheckLines(lines, result.checks);
  lines.push('', overallStatusBlurb(result));
  if (result.remediations !== undefined) appendFixOutcome(lines, result);
  return lines.join('\n');
}

export function formatDoctorJson(result: DoctorResultWithFix): string {
  return JSON.stringify(result, null, 2);
}

function appendCheckLines(lines: string[], checks: ReadonlyArray<DoctorResult['checks'][number]>): void {
  for (const c of checks) {
    lines.push(`${CHECK_STATUS_ICON[c.status]} **${c.name}** — ${c.detail}`);
    if (c.remediation) lines.push(`  → ${c.remediation}`);
  }
}

function appendStatusSummary(lines: string[], result: DoctorResult): void {
  const counts = countChecks(result.checks);
  lines.push(
    `**Status:** ${statusLabel(result.overallStatus)}`,
    `**Checks:** ${counts.ok} ok · ${counts.warn} warn · ${counts.fail} fail`,
  );
}

function appendNextSteps(lines: string[], result: DoctorResult): void {
  lines.push('', '## Next steps', '');
  const steps = uniqueRemediations(result.checks);
  if (steps.length === 0) {
    if (result.overallStatus === 'ok' && result.projectChecksSkipped) {
      lines.push(
        '- Project checks were skipped. Run `cartograph doctor <project>` without `--no-project-checks` when you want repository-specific verification.',
      );
      return;
    }
    lines.push('- No action needed.');
    return;
  }
  for (const step of steps) {
    lines.push(`- ${step.replaceAll('\n', '\n  ')}`);
  }
}

function countChecks(checks: ReadonlyArray<DoctorResult['checks'][number]>): Record<CheckStatus, number> {
  const counts: Record<CheckStatus, number> = { ok: 0, warn: 0, fail: 0 };
  for (const check of checks) counts[check.status]++;
  return counts;
}

function statusLabel(status: DoctorResult['overallStatus']): string {
  if (status === 'ok') return 'Ready';
  if (status === 'warn') return 'Ready with follow-up';
  return 'Blocked';
}

function uniqueRemediations(checks: ReadonlyArray<DoctorResult['checks'][number]>): string[] {
  const seen = new Set<string>();
  const steps: string[] = [];
  for (const check of checks) {
    if (check.status === 'ok' || !check.remediation) continue;
    const step = check.remediation.trim();
    if (!step || seen.has(step)) continue;
    seen.add(step);
    steps.push(step);
  }
  return steps;
}

function appendFixOutcome(lines: string[], result: DoctorResultWithFix): void {
  lines.push('', '## Auto-fix outcome', '');
  const remediations = result.remediations ?? [];
  if (remediations.length === 0) {
    lines.push('_No fixable gaps. Run without `--fix` to see the diagnostic report only._');
  } else {
    for (const r of remediations) {
      lines.push(`${REMEDIATION_ACTION_ICON[r.action]} **${r.check}** (${r.action}) — ${r.detail}`);
    }
  }
  if (result.afterFix) {
    lines.push('', '## Re-check after fix', '');
    for (const c of result.afterFix.checks) {
      lines.push(`${CHECK_STATUS_ICON[c.status]} **${c.name}** — ${c.detail}`);
    }
  }
}
