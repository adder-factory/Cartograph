/**
 * Test-names index hook — mines literal description strings from
 * `it/test/describe/context/fit/fdescribe/xit/xtest/xdescribe(...)`
 * calls in `is_test=1` files and persists to `test_names`. Feeds the
 * third FTS5 source (alongside summaries and docstrings) for
 * `mode=intent` search: lets the agent locate subject code by the
 * behavioral assertion ("rejects expired tokens") even when the
 * function name itself is opaque.
 *
 * TS/JS focus today (Mocha/Jest/Vitest/Cypress patterns share the
 * same call shape). Python pytest and Go test names are encoded in
 * the function name itself and are already searchable via `nodes_fts`.
 *
 * Mining is deliberately regex-based rather than tree-sitter — the
 * patterns are simple enough that the ~5% missed cases (multi-line
 * template literals with interpolation, deeply-aliased imports of
 * `it`) aren't worth a 3× LOC tree-sitter pipeline.
 *
 * Idempotent: full rescan on indexAll, per-file rescan on sync.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { IndexHook, IndexHookContext } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import { logDebug, errMsg } from '../errors.js';
import { getAllFiles } from '../db/queries-files.js';
import {
  clearAllTestNames,
  deleteTestNamesForPaths,
  insertTestNames,
  type TestNameRow,
} from '../db/queries-test-names.js';

const TS_JS_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

// Captures: group 1 = quote char (' / " / `), group 2 = description.
// The middle non-capture handles common chained forms (`it.skip`,
// `test.each`, etc.). Description body allows escaped chars; bails on
// the matching quote so each call extracts one description per match.
const TEST_CALL_RE =
  /(?:^|[^\w$.])(?:it|test|describe|context|fit|fdescribe|fcontext|xit|xtest|xdescribe)(?:\.(?:skip|only|each|todo|concurrent|sequential|failing))?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g;

function lineOf(text: string, offset: number): number {
  let line = 1;
  let codeUnitPos = 0;
  for (const char of text) {
    if (codeUnitPos >= offset) break;
    if (char === '\n') line++;
    codeUnitPos += char.length; // UTF-16 code units per char
  }
  return line;
}

function mineFile(rootDir: string, relPath: string): TestNameRow[] {
  let text: string;
  try {
    text = fs.readFileSync(path.join(rootDir, relPath), 'utf-8');
  } catch {
    return [];
  }
  const out: TestNameRow[] = [];
  TEST_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TEST_CALL_RE.exec(text)) !== null) {
    const description = m[2];
    if (!description || description.length === 0) continue;
    if (description.length > 500) continue;
    const decoded = description.replaceAll(/\\(['"`\\])/g, '$1');
    out.push({ filePath: relPath, line: lineOf(text, m.index), description: decoded });
  }
  return out;
}

function refresh(ctx: IndexHookContext, options: { scope: 'all' } | { scope: 'files'; files: string[] }): void {
  try {
    const allFiles = getAllFiles(ctx.queries);
    const isTestPath = new Set(allFiles.filter((f) => f.isTest && TS_JS_LANGS.has(f.language)).map((f) => f.path));
    if (isTestPath.size === 0) return;

    let targets: string[];
    if (options.scope === 'all') {
      targets = [...isTestPath];
      clearAllTestNames(ctx.queries);
    } else {
      targets = options.files.filter((p) => isTestPath.has(p));
      if (targets.length === 0) return;
      deleteTestNamesForPaths(ctx.queries, targets);
    }

    const rows: TestNameRow[] = [];
    for (const t of targets) rows.push(...mineFile(ctx.projectRoot, t));
    if (rows.length > 0) insertTestNames(ctx.queries, rows);
  } catch (err) {
    logDebug(`test-names hook failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'test-names',
  afterIndexAll(ctx) {
    refresh(ctx, { scope: 'all' });
  },
  afterSync(ctx, result: SyncResult) {
    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
