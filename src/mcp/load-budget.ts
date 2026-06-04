import type Cartograph from '../index.js';
import { FULL_PLAYBOOK, SERVER_INSTRUCTIONS } from './server-instructions.js';
import { ToolHandler, type ToolHandlerOptions } from './tools.js';
import { resolveMcpServerProfile } from './profiles.js';

const TOKEN_CHAR_ESTIMATE = 4;
const PERCENT_SCALE = 100;
const DEFAULT_TOP_CONTRIBUTORS = 10;

export const MCP_LOAD_BUDGET_LIMITS = {
  toolCount: 45,
  toolsListChars: 65_000,
  combinedChars: 68_000,
} as const;

export const MCP_LOAD_BUDGET_TARGETS = {
  toolsListChars: 62_500,
  combinedChars: 65_500,
} as const;

export interface McpLoadMetric {
  chars: number;
  estimatedTokens: number;
}

export interface McpLoadContributor extends McpLoadMetric {
  name: string;
  shareOfToolsList: number;
}

export interface McpLoadBudgetReport {
  profile: string;
  writeTools: boolean;
  disabledTools: string[];
  toolCount: number;
  toolsList: McpLoadMetric;
  initialize: McpLoadMetric;
  combinedStartup: McpLoadMetric;
  fullPlaybook: McpLoadMetric;
  limits: typeof MCP_LOAD_BUDGET_LIMITS;
  targets: typeof MCP_LOAD_BUDGET_TARGETS;
  topSchemaContributors: McpLoadContributor[];
}

export interface McpLoadBudgetViolation {
  label: string;
  actual: number;
  limit: number;
}

export interface MeasureMcpLoadBudgetOptions {
  handlerOptions?: ToolHandlerOptions;
  topContributors?: number;
}

function estimateTokens(chars: number): number {
  return Math.ceil(chars / TOKEN_CHAR_ESTIMATE);
}

function metricFromChars(chars: number): McpLoadMetric {
  return { chars, estimatedTokens: estimateTokens(chars) };
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US');
}

