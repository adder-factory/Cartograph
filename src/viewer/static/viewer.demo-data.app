/* ───────────────────────────────────────────────────────
   Data — hand-built to match the screenshots, but wired
   so the trace replay actually reflects the call sequence.
   ─────────────────────────────────────────────────────── */

// Register fCoSE on the global cytoscape so the layout name resolves.
// Both UMD globals are checked because the bundle name has shifted
// across versions of the extension.
if (globalThis.cytoscape !== undefined && typeof cytoscape.use === 'function') {
  const ext = globalThis.cytoscapeFcose || globalThis['cytoscape-fcose'];
  if (ext) try { cytoscape.use(ext); } catch (err) { console.debug('cytoscape extension already registered', err); }
}

const KIND = { fn: 'function', method: 'method', class: 'class' };

const NODES = [
  // Center / focus
  { id: 'extractFromSource', label: 'extractFromSource', kind: KIND.fn, file: 'src/extraction/tree-sitter.ts',
    line: 2336, health: 'healthy', centrality: 0.0048, coverage: 0.85,
    callers: [
      'indexAll', 'indexFiles', 'extractWorker', 'updateFile', 'indexFromSource',
      { id: 'reindexChanged',   label: 'reindexChanged',   file: 'src/sync/index.ts',                line: 188 },
      { id: 'incrementalIndex', label: 'incrementalIndex', file: 'src/sync/incremental.ts',          line: 41  },
      { id: 'rebuildIndex',     label: 'rebuildIndex',     file: '__tests__/extraction.test.ts',     line: 142 },
    ],
    callees: [
      'parseSource', 'walkTree', 'computeMetrics', 'analyseAnalysableNodes',
      { id: 'collectImports',  label: 'collectImports',  file: 'src/extraction/imports.ts',  line: 22 },
      { id: 'collectExports',  label: 'collectExports',  file: 'src/extraction/exports.ts',  line: 31 },
      { id: 'normalisePaths',  label: 'normalisePaths',  file: 'src/utils/paths.ts',         line: 12 },
      { id: 'findReferences',  label: 'findReferences',  file: 'src/resolution/index.ts',    line: 64 },
    ],
    metrics: { loc: 25, cyc: 4, nest: 2, first: '8mo ago', last: '2d ago', commits: 12 } },

  // Callers ring (some warning / error to show health colors)
  { id: 'indexAll',           label: 'indexAll',           kind: KIND.method, file: 'src/extraction/index.ts',  line: 43,  health: 'warning',  centrality: 0.0091, coverage: 0.62 },
  { id: 'indexFiles',         label: 'indexFiles',         kind: KIND.method, file: 'src/extraction/index.ts',  line: 288, health: 'healthy',  centrality: 0.0061, coverage: 0.71 },
  { id: 'extractWorker',      label: 'extractWorker',      kind: KIND.fn,     file: 'src/extraction/worker.ts', line: 71,  health: 'healthy',  centrality: 0.0034, coverage: 0.78 },
  { id: 'updateFile',         label: 'updateFile',         kind: KIND.method, file: 'src/sync/index.ts',        line: 115, health: 'healthy',  centrality: 0.0029, coverage: 0.81 },
  { id: 'indexFromSource',    label: 'indexFromSource',    kind: KIND.fn,     file: '__tests__/extraction.test.ts', line: 42, health: 'healthy', centrality: 0.0008, coverage: 1 },
  { id: 'getImpactRadius',    label: 'getImpactRadius',    kind: KIND.method, file: 'src/graph/traversal.ts',   line: 88,  health: 'warning',  centrality: 0.0072, coverage: 0.55 },
  { id: 'findRelevantContext',label: 'findRelevantContext',kind: KIND.method, file: 'src/context/index.ts',     line: 124, health: 'warning',  centrality: 0.0064, coverage: 0.49 },
  { id: 'handleSource',       label: 'handleSource',       kind: KIND.fn,     file: 'src/mcp/tools.ts',         line: 401, health: 'error',    centrality: 0.0052, coverage: 0.31 },
  { id: 'ingestCoverage',     label: 'ingestCoverage',     kind: KIND.fn,     file: 'src/coverage/index.ts',    line: 67,  health: 'healthy',  centrality: 0.0021, coverage: 0.84 },

  // Classes (around the periphery)
  { id: 'Cartograph',          label: 'Cartograph',          kind: KIND.class,  file: 'src/index.ts',             line: 41,  health: 'warning',  centrality: 0.0192, coverage: 0.66 },
  { id: 'QueryBuilder',       label: 'QueryBuilder',       kind: KIND.class,  file: 'src/db/queries.ts',        line: 28,  health: 'warning',  centrality: 0.0156, coverage: 0.74 },
  { id: 'GraphTraverser',     label: 'GraphTraverser',     kind: KIND.class,  file: 'src/graph/traversal.ts',   line: 14,  health: 'healthy',  centrality: 0.0089, coverage: 0.81 },
  { id: 'ContextBuilder',     label: 'ContextBuilder',     kind: KIND.class,  file: 'src/context/index.ts',     line: 22,  health: 'healthy',  centrality: 0.0078, coverage: 0.69 },

  // Callees that show in trace (impact subgraph)
  { id: 'parseSource',        label: 'parseSource',        kind: KIND.fn,     file: 'src/extraction/parser.ts', line: 14,  health: 'healthy',  centrality: 0.004, coverage: 0.92 },
  { id: 'walkTree',           label: 'walkTree',           kind: KIND.fn,     file: 'src/extraction/walker.ts', line: 31,  health: 'warning',  centrality: 0.0023, coverage: 0.61 },
  { id: 'computeMetrics',     label: 'computeMetrics',     kind: KIND.fn,     file: 'src/biomarkers/engine.ts', line: 86,  health: 'healthy',  centrality: 0.0017, coverage: 0.88 },
  { id: 'analyseAnalysableNodes', label: 'analyseAnalysableNodes', kind: KIND.fn, file: 'src/biomarkers/index.ts', line: 381, health: 'warning', centrality: 0.0019, coverage: 0.71 },
];

