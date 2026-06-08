/**
 * Compatibility exports for result-spec tests and older source imports.
 *
 * The standalone `cartograph_module` MCP tool was retired on 2026-06-08.
 * Directory/module summaries now live under
 * `cartograph_files({format: 'module', dirPath})`, and the reusable logic
 * belongs to the module feature runtime below.
 */
export { buildModuleReportSpec, buildModuleSummariesSpec } from '../../features/module/runtime.js';
