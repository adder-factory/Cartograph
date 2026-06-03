import { formatMcpLoadBudgetReport, measureMcpLoadBudget } from '../src/mcp/load-budget.js';

const report = measureMcpLoadBudget();
process.stdout.write(formatMcpLoadBudgetReport(report));
