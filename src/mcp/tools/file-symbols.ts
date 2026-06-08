import { z } from 'zod';
import { getAllFilesWithSymbolCount } from '../../db/queries-files.js';
import {
  MAX_FILE_SYMBOL_LIMIT,
  collectFileSymbols,
  parseFileSymbolKinds,
  renderFileSymbols,
  resolveIndexedFilePath,
} from '../../features/file-symbols/index.js';
import { lowTokensField, projectPathField } from './_common-fields.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, err, ok } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';

const fileSymbolsSchema = z.object({
  file: z.string().min(1).describe('Project-relative indexed file path, or an absolute path inside the project.'),
  kinds: z
    .string()
    .optional()
    .describe(
      'Comma-separated node kinds to include, e.g. class,function,method. Default hides file/import/export/parameter noise.',
    ),
  includeParameters: z.boolean().optional().describe('Include parameter nodes. Defaults to false.'),
  includeImports: z.boolean().optional().describe('Include import/export nodes. Defaults to false.'),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILE_SYMBOL_LIMIT)
    .optional()
    .describe(`Maximum symbols to return, in [1, ${MAX_FILE_SYMBOL_LIMIT}]. Defaults to 200, or 80 with lowTokens.`),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type FileSymbolsArgs = z.infer<typeof fileSymbolsSchema>;

function empty(message: string) {
  return ok(renderToolResponse({ body: '', empty: { message } }));
}

async function handleFileSymbols(ctx: ToolCtx, args: FileSymbolsArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  const indexedFiles = getAllFilesWithSymbolCount(cg.queries);
  const resolved = resolveIndexedFilePath({ file: args.file, projectRoot: cg.projectRoot, indexedFiles });
  if (!resolved.ok) return empty(resolved.message);
  const kinds = parseFileSymbolKinds(args.kinds);
  if (!kinds.ok) return err(kinds.message);
  const nodes = cg.queries.getNodesByFile(resolved.filePath);
  const result = collectFileSymbols({
    nodes,
    kinds: kinds.kinds,
    includeParameters: args.includeParameters === true,
    includeImports: args.includeImports === true,
    limit: args.limit,
    lowTokens: args.lowTokens === true,
  });
  return ok(
    renderToolResponse({
      body: renderFileSymbols({
        filePath: resolved.filePath,
        result,
        note: resolved.note,
        lowTokens: args.lowTokens === true,
      }),
    }),
  );
}

export const FILE_SYMBOLS_TOOL = defineTool({
  name: 'cartograph_file_symbols',
  description:
    'List indexed symbols in one file without reading source. Use after `cartograph_files` when you know the file path and need classes, functions, methods, routes, or other definitions by line.',
  schema: fileSymbolsSchema,
  handle: handleFileSymbols,
});
