import { z } from 'zod';
import { lowTokensField, projectPathField } from './_common-fields.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import {
  collectDependencyCoverage,
  DEFAULT_DEPENDENCY_COVERAGE_LIMIT,
  MAX_DEPENDENCY_COVERAGE_LIMIT,
  renderDependencyCoverage,
} from '../../features/dependency-coverage/index.js';

const dependencyCoverageSchema = z.object({
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_DEPENDENCY_COVERAGE_LIMIT)
    .default(DEFAULT_DEPENDENCY_COVERAGE_LIMIT)
    .describe(`Max language/kind rows to return, in [1, ${MAX_DEPENDENCY_COVERAGE_LIMIT}].`),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type DependencyCoverageArgs = z.infer<typeof dependencyCoverageSchema>;

function handleDependencyCoverage(ctx: ToolCtx, args: DependencyCoverageArgs): ToolOutcome {
  const cg = ctx.getCartograph(args.projectPath);
  const report = collectDependencyCoverage(cg.queries, args.limit);
  return ok(renderToolResponse({ body: renderDependencyCoverage(report, args.lowTokens === true) }));
}

export const DEPENDENCY_COVERAGE_TOOL = defineTool({
  name: 'cartograph_dependency_coverage',
  description:
    'Project-wide dependency resolution coverage — resolved edges and unresolved refs by language/kind, cross-file edges, confidence buckets, and unresolved chained-call candidates.',
  schema: dependencyCoverageSchema,
  handle: handleDependencyCoverage,
});
