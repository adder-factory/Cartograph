import * as fs from 'node:fs';
import * as path from 'node:path';
import { errMsg } from '../../errors.js';
import type { CliOptionCommand } from '../shared/cli-command.js';
import {
  DEFAULT_GRAPH_EXPORT_LIMIT,
  GRAPH_EXPORT_FORMATS,
  MAX_GRAPH_EXPORT_LIMIT,
  type GraphExportRawOptions,
} from './contract.js';
import { runGraphExport, type GraphExportRuntimeDeps, type GraphExportRunResult } from './runtime.js';

type CommandLike = CliOptionCommand;

interface GraphExportCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface GraphExportCommandDeps extends Omit<GraphExportRuntimeDeps, 'openCartograph'> {
  program: CommandLike;
  error: (message: string) => void;
  info: (message: string) => void;
  resolveProjectPath: (pathArg?: string) => string;
  loadCartograph: () => Promise<GraphExportCartographModule>;
  writeLine?: (message?: string) => void;
}

interface GraphExportCliOptions {
  projectPath?: string;
  format?: string;
  out?: string;
  limit?: string;
  kind?: string;
  edgeKind?: string;
  language?: string;
  file?: string;
}

export function registerGraphExportCommand(deps: GraphExportCommandDeps): void {
  deps.program
    .command('export [path]')
    .description('Export a capped graph snapshot as JSON, DOT, Mermaid, or Cytoscape JSON')
    .option('-p, --project-path <path>', 'Project path')
    .option('-f, --format <format>', `Output format (${GRAPH_EXPORT_FORMATS.join(', ')}; default: json)`)
    .option('-o, --out <file>', 'Write output to a file instead of stdout')
    .option(
      '--limit <number>',
      `Maximum nodes to export before truncation (default: ${DEFAULT_GRAPH_EXPORT_LIMIT}, max: ${MAX_GRAPH_EXPORT_LIMIT})`,
    )
    .option('--kind <kinds>', 'Comma-separated node kinds to include')
    .option('--edge-kind <kinds>', 'Comma-separated edge kinds to include')
    .option('--language <languages>', 'Comma-separated languages to include')
    .option('--file <prefix>', 'Only include nodes whose file path starts with this prefix')
    .action(async (pathArg: string | undefined, options: GraphExportCliOptions) => {
      await runGraphExportCommand(deps, pathArg, options);
    });
}

export async function runGraphExportCommand(
  deps: GraphExportCommandDeps,
  pathArg: string | undefined,
  options: GraphExportCliOptions,
): Promise<void> {
  const projectPath = deps.resolveProjectPath(options.projectPath ?? pathArg);
  const rawOptions: GraphExportRawOptions = {
    projectPath,
    ...(options.format ? { format: options.format } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
    ...(options.kind ? { kind: options.kind } : {}),
    ...(options.edgeKind ? { edgeKind: options.edgeKind } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.file ? { file: options.file } : {}),
  };

  try {
    const result = await runGraphExport(rawOptions, {
      ...deps,
      openCartograph: async (resolvedProjectPath) => {
        const { default: Cartograph } = await deps.loadCartograph();
        return Cartograph.open(resolvedProjectPath);
      },
    });
    renderGraphExportResult(result, deps, options.out);
  } catch (err) {
    deps.error(`Graph export failed: ${errMsg(err)}`);
    process.exitCode = 1;
  }
}

function renderGraphExportResult(
  result: GraphExportRunResult,
  deps: Pick<GraphExportCommandDeps, 'error' | 'info' | 'writeLine'>,
  outPath: string | undefined,
): void {
  if (!result.ok) {
    deps.error(result.error);
    process.exitCode = 1;
    return;
  }

  if (!outPath) {
    writeLine(deps, result.artifact.trimEnd());
    return;
  }

  const resolved = path.resolve(outPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, result.artifact);
  deps.info(
    `Exported graph snapshot -> ${resolved} (${result.snapshot.stats.exportedNodes} nodes, ${result.snapshot.stats.exportedEdges} edges)`,
  );
  if (result.snapshot.stats.truncatedNodes > 0) {
    deps.info(
      `Truncated ${result.snapshot.stats.truncatedNodes} node(s); increase --limit up to ${MAX_GRAPH_EXPORT_LIMIT} for a larger artifact.`,
    );
  }
}

function writeLine(deps: Pick<GraphExportCommandDeps, 'writeLine'>, message = ''): void {
  if (deps.writeLine) {
    deps.writeLine(message);
    return;
  }
  process.stdout.write(`${message}\n`);
}