function formatTokens(metric: McpLoadMetric): string {
  return `~${formatNumber(metric.estimatedTokens)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function sortedDisabledTools(disabledTools: ReadonlySet<string> | undefined): string[] {
  return [...(disabledTools ?? new Set<string>())].sort((a, b) => a.localeCompare(b));
}

function reportWriteToolsEnabled(options: ToolHandlerOptions | undefined): boolean {
  if (options?.disableWriteTools === true) return false;
  return resolveMcpServerProfile(options?.profile) !== 'read-only';
}

export function measureMcpLoadBudget(
  cg: Cartograph | null = null,
  options: MeasureMcpLoadBudgetOptions = {},
): McpLoadBudgetReport {
  const topContributors = Math.max(0, options.topContributors ?? DEFAULT_TOP_CONTRIBUTORS);
  const handler = new ToolHandler(cg, options.handlerOptions ?? {});
  try {
    const tools = handler.getTools();
    const toolsListChars = JSON.stringify({ tools }).length;
    const initializeChars = JSON.stringify({ instructions: SERVER_INSTRUCTIONS }).length;
    const fullPlaybookChars = JSON.stringify({ instructions: FULL_PLAYBOOK }).length;
    const contributors = tools
      .map((tool) => {
        const chars = JSON.stringify(tool).length;
        return {
          name: tool.name,
          chars,
          estimatedTokens: estimateTokens(chars),
          shareOfToolsList: toolsListChars === 0 ? 0 : (chars / toolsListChars) * PERCENT_SCALE,
        };
      })
      .sort((a, b) => b.chars - a.chars || a.name.localeCompare(b.name))
      .slice(0, topContributors);

    return {
      profile: options.handlerOptions?.profile ?? 'full',
      writeTools: reportWriteToolsEnabled(options.handlerOptions),
      disabledTools: sortedDisabledTools(options.handlerOptions?.disabledTools),
      toolCount: tools.length,
      toolsList: metricFromChars(toolsListChars),
      initialize: metricFromChars(initializeChars),
      combinedStartup: metricFromChars(toolsListChars + initializeChars),
      fullPlaybook: metricFromChars(fullPlaybookChars),
      limits: MCP_LOAD_BUDGET_LIMITS,
      targets: MCP_LOAD_BUDGET_TARGETS,
      topSchemaContributors: contributors,
    };
  } finally {
    handler.closeAll();
  }
}

export function formatMcpLoadBudgetReport(report: McpLoadBudgetReport): string {
  const disabledTools = report.disabledTools.length > 0 ? report.disabledTools.join(', ') : 'none';
  const lines = [
    'MCP Load Budget',
    '',
    `Profile: ${report.profile}`,
    `Write tools: ${report.writeTools ? 'enabled' : 'disabled'}`,
    `Disabled tools: ${disabledTools}`,
    'Token counts are estimated as characters / 4.',
    '',
    '| Payload | Chars | Est. tokens |',
    '|---|---:|---:|',
    `| tools/list (${report.toolCount} tools) | ${formatNumber(report.toolsList.chars)} | ${formatTokens(
      report.toolsList,
    )} |`,
    `| initialize instructions | ${formatNumber(report.initialize.chars)} | ${formatTokens(report.initialize)} |`,
    `| combined startup load | ${formatNumber(report.combinedStartup.chars)} | ${formatTokens(
      report.combinedStartup,
    )} |`,
    `| full playbook (on demand) | ${formatNumber(report.fullPlaybook.chars)} | ${formatTokens(report.fullPlaybook)} |`,
    '',
    `Hard guard: <= ${formatNumber(report.limits.toolCount)} tools, <= ${formatNumber(
      report.limits.toolsListChars,
    )} tools/list chars, <= ${formatNumber(report.limits.combinedChars)} combined startup chars.`,
    `Release target: <= ${formatNumber(report.targets.toolsListChars)} tools/list chars, <= ${formatNumber(
      report.targets.combinedChars,
    )} combined startup chars.`,
    '',
    `Top schema contributors (${report.topSchemaContributors.length}):`,
    '| Tool | Chars | Est. tokens | Share of tools/list |',
    '|---|---:|---:|---:|',
  ];

  for (const item of report.topSchemaContributors) {
    lines.push(
      `| ${item.name} | ${formatNumber(item.chars)} | ${formatTokens(item)} | ${formatPercent(
        item.shareOfToolsList,
      )} |`,
    );
  }

  lines.push('');
  return lines.join('\n');
}

export function getMcpLoadBudgetViolations(report: McpLoadBudgetReport): McpLoadBudgetViolation[] {
  const checks = [
    { label: 'tool count', actual: report.toolCount, limit: report.limits.toolCount },
    { label: 'tools/list chars', actual: report.toolsList.chars, limit: report.limits.toolsListChars },
    { label: 'combined startup chars', actual: report.combinedStartup.chars, limit: report.limits.combinedChars },
  ];
  return checks.filter((check) => check.actual > check.limit);
}

export function getMcpLoadBudgetWarnings(report: McpLoadBudgetReport): McpLoadBudgetViolation[] {
  const checks = [
    { label: 'tools/list chars release target', actual: report.toolsList.chars, limit: report.targets.toolsListChars },
    {
      label: 'combined startup chars release target',
      actual: report.combinedStartup.chars,
      limit: report.targets.combinedChars,
    },
  ];
  return checks.filter((check) => check.actual > check.limit);
}

export function formatMcpLoadBudgetCheckReport(report: McpLoadBudgetReport): string {
  const violations = getMcpLoadBudgetViolations(report);
  const warnings = getMcpLoadBudgetWarnings(report);
  const lines = [formatMcpLoadBudgetReport(report).trimEnd(), ''];

  if (violations.length === 0 && warnings.length === 0) {
    lines.push('Budget check: PASS', '');
    return lines.join('\n');
  }

  lines.push('Budget check: FAIL');
  for (const item of violations) {
    lines.push(`- ${item.label}: ${formatNumber(item.actual)} > ${formatNumber(item.limit)}`);
  }
  for (const item of warnings) {
    lines.push(`- ${item.label}: ${formatNumber(item.actual)} > ${formatNumber(item.limit)}`);
  }
  lines.push('');
  return lines.join('\n');
}
