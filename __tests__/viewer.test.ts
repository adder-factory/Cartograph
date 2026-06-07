/**
 * Viewer HTTP server tests
 *
 * Spins the server on a random port (port 0 → OS-picked) against a
 * temp project so we don't depend on a pre-built index.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { startViewerServer, type ViewerHandle } from '../src/features/viewer/server/index.js';

describe('viewer HTTP server', () => {
  let testDir: string;
  let cg: Cartograph;
  let handle: ViewerHandle;
  let gitCompareReady = false;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-test-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `
export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }
export function compute(x: number, y: number): number {
  // Body padded above ANALYSABLE_MIN_LOC so the biomarker pass
  // actually computes + persists metrics for this symbol.
  const a = add(x, y);
  const b = mul(a, 2);
  const c = add(b, x);
  const d = mul(c, y);
  return d;
}
export function gamma(v: number): number { return v + 1; }
export function beta(v: number): number { return gamma(v) * 2; }
export function alpha(v: number): number { return beta(v) + gamma(v); }
`,
    );
    cg = Cartograph.initSync(testDir, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.close();
    gitCompareReady = createGitCompareFixture(testDir);
    handle = await startViewerServer(testDir, { port: 0 });
  });

  afterAll(async () => {
    await handle.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('serves the static viewer HTML at /', async () => {
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const html = await res.text();
    expect(html).toContain('<link rel="stylesheet" href="viewer.css" />');
    expect(html).toContain('<script src="lucide.min.js"></script>');
    expect(html).not.toContain('unpkg.com/lucide');
    expect(html).toContain('<script src="viewer.demo-data.app"></script>');
    expect(html).toContain('<script src="viewer.app"></script>');
    expect(html).not.toContain('<style>');
    const scriptSrcs = Array.from(html.matchAll(/<script src="(viewer(?:[\w.-]+)?\.app)"><\/script>/g)).map(
      (m) => m[1],
    );
    expect(scriptSrcs).toEqual([
      'viewer.demo-data.app',
      'viewer.state.app',
      'viewer.graph-core.app',
      'viewer.mobile-panels.app',
      'viewer.graph-layout.app',
      'viewer.edge-inspection.app',
      'viewer.graph-diagnostics.app',
      'viewer.live.app',
      'viewer.health.app',
      'viewer.source.app',
      'viewer.palette.app',
      'viewer.hash-editor.app',
      'viewer.graph-export.app',
      'viewer.ask.app',
      'viewer.selection-detail.app',
      'viewer.trace.app',
      'viewer.filters.app',
      'viewer.features.app',
      'viewer.ui.app',
      'viewer.tooltips.app',
      'viewer.app',
    ]);
    const [cssRes, lucideRes, ...scriptResponses] = await Promise.all([
      fetch(`${handle.url}viewer.css`),
      fetch(`${handle.url}lucide.min.js`),
      ...scriptSrcs.map((src) => fetch(`${handle.url}${src}`)),
    ]);
    const jsRes = scriptResponses[scriptSrcs.indexOf('viewer.app')];
    if (!jsRes) throw new Error('viewer.app script response was not fetched');
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get('content-type')).toMatch(/text\/css/);
    expect(cssRes.headers.get('cache-control')).toBe('no-cache');
    expect(cssRes.headers.get('etag')).toMatch(/^"sha256-[a-f0-9]+"$/);
    expect(lucideRes.status).toBe(200);
    expect(lucideRes.headers.get('content-type')).toMatch(/text\/javascript/);
    expect(lucideRes.headers.get('cache-control')).toBe('no-cache');
    expect(lucideRes.headers.get('etag')).toMatch(/^"sha256-[a-f0-9]+"$/);
    for (const scriptRes of scriptResponses) {
      expect(scriptRes.status).toBe(200);
      expect(scriptRes.headers.get('content-type')).toMatch(/text\/javascript/);
      expect(scriptRes.headers.get('cache-control')).toBe('no-cache');
      expect(scriptRes.headers.get('etag')).toMatch(/^"sha256-[a-f0-9]+"$/);
    }
    const jsEtag = jsRes.headers.get('etag');
    expect(jsEtag).toMatch(/^"sha256-[a-f0-9]+"$/);
    if (jsEtag === null) throw new Error('viewer.app response did not include an ETag');
    const jsNotModified = await fetch(`${handle.url}viewer.app`, { headers: { 'if-none-match': jsEtag } });
    expect(jsNotModified.status).toBe(304);
    expect(await jsNotModified.text()).toBe('');
    const jsWeakNotModified = await fetch(`${handle.url}viewer.app`, { headers: { 'if-none-match': `W/${jsEtag}` } });
    expect(jsWeakNotModified.status).toBe(304);
    expect(await jsWeakNotModified.text()).toBe('');
    const scriptBodies = await Promise.all(scriptResponses.map((scriptRes) => scriptRes.text()));
    const body = `${html}\n${await cssRes.text()}\n${await lucideRes.text()}\n${scriptBodies.join('\n')}`;
    expect(body).toContain('cartograph viewer');
    expect(body).toContain('<title>cartograph viewer</title>');
    expect(body).toContain('lucide v0.468.0');
    expect(body).toContain('viewer.state.app');
    expect(body).toContain('viewer.mobile-panels.app');
    expect(body).toContain('viewer.graph-layout.app');
    expect(body).toContain('viewer.edge-inspection.app');
    expect(body).toContain('viewer.graph-diagnostics.app');
    expect(body).toContain('viewer.ui.app');
    expect(body).toContain('function createViewerStateStore');
    expect(body).toContain('const viewerState');
    expect(body).toContain('function syncViewerSelectionState');
    expect(body).toContain('function registerViewerAction');
    expect(body).toContain("registerViewerAction('fitGraph'");
    expect(body).toContain("registerViewerAction('saveGraphSnapshot'");
    expect(body).toContain('state: () => viewerState.snapshot()');
    expect(body).not.toContain('cartograph viewer — mockup');
    expect(body).toContain('@media (max-width: 860px)');
    expect(body).toContain('class="mobile-graphbar"');
    expect(body).toContain('data-mobile-panel="detail"');
    expect(body).toContain('data-mobile-panel="source"');
    expect(body).toContain('id="btn-mobile-close"');
    expect(body).not.toContain('class="kbd-hint"');
    expect(body).not.toContain('drag to pin');
    expect(body).toContain('.stage.mobile-detail-open .detailpane');
    expect(body).toContain('position: fixed');
    expect(body).toContain('function isMobileViewport()');
    expect(body).toContain('id="density-control"');
    expect(body).toContain('id="layout-quality-control"');
    expect(body).toContain('data-layout-quality="spread"');
    expect(body).toContain('id="edge-lens-control"');
    expect(body).toContain('data-edge-lens="selected"');
    expect(body).toContain('id="graph-diagnostics"');
    expect(body).toContain('id="btn-graph-diagnostics"');
    expect(body).toContain('id="saved-view-status"');
    expect(body).toContain('id="btn-save-snapshot"');
    expect(body).toContain('id="btn-load-snapshot"');
    expect(body).toContain('id="btn-copy-bug-report"');
    expect(body).toContain('id="bug-report-status"');
    expect(body).toContain('id="btn-viewer-mode"');
    expect(body).toContain('id="btn-graph-tools"');
    expect(body).toContain('id="graph-tools-popover"');
    expect(body).toContain('id="graph-health-pill"');
    expect(body).toContain('function setViewerUiMode');
    expect(body).toContain("registerViewerAction('toggleGraphToolsPopover'");
    expect(body).toContain('id="edge-kind-filters"');
    expect(body).toContain('id="btn-edge-all"');
    expect(body).toContain('id="btn-edge-none"');
    expect(body).toContain('id="btn-reset-view"');
    expect(body).toContain('id="btn-reset-local-state"');
    expect(body).toContain('id="viewer-reset-status"');
    expect(body).toContain('id="btn-canvas-reset"');
    expect(body).toContain('class="history-nav"');
    expect(body).toContain('id="btn-nav-back"');
    expect(body).toContain('id="btn-nav-fwd"');
    expect(body).toContain('.graph-layout-controls {');
    expect(body).toContain('flex-direction: row');
    expect(body).toContain('viewer.tooltips.app');
    expect(body).toContain("className = 'ui-tooltip'");
    expect(body).toContain('function showTooltipNow');
    expect(body).toContain('data-tooltip="Save the current view"');
    expect(body).toContain('id="detail-control"');
    expect(body).toContain('data-detail-mode="grouped"');
    expect(body).toContain('data-health-count');
    expect(body).toContain('detail=');
    expect(body).toContain('data-filter-edge');
    expect(body).toContain('data-density-mode="core" data-active="1"');
    expect(body).toContain('const DENSITY_LIMITS');
    expect(body).toContain("params.set('mode', graphDensityMode)");
    expect(body).toContain('function layoutOptionsForGraph()');
    expect(body).toContain('function setGraphLayoutQuality');
    expect(body).toContain('function syncGraphDiagnosticsPanel');
    expect(body).toContain('function viewerBugReportPayload');
    expect(body).toContain('function copyGraphBugReport');
    expect(body).toContain('function resetViewerLocalState');
    expect(body).toContain("registerViewerAction('resetViewerLocalState'");
    expect(body).toContain('function seedForceLayoutPositions');
    expect(body).toContain('function relaxLayoutNodeCollisions');
    expect(body).toContain('function isDegenerateLinearLayout');
    expect(body).toContain('const PINNED_LAYOUT_VERSION = 2');
    expect(body).toContain('function refreshPinnedLayoutForCurrentState');
    expect(body).toContain('function graphLayoutDiagnostics');
    expect(body).toContain('nodeOverlapCount');
    expect(body).toContain('diagnostics: graphLayoutDiagnostics');
    expect(body).toContain('function applyHashStateControls');
    expect(body).toContain('hideKinds=');
    expect(body).toContain('edges=');
    expect(body).toContain('function selectedNeighborhoodIds()');
    expect(body).toContain('function updateSelectedNeighborhoodHighlight()');
    expect(body).toContain('function setGraphEdgeLensMode');
    expect(body).toContain('node.selected-neighbor');
    expect(body).toContain('edge.selected-edge');
    expect(body).toContain('node[detailBucket]');
    expect(body).toContain('function syncDetailBuckets');
    expect(body).toContain('function rebuildDetailBucketEdges');
    expect(body).toContain('function syncHealthFilterCounts');
    expect(body).toContain('function resetGraphView()');
    expect(body).toContain('id="editor-picker"');
    expect(body).toContain('id="btn-open-editor"');
    expect(body).toContain('function openSelectedInEditor');
    expect(body).toContain('id="btn-graph-png"');
    expect(body).toContain('id="btn-graph-svg"');
    expect(body).toContain('id="btn-graph-json"');
    expect(body).toContain('function graphJsonPayload');
    expect(body).toContain('function graphSvgText');
    expect(body).toContain('id="btn-layout-pin"');
    expect(body).toContain('id="btn-layout-unlock"');
    expect(body).toContain('id="btn-layout-reset"');
    expect(body).toContain('cartograph-viewer-pinned-layouts-v1');
    expect(body).toContain('function applyPinnedLayoutPositions');
    expect(body).toContain('id="saved-view-select"');
    expect(body).toContain('id="impact-control"');
    expect(body).toContain('id="btn-path-run"');
    expect(body).toContain('id="btn-compare-view"');
    expect(body).toContain('id="graph-minimap"');
    expect(body).toContain('cartograph-viewer-saved-views-v1');
    expect(body).toContain('function runPathFinder');
    expect(body).toContain('function runImpactMode');
    expect(body).toContain('function runCompareView');
    expect(body).toContain('function setSavedViewStatus');
    expect(body).toContain('function saveGraphSnapshot');
    expect(body).toContain('function replayGraphSnapshot');
    expect(body).toContain('cartograph-viewer-graph-snapshot-v1');
    expect(body).toContain('function sortSearchSuggestions');
    expect(body).toContain('function highlightSearchLabel');
    expect(body).toContain('function drawGraphMinimap');
    expect(body).toContain("cy.on('dragfree', 'node'");
    expect(body).toContain('id="edge-inspector"');
    expect(body).toContain('function renderActiveEdgeInspection');
    expect(body).toContain('function renderEdgeDetail');
    expect(body).toContain('function renderEdgeSubpanel');
    expect(body).toContain('function handleSubpanelAction');
    expect(body).toContain('.ref-row[data-symbol] .loc');
    expect(body).toContain('data-biomarker');
    expect(body).toContain('role="button" tabindex="0"');
    expect(body).toContain("cy.on('tap', 'edge'");
    expect(body).toContain('edge.edge-inspected');
    expect(body).toContain('edge-kind-swatch');
    expect(body).toContain('function edgeColorForKind');
    expect(body).toContain('function edgeRouteDistance');
    expect(body).toContain("'curve-style': 'unbundled-bezier'");
    expect(body).toContain("'control-point-distances': edgeRouteDistance");
    expect(body).toContain("'control-point-weights': edgeRouteWeight");
    expect(body).toContain('function svgEdgePath');
    expect(body).toContain("'line-style'");
    expect(body).toContain('id="group-collapse-hint"');
    expect(body).toContain('id="btn-collapse-groups"');
    expect(body).toContain('id="btn-expand-groups"');
    expect(body).toContain('function collapseVisibleGroups');
    expect(body).toContain('function expandAllGroups');
    expect(body).toContain('function toggleGroupCollapse');
    expect(body).toContain('function rebuildCollapsedBoundaryEdges');
    expect(body).toContain('collapsedGroups=');
    expect(body).toContain('edge[collapsedEdge]');
    expect(body).toContain('detailBucketEdge');
    expect(body).toContain('id="search-suggest"');
    expect(body).toContain('id="graph-state"');
    expect(body).toContain('id="graph-trail"');
    expect(body).toContain('class="health-view"');
    expect(body).toContain('id="hc-biomarkers"');
    expect(body).toContain('id="hc-hotspots-list"');
    expect(body).toContain('function renderHealthDashboard');
    expect(body).toContain('function graphElementsFromPayload');
    expect(body).toContain('function focusGraphOnSymbol');
    expect(body).toContain('function clearCurrentSelection');
    expect(body).toContain('selectionState()');
    expect(body).toContain('<!doctype html>');
  });

  it('returns project metadata at /api/status', async () => {
    const res = await fetch(`${handle.url}api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectRoot: string;
      files: number;
      nodes: number;
      edges: number;
      languages: string[];
    };
    expect(body.projectRoot).toBe(testDir);
    expect(body.files).toBeGreaterThan(0);
    expect(body.nodes).toBeGreaterThan(0);
    expect(body.languages).toContain('typescript');
  });

  it('returns a connected default graph when no focus is given', async () => {
    // The no-focus path now anchors on the highest-centrality node
    // and BFS-traverses outward, so every visible node is connected.
    // The response carries that anchor as `focus` (was null in the
    // earlier "top-N by centrality" implementation).
    const res = await fetch(`${handle.url}api/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      focus: string | null;
      nodes: Array<{ id: string }>;
      edges: Array<{ source: string; target: string }>;
    };
    expect(body.focus).not.toBeNull();
    expect(body.nodes.length).toBeGreaterThan(0);
    // Connected — at least one edge exists when the project has any.
    expect(body.edges.length).toBeGreaterThan(0);
    if (body.nodes.length > 1) {
      const degree = new Map(body.nodes.map((n) => [n.id, 0]));
      for (const edge of body.edges) {
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
      }
      expect([...degree.values()].every((d) => d > 0)).toBe(true);
    }
  });

  it('returns the focus subgraph when focus= is given', async () => {
    const res = await fetch(`${handle.url}api/graph?focus=compute&depth=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      focus: string | null;
      nodes: Array<{ label: string }>;
      edges: Array<{ source: string; target: string; kind: string }>;
    };
    expect(body.focus).not.toBeNull();
    const labels = body.nodes.map((n) => n.label);
    expect(labels).toContain('compute');
    expect(labels).toContain('add');
    expect(labels).toContain('mul');
    expect(body.edges.length).toBeGreaterThan(0);
  });

  it('returns all relationships among nodes included in a focus graph', async () => {
    const res = await fetch(`${handle.url}api/graph?focus=alpha&depth=2&limit=20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      nodes: Array<{ id: string; label: string }>;
      edges: Array<{ source: string; target: string; kind: string }>;
    };
    const idByLabel = new Map(body.nodes.map((node) => [node.label, node.id]));
    const alphaId = idByLabel.get('alpha');
    const betaId = idByLabel.get('beta');
    const gammaId = idByLabel.get('gamma');
    expect(alphaId).toBeTruthy();
    expect(betaId).toBeTruthy();
    expect(gammaId).toBeTruthy();
    const edgeKeys = new Set(body.edges.map((edge) => `${edge.source}->${edge.target}:${edge.kind}`));
    expect(edgeKeys).toContain(`${alphaId}->${betaId}:calls`);
    expect(edgeKeys).toContain(`${alphaId}->${gammaId}:calls`);
    expect(edgeKeys).toContain(`${betaId}->${gammaId}:calls`);
  });

  it('caps graph payloads with mode and limit while preserving focus', async () => {
    const res = await fetch(`${handle.url}api/graph?focus=compute&mode=focus&limit=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      mode: string;
      limit: number;
      focus: string | null;
      nodes: Array<{ id: string; label: string; health: string; findings: unknown[] }>;
      edges: Array<{ source: string; target: string; kind: string }>;
    };
    expect(body.mode).toBe('focus');
    expect(body.limit).toBe(2);
    expect(body.focus).not.toBeNull();
    expect(body.nodes.length).toBeLessThanOrEqual(2);
    expect(body.nodes.some((n) => n.id === body.focus && n.label === 'compute')).toBe(true);
    expect(body.nodes.every((n) => ['error', 'warning', 'info', 'healthy'].includes(n.health))).toBe(true);
    expect(body.nodes.every((n) => Array.isArray(n.findings))).toBe(true);
    for (const edge of body.edges) {
      const ids = new Set(body.nodes.map((n) => n.id));
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.target)).toBe(true);
    }
  });

  it('returns autocomplete search results at /api/search', async () => {
    const res = await fetch(`${handle.url}api/search?q=compute&limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      query: string;
      results: Array<{ id: string; label: string; file: string; kind: string; score: number }>;
    };
    expect(body.query).toBe('compute');
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.some((r) => r.label === 'compute' && r.file === 'src/lib.ts')).toBe(true);
    expect(typeof body.results[0]?.score).toBe('number');
  });

  it('returns the shortest path between two symbols at /api/path', async () => {
    const res = await fetch(`${handle.url}api/path?from=alpha&to=gamma`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      found: boolean;
      hopCount: number;
      nodes: Array<{ id: string; label: string }>;
      edges: Array<{ source: string; target: string; kind: string }>;
    };
    expect(body.found).toBe(true);
    expect(body.hopCount).toBeGreaterThanOrEqual(1);
    const labels = body.nodes.map((node) => node.label);
    expect(labels[0]).toBe('alpha');
    expect(labels).toContain('gamma');
    expect(body.edges.some((edge) => edge.kind === 'calls')).toBe(true);
  });

  it('returns a focused impact graph at /api/impact', async () => {
    const res = await fetch(`${handle.url}api/impact?focus=gamma&mode=callers&depth=2&limit=20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      focus: { label: string } | null;
      mode: string;
      nodes: Array<{ label: string }>;
      edges: Array<{ kind: string }>;
    };
    expect(body.focus?.label).toBe('gamma');
    expect(body.mode).toBe('callers');
    const labels = body.nodes.map((node) => node.label);
    expect(labels).toContain('gamma');
    expect(labels).toContain('beta');
    expect(labels).toContain('alpha');
    expect(body.edges.some((edge) => edge.kind === 'calls')).toBe(true);
  });

  it('returns callee and combined impact graph modes at /api/impact', async () => {
    const calleesRes = await fetch(`${handle.url}api/impact?focus=alpha&mode=callees&depth=2&limit=20`);
    expect(calleesRes.status).toBe(200);
    const callees = (await calleesRes.json()) as { mode: string; nodes: Array<{ label: string }> };
    expect(callees.mode).toBe('callees');
    expect(callees.nodes.map((node) => node.label)).toContain('gamma');

    const bothRes = await fetch(`${handle.url}api/impact?focus=beta&mode=both&depth=1&limit=20`);
    expect(bothRes.status).toBe(200);
    const both = (await bothRes.json()) as { mode: string; nodes: Array<{ label: string }> };
    expect(both.mode).toBe('both');
    expect(both.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
  });

  it('returns changed files and indexed symbols at /api/compare', async () => {
    const res = await fetch(`${handle.url}api/compare?limit=20`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      gitAvailable: boolean;
      changedFiles: Array<{ path: string; status: string; nodes: Array<{ label: string }> }>;
      totals: { files: number; nodes: number };
    };
    expect(Array.isArray(body.changedFiles)).toBe(true);
    expect(typeof body.totals.files).toBe('number');
    if (!gitCompareReady) return;
    expect(body.gitAvailable).toBe(true);
    const file = body.changedFiles.find((row) => row.path === 'src/lib.ts');
    expect(file).toBeTruthy();
    expect(file?.status).toBe('M');
    expect(file?.nodes.some((node) => node.label === 'compute')).toBe(true);
  });

  it('returns symbol detail at /api/symbol/:name', async () => {
    const res = await fetch(`${handle.url}api/symbol/compute`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      label: string;
      kind: string;
      file: string;
      callers: unknown[];
      callees: Array<{ label: string }>;
      findings: unknown[];
      metrics: {
        loc: number;
        cyclomatic: number | null;
        maxNesting: number | null;
        fileFirstSeenTs: number | null;
        fileLastTouchedTs: number | null;
        fileCommits: number | null;
      };
    };
    expect(body.label).toBe('compute');
    expect(body.kind).toBe('function');
    expect(body.file).toBe('src/lib.ts');
    const calleeLabels = body.callees.map((c) => c.label);
    expect(calleeLabels).toContain('add');
    expect(calleeLabels).toContain('mul');
    // metrics block: loc is always available; with node_metrics
    // persistence (migration 029) cyclomatic + maxNesting are
    // populated even on clean symbols. file churn fields are null
    // in this test (no git history).
    expect(body.metrics.loc).toBeGreaterThan(0);
    expect(typeof body.metrics.cyclomatic).toBe('number');
    expect(typeof body.metrics.maxNesting).toBe('number');
  });

  it('returns source snippets at /api/source/:name', async () => {
    const res = await fetch(`${handle.url}api/source/compute`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      source: string;
      startLine: number;
      endLine: number;
      language: string;
      file: string;
    };
    expect(body.file).toBe('src/lib.ts');
    expect(body.language).toBe('typescript');
    expect(body.startLine).toBeGreaterThan(0);
    expect(body.endLine).toBeGreaterThanOrEqual(body.startLine);
    expect(body.source).toContain('export function compute');
    expect(body.source).toContain('return d;');
  });

  it('returns coverage: null when no lcov has been loaded', async () => {
    const res = await fetch(`${handle.url}api/symbol/compute`);
    const body = (await res.json()) as { coverage: unknown };
    expect(body.coverage).toBeNull();
  });

  it('returns 404 for unknown symbol', async () => {
    const res = await fetch(`${handle.url}api/symbol/__no_such_symbol__`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown symbol/);
  });

  it('returns 404 for unknown path', async () => {
    const res = await fetch(`${handle.url}does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('rejects non-GET methods with 405', async () => {
    const res = await fetch(`${handle.url}api/status`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('returns project-wide findings rollup at /api/findings', async () => {
    const res = await fetch(`${handle.url}api/findings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalFindings: number;
      byBiomarker: Record<string, number>;
      bySeverity: Record<string, number>;
      nodesWithFindings: number;
      totalNodes: number;
      totalFiles: number;
      codeHealth: number;
    };
    expect(body.totalFindings).toBeGreaterThanOrEqual(0);
    expect(body.totalNodes).toBeGreaterThan(0);
    expect(body.codeHealth).toBeGreaterThanOrEqual(1);
    expect(body.codeHealth).toBeLessThanOrEqual(10);
  });

  it('returns hotspots at /api/hotspots', async () => {
    const res = await fetch(`${handle.url}api/hotspots?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hotspots: unknown[] };
    expect(Array.isArray(body.hotspots)).toBe(true);
  });

  it('returns recent sessions at /api/sessions (empty on a fresh DB)', async () => {
    const res = await fetch(`${handle.url}api/sessions?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('returns session detail at /api/sessions/:id (empty calls for unknown id)', async () => {
    const res = await fetch(`${handle.url}api/sessions/nonexistent-session-id`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; calls: unknown[] };
    expect(body.sessionId).toBe('nonexistent-session-id');
    expect(body.calls).toEqual([]);
  });

  it('returns 400 on a malformed percent-encoded symbol id', async () => {
    const res = await fetch(`${handle.url}api/symbol/%GG`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/malformed/);
  });

  it('returns current LLM setup guidance when Ask has no configured backend', async () => {
    const res = await fetch(`${handle.url}api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'How does compute work?', symbol: 'compute' }),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; hint: string };
    expect(body.error).toMatch(/No (?:chat|ask) provider configured|not reachable/i);
    expect(body.hint).toContain('cartograph admin llm-plan');
    expect(body.hint).toContain('cartograph admin llm-apply');
  });

  it('routes Ask requests by pathname and rejects oversized Ask bodies with JSON', async () => {
    const routed = await fetch(`${handle.url}api/ask?debug=1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'How does compute work?', symbol: 'compute' }),
    });
    expect(routed.status).toBe(503);

    const oversized = await fetch(`${handle.url}api/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: 'body too large' });
  });
});

function createGitCompareFixture(dir: string): boolean {
  const run = (args: string[]) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  if (run(['--version']).status !== 0) return false;
  if (run(['init']).status !== 0) return false;
  run(['config', 'user.email', 'viewer-test@example.invalid']);
  run(['config', 'user.name', 'Viewer Test']);
  if (run(['add', 'src/lib.ts']).status !== 0) return false;
  if (run(['commit', '-m', 'initial']).status !== 0) return false;
  fs.appendFileSync(path.join(dir, 'src', 'lib.ts'), '\nexport const changedForViewerCompare = 1;\n');
  return true;
}

describe('viewer HTTP server — startup errors', () => {
  it('rejects when the project has no cartograph DB', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-empty-'));
    try {
      await expect(startViewerServer(empty, { port: 0 })).rejects.toThrow(/No cartograph DB/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
