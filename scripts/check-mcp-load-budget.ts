import {
  formatMcpLoadBudgetCheckReport,
  getMcpLoadBudgetViolations,
  measureMcpLoadBudget,
} from '../src/mcp/load-budget.js';

const report = measureMcpLoadBudget();
process.stdout.write(formatMcpLoadBudgetCheckReport(report));
if (getMcpLoadBudgetViolations(report).length > 0) process.exitCode = 1;
