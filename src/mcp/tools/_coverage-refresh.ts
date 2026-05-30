/**
 * @internal — handler for `cartograph_coverage({mode: 'refresh'})`.
 * Walks a small set of conventional coverage-report paths under the
 * project root and ingests the freshest one. Removes the "guess the
 * absolute path" friction the agent hit before.
 *
 * Discovery is intentionally narrow (no recursive scan): each entry
 * is a path that maps cleanly to a popular test runner's default
 * output. Add new entries when a runner becomes worth supporting.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { errMsg } from '../../errors.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import type Cartograph from '../../index.js';
import { detectTestRunner, testCoverageHint } from './_coverage-tips.js';

/** Conventional locations checked, in declaration order. The chosen
 *  report is the one with the newest mtime; declaration order is only
 *  used to render the "considered" list deterministically. */
const CONVENTIONAL_PATHS: readonly string[] = [
  'coverage/lcov.info',
  'coverage/lcov-report/lcov.info',
  'lcov.info',
  'coverage.lcov',
];

interface Candidate {
  /** Path relative to projectRoot, for display. */
  relPath: string;
  absPath: string;
  mtimeMs: number;
}

function discoverCandidates(projectRoot: string): Candidate[] {
  const found: Candidate[] = [];
  for (const rel of CONVENTIONAL_PATHS) {
    const abs = path.resolve(projectRoot, rel);
    try {
      const st = fs.statSync(abs);
      if (st.isFile() && st.size > 0) {
        found.push({ relPath: rel, absPath: abs, mtimeMs: st.mtimeMs });
      }
    } catch {
      // not present — fine, just skip
    }
  }
  return found;
}

/** Render the "Considered" footer from the same `discoverCandidates`
 *  snapshot used to choose the winner. We re-stat NOTHING here — if
 *  the snapshot says a path was present, we render ☑️ even if it has
 *  since been deleted, so the footer always agrees with the
 *  ingestion result above it. */
function renderConsidered(candidates: readonly Candidate[], picked: Candidate | null): string {
  const presentByPath = new Map(candidates.map((c) => [c.relPath, c]));
  const lines: string[] = ['', '_Considered:_'];
  for (const rel of CONVENTIONAL_PATHS) {
    const present = presentByPath.get(rel);
    let mark = '  - ❌';
    let suffix = '';
    if (present) {
      const isPicked = picked?.absPath === present.absPath;
      mark = isPicked ? '  - ✅' : '  - ☑️';
      suffix = isPicked ? ' (chosen — freshest)' : '';
    }
    lines.push(`${mark} \`${rel}\`${suffix}`);
  }
  return lines.join('\n');
}

function noCandidatesMessage(cg: Cartograph): string {
  const runner = detectTestRunner(cg.projectRoot);
  const runnerLine = runner
    ? `Detected **${runner.name}**. To generate one:\n\n${testCoverageHint(runner)}`
    : 'Run your test suite with a coverage reporter that emits lcov, then call this tool again.';
  const considered = renderConsidered([], null);
  return [
    '## No coverage report found',
    '',
    'No lcov report exists at any of the conventional paths under the project root.',
    '',
    runnerLine,
    considered,
  ].join('\n');
}

export async function handleCoverageRefresh(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const candidates = discoverCandidates(cg.projectRoot);

  if (candidates.length === 0) {
    return ok(textResult(noCandidatesMessage(cg)));
  }

  // Freshest wins; tiebreak by declaration order (earlier entry wins).
  candidates.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
    return CONVENTIONAL_PATHS.indexOf(a.relPath) - CONVENTIONAL_PATHS.indexOf(b.relPath);
  });
  const picked = candidates[0]!;

  const source = (args['source'] as string | undefined) ?? 'lcov';
  const clearSource = args['clear'] === true;

  try {
    const result = await cg.ingestCoverage(picked.absPath, { source, clearSource });
    const lines: string[] = [
      `## Refreshed coverage from \`${picked.relPath}\``,
      '',
      `- Source label: \`${source}\``,
      `- Files matched: ${result.filesMatched}`,
      `- Files unmatched: ${result.filesUnmatched}`,
      `- Symbols with coverage: ${result.symbolsUpdated}`,
      `- Symbols skipped (no overlap): ${result.symbolsEmpty}`,
      `- Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
      renderConsidered(candidates, picked),
    ];
    return ok(textResult(lines.join('\n')));
  } catch (caught) {
    return err(`Coverage refresh failed loading \`${picked.relPath}\`: ${errMsg(caught)}`);
  }
}
