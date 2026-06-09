import type { DependencyCoverageReport, DependencyCoverageRow } from './runtime.js';

function pct(value: number | null): string {
  return value === null ? '-' : `${(value * 100).toFixed(1)}%`;
}

function rowLabel(row: DependencyCoverageRow): string {
  return `${row.language}/${row.edgeKind}`;
}

export function renderDependencyCoverage(report: DependencyCoverageReport, lowTokens = false): string {
  if (lowTokens) return renderCompact(report);
  const lines = [
    '## Dependency Coverage',
    '',
    `- **resolved edges:** ${report.totals.resolved}`,
    `- **unresolved refs:** ${report.totals.unresolved}`,
    `- **cross-file edges:** ${report.totals.crossFile}`,
    '',
    '| Language / Kind | Resolved | Unresolved | Resolved % | Cross-file | Confidence |',
    '| --- | ---: | ---: | ---: | ---: | --- |',
  ];
  for (const row of report.rows) {
    lines.push(
      `| ${rowLabel(row)} | ${row.resolved} | ${row.unresolved} | ${pct(row.resolvedPct)} | ${row.crossFile} | ` +
        `E:${row.extracted} I:${row.inferred} A:${row.ambiguous} |`,
    );
  }
  appendNameSection(lines, 'Top unresolved names', report.unresolvedNames);
  appendNameSection(lines, 'Unresolved chained-call candidates', report.chainCandidates);
  return lines.join('\n');
}

function renderCompact(report: DependencyCoverageReport): string {
  const lines = [
    `coverage resolved=${report.totals.resolved} unresolved=${report.totals.unresolved} crossFile=${report.totals.crossFile}`,
  ];
  for (const row of report.rows) {
    lines.push(
      `${row.language}|${row.edgeKind}|resolved=${row.resolved}|unresolved=${row.unresolved}|pct=${pct(row.resolvedPct)}|cross=${row.crossFile}|E=${row.extracted}|I=${row.inferred}|A=${row.ambiguous}`,
    );
  }
  for (const row of report.chainCandidates.slice(0, 5)) {
    lines.push(`chain? ${row.language}|${row.edgeKind}|${row.count}|${row.name}`);
  }
  return lines.join('\n');
}

function appendNameSection(
  lines: string[],
  title: string,
  rows: ReadonlyArray<{ name: string; language: string; edgeKind: string; count: number }>,
): void {
  lines.push('', `### ${title}`, '');
  if (rows.length === 0) {
    lines.push('_None._');
    return;
  }
  for (const row of rows) {
    lines.push(`- \`${row.name}\` — ${row.language}/${row.edgeKind} x${row.count}`);
  }
}
