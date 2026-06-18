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
import { DatabaseConnection, getDatabasePath } from '../src/db/index.js';
import { upsertFile } from '../src/db/queries-files.js';
import { QueryBuilder } from '../src/db/queries.js';
import { appendToolCall, deleteSession, insertSession } from '../src/db/queries-trace.js';
import { hashContent } from '../src/extraction/index.js';
import { startViewerServer, type ViewerHandle } from '../src/features/viewer/server/index.js';
import { endReindexJob, tryBeginReindexJob } from '../src/features/viewer/server/reindex-job.js';

describe('viewer HTTP server', () => {
  let testDir: string;
  let cg: Cartograph;
  let handle: ViewerHandle;
  let gitCompareReady = false;
  let outsideDir: string | null = null;
  let symlinkEscapeReady = false;

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
    outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-outside-'));
    symlinkEscapeReady = addSymlinkEscapeFixture(cg, testDir, outsideDir);
    cg.close();
    gitCompareReady = createGitCompareFixture(testDir);
    handle = await startViewerServer(testDir, { port: 0 });
  });

  afterAll(async () => {
    await handle.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    if (outsideDir && fs.existsSync(outsideDir)) fs.rmSync(outsideDir, { recursive: true, force: true });
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
      'viewer.api.app',
      'viewer.graph-core.app',
      'viewer.mobile-panels.app',
      'viewer.graph-layout.app',
      'viewer.edge-inspection.app',
      'viewer.graph-diagnostics.app',
      'viewer.live.app',
      'viewer.health.app',
      'viewer.config.app',
      'viewer.status.app',
      'viewer.source.app',
      'viewer.palette.app',
      'viewer.hash-editor.app',
      'viewer.graph-export.app',
      'viewer.ask.app',
      'viewer.selection-detail.app',
      'viewer.trace.app',
      'viewer.livefeed.app',
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
    expect(body).toContain('viewer.api.app');
    expect(body).toContain('function apiFetch');
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
    expect(body).toContain('id="health-view"');
    expect(body).toContain('id="system-view"');
    expect(body).toContain('data-view="system"');
    expect(body).toContain('id="overview-view"');
    expect(body).toContain('id="hc-biomarkers"');
    expect(body).toContain('id="hc-hotspots-list"');
    expect(body).toContain('function renderHealthDashboard');
    expect(body).toContain('function graphElementsFromPayload');
    expect(body).toContain('function focusGraphOnSymbol');
    expect(body).toContain('function clearCurrentSelection');
    expect(body).toContain('selectionState()');
    expect(body).toContain('<!doctype html>');
  });

  it('rejects unauthorized API requests while leaving static assets readable', async () => {
    const res = await fetch(`${handle.url}api/status`);
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toMatchObject({ error: 'unauthorized' });

    const asset = await fetch(`${handle.url}viewer.css`);
    expect(asset.status).toBe(200);
  });

  it('returns project metadata at /api/status with the viewer token', async () => {
    const res = await apiFetch(handle, 'api/status');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectRoot: string;
      files: number;
      nodes: number;
      edges: number;
      languages: string[];
      dirs: Array<{ prefix: string; files: number; nodes: number }>;
    };
    expect(body.projectRoot).toBe(testDir);
    expect(body.files).toBeGreaterThan(0);
    expect(body.nodes).toBeGreaterThan(0);
    expect(body.languages).toContain('typescript');
    // The file-scope rail renders from these per-project buckets — the
    // viewer must never hardcode a directory layout.
    const srcBucket = body.dirs.find((d) => d.prefix === 'src/');
    expect(srcBucket).toBeDefined();
    expect(srcBucket!.files).toBeGreaterThan(0);
    expect(srcBucket!.nodes).toBeGreaterThan(0);
  });

  it('rejects API requests from foreign origins even with the viewer token', async () => {
    const rejected = await apiFetch(handle, 'api/status', { headers: { origin: 'http://example.com' } });
    expect(rejected.status).toBe(403);
    await expect(rejected.json()).resolves.toMatchObject({ error: 'forbidden origin' });

    const accepted = await apiFetch(handle, 'api/status', { headers: { origin: new URL(handle.url).origin } });
    expect(accepted.status).toBe(200);
  });

  it('returns a connected default graph when no focus is given', async () => {
    // The no-focus path now anchors on the highest-centrality node
    // and BFS-traverses outward, so every visible node is connected.
    // The response carries that anchor as `focus` (was null in the
    // earlier "top-N by centrality" implementation).
    const res = await apiFetch(handle, 'api/graph');
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
    const res = await apiFetch(handle, 'api/graph?focus=compute&depth=2');
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
    const res = await apiFetch(handle, 'api/graph?focus=alpha&depth=2&limit=20');
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
    const res = await apiFetch(handle, 'api/graph?focus=compute&mode=focus&limit=2');
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
    const res = await apiFetch(handle, 'api/search?q=compute&limit=5');
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
    const res = await apiFetch(handle, 'api/path?from=alpha&to=gamma');
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
    const res = await apiFetch(handle, 'api/impact?focus=gamma&mode=callers&depth=2&limit=20');
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
    const calleesRes = await apiFetch(handle, 'api/impact?focus=alpha&mode=callees&depth=2&limit=20');
    expect(calleesRes.status).toBe(200);
    const callees = (await calleesRes.json()) as { mode: string; nodes: Array<{ label: string }> };
    expect(callees.mode).toBe('callees');
    expect(callees.nodes.map((node) => node.label)).toContain('gamma');

    const bothRes = await apiFetch(handle, 'api/impact?focus=beta&mode=both&depth=1&limit=20');
    expect(bothRes.status).toBe(200);
    const both = (await bothRes.json()) as { mode: string; nodes: Array<{ label: string }> };
    expect(both.mode).toBe('both');
    expect(both.nodes.map((node) => node.label)).toEqual(expect.arrayContaining(['alpha', 'beta', 'gamma']));
  });

  it('returns changed files and indexed symbols at /api/compare', async () => {
    const res = await apiFetch(handle, 'api/compare?limit=20');
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
    const res = await apiFetch(handle, 'api/symbol/compute');
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
    const res = await apiFetch(handle, 'api/source/compute');
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

  it('rejects source reads through symlinks that escape the project root', async () => {
    if (!symlinkEscapeReady) return;
    const res = await apiFetch(handle, 'api/source/symlinkEscape');
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string; source: string };
    expect(body.error).toBe('path escapes project root');
    expect(body.source).toBe('');
  });

  it('returns coverage: null when no lcov has been loaded', async () => {
    const res = await apiFetch(handle, 'api/symbol/compute');
    const body = (await res.json()) as { coverage: unknown };
    expect(body.coverage).toBeNull();
  });

  it('returns 404 for unknown symbol', async () => {
    const res = await apiFetch(handle, 'api/symbol/__no_such_symbol__');
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown symbol/);
  });

  it('returns 404 for unknown path', async () => {
    const res = await fetch(`${handle.url}does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('rejects non-GET methods with 405', async () => {
    const res = await apiFetch(handle, 'api/status', { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('returns project-wide findings rollup at /api/findings', async () => {
    const res = await apiFetch(handle, 'api/findings');
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalFindings: number;
      byBiomarker: Record<string, number>;
      byBiomarkerSeverity: Record<string, { info: number; warning: number; error: number }>;
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
    // Per-biomarker severity split feeds the Health tab's mini stacks;
    // every biomarker bucket must also appear in the split.
    expect(typeof body.byBiomarkerSeverity).toBe('object');
    for (const name of Object.keys(body.byBiomarker)) {
      expect(body.byBiomarkerSeverity[name]).toBeDefined();
    }
  });

  it('returns hotspots at /api/hotspots', async () => {
    const res = await apiFetch(handle, 'api/hotspots?limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hotspots: unknown[] };
    expect(Array.isArray(body.hotspots)).toBe(true);
  });

  it('returns recent sessions at /api/sessions (empty on a fresh DB)', async () => {
    const res = await apiFetch(handle, 'api/sessions?limit=5');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('returns session detail at /api/sessions/:id (empty calls for unknown id)', async () => {
    const res = await apiFetch(handle, 'api/sessions/nonexistent-session-id');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; calls: unknown[] };
    expect(body.sessionId).toBe('nonexistent-session-id');
    expect(body.calls).toEqual([]);
  });

  it('returns session identity in /api/sessions and per-call project in the detail', async () => {
    const conn = DatabaseConnection.open(getDatabasePath(testDir));
    const qb = new QueryBuilder(conn.getDb());
    const sid = 'identity-session';
    try {
      insertSession({
        qb,
        id: sid,
        startedTs: Date.now(),
        label: 'review run',
        clientName: 'claude-code',
        clientVersion: '2.1.0',
        projectRoot: testDir,
      });
      appendToolCall(qb, {
        sessionId: sid,
        step: 1,
        ts: Date.now(),
        toolName: 'cartograph_status',
        argsJson: JSON.stringify({ projectPath: '/elsewhere/project' }),
        resultSummary: 'ok',
        durationMs: 4,
      });

      const list = await apiFetch(handle, 'api/sessions?limit=10');
      const sessions = ((await list.json()) as { sessions: Array<Record<string, unknown>> }).sessions;
      const mine = sessions.find((s) => s.id === sid);
      expect(mine?.clientName).toBe('claude-code');
      expect(mine?.clientVersion).toBe('2.1.0');
      expect(mine?.projectRoot).toBe(testDir);
      expect(mine?.label).toBe('review run');

      const detailRes = await apiFetch(handle, `api/sessions/${sid}`);
      const detail = (await detailRes.json()) as {
        session: { clientName: string; projectRoot: string } | null;
        calls: Array<{ project: string | null }>;
      };
      expect(detail.session?.clientName).toBe('claude-code');
      expect(detail.session?.projectRoot).toBe(testDir);
      // The call targeted another project via the projectPath arg.
      expect(detail.calls[0]?.project).toBe('/elsewhere/project');
    } finally {
      deleteSession(qb, sid);
      conn.close();
    }
  });

  it('returns the live call feed at /api/live/calls (and filters by sinceTs)', async () => {
    const empty = await apiFetch(handle, 'api/live/calls');
    expect(empty.status).toBe(200);
    expect(((await empty.json()) as { calls: unknown[] }).calls).toEqual([]);

    const conn = DatabaseConnection.open(getDatabasePath(testDir));
    const qb = new QueryBuilder(conn.getDb());
    const sid = 'live-calls-session';
    const t0 = Date.now();
    try {
      insertSession({ qb, id: sid, startedTs: t0 });
      appendToolCall(qb, {
        sessionId: sid,
        step: 1,
        ts: t0,
        toolName: 'cartograph_find',
        argsJson: JSON.stringify({ by: 'symbol', query: 'compute' }),
        resultSummary: 'ok',
        durationMs: 12,
      });
      appendToolCall(qb, {
        sessionId: sid,
        step: 2,
        ts: t0 + 5,
        toolName: 'cartograph_graph',
        argsJson: JSON.stringify({ projectPath: '/elsewhere/project' }),
        resultSummary: 'ok',
        durationMs: 7,
      });

      const res = await apiFetch(handle, 'api/live/calls');
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        calls: Array<{ sessionId: string; step: number; tool: string; args: unknown; project: string | null }>;
      };
      expect(body.calls.map((c) => c.step)).toEqual([1, 2]);
      expect(body.calls[0]!.project).toBeNull();
      expect(body.calls[1]!.project).toBe('/elsewhere/project');
      expect(body.calls[0]!.sessionId).toBe(sid);
      expect(body.calls[0]!.tool).toBe('cartograph_find');
      expect(body.calls[0]!.args).toEqual({ by: 'symbol', query: 'compute' });

      const since = await apiFetch(handle, `api/live/calls?sinceTs=${t0 + 1}`);
      const sinceBody = (await since.json()) as { calls: Array<{ step: number }> };
      expect(sinceBody.calls.map((c) => c.step)).toEqual([2]);
    } finally {
      deleteSession(qb, sid);
      conn.close();
    }
  });

  it('streams new tool calls over /api/live/stream (SSE)', async () => {
    const ctrl = new AbortController();
    const res = await apiFetch(handle, 'api/live/stream', { signal: ctrl.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readEvent = async (wanted: string, timeoutMs = 5000): Promise<unknown> => {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const idx = buf.indexOf('\n\n');
        if (idx >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (event === wanted && data) return JSON.parse(data);
          continue;
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for ${wanted} event`);
        const chunk = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) =>
            setTimeout(() => reject(new Error(`timed out waiting for ${wanted} event`)), remaining),
          ),
        ]);
        if (chunk.done) throw new Error('stream ended before the expected event');
        buf += decoder.decode(chunk.value, { stream: true });
      }
    };

    const conn = DatabaseConnection.open(getDatabasePath(testDir));
    const qb = new QueryBuilder(conn.getDb());
    const sid = 'live-stream-session';
    try {
      const backlog = (await readEvent('backlog')) as { calls: unknown[] };
      expect(Array.isArray(backlog.calls)).toBe(true);

      insertSession({ qb, id: sid, startedTs: Date.now() });
      appendToolCall(qb, {
        sessionId: sid,
        step: 1,
        ts: Date.now(),
        toolName: 'cartograph_status',
        argsJson: '{}',
        resultSummary: 'streamed',
        durationMs: 3,
      });
      const call = (await readEvent('call')) as { sessionId: string; tool: string; result: string };
      expect(call.sessionId).toBe(sid);
      expect(call.tool).toBe('cartograph_status');
      expect(call.result).toBe('streamed');
    } finally {
      await reader.cancel().catch(() => {});
      ctrl.abort();
      deleteSession(qb, sid);
      conn.close();
    }
  });

  it('never serves sessions recorded against a different project root', async () => {
    const conn = DatabaseConnection.open(getDatabasePath(testDir));
    const qb = new QueryBuilder(conn.getDb());
    const t0 = Date.now();
    try {
      insertSession({ qb, id: 'own-project-session', startedTs: t0, projectRoot: testDir });
      appendToolCall(qb, {
        sessionId: 'own-project-session',
        step: 1,
        ts: t0,
        toolName: 'cartograph_find',
        argsJson: '{}',
        resultSummary: 'ours',
        durationMs: 2,
      });
      insertSession({ qb, id: 'legacy-session', startedTs: t0 + 1 }); // NULL root — older binary
      appendToolCall(qb, {
        sessionId: 'legacy-session',
        step: 1,
        ts: t0 + 2,
        toolName: 'cartograph_status',
        argsJson: '{}',
        resultSummary: 'legacy',
        durationMs: 2,
      });
      insertSession({ qb, id: 'foreign-session', startedTs: t0 + 3, projectRoot: '/somewhere/else' });
      appendToolCall(qb, {
        sessionId: 'foreign-session',
        step: 1,
        ts: t0 + 4,
        toolName: 'cartograph_graph',
        argsJson: '{}',
        resultSummary: 'foreign',
        durationMs: 2,
      });

      const sessions = (await (await apiFetch(handle, 'api/sessions?limit=50')).json()) as {
        sessions: Array<{ id: string }>;
      };
      const ids = new Set(sessions.sessions.map((s) => s.id));
      expect(ids.has('own-project-session')).toBe(true);
      expect(ids.has('legacy-session')).toBe(true); // unattributable → kept
      expect(ids.has('foreign-session')).toBe(false);

      const foreign = await apiFetch(handle, 'api/sessions/foreign-session');
      expect(foreign.status).toBe(404);

      const live = (await (await apiFetch(handle, 'api/live/calls?limit=50')).json()) as {
        calls: Array<{ sessionId: string }>;
      };
      const liveSessions = new Set(live.calls.map((c) => c.sessionId));
      expect(liveSessions.has('own-project-session')).toBe(true);
      expect(liveSessions.has('legacy-session')).toBe(true);
      expect(liveSessions.has('foreign-session')).toBe(false);
    } finally {
      deleteSession(qb, 'own-project-session');
      deleteSession(qb, 'legacy-session');
      deleteSession(qb, 'foreign-session');
      conn.close();
    }
  });

  it('--session scopes the viewer to one session, enforced server-side', async () => {
    const conn = DatabaseConnection.open(getDatabasePath(testDir));
    const qb = new QueryBuilder(conn.getDb());
    const t0 = Date.now();
    let scopedHandle: ViewerHandle | null = null;
    try {
      insertSession({ qb, id: 'scoped-session', startedTs: t0, label: 'agent-a' });
      appendToolCall(qb, {
        sessionId: 'scoped-session',
        step: 1,
        ts: t0,
        toolName: 'cartograph_find',
        argsJson: '{}',
        resultSummary: 'mine',
        durationMs: 3,
      });
      insertSession({ qb, id: 'other-session', startedTs: t0 + 1 });
      appendToolCall(qb, {
        sessionId: 'other-session',
        step: 1,
        ts: t0 + 2,
        toolName: 'cartograph_status',
        argsJson: '{}',
        resultSummary: 'not mine',
        durationMs: 2,
      });

      // Scope by LABEL — resolution happens per request.
      scopedHandle = await startViewerServer(testDir, { port: 0, session: 'agent-a' });

      const status = (await (await apiFetch(scopedHandle, 'api/status')).json()) as {
        sessionScope: { selector: string; sessionId: string | null } | null;
      };
      expect(status.sessionScope?.selector).toBe('agent-a');
      expect(status.sessionScope?.sessionId).toBe('scoped-session');

      const sessions = (await (await apiFetch(scopedHandle, 'api/sessions?limit=50')).json()) as {
        sessions: Array<{ id: string }>;
      };
      expect(sessions.sessions.map((s) => s.id)).toEqual(['scoped-session']);

      const foreign = await apiFetch(scopedHandle, 'api/sessions/other-session');
      expect(foreign.status).toBe(404);
      const own = await apiFetch(scopedHandle, 'api/sessions/scoped-session');
      expect(own.status).toBe(200);

      const live = (await (await apiFetch(scopedHandle, 'api/live/calls?limit=50')).json()) as {
        calls: Array<{ sessionId: string }>;
      };
      expect(live.calls.length).toBe(1);
      expect(live.calls[0]!.sessionId).toBe('scoped-session');

      // The UNSCOPED server still sees both sessions.
      const all = (await (await apiFetch(handle, 'api/live/calls?limit=50')).json()) as {
        calls: Array<{ sessionId: string }>;
      };
      expect(new Set(all.calls.map((c) => c.sessionId))).toEqual(new Set(['scoped-session', 'other-session']));

      // Launch-before-start: a viewer scoped to a label that does not
      // exist yet serves nothing, then locks on per-request once the
      // labeled session appears.
      const early = await startViewerServer(testDir, { port: 0, session: 'agent-b' });
      try {
        const before = (await (await apiFetch(early, 'api/live/calls?limit=50')).json()) as { calls: unknown[] };
        expect(before.calls).toEqual([]);
        insertSession({ qb, id: 'late-session', startedTs: Date.now(), label: 'agent-b' });
        appendToolCall(qb, {
          sessionId: 'late-session',
          step: 1,
          ts: Date.now(),
          toolName: 'cartograph_graph',
          argsJson: '{}',
          resultSummary: 'late arrival',
          durationMs: 6,
        });
        const after = (await (await apiFetch(early, 'api/live/calls?limit=50')).json()) as {
          calls: Array<{ sessionId: string }>;
        };
        expect(after.calls.map((c) => c.sessionId)).toEqual(['late-session']);
      } finally {
        await early.close();
        deleteSession(qb, 'late-session');
      }
    } finally {
      if (scopedHandle) await scopedHandle.close();
      deleteSession(qb, 'scoped-session');
      deleteSession(qb, 'other-session');
      conn.close();
    }
  });

  it('returns 400 on a malformed percent-encoded symbol id', async () => {
    const res = await apiFetch(handle, 'api/symbol/%GG');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/malformed/);
  });

  it('returns current LLM setup guidance when Ask has no configured backend', async () => {
    const res = await apiFetch(handle, 'api/ask', {
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
    const routed = await apiFetch(handle, 'api/ask?debug=1', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'How does compute work?', symbol: 'compute' }),
    });
    expect(routed.status).toBe(503);

    const oversized = await apiFetch(handle, 'api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question: 'x'.repeat(70 * 1024) }),
    });
    expect(oversized.status).toBe(413);
    await expect(oversized.json()).resolves.toMatchObject({ error: 'body too large' });
  });

  // ── Config editor (loopback bind → allowConfigEdit is true here; the
  //    non-loopback 403 path is unit-tested via viewerConfigEditAllowed). ──

  interface ConfigPayload {
    allowConfigEdit: boolean;
    reindexing: boolean;
    config: {
      include: string[];
      exclude: string[];
      maxFileSize: number;
      enableBiomarkers: boolean;
      enableCoChange: boolean;
    };
    database: unknown;
    maxFileSizeCap: number;
    maxFileSizeCapLabel: string;
  }
  const getConfig = async (): Promise<ConfigPayload> =>
    (await apiFetch(handle, 'api/config')).json() as Promise<ConfigPayload>;
  const postConfig = (body: unknown): Promise<Response> =>
    apiFetch(handle, 'api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it('exposes the curated config + capabilities at GET /api/config', async () => {
    const body = await getConfig();
    expect(body.allowConfigEdit).toBe(true); // loopback bind enables it by default
    expect(body.config.include).toContain('src/**/*.ts');
    expect(Array.isArray(body.config.exclude)).toBe(true);
    expect(body.config.maxFileSize).toBeGreaterThan(0);
    expect(body.maxFileSizeCap).toBeGreaterThan(0);
    expect(body.database).toBeNull(); // sqlite default → no database block surfaced
  });

  it('persists a curated edit and reports the apply class', async () => {
    const before = await getConfig();
    const res = await postConfig({ ...before.config, exclude: [...before.config.exclude, '**/generated/**'] });
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, applyClass: 'reindex' });
    const after = await getConfig();
    expect(after.config.exclude).toContain('**/generated/**');
  });

  it('rejects an out-of-range maxFileSize with 400 and writes nothing', async () => {
    const before = await getConfig();
    const res = await postConfig({ maxFileSize: 999 * 1024 * 1024 }); // above the 10 MB cap
    expect(res.status).toBe(400);
    const after = await getConfig();
    expect(after.config.maxFileSize).toBe(before.config.maxFileSize);
  });

  it('never persists non-whitelisted fields (database) from the request body', async () => {
    const res = await postConfig({ database: { provider: 'postgres', url: 'postgres://evil' }, exclude: ['**/x/**'] });
    expect(res.status).toBe(200);
    const after = await getConfig();
    expect(after.database).toBeNull(); // the database block in the body was ignored
  });

  it('refuses to save config while a re-index is running (409)', async () => {
    // The reindex single-flight guard is module-global and shared with the
    // running server, so we can drive it deterministically.
    expect(tryBeginReindexJob()).toBe(true);
    try {
      const res = await postConfig({ exclude: ['**/while-reindexing/**'] });
      expect(res.status).toBe(409);
    } finally {
      endReindexJob();
    }
  });

  it('rejects an invalid re-index mode with 400', async () => {
    const res = await apiFetch(handle, 'api/reindex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'wipe' }),
    });
    expect(res.status).toBe(400);
  });

  it('streams an in-process re-index as Server-Sent Events', async () => {
    const res = await fetch(new URL('api/reindex', handle.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cartograph-viewer-token': handle.apiToken },
      body: JSON.stringify({ mode: 'sync' }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    // The server ends the response after the terminal frame, so reading
    // to completion is bounded.
    const text = await res.text();
    expect(text).toMatch(/event: (done|busy)/);

    // The single-flight guard must be released after the job finishes —
    // a second re-index must NOT get a stale 409. (Regression guard for
    // the leaked-lock path when stream setup throws.)
    const again = await fetch(new URL('api/reindex', handle.url), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-cartograph-viewer-token': handle.apiToken },
      body: JSON.stringify({ mode: 'sync' }),
      signal: AbortSignal.timeout(30_000),
    });
    expect(again.status).toBe(200);
    await again.text();
  }, 45_000);
});

