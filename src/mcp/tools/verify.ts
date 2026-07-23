import { z } from 'zod';
import { nonEmptyString, projectPathField } from './_common-fields.js';
import { buildVerificationPlan, type VerificationPlan } from '../../features/verification/index.js';
import { renderToolResponse } from './_response.js';
import { defineTool } from './_define-tool.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, err, ok } from './_outcome.js';
import { errMsg } from '../../errors.js';

const verifySchema = z.object({
  files: z
    .array(nonEmptyString)
    .min(1)
    .max(200)
    .optional()
    .describe('Changed project-relative files. Omit to derive the working-tree set from `git diff <ref>`. Max 200.'),
  ref: nonEmptyString.optional().describe('Git baseline for structural and working-tree comparison. Default `HEAD`.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(50)
    .default(5)
    .describe('Maximum dependency depth for affected-test selection. Default 5; range 1-50.'),
  format: z.enum(['markdown', 'json']).default('markdown').describe('Response format. Default `markdown`.'),
  projectPath: projectPathField,
});

type VerifyArgs = z.infer<typeof verifySchema>;

async function handleVerify(ctx: ToolCtx, args: VerifyArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  try {
    const plan = await buildVerificationPlan(cg, {
      ...(args.files === undefined ? {} : { files: args.files }),
      ...(args.ref === undefined ? {} : { ref: args.ref }),
      depth: args.depth,
    });
    if (args.format === 'json') return ok(renderToolResponse({ body: JSON.stringify(plan, null, 2) }));
    const rendered = renderVerificationPlan(plan);
    return plan.status === 'blocked' ? err(rendered) : ok(renderToolResponse({ body: rendered }));
  } catch (error) {
    return err(`verification planning failed: ${errMsg(error)}`);
  }
}

export function renderVerificationPlan(plan: VerificationPlan): string {
  const lines: string[] = ['## Verification plan', '', `**Status:** ${plan.status}`];
  if (plan.status === 'blocked') {
    lines.push('', '### Blocking errors', '', ...plan.errors.map((error) => `- ${error}`));
  }

  appendChangedFiles(lines, plan);
  appendTestCandidates(lines, plan);
  appendCommands(lines, plan);
  appendStructuralSummary(lines, plan);
  if (plan.warnings.length > 0) lines.push('', '### Warnings', '', ...plan.warnings.map((warning) => `- ${warning}`));
  return lines.join('\n');
}

function appendChangedFiles(lines: string[], plan: VerificationPlan): void {
  lines.push('', `### Changed files (${plan.changedFiles.length})`, '');
  if (plan.changedFiles.length === 0) {
    lines.push('_No files differ from the requested baseline._');
    return;
  }
  for (const file of plan.changedFiles) {
    const graphStatus = plan.indexedChangedFiles.includes(file) ? 'indexed' : 'not indexed';
    lines.push(`- \`${file}\` — ${graphStatus}`);
  }
}

function appendTestCandidates(lines: string[], plan: VerificationPlan): void {
  lines.push('', `### Graph-selected tests (${plan.testCandidates.length})`, '');
  if (plan.testCandidates.length === 0) {
    lines.push('_No affected test was selected._');
    return;
  }
  for (const tier of ['direct', 'likely', 'broad'] as const) {
    const candidates = plan.testCandidates.filter((candidate) => candidate.tier === tier);
    if (candidates.length === 0) continue;
    lines.push(`**${tier}:**`);
    for (const candidate of candidates) {
      lines.push(`- \`${candidate.path}\` — ${candidate.reason.replaceAll('-', ' ')}, ${candidate.distance} hop(s)`);
    }
  }
}

function appendCommands(lines: string[], plan: VerificationPlan): void {
  lines.push(
    '',
    `### Commands to run (${plan.commands.length})`,
    '',
    '_Commands were planned only; Cartograph did not execute them._',
  );
  if (plan.commands.length === 0) return;
  lines.push('', '```sh', ...plan.commands.map((command) => command.command), '```', '');
  for (const command of plan.commands) lines.push(`- **${command.kind}:** ${command.reason}`);
}

function appendStructuralSummary(lines: string[], plan: VerificationPlan): void {
  if (plan.structural === null) return;
  const structural = plan.structural;
  lines.push(
    '',
    `### Structural self-check vs \`${structural.ref}\``,
    '',
    `- Files: ${structural.filesChanged} changed / ${structural.filesScanned} scanned; ${structural.filesSkipped} skipped`,
    `- Symbols: +${structural.symbolsAdded} / -${structural.symbolsRemoved} / ~${structural.symbolsModified}`,
    `- Per-file findings: +${structural.findingsIntroduced} introduced / -${structural.findingsCleared} cleared`,
  );
  if (structural.findingDiagnostics.length > 0) {
    lines.push(`- Finding diagnostics: ${structural.findingDiagnostics.join('; ')}`);
  }
}

export const VERIFY_TOOL = defineTool({
  name: 'cartograph_verify',
  description:
    'One-call post-edit verification planner for coding agents. Derives changed files, selects direct/likely/broad tests, emits bounded package commands, and computes structural plus per-file biomarker deltas. Commands are never executed.',
  schema: verifySchema,
  handle: handleVerify,
  requiresFreshIndex: true,
});
