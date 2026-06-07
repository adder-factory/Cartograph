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
  warn: '_Doctor found non-blocking gaps. The checks above suggest next steps._',
  fail: '_Doctor found blocking gaps. Fix the `✗` items above before using LLM-backed features._',
};

function overallStatusBlurb(result: DoctorResult): string {
  if (result.overallStatus === 'ok' && result.projectChecksSkipped) {
    return '_Checks completed. Project init/config checks were skipped._';
  }
  return OVERALL_STATUS_BLURB[result.overallStatus];
}

export function formatDoctorReport(result: DoctorResultWithFix): string {
  const lines: string[] = ['## cartograph doctor', ''];
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
