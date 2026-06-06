import * as path from 'node:path';
import type { QueryBuilder } from '../../db/queries.js';
import { errMsg } from '../../errors.js';

export interface ScipGraph {
  queries: QueryBuilder;
  projectRoot: string;
  close: () => void;
}

export interface ScipExportStats {
  documents: number;
  symbols: number;
  occurrences: number;
  bytes: number;
  disambiguated: number;
}

export interface ScipImportStats {
  documents: number;
  files: number;
  nodes: number;
  edges: number;
  skippedDocuments: number;
  unresolvedEdges: number;
}

export interface ScipAdminRuntimeDeps {
  isInitialized: (projectPath: string) => boolean;
  openCartograph: (projectPath: string) => Promise<ScipGraph>;
  writeScipExport: (
    queries: QueryBuilder,
    projectRoot: string,
    outPath: string,
  ) => { outPath: string; stats: ScipExportStats };
  writeScipImport: (queries: QueryBuilder, projectRoot: string, scipBytes: Uint8Array) => { stats: ScipImportStats };
  readFile: (filePath: string) => Uint8Array | Promise<Uint8Array>;
}

export interface RunScipExportOptions {
  projectPath: string;
  outPath?: string;
}

export interface RunScipImportOptions {
  projectPath: string;
  inPath?: string;
}

export type ScipAdminRunResult = { ok: true; messages: string[] } | { ok: false; error: string };

export async function runScipExport(
  options: RunScipExportOptions,
  deps: ScipAdminRuntimeDeps,
): Promise<ScipAdminRunResult> {
  if (!deps.isInitialized(options.projectPath)) {
    return { ok: false, error: `Cartograph not initialized in ${options.projectPath}` };
  }

  let graph: ScipGraph | null = null;
  try {
    graph = await deps.openCartograph(options.projectPath);
    const outPath = options.outPath ?? path.join(options.projectPath, 'index.scip');
    const result = deps.writeScipExport(graph.queries, graph.projectRoot, outPath);
    return { ok: true, messages: exportMessages(result) };
  } catch (err) {
    return { ok: false, error: `SCIP export failed: ${errMsg(err)}` };
  } finally {
    graph?.close();
  }
}

export async function runScipImport(
  options: RunScipImportOptions,
  deps: ScipAdminRuntimeDeps,
): Promise<ScipAdminRunResult> {
  if (!deps.isInitialized(options.projectPath)) {
    return { ok: false, error: `Cartograph not initialized in ${options.projectPath}` };
  }

  const inPath = options.inPath ?? path.join(options.projectPath, 'index.scip');
  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(inPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { ok: false, error: `SCIP file not found: ${inPath}` };
    return { ok: false, error: `SCIP import failed: ${errMsg(err)}` };
  }

  let graph: ScipGraph | null = null;
  try {
    graph = await deps.openCartograph(options.projectPath);
    const result = deps.writeScipImport(graph.queries, graph.projectRoot, bytes);
    return { ok: true, messages: importMessages(inPath, result) };
  } catch (err) {
    return { ok: false, error: `SCIP import failed: ${errMsg(err)}` };
  } finally {
    graph?.close();
  }
}

function exportMessages(result: { outPath: string; stats: ScipExportStats }): string[] {
  const messages = [
    `Exported SCIP index → ${result.outPath}`,
    `${result.stats.documents} documents, ${result.stats.symbols} symbols, ${result.stats.occurrences} occurrences (${result.stats.bytes} bytes)`,
  ];
  if (result.stats.disambiguated > 0) {
    messages.push(`${result.stats.disambiguated} symbol(s) disambiguated (name collision)`);
  }
  return messages;
}

function importMessages(inPath: string, result: { stats: ScipImportStats }): string[] {
  const messages = [
    `Imported SCIP index ← ${inPath}`,
    `${result.stats.documents} documents, ${result.stats.files} files, ${result.stats.nodes} nodes, ${result.stats.edges} edges`,
  ];
  if (result.stats.skippedDocuments > 0) {
    messages.push(`${result.stats.skippedDocuments} document(s) skipped (unsafe path)`);
  }
  if (result.stats.unresolvedEdges > 0) {
    messages.push(`${result.stats.unresolvedEdges} edge(s) dropped (target symbol had no definition)`);
  }
  return messages;
}
