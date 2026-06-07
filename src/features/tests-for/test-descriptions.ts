import * as fs from 'node:fs';
import * as path from 'node:path';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getEnclosingTestName } from '../../db/queries-test-names.js';
import { detectLanguage } from '../../extraction/grammars.js';
import type Cartograph from '../../index.js';
import { identifierBoundaryRegex, isTestPath, stripCommentsForRegex } from '../../utils.js';
import { callSiteLinesFromEdge } from '../graph/callers/index.js';
import type { TestRow } from './render.js';

/** Node kinds whose names can plausibly identify a test function/method. */
const TEST_SYMBOL_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

function looksLikeTestName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('test') ||
    lower.startsWith('it_') ||
    lower === 'it' ||
    lower.startsWith('describe') ||
    lower.endsWith('test') ||
    lower.endsWith('_test') ||
    lower.endsWith('spec')
  );
}

/** Pull test-shaped symbols out of a file via its indexed nodes. */
export function buildTestRow(cg: Cartograph, filePath: string, hops: number): TestRow {
  const symbols: string[] = [];
  for (const n of cg.queries.getNodesByFile(filePath)) {
    if (!TEST_SYMBOL_KINDS.has(n.kind)) continue;
    if (looksLikeTestName(n.name)) symbols.push(n.name);
  }
  const testDescriptions = fetchTestDescriptionsForFile(cg, filePath);
  return { filePath, testSymbols: symbols, testDescriptions, hops };
}

/** Pull mined `it/test/describe(...)` descriptions for a file from the `test_names` table. */
export function fetchTestDescriptionsForFile(
  cg: Cartograph,
  filePath: string,
): Array<{ line: number; description: string }> {
  try {
    const rows = cg.db
      .getDb()
      .prepare('SELECT line, description FROM test_names WHERE file_path = ? ORDER BY line LIMIT 50')
      .all(filePath) as Array<{ line: number; description: string }>;
    return rows;
  } catch {
    // Table may not exist on older indexes; symbol/test rows still render.
    return [];
  }
}

function scanSymbolTestDescriptions(cg: Cartograph, filePath: string, symbolName: string): Map<number, string> {
  const found = new Map<number, string>();
  if (!/^[A-Za-z_$][\w$]*$/.test(symbolName)) return found;
  const projectRoot = cg.projectRoot;
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  let src: string;
  try {
    src = fs.readFileSync(absPath, 'utf8');
  } catch {
    return found;
  }

  const stripped = stripCommentsForRegex(src, detectLanguage(filePath));
  const identRe = identifierBoundaryRegex(symbolName);
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!identRe.test(lines[i]!)) continue;
    const test = getEnclosingTestName(cg.queries, { filePath, line: i + 1 });
    if (!test) continue;
    found.set(test.line, test.description);
  }
  return found;
}

export function collectSymbolTestDescriptions(
  cg: Cartograph,
  symbolNodeId: string,
  symbolName: string,
): Map<string, Array<{ line: number; description: string }>> {
  const perFile = new Map<string, Map<number, string>>();
  for (const edge of getIncomingEdges(cg.queries, symbolNodeId, ['calls', 'references'])) {
    const source = cg.queries.getNodeById(edge.source);
    if (!source?.filePath || !isTestPath(source.filePath)) continue;
    let descs = perFile.get(source.filePath);
    if (!descs) {
      descs = new Map();
      perFile.set(source.filePath, descs);
    }
    for (const line of callSiteLinesFromEdge(edge)) {
      const test = getEnclosingTestName(cg.queries, { filePath: source.filePath, line });
      if (!test) continue;
      descs.set(test.line, test.description);
    }
  }

  for (const [filePath, descs] of perFile) {
    for (const [line, description] of scanSymbolTestDescriptions(cg, filePath, symbolName)) {
      descs.set(line, description);
    }
  }

  const out = new Map<string, Array<{ line: number; description: string }>>();
  for (const [file, descs] of perFile) {
    out.set(
      file,
      [...descs.entries()].map(([line, description]) => ({ line, description })).sort((a, b) => a.line - b.line),
    );
  }
  return out;
}

export function scopeRowsToSymbol(
  rows: readonly TestRow[],
  scoped: Map<string, Array<{ line: number; description: string }>>,
): TestRow[] {
  return rows.map((r) => ({ ...r, testDescriptions: scoped.get(r.filePath) ?? [] }));
}
