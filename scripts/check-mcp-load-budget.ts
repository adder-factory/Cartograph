import {
  formatMcpLoadBudgetCheckReport,
  getMcpLoadBudgetViolations,
  getMcpLoadBudgetWarnings,
  measureMcpLoadBudget,
} from '../src/mcp/load-budget.js';

const report = measureMcpLoadBudget();
process.stdout.write(formatMcpLoadBudgetCheckReport(report));
if (getMcpLoadBudgetViolations(report).length > 0 || getMcpLoadBudgetWarnings(report).length > 0) {
  process.exitCode = 1;
}
