import fs from 'node:fs';
import path from 'node:path';

export type ChainResolutionStatus = 'covered' | 'gap';

export interface ChainResolutionCase {
  language: string;
  pattern: string;
  status: ChainResolutionStatus;
  fixture: string;
  notes: string;
}

export const CHAIN_RESOLUTION_CASES: readonly ChainResolutionCase[] = [
  {
    language: 'typescript',
    pattern: 'field receiver: this.field.method()',
    status: 'covered',
    fixture: '__tests__/chained-receiver-resolution.test.ts',
    notes: 'Receiver field inference routes to the field type method.',
  },
  {
    language: 'typescript',
    pattern: 'returned receiver: obj.factory().method()',
    status: 'covered',
    fixture: '__tests__/resolution.test.ts',
    notes: 'One returned-receiver hop via method return type.',
  },
  {
    language: 'csharp',
    pattern: 'generic/nullable returned receiver',
    status: 'covered',
    fixture: '__tests__/resolution.test.ts',
    notes: 'Return type parsing handles common C# signature shapes.',
  },
  {
    language: 'cpp',
    pattern: 'static factory: Class::factory().method()',
    status: 'covered',
    fixture: '__tests__/cpp-returned-receiver.test.ts',
    notes: 'Out-of-class factory definitions resolve terminal method calls.',
  },
  {
    language: 'php',
    pattern: 'static factory: Class::for(...)->method()',
    status: 'covered',
    fixture: '__tests__/go-php-returned-receiver.test.ts',
    notes: 'PHP static factory returned receiver is fixture-backed.',
  },
  {
    language: 'ruby',
    pattern: 'constructor receiver: Class.new.method()',
    status: 'covered',
    fixture: '__tests__/ruby-receiver-resolution.test.ts',
    notes: 'Constructor receiver inference covers direct and local assignment forms.',
  },
  {
    language: 'java',
    pattern: 'field receiver: this.field.method()',
    status: 'covered',
    fixture: '__tests__/java-field-receiver-resolution.test.ts',
    notes: 'JVM field receiver inference covers imported field types.',
  },
  {
    language: 'multi',
    pattern: 'multi-hop builders: a().b().c()',
    status: 'gap',
    fixture: '',
    notes: 'Current returned-receiver resolver is intentionally one-hop.',
  },
  {
    language: 'multi',
    pattern: 'fluent return-this chains',
    status: 'gap',
    fixture: '',
    notes: 'No generic model for methods returning the receiver instance.',
  },
  {
    language: 'multi',
    pattern: 'singleton conventions: getInstance/shared/default',
    status: 'gap',
    fixture: '',
    notes: 'No convention-aware singleton resolver yet.',
  },
];

export function renderChainResolutionCoverage(cases: readonly ChainResolutionCase[] = CHAIN_RESOLUTION_CASES): string {
  const covered = cases.filter((c) => c.status === 'covered').length;
  const gaps = cases.filter((c) => c.status === 'gap').length;
  const lines = [
    '# Chain Resolution Coverage',
    '',
    `Covered patterns: ${covered}`,
    `Known gaps: ${gaps}`,
    '',
    '| Language | Pattern | Status | Fixture | Notes |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const row of cases) {
    lines.push(`| ${row.language} | ${row.pattern} | ${row.status} | ${row.fixture || '-'} | ${row.notes} |`);
  }
  return `${lines.join('\n')}\n`;
}

export function validateChainResolutionCoverage(projectRoot: string): string[] {
  const missing: string[] = [];
  for (const row of CHAIN_RESOLUTION_CASES) {
    if (row.status !== 'covered') continue;
    if (!row.fixture) {
      missing.push(`${row.language}/${row.pattern}: missing fixture path`);
      continue;
    }
    if (!fs.existsSync(path.join(projectRoot, row.fixture))) {
      missing.push(`${row.language}/${row.pattern}: fixture not found at ${row.fixture}`);
    }
  }
  return missing;
}

if (import.meta.main) {
  const projectRoot = process.cwd();
  const missing = validateChainResolutionCoverage(projectRoot);
  if (missing.length > 0) {
    for (const line of missing) console.error(line);
    process.exitCode = 1;
  }
  process.stdout.write(renderChainResolutionCoverage());
}
