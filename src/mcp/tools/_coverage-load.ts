/**
 * @internal — load-action handler for the consolidated
 * `cartograph_coverage({mode: 'load'})` family. Lives in its own file
 * (prefixed `_` to discourage external import) to keep the family
 * dispatcher small. Logic preserved verbatim from the prior
 * `coverage-load.ts` so eval baseline is unchanged.
 */

import * as path from 'node:path';
import { errMsg } from '../../errors.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

export async function handleCoverageLoad(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const reportPath = args['reportPath'];
  if (typeof reportPath !== 'string' || !reportPath) {
    return err(
      "cartograph_coverage mode='load': `reportPath` must be a non-empty string. " +
        'Pass an absolute or project-relative path to an lcov.info or cobertura.xml file ' +
        '(e.g. `coverage/lcov.info`).',
    );
  }
  const source = (args['source'] as string | undefined) ?? 'lcov';
  const clearSource = args['clear'] === true;
  // Resolve project-relative paths against the project root rather
  // than process.cwd(). The MCP server's cwd often differs from the
  // project root (it's the host shell's cwd at startup), so a relative
  // `coverage/lcov.info` would otherwise ENOENT even when the file is
  // exactly where the agent expects.
  const resolvedPath = path.isAbsolute(reportPath) ? reportPath : path.resolve(cg.projectRoot, reportPath);
  try {
    const result = await cg.ingestCoverage(resolvedPath, { source, clearSource });
    const lines: string[] = [
      `## Loaded coverage report (${source})`,
      `- Files matched: ${result.filesMatched}`,
      `- Files unmatched: ${result.filesUnmatched}`,
      `- Symbols with coverage: ${result.symbolsUpdated}`,
      `- Symbols skipped (no overlap): ${result.symbolsEmpty}`,
      `- Duration: ${(result.durationMs / 1000).toFixed(1)}s`,
    ];
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`Coverage ingestion failed: ${errMsg(error_)}`);
  }
}
