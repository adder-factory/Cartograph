/**
 * SCIP interop — cartograph ⇄ Sourcegraph Code Intelligence Protocol.
 *
 * Export: cartograph's knowledge graph → a `.scip` protobuf index
 * consumable by Sourcegraph and other SCIP tooling. Import: a `.scip`
 * (cartograph's own or a foreign indexer's) → cartograph nodes+edges,
 * replacing native extraction per file the index covers.
 *
 * The module entry points are {@link writeScipExport} and
 * {@link writeScipImport} (the CLI and MCP surfaces call them). The
 * lower-level pieces — `exportScipIndex`, `buildGraphFromScip`,
 * `ProtoWriter`, the symbol-string helpers — are imported directly
 * from their sub-modules by tests.
 */

export { writeScipExport, type WriteScipResult } from './export.js';
export { writeScipImport, type WriteScipImportResult, type ScipImportStats } from './import.js';