const EDGES = [
  // calls into extractFromSource
  ['indexAll', 'extractFromSource', 'calls'],
  ['indexFiles', 'extractFromSource', 'calls'],
  ['extractWorker', 'extractFromSource', 'calls'],
  ['updateFile', 'extractFromSource', 'calls'],
  ['indexFromSource', 'extractFromSource', 'calls'],
  ['handleSource', 'extractFromSource', 'calls'],
  ['ingestCoverage', 'extractFromSource', 'references'],
  ['getImpactRadius', 'extractFromSource', 'references'],
  ['findRelevantContext', 'extractFromSource', 'references'],

  // extractFromSource calls out
  ['extractFromSource', 'parseSource', 'calls'],
  ['extractFromSource', 'walkTree', 'calls'],
  ['extractFromSource', 'computeMetrics', 'calls'],
  ['extractFromSource', 'analyseAnalysableNodes', 'calls'],

  // class containment
  ['Cartograph', 'indexAll', 'contains'],
  ['Cartograph', 'indexFiles', 'contains'],
  ['QueryBuilder', 'updateFile', 'references'],
  ['GraphTraverser', 'getImpactRadius', 'contains'],
  ['ContextBuilder', 'findRelevantContext', 'contains'],

  // misc cross-links to fluff out the graph
  ['Cartograph', 'QueryBuilder', 'instantiates'],
  ['Cartograph', 'GraphTraverser', 'instantiates'],
  ['Cartograph', 'ContextBuilder', 'instantiates'],
  ['indexFiles', 'extractWorker', 'calls'],
  ['walkTree', 'parseSource', 'calls'],
  ['analyseAnalysableNodes', 'computeMetrics', 'calls'],
];

/* Trace = the agent's discovery sequence on extractFromSource.
   Each step has a "focus" (the node the call illuminates) and an
   optional "subgraph" — the set of nodes the call's *result*
   reveals (callers list, impact radius, etc.). Replay mode
   restricts the visible graph to the union of the focus + subgraph
   so the user sees what each tool call "saw". */
const TRACE = [
  { delta: '+0ms',   step: 1, tool: 'cartograph_status',    args: '{}',
    result: '153 files', focus: null, subgraph: null },
  { delta: '+12ms',  step: 2, tool: 'cartograph_search',    args: 'query: "extractFromSource", kind: "function"',
    result: '1 result', focus: 'extractFromSource', subgraph: ['extractFromSource'] },
  { delta: '+30ms',  step: 3, tool: 'cartograph_node',      args: 'symbol: "extractFromSource", includeCode: true',
    result: '1 node + code', focus: 'extractFromSource', subgraph: ['extractFromSource'] },
  { delta: '+45ms',  step: 4, tool: 'cartograph_callers',   args: 'symbol: "extractFromSource"',
    result: '5 callers', focus: 'extractFromSource',
    subgraph: ['extractFromSource', 'indexAll', 'indexFiles', 'extractWorker', 'updateFile', 'indexFromSource'] },
  { delta: '+51ms',  step: 5, tool: 'cartograph_callees',   args: 'symbol: "extractFromSource"',
    result: '8 callees', focus: 'extractFromSource',
    subgraph: ['extractFromSource', 'parseSource', 'walkTree', 'computeMetrics', 'analyseAnalysableNodes'] },
  { delta: '+71ms',  step: 6, tool: 'cartograph_impact',    args: 'symbol: "extractFromSource", depth: 3',
    result: '68 symbols', focus: 'extractFromSource',
    subgraph: ['extractFromSource', 'parseSource', 'walkTree', 'computeMetrics', 'analyseAnalysableNodes',
               'indexAll', 'indexFiles', 'extractWorker', 'updateFile', 'Cartograph', 'QueryBuilder', 'getImpactRadius',
               'GraphTraverser', 'findRelevantContext', 'ContextBuilder', 'handleSource', 'ingestCoverage', 'indexFromSource'] },
  { delta: '+118ms', step: 7, tool: 'cartograph_biomarkers',args: 'mode: "symbol", symbol: "extractFromSource"',
    result: '0 findings', focus: 'extractFromSource', subgraph: ['extractFromSource'] },
  { delta: '+126ms', step: 8, tool: 'cartograph_coverage',  args: 'mode: "symbol", symbol: "extractFromSource"',
    result: '85% covered', focus: 'extractFromSource', subgraph: ['extractFromSource'] },
];