function apiFetch(handle: ViewerHandle, pathOrUrl: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('x-cartograph-viewer-token', handle.apiToken);
  return fetch(new URL(pathOrUrl, handle.url), { ...init, headers, signal: init.signal ?? AbortSignal.timeout(5000) });
}

function addSymlinkEscapeFixture(cg: Cartograph, projectRoot: string, outsideDir: string): boolean {
  const outsideSource = 'export function symlinkEscape(): string { return "outside"; }\n';
  const outsideFile = path.join(outsideDir, 'escape.ts');
  const linkRel = 'src/escape-link.ts';
  const linkAbs = path.join(projectRoot, linkRel);
  fs.writeFileSync(outsideFile, outsideSource);
  try {
    fs.symlinkSync(outsideFile, linkAbs);
  } catch {
    return false;
  }
  const now = Date.now();
  upsertFile(cg.queries, {
    path: linkRel,
    contentHash: hashContent(outsideSource),
    language: 'typescript',
    size: Buffer.byteLength(outsideSource),
    modifiedAt: now,
    indexedAt: now,
    nodeCount: 1,
    errors: [],
    commitCount: 0,
    loc: 1,
    firstSeenTs: null,
    lastTouchedTs: null,
    isTest: false,
    needsReextract: false,
  });
  cg.queries.insertNode({
    id: 'function:symlinkEscape',
    kind: 'function',
    name: 'symlinkEscape',
    qualifiedName: 'symlinkEscape',
    filePath: linkRel,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  });
  return true;
}

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
