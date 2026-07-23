import type { ToolResult } from '../tool-types.js';
import { buildTrustReport, type TrustCheck } from '../../features/trust/index.js';
import { isFixturePath, textResult, truncateOutput } from './shared.js';
import type { ToolCtx } from './types.js';

export async function handleTrustReview(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const deep = args['deep'] === true;
  const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined;
  const report = await buildTrustReport(cg, {
    deep,
    isFixturePath,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
  const lines = [
    `# Trust self-check — ${report.overall.toUpperCase()}`,
    '',
    deep
      ? 'Deep mode executed live LLM requests and a semantic self-retrieval probe when prerequisites were available.'
      : 'Shallow mode checks local state and configuration only. Use `deep: true` to execute live LLM requests and a semantic usefulness probe.',
    '`blocked` means refresh first; `warn` means results are usable with the stated caveats.',
    '',
    ...report.checks.map(formatCheck),
  ];
  return textResult(truncateOutput(lines.join('\n')));
}

function formatCheck(check: TrustCheck): string {
  const icon = trustCheckIcon(check);
  return `- **${icon} ${check.label}:** ${check.detail} Action: ${check.action}`;
}

function trustCheckIcon(check: TrustCheck): string {
  if (check.state === 'ok') return 'OK';
  if (check.state === 'warn') return 'WARN';
  return 'BLOCKED';
}
