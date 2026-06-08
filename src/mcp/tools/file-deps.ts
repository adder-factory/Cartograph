import { z } from 'zod';
import { getAllFilesWithSymbolCount } from '../../db/queries-files.js';
import {
  FILE_DEPS_DIRECTIONS,
  MAX_FILE_DEPS_LIMIT,
  collectFileDeps,
  renderFileDeps,
} from '../../features/file-deps/index.js';
import { resolveIndexedFilePath } from '../../features/shared/indexed-file-path.js';
import { lowTokensField, projectPathField } from './_common-fields.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';

const fileDepsSchema = z.object({
  file: z.string().min(1).describe('Project-relative indexed file path, or an absolute path inside the project.'),
  direction: z
    .enum(FILE_DEPS_DIRECTIONS)
    .optional()
    .describe("Which side to show: 'dependencies', 'dependents', or 'both' (default)."),
  symbols: z.boolean().optional().describe('Include a short defines section. Defaults to true; pass false to omit.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_DEPS_LIMIT)
    .optional()
    .describe(`Maximum paths per section, in [1, ${MAX_FILE_DEPS_LIMIT}]. Defaults to 100, or 30 with lowTokens.`),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type FileDepsArgs = z.infer<typeof fileDepsSchema>;

function empty(message: string) {
  return ok(renderToolResponse({ body: '', empty: { message } }));
}

async function handleFileDeps(ctx: ToolCtx, args: FileDepsArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const indexedFiles = getAllFilesWithSymbolCount(cg.queries);
  const resolved = resolveIndexedFilePath({ file: args.file, projectRoot: cg.projectRoot, indexedFiles });
  if (!resolved.ok) return empty(resolved.message);
  const result = collectFileDeps({
    filePath: resolved.filePath,
    dependencies: cg.internals.graphManager.getFileDependencies(resolved.filePath),
    dependents: cg.internals.graphManager.getFileDependents(resolved.filePath),
    nodes: cg.queries.getNodesByFile(resolved.filePath),
    direction: args.direction,
    symbols: args.symbols,
    limit: args.limit,
    lowTokens: args.lowTokens === true,
  });
  return ok(
    renderToolResponse({
      body: renderFileDeps({ result, note: resolved.note, lowTokens: args.lowTokens === true }),
    }),
  );
}

export const FILE_DEPS_TOOL = defineTool({
  name: 'cartograph_file_deps',
  description:
    'Show one indexed file’s local file dependencies and reverse dependents without reading source. Use when you need file-level blast radius or import structure.',
  schema: fileDepsSchema,
  handle: handleFileDeps,
});
