import { describe, expect, it } from 'vitest';
import {
  formatMcpLoadBudgetCheckReport,
  formatMcpLoadBudgetReport,
  getMcpLoadBudgetViolations,
  MCP_LOAD_BUDGET_LIMITS,
  measureMcpLoadBudget,
} from '../src/mcp/load-budget.js';
import { SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('MCP load-budget measurement', () => {
  it('reports startup payload size and top schema contributors', () => {
    const report = measureMcpLoadBudget(null, { topContributors: 5 });
    const tools = new ToolHandler(null).getTools();
    const toolsListChars = JSON.stringify({ tools }).length;
    const initializeChars = JSON.stringify({ instructions: SERVER_INSTRUCTIONS }).length;

    expect(report.toolCount).toBe(tools.length);
    expect(report.profile).toBe('core');
    expect(report.toolsList.chars).toBe(toolsListChars);
    expect(report.initialize.chars).toBe(initializeChars);
    expect(report.combinedStartup.chars).toBe(toolsListChars + initializeChars);
    expect(report.topSchemaContributors).toHaveLength(5);
    expect(report.topSchemaContributors[0]!.chars).toBeGreaterThanOrEqual(report.topSchemaContributors[1]!.chars);
    expect(report.limits).toBe(MCP_LOAD_BUDGET_LIMITS);

    const text = formatMcpLoadBudgetReport(report);
    expect(text).toContain('MCP Load Budget');
    expect(text).toContain('combined startup load');
    expect(text).toContain('Top schema contributors');
  });

  it('measures narrowed advertised surfaces', () => {
    const full = measureMcpLoadBudget(null, { handlerOptions: { profile: 'full' } });
    const narrowed = measureMcpLoadBudget(null, {
      handlerOptions: {
        profile: 'review',
        disableWriteTools: true,
        disabledTools: new Set(['cartograph_ask']),
      },
      topContributors: 0,
    });

    expect(narrowed.profile).toBe('review');
    expect(narrowed.writeTools).toBe(false);
    expect(narrowed.disabledTools).toEqual(['cartograph_ask']);
    expect(narrowed.toolCount).toBeLessThan(full.toolCount);
    expect(narrowed.toolsList.chars).toBeLessThan(full.toolsList.chars);
    expect(narrowed.topSchemaContributors).toEqual([]);
  });

  it('formats pass/fail reports for CI budget checks', () => {
    const report = measureMcpLoadBudget();
    expect(getMcpLoadBudgetViolations(report)).toEqual([]);
    expect(formatMcpLoadBudgetCheckReport(report)).toContain('Budget check: PASS');

    const failing = {
      ...report,
      limits: {
        ...report.limits,
        combinedChars: report.combinedStartup.chars - 1,
      },
    };
    const violations = getMcpLoadBudgetViolations(failing);
    expect(violations).toEqual([
      {
        label: 'combined startup chars',
        actual: report.combinedStartup.chars,
        limit: report.combinedStartup.chars - 1,
      },
    ]);
    expect(formatMcpLoadBudgetCheckReport(failing)).toContain('Budget check: FAIL');
  });
});
