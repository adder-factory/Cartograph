import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { DatabaseConnection, getDatabasePath } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { appendToolCall, insertSession } from '../src/db/queries-trace.js';
import { startViewerServer, type ViewerHandle } from '../src/features/viewer/server/index.js';
import { runViewerSmokeFeaturesWorkflow } from './viewer-smoke-features.js';
import { runViewerSmokeLayoutWorkflow } from './viewer-smoke-layout.js';
import { runViewerSmokeMobileWorkflow } from './viewer-smoke-mobile.js';
import { captureViewerScreenshot, writeViewerSmokeFailureArtifacts } from './viewer-smoke-screenshots.js';

const PLAYWRIGHT_MODULE_ENV = 'PLAYWRIGHT_MODULE';
const DEFAULT_PLAYWRIGHT_MODULE = 'playwright';
const VIEWER_SMOKE_REQUIRED_ENV = 'VIEWER_SMOKE_REQUIRED';
const VIEWER_SMOKE_REAL_PROJECT_ENV = 'VIEWER_SMOKE_REAL_PROJECT';
const VIEWER_SMOKE_REAL_PROJECT_REQUIRED_ENV = 'VIEWER_SMOKE_REAL_PROJECT_REQUIRED';
const DESKTOP_VIEWPORT = { width: 1280, height: 820 } as const;
const MOBILE_VIEWPORT = { width: 390, height: 760 } as const;
const GRAPH_RENDER_TIMEOUT_MS = 20_000;
const SEARCH_TIMEOUT_MS = 10_000;
const MOBILE_QUERY_TIMEOUT_MS = 5_000;
const DETAIL_OPEN_FAST_TIMEOUT_MS = 1_000;
const CANVAS_PIXEL_SAMPLE_COUNT = 8_000;
const GRAPH_FIT_TOLERANCE_PX = 2;
const EDGE_GEOMETRY_SAMPLE_LIMIT = 8;
const LAYOUT_STABILITY_NODE_LIMIT = 20;
const LAYOUT_STABILITY_SETTLE_MS = 900;
// Max per-node drift (after centering, so translation is already removed)
// allowed between two independent reloads. This guards against the regression
// it was written for — the graph grossly rearranging or collapsing on reload
// (nodes moving tens-to-hundreds of px) — NOT sub-pixel reproducibility.
//
// The layout is seeded-deterministic and runs synchronously, but the
// post-layout collision-relaxation pass sizes each node from its rendered
// metrics (`outerWidth()` / label width — see layoutCollisionRadius in
// viewer.graph-layout.app). Whether a node is already measured when the
// synchronous layout runs is render-timing-sensitive, so its collision radius
// — and thus the packing equilibrium — can differ by a couple of px between
// two reloads even though each run is internally converged (MIN_MOVE 0.05px).
// The previous 0.5px bound was tighter than that irreducible metric-driven
// variance and flaked intermittently (observed worst case ~4.4px); 8px stays
// well below any real rearrangement while absorbing the settling noise.
// Units are Cytoscape model coordinates (node.position()), not rendered px.
const LAYOUT_STABILITY_TOLERANCE_PX = 8;
const LINEAR_LAYOUT_MIN_NODE_COUNT = 8;
const LINEAR_LAYOUT_MIN_SPAN_PX = 80;
const LINEAR_LAYOUT_MIN_SPREAD_PX = 8;
const LINEAR_LAYOUT_SPREAD_RATIO = 0.04;
const SYNTHETIC_LAYOUT_NODE_COUNT = 36;
const SYNTHETIC_LAYOUT_FUNCTION_INTERVAL = 5;
const SYNTHETIC_LAYOUT_METHOD_INTERVAL = 3;
const SYNTHETIC_LAYOUT_STAR_EDGE_INTERVAL = 2;
const SYNTHETIC_LAYOUT_FOCUS_CENTRALITY = 0.01;
const SYNTHETIC_LAYOUT_NODE_CENTRALITY = 0.001;
const DENSE_LAYOUT_CLUSTER_COUNT = 4;
const DENSE_LAYOUT_CLUSTER_SIZE = 18;
const DENSE_LAYOUT_INTRA_LINKS = 3;
const DENSE_LAYOUT_CLASS_INTERVAL = 7;
const DENSE_LAYOUT_METHOD_INTERVAL = 3;
const DENSE_LAYOUT_BRIDGE_INTERVAL = 6;
const DENSE_LAYOUT_FOCUS_CENTRALITY = 0.012;
const DENSE_LAYOUT_BASE_CENTRALITY = 0.002;
const DENSE_LAYOUT_CENTRALITY_BUCKET_COUNT = 5;
const DENSE_LAYOUT_CENTRALITY_STEP = 0.0004;
const DENSE_LAYOUT_CONFIG = {
  baseCentrality: DENSE_LAYOUT_BASE_CENTRALITY,
  bridgeInterval: DENSE_LAYOUT_BRIDGE_INTERVAL,
  centralityBucketCount: DENSE_LAYOUT_CENTRALITY_BUCKET_COUNT,
  centralityStep: DENSE_LAYOUT_CENTRALITY_STEP,
  classInterval: DENSE_LAYOUT_CLASS_INTERVAL,
  clusterCount: DENSE_LAYOUT_CLUSTER_COUNT,
  clusterSize: DENSE_LAYOUT_CLUSTER_SIZE,
  focusCentrality: DENSE_LAYOUT_FOCUS_CENTRALITY,
  intraLinks: DENSE_LAYOUT_INTRA_LINKS,
  methodInterval: DENSE_LAYOUT_METHOD_INTERVAL,
} as const;
const GRAPH_FIXTURE_MATRIX = [
  {
    name: 'dense clustered graph',
    shape: 'clusters',
    minEdges: DENSE_LAYOUT_CLUSTER_COUNT * DENSE_LAYOUT_CLUSTER_SIZE,
    minNodes: DENSE_LAYOUT_CLUSTER_COUNT * DENSE_LAYOUT_CLUSTER_SIZE,
    maxOverlaps: 0,
    config: DENSE_LAYOUT_CONFIG,
  },
  {
    name: 'starburst graph',
    shape: 'starburst',
    minEdges: 80,
    minNodes: 72,
    maxOverlaps: 0,
    config: { nodeCount: 72, secondaryHop: 5 },
  },
  {
    name: 'branched chain graph',
    shape: 'branched-chain',
    minEdges: 76,
    minNodes: 80,
    maxOverlaps: 0,
    config: { backboneCount: 52, branchCount: 28, branchInterval: 2 },
  },
  {
    name: 'mesh graph',
    shape: 'mesh',
    minEdges: 210,
    minNodes: 56,
    maxOverlaps: 0,
    config: { hopCount: 4, nodeCount: 56 },
  },
] as const;
const MIN_EDGE_BOX_SPAN_PX = 1;
const MIN_EDGE_ENDPOINT_DISTANCE_PX = 2;
const MIN_DRAWER_TOP_Y = 120;
const MIN_DETAIL_DRAWER_HEIGHT = 160;
const MIN_CODE_DRAWER_HEIGHT = 240;
const PINNED_LAYOUTS_KEY = 'cartograph-viewer-pinned-layouts-v1';
const SAVED_VIEWS_KEY = 'cartograph-viewer-saved-views-v1';
const GRAPH_SNAPSHOT_KEY = 'cartograph-viewer-graph-snapshot-v1';
const SPLITTERS_KEY = 'cartograph-viewer-splitters-v1';
const LAYOUT_QUALITY_KEY = 'cartograph-viewer-layout-quality-v1';
const DENSITY_KEY = 'cartograph-viewer-density-v1';
const CORRUPT_STATE_PINNED_ENTRIES = 40;
const CORRUPT_STATE_PINNED_POSITIONS = 660;
const DETAIL_GROUPING_FIXTURE = {
  centrality: 0.01,
  file: 'src/lib.ts',
  health: 'healthy',
  kind: 'variable',
  nodes: [
    { id: 'smoke-detail-variable-a', label: 'smokeA', line: 20, position: { x: 120, y: 80 } },
    { id: 'smoke-detail-variable-b', label: 'smokeB', line: 21, position: { x: 160, y: 120 } },
  ],
  edges: [],
} as const;
const FINDING_FIXTURE_SYMBOL = 'largeProblem';
const FINDING_FIXTURE_BODY = Array.from({ length: 105 }, (_, i) => `  total += ${i + 3};`).join('\n');
const REAL_PROJECT_LAYOUT_SNAPSHOTS = [
  { name: 'default core graph', hash: '#tab=graph&density=core&detail=grouped', minNodes: 20, minEdges: 8 },
  { name: 'viewer focus graph', search: 'startViewerServer', minNodes: 2, minEdges: 1 },
  { name: 'graph payload focus', search: 'graphPayload', minNodes: 20, minEdges: 8 },
] as const;

function printLine(line: string): void {
  process.stdout.write(`${line}\n`);
}

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}

type Browser = { close: () => Promise<void> };
type Page = {
  goto: (url: string, opts?: Record<string, unknown>) => Promise<unknown>;
  locator: (selector: string) => {
    fill: (text: string) => Promise<void>;
    click: () => Promise<void>;
    boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
    screenshot: (opts: { path: string }) => Promise<Buffer>;
  };
  keyboard: { press: (key: string) => Promise<void> };
  evaluate: {
    <T>(fn: () => T | Promise<T>): Promise<T>;
    <T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  };
  on: (event: string, cb: (arg: unknown) => void) => void;
  screenshot: (opts: { fullPage?: boolean; path: string }) => Promise<Buffer>;
  setViewportSize: (size: { width: number; height: number }) => Promise<void>;
  waitForFunction: (fn: (arg?: unknown) => unknown, arg?: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
  waitForSelector: (selector: string, opts?: Record<string, unknown>) => Promise<unknown>;
};

type EdgeProbe = {
  data: (name: string) => unknown;
  hasClass: (name: string) => boolean;
  id: () => string;
  source: () => NodeProbe;
  style: (name: string) => string;
  target: () => NodeProbe;
};

type NodeProbe = {
  children: () => {
    filter: (fn: (node: { hasClass: (name: string) => boolean; style: (name: string) => string }) => boolean) => {
      length: number;
    };
  };
  data: (name: string) => unknown;
  hasClass: (name: string) => boolean;
  id: () => string;
  style: (name: string) => string;
  trigger: (event: string) => void;
};

type SmokeCy = {
  add: (elements: Array<Record<string, unknown>>) => unknown;
  edges: () => {
    filter: (fn: (edge: EdgeProbe) => boolean) => { 0?: EdgeProbe };
    forEach: (fn: (edge: EdgeProbe) => void) => void;
  };
  getElementById: (id: string) => NodeProbe;
  nodes: () => {
    filter: (fn: (node: NodeProbe) => boolean) => { 0?: NodeProbe; length: number };
    forEach: (fn: (node: NodeProbe) => void) => void;
  };
  zoom: () => number;
};

type RenderedPoint = { x: number; y: number };
type GraphFitBox = { x1: number; x2: number; y1: number; y2: number; w: number; h: number };
type GraphFitNodeProbe = NodeProbe & { renderedPosition: () => RenderedPoint };
type GraphFitNodeCollection = {
  filter: (fn: (node: GraphFitNodeProbe) => boolean) => GraphFitNodeCollection;
  length: number;
  map: <T>(fn: (node: GraphFitNodeProbe) => T) => T[];
  renderedBoundingBox: (opts?: Record<string, unknown>) => GraphFitBox;
};
type GraphEdgeProbe = EdgeProbe & {
  renderedBoundingBox: (opts?: Record<string, unknown>) => GraphFitBox;
  renderedSourceEndpoint?: () => RenderedPoint;
  renderedTargetEndpoint?: () => RenderedPoint;
  source: () => GraphFitNodeProbe;
  target: () => GraphFitNodeProbe;
};
type GraphEdgeCollection = {
  filter: (fn: (edge: GraphEdgeProbe) => boolean) => GraphEdgeCollection;
  forEach: (fn: (edge: GraphEdgeProbe) => void) => void;
  length: number;
  map: <T>(fn: (edge: GraphEdgeProbe) => T) => T[];
};
type GraphFitCy = {
  height: () => number;
  minZoom: () => number;
  nodes: () => GraphFitNodeCollection;
  pan: () => RenderedPoint;
  width: () => number;
  zoom: () => number;
};
type GraphFitState = {
  canvas: { width: number; height: number };
  label: string;
  minZoom: number;
  offscreenCount: number;
  offscreenSample: Array<{ id: string; label: unknown; rendered: RenderedPoint }>;
  pan: RenderedPoint;
  renderedBox: GraphFitBox | null;
  visibleNodeCount: number;
  zoom: number;
};
type GraphEdgeGeometryCy = GraphFitCy & { edges: () => GraphEdgeCollection };
type EdgeGeometryState = {
  badBoxCount: number;
  badBoxSample: Array<{ id: string; kind: unknown; box: GraphFitBox | null }>;
  hiddenEndpointCount: number;
  hiddenEndpointSample: Array<{
    id: string;
    kind: unknown;
    source: string;
    sourceVisible: boolean;
    target: string;
    targetVisible: boolean;
  }>;
  label: string;
  shortEndpointCount: number;
  shortEndpointSample: Array<{ id: string; kind: unknown; source: string; target: string; endpointDistance: number }>;
  visibleEdgeCount: number;
};
type EdgeVisibilityState = Pick<EdgeGeometryState, 'hiddenEndpointCount' | 'hiddenEndpointSample' | 'visibleEdgeCount'>;
type EdgeBoxState = Pick<EdgeGeometryState, 'badBoxCount' | 'badBoxSample'>;
type EdgeShortEndpointState = Pick<EdgeGeometryState, 'shortEndpointCount' | 'shortEndpointSample'>;
type GraphLayoutSample = Array<{ id: string; label: unknown; x: number; y: number }>;
type GraphLayoutShapeState = {
  diagonalSpread: number;
  label: string;
  narrowestLineSpread: number;
  renderedHeight: number;
  renderedWidth: number;
  sample: Array<{ id: string; label: unknown; x: number; y: number }>;
  visibleNodeCount: number;
};
type ViewerDiagnostics = GraphLayoutShapeState & {
  badBoxCount: number;
  disconnectedVisibleEdgeCount: number;
  graphLayoutKey: string | null;
  hiddenEndpointCount: number;
  hiddenEdgeByEndpointCount: number;
  hiddenEdgeByFilterCount: number;
  hiddenEdgeByLensCount: number;
  hiddenNodeByDensityCount: number;
  invariantErrorCount: number;
  invariantWarningCount?: number;
  lastLayoutDurationMs: number;
  layoutEngine: string;
  layoutQualityMode: string;
  nodeOverlapCount: number;
  nodeOverlapSample: Array<{
    a: { id: string; label: unknown };
    b: { id: string; label: unknown };
    overlapX: number;
    overlapY: number;
  }>;
  pinnedNodeCount: number;
  shortEndpointCount: number;
  totalEdgeCount: number;
  totalNodeCount: number;
  visibleEdgeCount: number;
};
type ViewerSelectionState = {
  currentSymbolId: string | null;
  detailMode: string;
  detailName: string;
  focusIds: string[];
  graphHasCurrent: boolean;
  hash: string;
  liveSymbolId: string | null;
  navHistory: string[];
  navIndex: number;
  navLabels?: string[];
  selectedEdgeCount: number;
};
type ViewerStateSnapshot = {
  actionNames?: string[];
  edgeInspection?: {
    hoveredEdgeId?: string | null;
    selectedEdgeId?: string | null;
  };
  graph?: {
    densityMode?: string;
    edgeLensMode?: string;
    layoutQuality?: string;
    visibilityStats?: {
      visibleNodeCount?: number;
      visibleEdgeCount?: number;
    } | null;
  };
  navigation?: {
    history?: Array<{ id: string; label?: string }>;
    index?: number;
  };
  selection?: {
    currentSymbolId?: string | null;
    liveSymbolCache?: { id?: string } | null;
  };
};

type ViewerSmokeHook = {
  actions?: Record<string, unknown>;
  bugReportPayload?: () => Record<string, unknown>;
  clearEdgeInspection: () => void;
  cy: SmokeCy;
  diagnostics?: (label?: string) => ViewerDiagnostics;
  graphJsonPayload: () => { nodes?: unknown[]; edges?: unknown[] };
  graphPngDataUrl: () => string;
  graphSvgText: () => string;
  resetGraphView: () => Promise<void>;
  selectEdge: (edgeId: string) => void;
  selectionState: () => ViewerSelectionState;
  state?: () => ViewerStateSnapshot;
  toggleGroupCollapse: (id: string, force?: boolean) => void;
};

type ViewerSmokeGlobal = typeof globalThis & {
  __cartographViewerSmoke?: ViewerSmokeHook;
  __cartographViewerTooltips?: {
    hideTooltip: () => void;
    showFor: (selector: string) => boolean;
    textFor: (selector: string) => string;
  };
  closeViewerRailSection?: (id: string) => boolean;
  openViewerRailSection?: (id: string) => boolean;
  setViewerUiMode?: (mode: 'simple' | 'advanced', opts?: Record<string, unknown>) => string;
  toggleGraphToolsPopover?: (force?: boolean) => boolean;
};

async function loadPlaywright(): Promise<{
  chromium: {
    launch: (
      opts?: Record<string, unknown>,
    ) => Promise<Browser & { newPage: (opts?: Record<string, unknown>) => Promise<Page> }>;
  };
} | null> {
  try {
    const moduleName = process.env[PLAYWRIGHT_MODULE_ENV] || DEFAULT_PLAYWRIGHT_MODULE;
    return (await import(moduleName)) as {
      chromium: {
        launch: (
          opts?: Record<string, unknown>,
        ) => Promise<Browser & { newPage: (opts?: Record<string, unknown>) => Promise<Page> }>;
      };
    };
  } catch (err) {
    if (envFlag(VIEWER_SMOKE_REQUIRED_ENV)) {
      throw new Error(
        `viewer-smoke requires Playwright, but it could not be loaded: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    printLine(`viewer-smoke SKIP: Playwright is not installed (${err instanceof Error ? err.message : String(err)})`);
    printLine('Install it with `bun add -d playwright` or run in an environment that already provides Playwright.');
    return null;
  }
}

function writeFixture(projectPath: string): void {
  fs.mkdirSync(path.join(projectPath, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectPath, 'src', 'lib.ts'),
    `
export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }
export function compute(x: number, y: number): number {
  const a = add(x, y);
  const b = mul(a, 2);
  const c = add(b, x);
  const d = mul(c, y);
  return d;
}
export function ${FINDING_FIXTURE_SYMBOL}(input: number): number {
  let total = input;
${FINDING_FIXTURE_BODY}
  return total;
}
`,
  );
}

async function buildFixtureIndex(projectPath: string): Promise<void> {
  const cg = Cartograph.initSync(projectPath, { config: { include: ['src/**/*.ts'], exclude: [] } });
  try {
    await cg.indexAll();
  } finally {
    cg.close();
  }
}

/** Seed recorded MCP sessions so the Agent-trace timeline (and the
 *  Live feed's backlog) render real rows in the fixture run. The
 *  primary session has a fast call, a symbol-bearing call (step
 *  detail → "On the graph" chip), a long gap (>10s → .long marker), and an
 *  error-tier result; a second, earlier session exists so the Live
 *  session filter has something to narrow away. */
function seedTraceFixture(projectPath: string): void {
  const conn = DatabaseConnection.open(getDatabasePath(projectPath));
  try {
    const qb = new QueryBuilder(conn.getDb());
    const base = Date.now() - 60_000;
    const earlierId = 'smoke-trace-session-b';
    insertSession({ qb, id: earlierId, startedTs: base - 30_000 });
    appendToolCall(qb, {
      sessionId: earlierId,
      step: 1,
      ts: base - 30_000,
      toolName: 'cartograph_status',
      argsJson: '{}',
      resultSummary: 'second session call',
      durationMs: 8,
    });
    const sessionId = 'smoke-trace-session';
    insertSession({
      qb,
      id: sessionId,
      startedTs: base,
      label: 'smoke',
      clientName: 'smoke-client',
      clientVersion: '1.0.0',
      projectRoot: projectPath,
    });
    appendToolCall(qb, {
      sessionId,
      step: 1,
      ts: base,
      toolName: 'cartograph_find',
      argsJson: JSON.stringify({ by: 'symbol', query: 'compute' }),
      resultSummary: '1 result',
      durationMs: 12,
    });
    appendToolCall(qb, {
      sessionId,
      step: 2,
      ts: base + 100,
      toolName: 'cartograph_graph',
      argsJson: JSON.stringify({ symbol: 'compute', direction: 'callers' }),
      resultSummary: '3 callers',
      durationMs: 230,
    });
    appendToolCall(qb, {
      sessionId,
      step: 3,
      ts: base + 15_100,
      toolName: 'cartograph_status',
      argsJson: '{}',
      resultSummary: '⚠ tool error: demo failure',
      durationMs: 5,
    });
    appendToolCall(qb, {
      sessionId,
      step: 4,
      ts: base + 15_200,
      toolName: 'cartograph_node',
      argsJson: JSON.stringify({ symbol: 'compute', projectPath: '/elsewhere/project' }),
      resultSummary: 'cross-project call',
      durationMs: 9,
    });
  } finally {
    conn.close();
  }
}

function consoleText(msg: unknown): string {
  if (typeof msg === 'object' && msg && 'text' in msg && typeof msg.text === 'function') {
    try {
      return String(msg.text());
    } catch {
      return String(msg);
    }
  }
  return String(msg);
}

async function assertCanvasHasPixels(page: Page): Promise<void> {
  const hasPixels = await page.waitForFunction(
    (sampleCount) => {
      const canvases = Array.from(document.querySelectorAll<HTMLCanvasElement>('#cy canvas'));
      return canvases.some((canvas) => {
        if (canvas.width <= 0 || canvas.height <= 0) return false;
        const ctx = canvas.getContext('2d');
        if (!ctx) return false;
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h).data;
        const pixelStride = Math.max(1, Math.floor((w * h) / Number(sampleCount)));
        for (let i = 0; i < data.length; i += pixelStride * 4) {
          if (data[i + 3] > 0 && (data[i] !== 0 || data[i + 1] !== 0 || data[i + 2] !== 0)) return true;
        }
        return false;
      });
    },
    CANVAS_PIXEL_SAMPLE_COUNT,
    { timeout: GRAPH_RENDER_TIMEOUT_MS },
  );
  if (!hasPixels) throw new Error('graph canvas stayed blank');
}

async function waitForGraph(page: Page): Promise<void> {
  await page.waitForSelector('#cy canvas', { state: 'visible', timeout: GRAPH_RENDER_TIMEOUT_MS });
  await page.waitForFunction(
    () =>
      document.querySelector('#canvas-counter')?.textContent?.includes('Showing') &&
      Boolean((document.querySelector('#graph-state') as HTMLElement | null)?.hidden),
    undefined,
    {
      timeout: GRAPH_RENDER_TIMEOUT_MS,
    },
  );
  await assertCanvasHasPixels(page);
  await assertGraphReadyState(page);
  await assertGraphFitsViewport(page, 'graph ready');
  await assertVisibleEdgesConnect(page, 'graph ready');
}

async function assertCalmerDefaultUi(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const groups = Array.from(document.querySelectorAll<HTMLElement>('.leftrail > [data-rail-section]'));
      const advanced = document.querySelector<HTMLElement>('[data-rail-section="advanced"]');
      const popover = document.querySelector<HTMLElement>('#graph-tools-popover');
      return (
        document.body.dataset.viewerMode === 'simple' &&
        groups.length === 4 &&
        advanced?.hidden === true &&
        popover?.hidden === true
      );
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const state = await page.evaluate(() => ({
    advancedHidden: document.querySelector<HTMLElement>('[data-rail-section="advanced"]')?.hidden ?? false,
    groupCount: document.querySelectorAll('.leftrail > [data-rail-section]').length,
    mode: document.body.dataset.viewerMode || '',
    popoverHidden: document.querySelector<HTMLElement>('#graph-tools-popover')?.hidden ?? false,
    toolsVisible: Boolean(document.querySelector('#btn-graph-tools')),
  }));
  if (
    state.mode !== 'simple' ||
    state.groupCount !== 4 ||
    !state.advancedHidden ||
    !state.popoverHidden ||
    !state.toolsVisible
  ) {
    throw new Error(`default viewer UI was not simplified: ${JSON.stringify(state)}`);
  }
}

async function setViewerUiModeForSmoke(page: Page, mode: 'simple' | 'advanced'): Promise<void> {
  await page.evaluate((nextMode) => {
    const global = globalThis as ViewerSmokeGlobal;
    if (typeof global.setViewerUiMode !== 'function') throw new Error('setViewerUiMode was unavailable');
    global.setViewerUiMode(nextMode, { openAdvanced: nextMode === 'advanced' });
    if (nextMode === 'simple') global.toggleGraphToolsPopover?.(false);
  }, mode);
  await page.waitForFunction((expected) => document.body.dataset.viewerMode === expected, mode, {
    timeout: SEARCH_TIMEOUT_MS,
  });
}

async function openViewerRailSectionForSmoke(page: Page, id: string): Promise<void> {
  await page.evaluate((sectionId) => {
    const global = globalThis as ViewerSmokeGlobal;
    if (typeof global.openViewerRailSection !== 'function') throw new Error('openViewerRailSection was unavailable');
    global.openViewerRailSection(String(sectionId));
  }, id);
  await page.waitForFunction(
    (sectionId) => {
      const section = document.querySelector<HTMLElement>(`[data-rail-section="${String(sectionId)}"]`);
      return Boolean(section && !section.hidden && !section.classList.contains('collapsed'));
    },
    id,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function openGraphToolsForSmoke(page: Page): Promise<void> {
  await page.evaluate(() => {
    const global = globalThis as ViewerSmokeGlobal;
    if (typeof global.toggleGraphToolsPopover !== 'function')
      throw new Error('toggleGraphToolsPopover was unavailable');
    global.toggleGraphToolsPopover(true);
  });
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#graph-tools-popover')?.hidden === false,
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function exposeAdvancedViewerControls(page: Page): Promise<void> {
  await setViewerUiModeForSmoke(page, 'advanced');
  await openViewerRailSectionForSmoke(page, 'view');
  await openViewerRailSectionForSmoke(page, 'filters');
  await openViewerRailSectionForSmoke(page, 'saved');
  await openViewerRailSectionForSmoke(page, 'advanced');
  await openGraphToolsForSmoke(page);
}

async function setSimpleViewerChrome(page: Page): Promise<void> {
  await setViewerUiModeForSmoke(page, 'simple');
  await openViewerRailSectionForSmoke(page, 'view');
}

async function assertGraphReadyState(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const graphState = document.querySelector<HTMLElement>('#graph-state');
    return {
      graphStateHidden: graphState?.hidden ?? false,
      graphStateText: graphState?.textContent || '',
      counter: document.querySelector('#canvas-counter')?.textContent || '',
    };
  });
  if (!state.graphStateHidden) throw new Error(`graph state overlay remained visible: ${state.graphStateText}`);
  if (!state.counter.includes('Showing'))
    throw new Error(`graph counter did not render a showing state: ${state.counter}`);
}

async function graphFitState(page: Page, label: string): Promise<GraphFitState> {
  return page.evaluate(
    ({ label: fitLabel, tolerance }) => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const cy = hook?.cy as unknown as GraphFitCy | undefined;
      const emptyState = {
        canvas: { width: 0, height: 0 },
        label: String(fitLabel),
        minZoom: 0,
        offscreenCount: 0,
        offscreenSample: [],
        pan: { x: 0, y: 0 },
        renderedBox: null,
        visibleNodeCount: 0,
        zoom: 0,
      };
      if (!cy) return emptyState;
      const visibleNodes = cy
        .nodes()
        .filter((node) => node.style('display') !== 'none' && !node.hasClass('collapse-hidden'));
      const width = cy.width();
      const height = cy.height();
      const renderedBox =
        visibleNodes.length > 0
          ? visibleNodes.renderedBoundingBox({ includeLabels: false, includeOverlays: false })
          : null;
      const offscreen = visibleNodes.filter((node) => {
        const p = node.renderedPosition();
        if (p.x < -tolerance) return true;
        if (p.y < -tolerance) return true;
        if (p.x > width + tolerance) return true;
        if (p.y > height + tolerance) return true;
        return false;
      });
      return {
        canvas: { width, height },
        label: String(fitLabel),
        minZoom: cy.minZoom(),
        offscreenCount: offscreen.length,
        offscreenSample: offscreen
          .map((node) => ({ id: node.id(), label: node.data('label'), rendered: node.renderedPosition() }))
          .slice(0, 8),
        pan: cy.pan(),
        renderedBox,
        visibleNodeCount: visibleNodes.length,
        zoom: cy.zoom(),
      };
    },
    { label, tolerance: GRAPH_FIT_TOLERANCE_PX },
  );
}

async function assertGraphFitsViewport(page: Page, label: string): Promise<void> {
  const ok = await page
    .waitForFunction(
      ({ tolerance }) => {
        const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
        const cy = hook?.cy as unknown as GraphFitCy | undefined;
        if (!cy) return false;
        const visibleNodes = cy
          .nodes()
          .filter((node) => node.style('display') !== 'none' && !node.hasClass('collapse-hidden'));
        if (visibleNodes.length === 0) return false;
        const width = cy.width();
        const height = cy.height();
        const box = visibleNodes.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
        if (box.x1 < -tolerance) return false;
        if (box.y1 < -tolerance) return false;
        if (box.x2 > width + tolerance) return false;
        if (box.y2 > height + tolerance) return false;
        return (
          visibleNodes.filter((node) => {
            const p = node.renderedPosition();
            if (p.x < -tolerance) return true;
            if (p.y < -tolerance) return true;
            if (p.x > width + tolerance) return true;
            if (p.y > height + tolerance) return true;
            return false;
          }).length === 0
        );
      },
      { tolerance: GRAPH_FIT_TOLERANCE_PX },
      { timeout: SEARCH_TIMEOUT_MS },
    )
    .then(() => true)
    .catch(() => false);
  if (ok) return;
  throw new Error(
    `graph nodes did not fit viewport after ${label}: ${JSON.stringify(await graphFitState(page, label))}`,
  );
}

async function edgeVisibilityState(page: Page): Promise<EdgeVisibilityState> {
  return page.evaluate(
    ({ sampleLimit }) => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const cy = hook?.cy as unknown as GraphEdgeGeometryCy | undefined;
      const emptyState: EdgeVisibilityState = {
        hiddenEndpointCount: 0,
        hiddenEndpointSample: [],
        visibleEdgeCount: 0,
      };
      if (!cy) return emptyState;
      const visibleNode = (node: GraphFitNodeProbe) =>
        node.style('display') !== 'none' && !node.hasClass('collapse-hidden');
      const visibleEdges = cy.edges().filter((edge) => edge.style('display') !== 'none');
      const hiddenEndpointSample: EdgeGeometryState['hiddenEndpointSample'] = [];
      let hiddenEndpointCount = 0;
      visibleEdges.forEach((edge) => {
        const source = edge.source();
        const target = edge.target();
        const sourceVisible = visibleNode(source);
        const targetVisible = visibleNode(target);
        if (!sourceVisible || !targetVisible) {
          hiddenEndpointCount++;
          if (hiddenEndpointSample.length < sampleLimit) {
            hiddenEndpointSample.push({
              id: edge.id(),
              kind: edge.data('kind'),
              source: source.id(),
              sourceVisible,
              target: target.id(),
              targetVisible,
            });
          }
        }
      });
      return { hiddenEndpointCount, hiddenEndpointSample, visibleEdgeCount: visibleEdges.length };
    },
    { sampleLimit: EDGE_GEOMETRY_SAMPLE_LIMIT },
  );
}

async function edgeBoxState(page: Page): Promise<EdgeBoxState> {
  return page.evaluate(
    ({ minBoxSpan, sampleLimit }) => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const cy = hook?.cy as unknown as GraphEdgeGeometryCy | undefined;
      if (!cy) return { badBoxCount: 0, badBoxSample: [] };
      const visibleEdges = cy.edges().filter((edge) => edge.style('display') !== 'none');
      const badBoxSample: EdgeGeometryState['badBoxSample'] = [];
      let badBoxCount = 0;
      visibleEdges.forEach((edge) => {
        const source = edge.source();
        const target = edge.target();
        const syntheticAggregateEdge = edge.data('collapsedEdge') || edge.data('detailBucketEdge');
        if (source.id() !== target.id() && !syntheticAggregateEdge) {
          const box = edge.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
          const badBox =
            !box ||
            !Number.isFinite(box.x1) ||
            !Number.isFinite(box.y1) ||
            (Math.abs(box.x2 - box.x1) < minBoxSpan && Math.abs(box.y2 - box.y1) < minBoxSpan);
          if (badBox) {
            badBoxCount++;
            if (badBoxSample.length < sampleLimit) {
              badBoxSample.push({ id: edge.id(), kind: edge.data('kind'), box });
            }
          }
        }
      });
      return { badBoxCount, badBoxSample };
    },
    { minBoxSpan: MIN_EDGE_BOX_SPAN_PX, sampleLimit: EDGE_GEOMETRY_SAMPLE_LIMIT },
  );
}

async function edgeShortEndpointState(page: Page): Promise<EdgeShortEndpointState> {
  return page.evaluate(
    ({ minEndpointDistance, sampleLimit }) => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const cy = hook?.cy as unknown as GraphEdgeGeometryCy | undefined;
      if (!cy) return { shortEndpointCount: 0, shortEndpointSample: [] };
      const visibleEdges = cy.edges().filter((edge) => edge.style('display') !== 'none');
      const shortEndpointSample: EdgeGeometryState['shortEndpointSample'] = [];
      let shortEndpointCount = 0;
      visibleEdges.forEach((edge) => {
        const source = edge.source();
        const target = edge.target();
        if (source.id() === target.id()) return;
        const renderedSource = edge.renderedSourceEndpoint?.();
        const renderedTarget = edge.renderedTargetEndpoint?.();
        if (!renderedSource || !renderedTarget) return;
        if (
          !Number.isFinite(renderedSource.x) ||
          !Number.isFinite(renderedSource.y) ||
          !Number.isFinite(renderedTarget.x) ||
          !Number.isFinite(renderedTarget.y)
        ) {
          return;
        }
        const endpointDistance = Math.hypot(renderedSource.x - renderedTarget.x, renderedSource.y - renderedTarget.y);
        if (endpointDistance >= minEndpointDistance) return;
        shortEndpointCount++;
        if (shortEndpointSample.length < sampleLimit) {
          shortEndpointSample.push({
            id: edge.id(),
            kind: edge.data('kind'),
            source: source.id(),
            target: target.id(),
            endpointDistance,
          });
        }
      });
      return { shortEndpointCount, shortEndpointSample };
    },
    { minEndpointDistance: MIN_EDGE_ENDPOINT_DISTANCE_PX, sampleLimit: EDGE_GEOMETRY_SAMPLE_LIMIT },
  );
}

async function edgeGeometryState(page: Page, label: string): Promise<EdgeGeometryState> {
  const [visibility, box, shortEndpoint] = await Promise.all([
    edgeVisibilityState(page),
    edgeBoxState(page),
    edgeShortEndpointState(page),
  ]);
  return { label, ...visibility, ...box, ...shortEndpoint };
}

async function assertVisibleEdgesConnect(page: Page, label: string, requireEdges = true): Promise<void> {
  const state = await edgeGeometryState(page, label);
  if (state.visibleEdgeCount <= 0 && requireEdges) throw new Error(`graph had no visible edges after ${label}`);
  if (state.visibleEdgeCount <= 0) return;
  if (state.hiddenEndpointCount > 0 || state.badBoxCount > 0 || state.shortEndpointCount > 0) {
    throw new Error(`visible graph edges looked disconnected after ${label}: ${JSON.stringify(state)}`);
  }
}

async function graphLayoutSample(page: Page): Promise<GraphLayoutSample> {
  return page.evaluate((limit) => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    const cy = hook?.cy as unknown as GraphFitCy | undefined;
    if (!cy) return [];
    return cy
      .nodes()
      .filter((node) => !node.data('isGroup') && node.style('display') !== 'none' && !node.hasClass('collapse-hidden'))
      .map((node) => {
        const p = node.position();
        return { id: node.id(), label: node.data('label'), x: p.x, y: p.y };
      })
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, Number(limit));
  }, LAYOUT_STABILITY_NODE_LIMIT);
}

async function graphLayoutShapeState(page: Page, label: string): Promise<GraphLayoutShapeState> {
  return page.evaluate((inputLabel) => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    const diagnostics = hook?.diagnostics?.(String(inputLabel));
    if (diagnostics) {
      return {
        diagonalSpread: diagnostics.diagonalSpread,
        label: diagnostics.label,
        narrowestLineSpread: diagnostics.narrowestLineSpread,
        renderedHeight: diagnostics.renderedHeight,
        renderedWidth: diagnostics.renderedWidth,
        sample: diagnostics.sample,
        visibleNodeCount: diagnostics.visibleNodeCount,
      };
    }
    const cy = hook?.cy as unknown as GraphFitCy | undefined;
    const nodes = cy
      ?.nodes()
      .filter((node) => !node.data('isGroup') && node.style('display') !== 'none' && !node.hasClass('collapse-hidden'));
    const positions =
      nodes?.map((node) => {
        const p = node.renderedPosition();
        return { id: node.id(), label: node.data('label'), x: p.x, y: p.y };
      }) ?? [];
    if (positions.length === 0) {
      return {
        diagonalSpread: 0,
        label: String(inputLabel),
        narrowestLineSpread: 0,
        renderedHeight: 0,
        renderedWidth: 0,
        sample: [],
        visibleNodeCount: 0,
      };
    }
    const xs = positions.map((pos) => pos.x);
    const ys = positions.map((pos) => pos.y);
    const diagonalResiduals = positions.map((pos) => pos.y - pos.x);
    const antiDiagonalResiduals = positions.map((pos) => pos.y + pos.x);
    const spread = (values: number[]) => Math.max(...values) - Math.min(...values);
    const diagonalSpread = spread(diagonalResiduals);
    const antiDiagonalSpread = spread(antiDiagonalResiduals);
    return {
      diagonalSpread,
      label: String(inputLabel),
      narrowestLineSpread: Math.min(diagonalSpread, antiDiagonalSpread),
      renderedHeight: spread(ys),
      renderedWidth: spread(xs),
      sample: positions.slice(0, 8),
      visibleNodeCount: positions.length,
    };
  }, label);
}

async function viewerDiagnostics(page: Page, label: string): Promise<ViewerDiagnostics> {
  const diagnostics = await page.evaluate((inputLabel) => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    return hook?.diagnostics?.(String(inputLabel)) ?? null;
  }, label);
  if (!diagnostics) throw new Error(`viewer diagnostics hook was unavailable after ${label}`);
  return diagnostics;
}

async function assertGraphLayoutNotLinear(page: Page, label: string): Promise<void> {
  const state = await graphLayoutShapeState(page, label);
  if (state.visibleNodeCount < LINEAR_LAYOUT_MIN_NODE_COUNT) return;
  const minSpan = Math.min(state.renderedWidth, state.renderedHeight);
  const lineThreshold = Math.max(LINEAR_LAYOUT_MIN_SPREAD_PX, minSpan * LINEAR_LAYOUT_SPREAD_RATIO);
  if (
    state.renderedWidth < LINEAR_LAYOUT_MIN_SPAN_PX ||
    state.renderedHeight < LINEAR_LAYOUT_MIN_SPAN_PX ||
    state.narrowestLineSpread < lineThreshold
  ) {
    throw new Error(`graph layout collapsed into a line after ${label}: ${JSON.stringify(state)}`);
  }
}

async function assertDiagnosticSnapshot(
  page: Page,
  snapshot: { name: string; minEdges: number; minNodes: number },
): Promise<void> {
  await waitForGraph(page);
  await assertGraphLayoutNotLinear(page, snapshot.name);
  await assertVisibleEdgesConnect(page, snapshot.name);
  const diagnostics = await viewerDiagnostics(page, snapshot.name);
  if (diagnostics.visibleNodeCount < snapshot.minNodes || diagnostics.visibleEdgeCount < snapshot.minEdges) {
    throw new Error(`viewer diagnostic snapshot was too small: ${JSON.stringify({ snapshot, diagnostics })}`);
  }
  if (diagnostics.disconnectedVisibleEdgeCount > 0) {
    throw new Error(`viewer diagnostic snapshot had disconnected edges: ${JSON.stringify({ snapshot, diagnostics })}`);
  }
  if (diagnostics.nodeOverlapCount > 0) {
    throw new Error(`viewer diagnostic snapshot had overlapping nodes: ${JSON.stringify({ snapshot, diagnostics })}`);
  }
}

async function waitForLayoutStabilitySample(page: Page): Promise<GraphLayoutSample> {
  await page.evaluate(
    (settleMs) => new Promise((resolve) => setTimeout(resolve, Number(settleMs))),
    LAYOUT_STABILITY_SETTLE_MS,
  );
  return graphLayoutSample(page);
}

function centerGraphLayoutSample(sample: GraphLayoutSample): GraphLayoutSample {
  if (sample.length === 0) return sample;
  const center = sample.reduce((acc, node) => ({ x: acc.x + node.x, y: acc.y + node.y }), { x: 0, y: 0 });
  center.x /= sample.length;
  center.y /= sample.length;
  return sample.map((node) => ({ ...node, x: node.x - center.x, y: node.y - center.y }));
}

async function assertGraphLayoutStableAcrossReload(page: Page, url: string): Promise<void> {
  const before = centerGraphLayoutSample(await waitForLayoutStabilitySample(page));
  if (before.length === 0) throw new Error('graph layout stability check had no visible nodes before reload');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForGraph(page);
  const after = centerGraphLayoutSample(await waitForLayoutStabilitySample(page));
  const afterById = new Map(after.map((node) => [node.id, node]));
  const changed = before
    .map((node) => {
      const next = afterById.get(node.id);
      if (!next) return { id: node.id, label: node.label, missing: true };
      const dx = Math.abs(node.x - next.x);
      const dy = Math.abs(node.y - next.y);
      return { id: node.id, label: node.label, dx, dy };
    })
    .filter(
      (node) =>
        node.missing ||
        (node.dx ?? 0) > LAYOUT_STABILITY_TOLERANCE_PX ||
        (node.dy ?? 0) > LAYOUT_STABILITY_TOLERANCE_PX,
    );
  if (changed.length > 0) {
    throw new Error(`graph layout changed across reload: ${JSON.stringify(changed.slice(0, 8))}`);
  }
}

async function assertSyntheticForceLayoutDoesNotCollapse(page: Page, url: string): Promise<void> {
  await page.evaluate(
    (config) => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const cy = hook?.cy as unknown as {
        add: (elements: Array<Record<string, unknown>>) => unknown;
        elements: () => { remove: () => void };
      };
      cy.elements().remove();
      const nodes = Array.from({ length: config.nodeCount }, (_, index) => ({
        group: 'nodes',
        data: {
          id: `synthetic-layout-${index}`,
          label: `synthetic${index}`,
          kind:
            index % config.functionInterval === 0
              ? 'function'
              : index % config.methodInterval === 0
                ? 'method'
                : 'constant',
          health: 'healthy',
          file: 'src/synthetic-layout.ts',
          centrality: index === 0 ? config.focusCentrality : config.nodeCentrality,
        },
      }));
      const edges = Array.from({ length: nodes.length - 1 }, (_, index) => ({
        group: 'edges',
        data: {
          id: `synthetic-layout-edge-${index}`,
          source: index % config.starEdgeInterval === 0 ? 'synthetic-layout-0' : `synthetic-layout-${index}`,
          target: `synthetic-layout-${index + 1}`,
          kind: 'calls',
        },
      }));
      cy.add([...nodes, ...edges]);
      (globalThis as ViewerSmokeGlobal & { relayoutAndFit?: () => void }).relayoutAndFit?.();
    },
    {
      focusCentrality: SYNTHETIC_LAYOUT_FOCUS_CENTRALITY,
      functionInterval: SYNTHETIC_LAYOUT_FUNCTION_INTERVAL,
      methodInterval: SYNTHETIC_LAYOUT_METHOD_INTERVAL,
      nodeCentrality: SYNTHETIC_LAYOUT_NODE_CENTRALITY,
      nodeCount: SYNTHETIC_LAYOUT_NODE_COUNT,
      starEdgeInterval: SYNTHETIC_LAYOUT_STAR_EDGE_INTERVAL,
    },
  );
  await page.evaluate(
    (settleMs) => new Promise((resolve) => setTimeout(resolve, Number(settleMs))),
    LAYOUT_STABILITY_SETTLE_MS,
  );
  await assertGraphLayoutNotLinear(page, 'synthetic force layout');
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForGraph(page);
}

type GraphFixture = (typeof GRAPH_FIXTURE_MATRIX)[number];
type GraphFixtureElement = { group: 'nodes' | 'edges'; data: Record<string, unknown> };
type GraphFixtureNodeArgs = { file?: string; id: string; index: number; shape: string };
type GraphFixtureEdgeArgs = { index: number; kind?: string; shape: string; source: string; target: string };

function graphFixtureNodeKind(index: number): string {
  if (index % 7 === 0) return 'class';
  if (index % 3 === 0) return 'method';
  return 'function';
}

function graphFixtureNodeCentrality(index: number): number {
  return index === 0 ? 0.014 : 0.002 + (index % 9) * 0.00035;
}

function graphFixtureNode({ file, id, index, shape }: GraphFixtureNodeArgs): GraphFixtureElement {
  return {
    group: 'nodes',
    data: {
      id,
      label: id.replace(`${shape}-`, ''),
      kind: graphFixtureNodeKind(index),
      health: 'healthy',
      file: file || `src/${shape}.ts`,
      centrality: graphFixtureNodeCentrality(index),
    },
  };
}

function graphFixtureEdge({ index, kind = 'calls', shape, source, target }: GraphFixtureEdgeArgs): GraphFixtureElement {
  return {
    group: 'edges',
    data: {
      id: `${shape}-edge-${index}-${source}-${target}`,
      source,
      target,
      kind,
    },
  };
}

function customizeClusterNode(node: GraphFixtureElement, index: number, config: typeof DENSE_LAYOUT_CONFIG): void {
  if (index % config.classInterval === 0) node.data.kind = 'class';
  else if (index % config.methodInterval === 0) node.data.kind = 'method';
  node.data.centrality =
    index === 0
      ? config.focusCentrality
      : config.baseCentrality + (index % config.centralityBucketCount) * config.centralityStep;
}

function buildClusteredGraphFixture(config: typeof DENSE_LAYOUT_CONFIG): GraphFixtureElement[] {
  const nodes: GraphFixtureElement[] = [];
  const edges: GraphFixtureElement[] = [];
  for (let cluster = 0; cluster < config.clusterCount; cluster++) {
    for (let index = 0; index < config.clusterSize; index++) {
      const id = `dense-layout-${cluster}-${index}`;
      const node = graphFixtureNode({ file: `src/dense-${cluster}.ts`, id, index, shape: 'clusters' });
      customizeClusterNode(node, index, config);
      nodes.push(node);
    }
  }
  for (let cluster = 0; cluster < config.clusterCount; cluster++) {
    for (let index = 0; index < config.clusterSize; index++) {
      const source = `dense-layout-${cluster}-${index}`;
      for (let hop = 1; hop <= config.intraLinks; hop++) {
        const target = `dense-layout-${cluster}-${(index + hop) % config.clusterSize}`;
        edges.push(
          graphFixtureEdge({
            shape: 'clusters',
            source,
            target,
            index: hop,
            kind: hop === 1 ? 'calls' : hop === 2 ? 'references' : 'field_access',
          }),
        );
      }
      if (index % config.bridgeInterval === 0) {
        const nextCluster = (cluster + 1) % config.clusterCount;
        edges.push(
          graphFixtureEdge({
            shape: 'clusters',
            source,
            index,
            kind: 'imports',
            target: `dense-layout-${nextCluster}-${index % config.clusterSize}`,
          }),
        );
      }
    }
  }
  return [...nodes, ...edges];
}

function buildStarburstGraphFixture(config: { nodeCount: number; secondaryHop: number }): GraphFixtureElement[] {
  const elements = [graphFixtureNode({ id: 'starburst-hub', index: 0, shape: 'starburst' })];
  for (let index = 1; index < config.nodeCount; index++) {
    const id = `starburst-${index}`;
    elements.push(graphFixtureNode({ id, index, shape: 'starburst' }));
    elements.push(
      graphFixtureEdge({
        index,
        kind: index % 2 === 0 ? 'calls' : 'references',
        shape: 'starburst',
        source: 'starburst-hub',
        target: id,
      }),
    );
    if (index > config.secondaryHop) {
      elements.push(
        graphFixtureEdge({
          index,
          kind: 'field_access',
          shape: 'starburst',
          source: id,
          target: `starburst-${index - config.secondaryHop}`,
        }),
      );
    }
  }
  return elements;
}

function buildBranchedChainGraphFixture(config: {
  backboneCount: number;
  branchCount: number;
  branchInterval: number;
}): GraphFixtureElement[] {
  const elements: GraphFixtureElement[] = [];
  for (let index = 0; index < config.backboneCount; index++) {
    elements.push(graphFixtureNode({ id: `chain-${index}`, index, shape: 'branched-chain' }));
  }
  for (let index = 1; index < config.backboneCount; index++) {
    elements.push(
      graphFixtureEdge({
        index,
        shape: 'branched-chain',
        source: `chain-${index - 1}`,
        target: `chain-${index}`,
      }),
    );
  }
  for (let index = 0; index < config.branchCount; index++) {
    const branchId = `chain-branch-${index}`;
    const parent = `chain-${(index * config.branchInterval) % config.backboneCount}`;
    elements.push(graphFixtureNode({ id: branchId, index: config.backboneCount + index, shape: 'branched-chain' }));
    elements.push(
      graphFixtureEdge({
        index,
        kind: index % 2 === 0 ? 'references' : 'imports',
        shape: 'branched-chain',
        source: parent,
        target: branchId,
      }),
    );
  }
  return elements;
}

function buildMeshGraphFixture(config: { hopCount: number; nodeCount: number }): GraphFixtureElement[] {
  const elements: GraphFixtureElement[] = [];
  for (let index = 0; index < config.nodeCount; index++)
    elements.push(graphFixtureNode({ id: `mesh-${index}`, index, shape: 'mesh' }));
  for (let index = 0; index < config.nodeCount; index++) {
    for (let hop = 1; hop <= config.hopCount; hop++) {
      elements.push(
        graphFixtureEdge({
          index: hop,
          kind: hop % 2 === 0 ? 'references' : 'calls',
          shape: 'mesh',
          source: `mesh-${index}`,
          target: `mesh-${(index + hop) % config.nodeCount}`,
        }),
      );
    }
  }
  return elements;
}

function buildGraphFixtureElements(fixture: GraphFixture): GraphFixtureElement[] {
  if (fixture.shape === 'clusters') return buildClusteredGraphFixture(fixture.config);
  if (fixture.shape === 'starburst') return buildStarburstGraphFixture(fixture.config);
  if (fixture.shape === 'branched-chain') return buildBranchedChainGraphFixture(fixture.config);
  return buildMeshGraphFixture(fixture.config);
}

async function injectGraphFixture(page: Page, fixture: GraphFixture): Promise<void> {
  const elements = buildGraphFixtureElements(fixture);
  const nodeCount = elements.filter((element) => element.group === 'nodes').length;
  const edgeCount = elements.length - nodeCount;
  await page.evaluate(
    ({ edgeCount, elements, fixtureName, nodeCount }) => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const cy = hook?.cy as unknown as {
        add: (elements: Array<Record<string, unknown>>) => unknown;
        elements: () => { remove: () => void };
      };
      const controls = globalThis as ViewerSmokeGlobal & {
        applyFilters?: () => void;
        relayoutAndFit?: () => void;
        setBaseCounter?: (html: string) => void;
        setGraphLayoutQuality?: (mode: string, opts?: Record<string, unknown>) => void;
        syncEdgeKindFilters?: () => void;
      };
      hook?.clearEdgeInspection?.();
      cy.elements().remove();
      cy.add(elements);
      controls.setBaseCounter?.(`${fixtureName} · ${nodeCount} nodes · ${edgeCount} edges`);
      controls.setGraphLayoutQuality?.('spread', { relayout: false });
      controls.syncEdgeKindFilters?.();
      controls.applyFilters?.();
      controls.relayoutAndFit?.();
    },
    { edgeCount, elements, fixtureName: fixture.name, nodeCount },
  );
}

async function assertDenseGraphFixtureSpreads(page: Page, url: string): Promise<void> {
  for (const fixture of GRAPH_FIXTURE_MATRIX) {
    await injectGraphFixture(page, fixture);
    await page.evaluate(
      (settleMs) => new Promise((resolve) => setTimeout(resolve, Number(settleMs))),
      LAYOUT_STABILITY_SETTLE_MS,
    );
    await assertGraphLayoutNotLinear(page, fixture.name);
    await assertVisibleEdgesConnect(page, fixture.name);
    const diagnostics = await viewerDiagnostics(page, fixture.name);
    if (diagnostics.visibleNodeCount < fixture.minNodes || diagnostics.visibleEdgeCount < fixture.minEdges) {
      throw new Error(`${fixture.name} rendered too little graph: ${JSON.stringify(diagnostics)}`);
    }
    if (diagnostics.nodeOverlapCount > fixture.maxOverlaps || diagnostics.invariantErrorCount > 0) {
      throw new Error(`${fixture.name} layout failed diagnostics: ${JSON.stringify(diagnostics)}`);
    }
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForGraph(page);
}

async function pinnedLayoutPositionCount(page: Page): Promise<number> {
  return page.evaluate((key) => {
    const storageKey = (
      globalThis as typeof globalThis & { viewerProjectStorageKey?: (baseKey: string) => string }
    ).viewerProjectStorageKey?.(String(key));
    const raw = localStorage.getItem(storageKey || String(key));
    if (!raw) return 0;
    try {
      const store = JSON.parse(raw) as Record<string, { positions?: Record<string, unknown> }>;
      return Object.values(store).reduce((sum, entry) => sum + Object.keys(entry.positions || {}).length, 0);
    } catch {
      return 0;
    }
  }, PINNED_LAYOUTS_KEY);
}

async function assertPinnedLayoutControls(page: Page, url: string): Promise<void> {
  await exposeAdvancedViewerControls(page);
  await page.waitForSelector('#btn-layout-pin', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await page.waitForSelector('#btn-layout-unlock', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await page.waitForSelector('#btn-layout-reset', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });

  await page.locator('#btn-layout-pin').click();
  const pinnedAfterPin = await pinnedLayoutPositionCount(page);
  if (pinnedAfterPin <= 0) throw new Error('pin layout control did not persist node positions');

  await page.locator('#btn-layout-unlock').click();
  const pinnedAfterUnlock = await pinnedLayoutPositionCount(page);
  if (pinnedAfterUnlock !== 0) throw new Error(`unlock layout control left ${pinnedAfterUnlock} pinned positions`);

  await page.locator('#btn-layout-pin').click();
  const pinnedBeforeReload = await pinnedLayoutPositionCount(page);
  if (pinnedBeforeReload <= 0) throw new Error('pin layout control did not persist before reload');

  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForGraph(page);
  await exposeAdvancedViewerControls(page);
  const persistedAfterReload = await pinnedLayoutPositionCount(page);
  if (persistedAfterReload <= 0) throw new Error('pinned layout positions did not persist across reload');

  await page.locator('#btn-layout-reset').click();
  const pinnedAfterReset = await pinnedLayoutPositionCount(page);
  if (pinnedAfterReset !== 0) throw new Error(`reset layout control left ${pinnedAfterReset} pinned positions`);
}

async function assertZoomControls(page: Page): Promise<void> {
  const before = await page.evaluate(() => (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.cy.zoom() ?? 0);
  await page.locator('#btn-zoom-in').click();
  await page.waitForFunction(
    (initial) => ((globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.cy.zoom() ?? 0) > Number(initial),
    before,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const afterIn = await page.evaluate(() => (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.cy.zoom() ?? 0);
  await page.locator('#btn-zoom-out').click();
  await page.waitForFunction(
    (zoomed) => ((globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.cy.zoom() ?? 0) < Number(zoomed),
    afterIn,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('#btn-zoom-fit').click();
  await waitForGraph(page);
}

async function assertDensityControls(page: Page): Promise<void> {
  const modes = ['focus', 'all', 'core'];
  for (let i = 0; i < modes.length; i++) {
    const mode = modes[i]!;
    await page.locator(`[data-density-mode="${mode}"]`).click();
    await page.waitForFunction(
      (expected) =>
        document.querySelector<HTMLElement>(`[data-density-mode="${expected}"]`)?.dataset.active === '1' &&
        location.hash.includes(`density=${expected}`),
      mode,
      { timeout: SEARCH_TIMEOUT_MS },
    );
    await waitForGraph(page);
  }
}

async function assertLayoutQualityAndDiagnostics(page: Page): Promise<void> {
  await page.waitForSelector('#layout-quality-control', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await page.locator('[data-layout-quality="spread"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('[data-layout-quality="spread"]')?.dataset.active === '1' &&
      location.hash.includes('layout=spread'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await waitForGraph(page);
  const spreadDiagnostics = await viewerDiagnostics(page, 'layout quality spread');
  if (spreadDiagnostics.layoutQualityMode !== 'spread' || spreadDiagnostics.lastLayoutDurationMs <= 0) {
    throw new Error(`spread layout diagnostics did not update: ${JSON.stringify(spreadDiagnostics)}`);
  }

  await page.locator('#btn-graph-diagnostics').click();
  await page.waitForFunction(
    () => {
      const panel = document.querySelector<HTMLElement>('#graph-diagnostics');
      const text = panel?.textContent || '';
      return Boolean(panel && !panel.hidden && text.includes('Visible nodes') && text.includes('Overlaps'));
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const diagnosticsText = await page.evaluate(() => document.querySelector('#graph-diagnostics')?.textContent || '');
  if (!diagnosticsText.includes('Layout') || !diagnosticsText.includes('Last layout')) {
    throw new Error(`diagnostics panel was missing layout rows: ${diagnosticsText}`);
  }

  await page.locator('[data-layout-quality="balanced"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('[data-layout-quality="balanced"]')?.dataset.active === '1' &&
      location.hash.includes('layout=balanced'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await waitForGraph(page);
}

async function assertEdgeLensControl(page: Page): Promise<void> {
  await focusSymbolViaSearch(page, 'compute');
  await page.waitForSelector('#edge-lens-control', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await page.locator('[data-edge-lens="selected"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('[data-edge-lens="selected"]')?.dataset.active === '1' &&
      location.hash.includes('edgeLens=selected'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const selectedState = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    const current = hook?.selectionState().currentSymbolId;
    const bad: Array<{ id: string; source: string; target: string }> = [];
    let visible = 0;
    hook?.cy.edges().forEach((edge) => {
      if (edge.style('display') === 'none') return;
      visible++;
      const source = String(edge.source().id());
      const target = String(edge.target().id());
      if (current && source !== current && target !== current) bad.push({ id: edge.id(), source, target });
    });
    return { bad, current, visible };
  });
  if (!selectedState.current || selectedState.visible <= 0 || selectedState.bad.length > 0) {
    throw new Error(`selected edge lens leaked unrelated edges: ${JSON.stringify(selectedState)}`);
  }
  await page.locator('[data-edge-lens="all"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('[data-edge-lens="all"]')?.dataset.active === '1' &&
      location.hash.includes('edgeLens=all'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function assertSearchDisambiguation(page: Page): Promise<void> {
  await page.locator('#search-input').fill('add');
  await page.waitForSelector('.search-suggest-row', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const state = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll<HTMLElement>('.search-suggest-row')).map((row) => ({
      exact: Boolean(row.querySelector('.search-suggest-exact')),
      file: row.querySelector('.search-suggest-file')?.textContent || '',
      kind: row.querySelector('.search-suggest-kind')?.textContent || '',
      marked: Boolean(row.querySelector('mark')),
      name: row.querySelector('.search-suggest-name')?.textContent || '',
      score: row.querySelector('.search-suggest-score')?.textContent || '',
    }));
    return { rows };
  });
  if (state.rows.length === 0 || !state.rows[0]?.name.includes('add') || !state.rows[0]?.file.includes('src/')) {
    throw new Error(`search disambiguation rows were not useful: ${JSON.stringify(state)}`);
  }
  if (!state.rows[0]?.kind || !state.rows[0]?.marked) {
    throw new Error(`search disambiguation did not show kind/highlight metadata: ${JSON.stringify(state)}`);
  }
  await page.keyboard.press('Escape');
}

async function assertEdgeKindFilters(page: Page): Promise<void> {
  await page.waitForSelector('[data-filter-edge]', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const failure = await page.evaluate(async () => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) return 'viewer smoke hook missing';
    const input = Array.from(document.querySelectorAll<HTMLInputElement>('[data-filter-edge]')).find(
      (candidate) => candidate.checked,
    );
    if (!input) return 'no checked edge-kind filter';
    const kind = input.dataset.filterEdge || '';
    const visibleEdgeCount = (): number => {
      let count = 0;
      hook.cy.edges().forEach((edge) => {
        if (edge.data('kind') === kind && edge.style('display') !== 'none') count++;
      });
      return count;
    };
    const before = visibleEdgeCount();
    if (before <= 0) return `selected edge kind ${kind} had no visible edges before toggling`;
    input.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const afterOff = visibleEdgeCount();
    input.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    const afterOn = visibleEdgeCount();
    if (afterOff !== 0) return `edge filter ${kind} left ${afterOff} visible edges`;
    if (afterOn <= 0) return `edge filter ${kind} did not restore visible edges`;
    return '';
  });
  if (failure) throw new Error(`edge kind filters failed: ${failure}`);

  await page.locator('#btn-edge-none').click();
  await page.waitForFunction(
    () => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      let visible = 0;
      hook?.cy.edges().forEach((edge) => {
        if (edge.style('display') !== 'none') visible++;
      });
      return visible === 0;
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('#btn-edge-all').click();
  await page.waitForFunction(
    () => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      let visible = 0;
      hook?.cy.edges().forEach((edge) => {
        if (edge.style('display') !== 'none') visible++;
      });
      return visible > 0;
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertGraphFitsViewport(page, 'edge filters restored');
  await assertVisibleEdgesConnect(page, 'edge filters restored');
}

async function assertGraphExports(page: Page): Promise<void> {
  const exported = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) return null;
    return {
      json: hook.graphJsonPayload(),
      pngPrefix: hook.graphPngDataUrl().slice(0, 22),
      svgPrefix: hook.graphSvgText().slice(0, 80),
    };
  });
  if (!exported) throw new Error('viewer smoke hook missing');
  if (!Array.isArray(exported.json.nodes) || exported.json.nodes.length === 0) {
    throw new Error(`graph JSON export had no nodes: ${JSON.stringify(exported.json)}`);
  }
  if (!Array.isArray(exported.json.edges)) throw new Error('graph JSON export had no edge array');
  if (!exported.pngPrefix.startsWith('data:image/png;base64,')) {
    throw new Error(`graph PNG export returned unexpected data URL: ${exported.pngPrefix}`);
  }
  if (!exported.svgPrefix.startsWith('<svg')) {
    throw new Error(`graph SVG export returned unexpected markup: ${exported.svgPrefix}`);
  }
}

async function assertEdgeInspector(page: Page): Promise<void> {
  await page.waitForSelector('#edge-inspector', { state: 'attached', timeout: SEARCH_TIMEOUT_MS });
  const edgeState = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) {
      return { inspector: '', detailName: '', detailLoc: '', subpanel: '', askTarget: '', actionsDisabled: false };
    }
    const edge = hook.cy.edges().filter((e) => e.style('display') !== 'none')[0];
    if (!edge) {
      return { inspector: '', detailName: '', detailLoc: '', subpanel: '', askTarget: '', actionsDisabled: false };
    }
    hook.selectEdge(edge.id());
    const disabledActions = ['btn-open-editor', 'btn-copy-link', 'btn-copy-mcp', 'editor-picker'];
    return {
      inspector: document.querySelector('#edge-inspector')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      detailName: document.querySelector('#d-name')?.textContent || '',
      detailLoc: document.querySelector('#d-loc')?.textContent || '',
      subpanel: document.querySelector('#subpanel')?.textContent?.replace(/\s+/g, ' ').trim() || '',
      askTarget: document.querySelector('#ask-target')?.textContent || '',
      actionsDisabled: disabledActions.every(
        (id) => (document.getElementById(id) as HTMLButtonElement | HTMLSelectElement | null)?.disabled,
      ),
    };
  });
  if (!edgeState.inspector.includes('selected') || !edgeState.inspector.includes('→')) {
    throw new Error(`edge inspector did not render source/target/kind text: ${edgeState.inspector}`);
  }
  if (
    !edgeState.detailName.includes('→') ||
    !edgeState.detailLoc.includes('edge') ||
    !edgeState.subpanel.includes('Source:')
  ) {
    throw new Error(`edge detail pane did not render source/target/kind text: ${JSON.stringify(edgeState)}`);
  }
  if (edgeState.askTarget !== 'this edge' || !edgeState.actionsDisabled) {
    throw new Error(`edge detail pane action state was wrong: ${JSON.stringify(edgeState)}`);
  }
  await page.evaluate(() => (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.clearEdgeInspection());
}

async function assertGroupCollapse(page: Page): Promise<void> {
  await page.waitForSelector('#btn-collapse-groups', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await page.waitForSelector('#btn-expand-groups', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const result = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) return { ok: false, reason: 'viewer smoke hook missing' };
    const group = hook.cy.nodes().filter((n) => Boolean(n.data('isGroup')) && n.style('display') !== 'none')[0];
    if (!group) return { ok: false, reason: 'no visible group node' };
    const id = group.id();
    const visibleChild = (child: { hasClass: (name: string) => boolean; style: (name: string) => string }): boolean =>
      child.style('display') !== 'none' && !child.hasClass('collapse-hidden');
    const before = group.children().filter(visibleChild).length;
    hook.toggleGroupCollapse(id, true);
    const collapsed = hook.cy.getElementById(id);
    const proxy = hook.cy.nodes().filter((n) => Boolean(n.data('collapsedProxy')) && n.data('sourceGroup') === id)[0];
    const afterCollapse = collapsed.children().filter(visibleChild).length;
    const collapsedHash = location.hash.includes('collapsedGroups=');
    const collapsedVisible = Boolean(proxy && proxy.style('display') !== 'none');
    const collapsedClass = collapsed.hasClass('collapsed');
    hook.toggleGroupCollapse(id, false);
    const expanded = hook.cy.getElementById(id);
    const afterExpand = expanded.children().filter(visibleChild).length;
    return {
      ok: before > 0 && afterCollapse === 0 && afterExpand > 0 && collapsedHash && collapsedVisible && collapsedClass,
      before,
      afterCollapse,
      afterExpand,
      collapsedHash,
      collapsedVisible,
      collapsedClass,
    };
  });
  if (!result.ok) throw new Error(`group collapse/expand failed: ${JSON.stringify(result)}`);

  await page.locator('#btn-collapse-groups').click();
  await page.waitForFunction(
    () => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      return (
        (hook?.cy.nodes().filter((n) => Boolean(n.data('collapsedProxy')) && n.style('display') !== 'none').length ??
          0) > 0
      );
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertVisibleEdgesConnect(page, 'collapse groups', false);
  const collapsedAll = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    return {
      proxyCount:
        hook?.cy.nodes().filter((n) => Boolean(n.data('collapsedProxy')) && n.style('display') !== 'none').length ?? 0,
      hash: location.hash,
      note: document.querySelector('#group-note')?.textContent || '',
    };
  });
  if (
    collapsedAll.proxyCount <= 0 ||
    !collapsedAll.hash.includes('collapsedGroups=') ||
    !collapsedAll.note.includes('collapsed')
  ) {
    throw new Error(`collapse-all control did not collapse visible groups: ${JSON.stringify(collapsedAll)}`);
  }

  await page.locator('#btn-expand-groups').click();
  await page.waitForFunction(
    () => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      return (
        (hook?.cy.nodes().filter((n) => Boolean(n.data('collapsedProxy')) && n.style('display') !== 'none').length ??
          0) === 0 && !location.hash.includes('collapsedGroups=')
      );
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertGraphFitsViewport(page, 'reset view');
}

async function assertKindFilters(page: Page): Promise<void> {
  await page.waitForSelector('.kind-chip', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const failures = await page.evaluate(async () => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) return ['viewer smoke hook missing'];
    const visibleKindCounts = (): Record<string, number> => {
      const counts: Record<string, number> = {};
      hook.cy.nodes().forEach((node) => {
        if (node.data('isGroup') || node.data('collapsedProxy') || node.data('detailBucket')) return;
        if (node.style('display') === 'none') return;
        const kind = String(node.data('kind') || 'unknown');
        counts[kind] = (counts[kind] || 0) + 1;
      });
      return counts;
    };
    const waitFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const out: string[] = [];
    for (const chip of Array.from(document.querySelectorAll<HTMLElement>('#kind-chips .kind-chip'))) {
      const label = chip.textContent?.replace(/\s+/g, ' ').trim() || chip.dataset.filterKinds || 'kind chip';
      const kinds = String(chip.dataset.filterKinds || '')
        .split(',')
        .map((kind) => kind.trim())
        .filter(Boolean);
      const available = chip.dataset.available !== '0';
      const activeBefore = chip.dataset.active;
      chip.click();
      await waitFrame();
      const counts = visibleKindCounts();
      const activeAfter = chip.dataset.active;
      if (!available) {
        if (activeAfter !== activeBefore) out.push(`${label} changed state despite having no current graph nodes`);
        continue;
      }
      if (activeAfter !== '0') out.push(`${label} did not toggle off`);
      const stillVisible = kinds.filter((kind) => (counts[kind] || 0) > 0);
      if (stillVisible.length > 0) out.push(`${label} left visible kinds: ${stillVisible.join(', ')}`);
      chip.click();
      await waitFrame();
      if (chip.dataset.active !== activeBefore) out.push(`${label} did not restore its active state`);
    }
    return out;
  });
  if (failures.length > 0) throw new Error(`kind filters failed:\n${failures.join('\n')}`);
}

async function assertHealthFilters(page: Page): Promise<void> {
  await page.waitForSelector('[data-health-count]', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const failures = await page.evaluate(async () => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) return ['viewer smoke hook missing'];
    const contentNodes = (): NodeProbe[] => {
      const rows: NodeProbe[] = [];
      hook.cy.nodes().forEach((node) => {
        if (node.data('isGroup') || node.data('collapsedProxy') || node.data('detailBucket')) return;
        rows.push(node);
      });
      return rows;
    };
    const visibleHealthCount = (health: string): number =>
      contentNodes().filter(
        (node) => String(node.data('health') || 'healthy') === health && node.style('display') !== 'none',
      ).length;
    const waitFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const counts = contentNodes().reduce<Record<string, number>>((acc, node) => {
      const health = String(node.data('health') || 'healthy');
      acc[health] = (acc[health] || 0) + 1;
      return acc;
    }, {});
    const out: string[] = [];
    const rows = Array.from(document.querySelectorAll<HTMLInputElement>('[data-filter-health]')).map((input) => {
      const countText = input.closest('.rail-row')?.querySelector('[data-health-count]')?.textContent || '0';
      return {
        count: Number(countText.replace(/,/g, '')),
        input,
        key: input.dataset.filterHealth || 'unknown',
        visible: visibleHealthCount(input.dataset.filterHealth || ''),
      };
    });
    for (const row of rows) {
      const expected = counts[row.key] || 0;
      if (row.count !== expected) out.push(`${row.key} count ${row.count} did not match graph count ${expected}`);
      if (expected === 0 && !row.input.disabled) out.push(`${row.key} remained enabled with no current graph nodes`);
      if (expected > 0 && row.input.disabled) out.push(`${row.key} was disabled despite ${expected} graph nodes`);
    }
    const active = rows.find((row) => row.visible > 0 && !row.input.disabled);
    if (!active) return out;
    active.input.click();
    await waitFrame();
    const afterHidden = visibleHealthCount(active.key);
    if (afterHidden > 0) out.push(`${active.key} filter left ${afterHidden} visible nodes after toggle off`);
    active.input.click();
    await waitFrame();
    if (active.input.checked !== true) out.push(`${active.key} filter did not restore checked state`);
    return out;
  });
  if (failures.length > 0) throw new Error(`health filters failed:\n${failures.join('\n')}`);
}

type DetailGroupingState = {
  bucketId?: string;
  buckets: number;
  counter: string;
  hash: string;
};

async function injectDetailGroupingFixture(page: Page): Promise<void> {
  const injected = await page.evaluate((fixture) => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (!hook) return { ok: false, reason: 'viewer smoke hook missing' };
    const visible = hook.cy
      .nodes()
      .filter(
        (node) =>
          !node.data('isGroup') &&
          !node.data('collapsedProxy') &&
          !node.data('detailBucket') &&
          node.style('display') !== 'none',
      );
    const anchor = visible[0];
    if (!anchor) return { ok: false, reason: 'no visible graph node available for detail grouping fixture' };
    hook.cy.add([
      ...fixture.nodes.map((node) => ({
        group: 'nodes',
        data: {
          id: node.id,
          label: node.label,
          kind: fixture.kind,
          health: fixture.health,
          file: fixture.file,
          line: node.line,
          centrality: fixture.centrality,
        },
        position: node.position,
      })),
    ]);
    return { ok: true, reason: '', anchor: anchor.id() };
  }, DETAIL_GROUPING_FIXTURE);
  if (!injected.ok) throw new Error(`detail grouping fixture setup failed: ${injected.reason}`);
}

async function waitForDetailMode(page: Page, mode: 'expanded' | 'grouped'): Promise<void> {
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLElement>(`[data-detail-mode="${expected}"]`)?.dataset.active === '1',
    mode,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function readDetailGroupingState(page: Page): Promise<DetailGroupingState> {
  return page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    const buckets = hook?.cy
      .nodes()
      .filter((node) => Boolean(node.data('detailBucket')) && node.style('display') !== 'none');
    return {
      buckets: buckets?.length ?? 0,
      bucketId: buckets?.[0]?.id(),
      hash: location.hash,
      counter: document.querySelector('#canvas-counter')?.textContent || '',
    };
  });
}

function assertGroupedDetailState(grouped: DetailGroupingState): void {
  if (grouped.buckets <= 0 || !grouped.hash.includes('detail=grouped') || !grouped.counter.includes('detail bucket')) {
    throw new Error(`detail grouping did not surface visible buckets: ${JSON.stringify(grouped)}`);
  }
}

async function triggerDetailBucket(page: Page, bucketId: string | undefined): Promise<void> {
  await page.evaluate((bucketId) => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    if (bucketId) hook?.cy.getElementById(String(bucketId)).trigger('tap');
  }, bucketId);
}

async function waitForNoDetailBuckets(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const buckets =
        hook?.cy.nodes().filter((node) => Boolean(node.data('detailBucket')) && node.style('display') !== 'none')
          .length ?? 0;
      return (
        buckets === 0 && document.querySelector<HTMLElement>('[data-detail-mode="expanded"]')?.dataset.active === '1'
      );
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function assertDetailGrouping(page: Page): Promise<void> {
  await page.waitForSelector('#detail-control', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await injectDetailGroupingFixture(page);

  await page.locator('[data-detail-mode="grouped"]').click();
  await waitForDetailMode(page, 'grouped');
  const grouped = await readDetailGroupingState(page);
  assertGroupedDetailState(grouped);

  await triggerDetailBucket(page, grouped.bucketId);
  await waitForNoDetailBuckets(page);

  await page.locator('[data-detail-mode="grouped"]').click();
  await waitForDetailMode(page, 'grouped');
}

async function assertResetView(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const health = document.querySelector<HTMLInputElement>('[data-filter-health="healthy"]');
    if (health) health.checked = false;
    document.querySelector<HTMLElement>('#kind-chips .kind-chip[data-available="1"]')?.click();
    document.querySelector<HTMLElement>('#btn-edge-none')?.click();
    document.querySelector<HTMLElement>('[data-detail-mode="expanded"]')?.click();
    await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  });
  await page.locator('#btn-reset-view').click();
  await page.waitForFunction(
    () => {
      const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
      const chipsOk = Array.from(document.querySelectorAll<HTMLElement>('#kind-chips .kind-chip')).every(
        (chip) => chip.dataset.active === '1',
      );
      const checksOk = Array.from(
        document.querySelectorAll<HTMLInputElement>('[data-filter-health], [data-filter-scope], [data-filter-edge]'),
      ).every((input) => input.checked);
      const graphStateHidden = (document.querySelector('#graph-state') as HTMLElement | null)?.hidden ?? false;
      const visibleNodes =
        hook?.cy.nodes().filter((node) => !node.data('isGroup') && node.style('display') !== 'none').length ?? 0;
      const grouped = document.querySelector<HTMLElement>('[data-detail-mode="grouped"]')?.dataset.active === '1';
      return (
        chipsOk && checksOk && graphStateHidden && grouped && visibleNodes > 0 && location.hash.includes('density=core')
      );
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertVisibleEdgesConnect(page, 'reset view');
}

async function assertResetViewerLocalState(page: Page): Promise<void> {
  await page.locator('[data-density-mode="all"]').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-density-mode="all"]')?.dataset.active === '1',
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('[data-layout-quality="spread"]').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('[data-layout-quality="spread"]')?.dataset.active === '1',
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await openGraphToolsForSmoke(page);
  await page.locator('#btn-layout-pin').click();
  await page.locator('#saved-view-name').fill('Reset smoke');
  await page.locator('#btn-save-view').click();
  await page.locator('#btn-save-snapshot').click();
  await page.evaluate(() => {
    localStorage.setItem('cartograph-viewer-smoke-extra', '1');
  });
  await page.locator('#btn-reset-local-state').click();
  await page.waitForFunction(
    () => {
      const status = document.querySelector<HTMLElement>('#viewer-reset-status');
      return status?.dataset.state === 'ok' && /Cleared/.test(status.textContent || '');
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const state = await page.evaluate(() => {
    const projectKey =
      (globalThis as typeof globalThis & { viewerProjectStorageKey?: (baseKey: string) => string })
        .viewerProjectStorageKey || ((baseKey: string) => baseKey);
    let pinnedCount = 0;
    try {
      const pinned = JSON.parse(
        localStorage.getItem(projectKey('cartograph-viewer-pinned-layouts-v1')) || '{}',
      ) as Record<string, unknown>;
      pinnedCount = Object.keys(pinned).length;
    } catch {
      pinnedCount = -1;
    }
    return {
      customCleared: localStorage.getItem('cartograph-viewer-smoke-extra') === null,
      densityCore: document.querySelector<HTMLElement>('[data-density-mode="core"]')?.dataset.active === '1',
      detailGrouped: document.querySelector<HTMLElement>('[data-detail-mode="grouped"]')?.dataset.active === '1',
      edgeAll: document.querySelector<HTMLElement>('[data-edge-lens="all"]')?.dataset.active === '1',
      layoutBalanced: document.querySelector<HTMLElement>('[data-layout-quality="balanced"]')?.dataset.active === '1',
      loadSnapshotDisabled: document.querySelector<HTMLButtonElement>('#btn-load-snapshot')?.disabled === true,
      pinnedCount,
      savedViewsMissing: localStorage.getItem(projectKey('cartograph-viewer-saved-views-v1')) === null,
      snapshotMissing: localStorage.getItem(projectKey('cartograph-viewer-graph-snapshot-v1')) === null,
    };
  });
  if (
    !state.customCleared ||
    !state.densityCore ||
    !state.detailGrouped ||
    !state.edgeAll ||
    !state.layoutBalanced ||
    !state.loadSnapshotDisabled ||
    state.pinnedCount !== 0 ||
    !state.savedViewsMissing ||
    !state.snapshotMissing
  ) {
    throw new Error(`viewer local state reset did not restore defaults: ${JSON.stringify(state)}`);
  }
  await waitForGraph(page);
}

async function assertLocalStateCorruptionRecovery(page: Page, url: string): Promise<void> {
  await page.evaluate(
    ({ densityKey, entries, layoutKey, pinnedKey, positions, savedKey, snapshotKey, splitKey }) => {
      const projectKey =
        (globalThis as typeof globalThis & { viewerProjectStorageKey?: (baseKey: string) => string })
          .viewerProjectStorageKey || ((baseKey: string) => baseKey);
      const pinned: Record<
        string,
        { nodeCount: number; positions: Record<string, { x: number; y: number }>; updatedAt: number; version: number }
      > = {};
      for (let entryIndex = 0; entryIndex < entries; entryIndex++) {
        const entryPositions: Record<string, { x: number; y: number }> = {};
        for (let positionIndex = 0; positionIndex < positions; positionIndex++) {
          entryPositions[`corrupt-node-${entryIndex}-${positionIndex}`] = { x: positionIndex, y: entryIndex };
        }
        pinned[`corrupt-layout-${entryIndex}`] = {
          nodeCount: positions,
          positions: entryPositions,
          updatedAt: Date.now() - entryIndex,
          version: 2,
        };
      }
      localStorage.setItem(projectKey(savedKey), '{bad saved views');
      localStorage.setItem(projectKey(snapshotKey), '"not a snapshot"');
      localStorage.setItem(splitKey, '{bad splitters');
      localStorage.setItem(layoutKey, 'not-a-layout');
      localStorage.setItem(densityKey, 'not-a-density');
      localStorage.setItem(projectKey(pinnedKey), JSON.stringify(pinned));
    },
    {
      densityKey: DENSITY_KEY,
      entries: CORRUPT_STATE_PINNED_ENTRIES,
      layoutKey: LAYOUT_QUALITY_KEY,
      pinnedKey: PINNED_LAYOUTS_KEY,
      positions: CORRUPT_STATE_PINNED_POSITIONS,
      savedKey: SAVED_VIEWS_KEY,
      snapshotKey: GRAPH_SNAPSHOT_KEY,
      splitKey: SPLITTERS_KEY,
    },
  );
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await waitForGraph(page);
  const state = await page.evaluate(
    ({ densityKey, pinnedKey, savedKey, snapshotKey, splitKey }) => {
      const projectKey =
        (globalThis as typeof globalThis & { viewerProjectStorageKey?: (baseKey: string) => string })
          .viewerProjectStorageKey || ((baseKey: string) => baseKey);
      const activeDensity = document.querySelector<HTMLElement>('[data-density-mode="core"]')?.dataset.active === '1';
      const activeLayout =
        document.querySelector<HTMLElement>('[data-layout-quality="balanced"]')?.dataset.active === '1';
      let pinnedEntries = 0;
      let largestPinnedEntry = 0;
      try {
        const parsed = JSON.parse(localStorage.getItem(projectKey(pinnedKey)) || '{}') as Record<
          string,
          { positions?: Record<string, unknown> }
        >;
        pinnedEntries = Object.keys(parsed).length;
        largestPinnedEntry = Object.values(parsed).reduce(
          (max, entry) => Math.max(max, Object.keys(entry.positions || {}).length),
          0,
        );
      } catch {
        pinnedEntries = -1;
      }
      return {
        activeDensity,
        activeLayout,
        densityValue: localStorage.getItem(densityKey),
        invariantErrors:
          (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.diagnostics?.('local-state-recovery')
            ?.invariantErrorCount || 0,
        pinnedEntries,
        largestPinnedEntry,
        savedViewsCleared: localStorage.getItem(projectKey(savedKey)) === null,
        snapshotCleared: localStorage.getItem(projectKey(snapshotKey)) === null,
        splittersCleared: localStorage.getItem(splitKey) === null,
      };
    },
    {
      densityKey: DENSITY_KEY,
      pinnedKey: PINNED_LAYOUTS_KEY,
      savedKey: SAVED_VIEWS_KEY,
      snapshotKey: GRAPH_SNAPSHOT_KEY,
      splitKey: SPLITTERS_KEY,
    },
  );
  if (
    !state.activeDensity ||
    !state.activeLayout ||
    state.invariantErrors > 0 ||
    state.pinnedEntries > 32 ||
    state.largestPinnedEntry > 600 ||
    !state.savedViewsCleared ||
    !state.snapshotCleared ||
    !state.splittersCleared
  ) {
    throw new Error(`viewer did not recover from corrupted local state: ${JSON.stringify(state)}`);
  }
  await assertVisibleEdgesConnect(page, 'corrupted local state recovery');
  await assertGraphLayoutNotLinear(page, 'corrupted local state recovery');
}

async function assertInteractionRaceStability(page: Page): Promise<void> {
  await focusSymbolViaSearch(page, 'add');
  await focusSymbolViaSearch(page, 'compute');
  await page.evaluate(() => {
    const selectors = [
      '#btn-nav-back',
      '#btn-nav-fwd',
      '[data-density-mode="all"]',
      '[data-density-mode="focus"]',
      '[data-density-mode="core"]',
      '[data-layout-quality="fast"]',
      '[data-layout-quality="spread"]',
      '[data-layout-quality="balanced"]',
      '#btn-edge-none',
      '#btn-edge-all',
      '#btn-zoom-in',
      '#btn-zoom-out',
      '#btn-zoom-fit',
      '#btn-reset-view',
    ];
    for (let round = 0; round < 4; round++) {
      for (const selector of selectors) {
        document.querySelector<HTMLElement>(selector)?.click();
      }
    }
  });
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 650)));
  await waitForGraph(page);
  await assertGraphFitsViewport(page, 'interaction race stability');
  await assertVisibleEdgesConnect(page, 'interaction race stability');
  const diagnostics = await viewerDiagnostics(page, 'interaction race stability');
  if (diagnostics.invariantErrorCount > 0 || diagnostics.nodeOverlapCount > 0) {
    throw new Error(`interaction race left graph in a bad state: ${JSON.stringify(diagnostics)}`);
  }
}

async function featurePanelState(page: Page): Promise<{ hidden: boolean; state: string; text: string }> {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>('#feature-panel');
    return {
      hidden: panel?.hidden ?? true,
      state: panel?.dataset.state || '',
      text: panel?.textContent?.replace(/\s+/g, ' ').trim() || '',
    };
  });
}

async function assertGraphToolStates(page: Page): Promise<void> {
  await page.locator('#path-from').fill('');
  await page.locator('#path-to').fill('');
  await page.locator('#btn-path-run').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('#feature-panel')?.dataset.state === 'empty' &&
      (document.querySelector('#feature-panel')?.textContent || '').includes('Choose two symbols'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );

  await page.locator('#path-from').fill('compute');
  await page.locator('#path-to').fill('mul');
  await page.locator('#btn-path-run').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('#feature-panel')?.dataset.state === 'ready' &&
      (document.querySelector('#feature-panel')?.textContent || '').includes('Path'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertVisibleEdgesConnect(page, 'path finder');

  await focusSymbolViaSearch(page, 'compute');
  await page.locator('[data-impact-mode="both"]').click();
  await page.waitForFunction(
    () => {
      const panel = document.querySelector<HTMLElement>('#feature-panel');
      const text = panel?.textContent || '';
      return Boolean(panel && !panel.hidden && panel.dataset.state !== 'loading' && text.includes('Impact'));
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertVisibleEdgesConnect(page, 'impact mode');
  await captureViewerScreenshot(page, 'desktop-heavy-impact', { baseline: true, selector: '#stage' });

  await page.locator('#btn-compare-view').click();
  await page.waitForFunction(
    () => {
      const panel = document.querySelector<HTMLElement>('#feature-panel');
      const text = panel?.textContent || '';
      return Boolean(panel && !panel.hidden && panel.dataset.state !== 'loading' && text.includes('Compare'));
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const compare = await featurePanelState(page);
  if (!['ready', 'empty', 'error'].includes(compare.state)) {
    throw new Error(`compare view did not settle into a known state: ${JSON.stringify(compare)}`);
  }
  await page.locator('#btn-feature-clear').click();
}

async function assertBugReportCopy(page: Page): Promise<void> {
  await page.waitForSelector('#btn-copy-bug-report', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const payload = await page.evaluate(() =>
    (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.bugReportPayload?.(),
  );
  if (!payload || typeof payload !== 'object') throw new Error('bug report payload hook was unavailable');
  const diagnostics = (payload as { diagnostics?: ViewerDiagnostics }).diagnostics;
  if (!diagnostics || diagnostics.visibleNodeCount <= 0 || !('layoutQualityMode' in diagnostics)) {
    throw new Error(`bug report payload missed diagnostics: ${JSON.stringify(payload)}`);
  }
  await page.locator('#btn-copy-bug-report').click();
  await page.waitForFunction(
    () => {
      const status = document.querySelector<HTMLElement>('#bug-report-status');
      return status && !status.hidden && /copied|failed/i.test(status.textContent || '');
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const status = await page.evaluate(() => ({
    state: document.querySelector<HTMLElement>('#bug-report-status')?.dataset.state || '',
    text: document.querySelector('#bug-report-status')?.textContent || '',
  }));
  if (status.state === 'err') throw new Error(`bug report copy failed: ${JSON.stringify(status)}`);
}

async function assertGraphSnapshotReplay(page: Page): Promise<void> {
  await page.waitForSelector('#btn-save-snapshot', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await focusSymbolViaSearch(page, 'compute');
  const before = await selectionState(page);
  await page.locator('#btn-save-snapshot').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#snapshot-status')?.dataset.state === 'ok',
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('[data-density-mode="focus"]').click();
  await waitForGraph(page);
  await page.locator('#btn-load-snapshot').click();
  await page.waitForFunction(
    (expected) => {
      const status = document.querySelector<HTMLElement>('#snapshot-status');
      const counter = document.querySelector('#canvas-counter')?.textContent || '';
      const selected = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.selectionState().currentSymbolId;
      return status?.dataset.state === 'ok' && counter.includes('Snapshot') && selected === expected;
    },
    before.currentSymbolId,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const after = await selectionState(page);
  if (after.currentSymbolId !== before.currentSymbolId) {
    throw new Error(`snapshot replay did not restore focus: ${JSON.stringify({ before, after })}`);
  }
  await page.locator('#btn-delete-snapshot').click();
  await page.waitForFunction(
    () => document.querySelector<HTMLElement>('#btn-load-snapshot')?.hasAttribute('disabled'),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function assertSelectedNeighborhood(page: Page): Promise<void> {
  const state = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    let neighbors = 0;
    let edges = 0;
    hook?.cy.nodes().forEach((node) => {
      if (node.hasClass('selected-neighbor') && node.style('display') !== 'none') neighbors++;
    });
    hook?.cy.edges().forEach((edge) => {
      if (edge.hasClass('selected-edge') && edge.style('display') !== 'none') edges++;
    });
    return { neighbors, edges };
  });
  if (state.neighbors <= 0 || state.edges <= 0) {
    throw new Error(`selected neighborhood did not highlight adjacent graph elements: ${JSON.stringify(state)}`);
  }
}

async function selectionState(page: Page): Promise<ViewerSelectionState> {
  const state = await page.evaluate(() => (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.selectionState());
  if (!state) throw new Error('viewer smoke selectionState hook was unavailable');
  return state;
}

async function assertViewerStateStore(page: Page): Promise<void> {
  const result = await page.evaluate(() => {
    const hook = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke;
    return {
      selection: hook?.selectionState?.() || null,
      state: hook?.state?.() || null,
    };
  });
  const state = result.state;
  if (!state) throw new Error('viewer shared state hook was unavailable');
  const actionNames = state.actionNames || [];
  for (const action of ['fitGraph', 'navBack', 'saveGraphSnapshot', 'relayoutAndFit']) {
    if (!actionNames.includes(action)) {
      throw new Error(`viewer action registry missed ${action}: ${JSON.stringify(actionNames)}`);
    }
  }
  if (!state.graph?.densityMode || !state.graph.layoutQuality || !state.graph.edgeLensMode) {
    throw new Error(`viewer graph modes were not mirrored: ${JSON.stringify(state.graph)}`);
  }
  if ((state.graph.visibilityStats?.visibleNodeCount ?? 0) <= 0) {
    throw new Error(`viewer visibility stats were not mirrored: ${JSON.stringify(state.graph.visibilityStats)}`);
  }
  const current = result.selection?.currentSymbolId || null;
  if (current && state.selection?.currentSymbolId !== current) {
    throw new Error(`viewer selection state drifted: ${JSON.stringify({ selection: result.selection, state })}`);
  }
  const navHistory = result.selection?.navHistory || [];
  const stateHistory = state.navigation?.history?.map((entry) => entry.id) || [];
  if (navHistory.length > 0 && navHistory.join('|') !== stateHistory.join('|')) {
    throw new Error(`viewer navigation state drifted: ${JSON.stringify({ navHistory, stateHistory })}`);
  }
}

async function assertFocusedGraphMatchesSelection(page: Page, label: string): Promise<ViewerSelectionState> {
  const state = await selectionState(page);
  if (!state.currentSymbolId || state.liveSymbolId !== state.currentSymbolId || !state.graphHasCurrent) {
    throw new Error(`${label}: selected symbol was not present in the focused graph: ${JSON.stringify(state)}`);
  }
  if (!state.focusIds.includes(state.currentSymbolId)) {
    throw new Error(`${label}: selected symbol did not have graph focus: ${JSON.stringify(state)}`);
  }
  return state;
}

async function assertNavigationHistoryRefocusesGraph(page: Page): Promise<void> {
  await focusSymbolViaSearch(page, 'compute');
  const first = await assertFocusedGraphMatchesSelection(page, 'history initial focus');
  await focusSymbolViaSearch(page, 'add');
  const second = await assertFocusedGraphMatchesSelection(page, 'history callee focus');
  if (first.currentSymbolId === second.currentSymbolId) {
    throw new Error(`history test did not navigate to a different symbol: ${JSON.stringify({ first, second })}`);
  }

  await page.locator('#btn-nav-back').click();
  await page.waitForFunction(
    (expected) => {
      const state = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.selectionState();
      return (
        state?.currentSymbolId === expected &&
        state.liveSymbolId === expected &&
        state.detailName &&
        state.graphHasCurrent &&
        state.focusIds.includes(String(expected))
      );
    },
    first.currentSymbolId,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.waitForFunction(
    (expectedName) =>
      (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke
        ?.selectionState()
        .detailName.includes(String(expectedName)),
    first.detailName,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertVisibleEdgesConnect(page, 'history back focus');

  await page.locator('#btn-nav-fwd').click();
  await page.waitForFunction(
    (expected) => {
      const state = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.selectionState();
      return (
        state?.currentSymbolId === expected &&
        state.liveSymbolId === expected &&
        state.detailName &&
        state.graphHasCurrent &&
        state.focusIds.includes(String(expected))
      );
    },
    second.currentSymbolId,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.waitForFunction(
    (expectedName) =>
      (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke
        ?.selectionState()
        .detailName.includes(String(expectedName)),
    second.detailName,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await assertVisibleEdgesConnect(page, 'history forward focus');
}

async function assertTooltips(page: Page): Promise<void> {
  const texts = await page.evaluate(() => {
    const tooltips = (globalThis as ViewerSmokeGlobal).__cartographViewerTooltips;
    return {
      back: tooltips?.textFor('#btn-nav-back') ?? '',
      kind: tooltips?.textFor('.kind-chip') ?? '',
      save: tooltips?.textFor('#btn-save-view') ?? '',
      shown: tooltips?.showFor('#btn-save-view') ?? false,
    };
  });
  if (!texts.shown || texts.save !== 'Save the current view' || !texts.kind.includes('Toggle')) {
    throw new Error(`tooltip API did not expose expected control text: ${JSON.stringify(texts)}`);
  }
  await page.waitForFunction(
    () => document.querySelector('.ui-tooltip')?.textContent === 'Save the current view',
    undefined,
    {
      timeout: DETAIL_OPEN_FAST_TIMEOUT_MS,
    },
  );
  if (!texts.back.includes('Back') && !texts.back.includes('No previous symbol')) {
    throw new Error(`back button tooltip was not populated: ${JSON.stringify(texts)}`);
  }
  await page.evaluate(() => (globalThis as ViewerSmokeGlobal).__cartographViewerTooltips?.hideTooltip());
}

async function assertEscapeClearsSelection(page: Page): Promise<void> {
  await focusSymbolViaSearch(page, 'compute');
  await assertSelectedNeighborhood(page);
  // After a search-driven focus the search input still owns keyboard
  // focus. The first Escape only dismisses the field (blur) — it must
  // NOT destroy the selection the user just made.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => {
      const state = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.selectionState();
      return state?.currentSymbolId !== null && document.activeElement?.id !== 'search-input';
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  // The second Escape (no field focused) clears the selection.
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => {
      const state = (globalThis as ViewerSmokeGlobal).__cartographViewerSmoke?.selectionState();
      return (
        state?.currentSymbolId === null &&
        state.liveSymbolId === null &&
        state.focusIds.length === 0 &&
        state.selectedEdgeCount === 0 &&
        state.detailName === 'No selection' &&
        !state.hash.includes('focus=')
      );
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function focusSymbolViaSearch(page: Page, symbol: string): Promise<void> {
  await page.locator('#search-input').fill(symbol);
  await page.waitForSelector('.search-suggest-row', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  await page.keyboard.press('Enter');
  await page.waitForFunction((expected) => document.querySelector('#d-name')?.textContent === expected, symbol, {
    timeout: SEARCH_TIMEOUT_MS,
  });
  await assertGraphFitsViewport(page, `focus ${symbol}`);
  await assertVisibleEdgesConnect(page, `focus ${symbol}`);
}

async function clickSubtab(page: Page, sub: 'callers' | 'callees' | 'findings'): Promise<void> {
  await page.locator(`.subtab[data-sub="${sub}"]`).click();
  await page.waitForFunction(
    (expected) => document.querySelector<HTMLElement>(`.subtab[data-sub="${expected}"]`)?.classList.contains('active'),
    sub,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function clickFirstSymbolRef(page: Page): Promise<{ before: string; label: string }> {
  const clicked = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('#subpanel .ref-row[data-symbol]');
    if (!row) return { before: '', label: '', ok: false };
    const before = document.querySelector('#d-name')?.textContent || '';
    const label = row.querySelector('.name')?.textContent || '';
    row.click();
    return { before, label, ok: true };
  });
  if (!clicked.ok) throw new Error('no clickable symbol row found in subpanel');
  await page.waitForFunction(
    ({ before, label }) => {
      const selected = document.querySelector('#d-name')?.textContent || '';
      const trail = document.querySelector('#graph-trail')?.textContent || '';
      return selected !== before || trail.includes(label);
    },
    { before: clicked.before, label: clicked.label },
    { timeout: SEARCH_TIMEOUT_MS },
  );
  return clicked;
}

async function assertClickableRefCursor(page: Page): Promise<void> {
  const cursors = await page.evaluate(() =>
    [
      '#subpanel .ref-row[data-symbol]',
      '#subpanel .ref-row[data-symbol] .name',
      '#subpanel .ref-row[data-symbol] .loc',
    ].map((selector) => {
      const el = document.querySelector(selector);
      return { cursor: el ? getComputedStyle(el).cursor : 'missing', selector };
    }),
  );
  const bad = cursors.filter((row) => row.cursor !== 'pointer');
  if (bad.length > 0) throw new Error(`clickable ref rows did not show pointer cursor: ${JSON.stringify(bad)}`);
}

async function assertSubpanelSymbolNavigation(page: Page): Promise<void> {
  await focusSymbolViaSearch(page, 'compute');
  await clickSubtab(page, 'callees');
  await assertClickableRefCursor(page);
  const callee = await clickFirstSymbolRef(page);
  if (!callee.label) throw new Error('callee row did not expose a label');

  await clickSubtab(page, 'callers');
  const caller = await clickFirstSymbolRef(page);
  if (!caller.label.includes('compute')) {
    throw new Error(`caller navigation did not return to compute: ${JSON.stringify(caller)}`);
  }
}

async function assertFindingsInteraction(page: Page): Promise<void> {
  await focusSymbolViaSearch(page, FINDING_FIXTURE_SYMBOL);
  await clickSubtab(page, 'findings');
  await page.waitForSelector('#subpanel .ref-row[data-biomarker]', { state: 'visible', timeout: SEARCH_TIMEOUT_MS });
  const cursor = await page.evaluate(() => {
    const row = document.querySelector('#subpanel .ref-row[data-biomarker]');
    const name = document.querySelector('#subpanel .ref-row[data-biomarker] .name');
    const loc = document.querySelector('#subpanel .ref-row[data-biomarker] .loc');
    return [row, name, loc].map((el) => (el ? getComputedStyle(el).cursor : 'missing'));
  });
  if (cursor.some((value) => value !== 'pointer')) {
    throw new Error(`clickable finding row did not show pointer cursor: ${JSON.stringify(cursor)}`);
  }
  const clicked = await page.evaluate(() => {
    const row = document.querySelector<HTMLElement>('#subpanel .ref-row[data-biomarker]');
    const biomarker = row?.dataset.biomarker || '';
    row?.click();
    return biomarker;
  });
  if (!clicked) throw new Error('finding row did not expose a biomarker');
  await page.waitForFunction(
    (biomarker) =>
      document.querySelector('#ask-history')?.textContent?.includes(`Filtered to ${String(biomarker)}`) ||
      document.querySelector('#ask-history')?.textContent?.includes(String(biomarker)),
    clicked,
    { timeout: SEARCH_TIMEOUT_MS },
  );
}

async function assertHealthView(page: Page): Promise<void> {
  await page.locator('.tab[data-view="system"]').click();
  await page.locator('#system-subnav .system-subtab[data-subview="health"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('#system-view')?.style.display !== 'none' &&
      document.querySelector<HTMLElement>('#health-view')?.hidden === false &&
      document.querySelector<HTMLElement>('#health-view')?.dataset.loaded === '1',
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  // The gauge sweep is set on a rAF after data-loaded flips — wait for
  // it so the dasharray assertion below cannot race the paint.
  await page.waitForFunction(
    () => Boolean(document.querySelector<SVGPathElement>('#hc-gauge-fill')?.style.strokeDasharray),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const health = await page.evaluate(() => ({
    score: document.querySelector('#hc-health')?.textContent || '',
    grade: document.querySelector('#hc-grade')?.textContent || '',
    gaugeDash: document.querySelector<SVGPathElement>('#hc-gauge-fill')?.style.strokeDasharray || '',
    severityChips: document.querySelectorAll('#hc-severity-chips .health-severity-chip').length,
    biomarkers: document.querySelector('#hc-biomarkers')?.textContent?.trim() || '',
    hotspots: document.querySelector('#hc-hotspots-list')?.textContent?.trim() || '',
    kindRows: document.querySelectorAll('#hc-kinds .health-row').length,
    symbols: document.querySelector('#hc-total-nodes')?.textContent || '',
  }));
  if (!/^\d+(\.\d+)?$/.test(health.score) || health.severityChips !== 3 || !health.symbols || !health.grade) {
    throw new Error(`health dashboard did not render core metrics: ${JSON.stringify(health)}`);
  }
  if (!health.biomarkers || !health.hotspots || health.kindRows === 0) {
    throw new Error(`health dashboard lists were empty: ${JSON.stringify(health)}`);
  }
  await page.locator('[data-view="graph"]').click();
  await waitForGraph(page);
}

async function assertLiveView(page: Page): Promise<void> {
  await page.locator('[data-view="live"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('#live-view')?.style.display === 'block' &&
      document.querySelector<HTMLElement>('#lf-indicator')?.dataset.state === 'live',
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const live = await page.evaluate(() => ({
    rows: document.querySelectorAll('#lf-feed .lf-row').length,
    emptyHidden: document.querySelector<HTMLElement>('#lf-empty')?.hidden ?? false,
    conn: document.querySelector('#lf-conn')?.textContent || '',
    toolmixRows: document.querySelectorAll('#lf-toolmix .live-toolmix-row').length,
  }));
  // The fixture DB carries one seeded session (seedTraceFixture) —
  // the backlog must render those rows and the empty state must
  // yield.
  if (live.rows < 4 || !live.emptyHidden || live.toolmixRows < 1) {
    throw new Error(`live view did not render the seeded backlog: ${JSON.stringify(live)}`);
  }
  // Exact-session view: the dropdown has NO "All sessions" option;
  // the newest session (the primary) is auto-selected. The live feed is
  // project-scoped, so it drops the seeded cross-project call; the trace
  // timeline below still verifies that cross-project row explicitly.
  const exact = await page.evaluate(() => {
    const dropdown = document.getElementById('lf-session-filter') as HTMLSelectElement;
    const rows = [...document.querySelectorAll<HTMLElement>('#lf-feed .lf-row')];
    return {
      options: [...dropdown.options].map((o) => o.value),
      selected: dropdown.value,
      total: rows.length,
      visible: rows.filter((el) => !el.hidden).length,
    };
  });
  if (exact.options.includes('') || exact.selected !== 'smoke-trace-session') {
    throw new Error(`exact-session dropdown wrong: ${JSON.stringify(exact)}`);
  }
  if (exact.total < 4 || exact.visible !== 3) {
    throw new Error(`exact-session default visibility wrong: ${JSON.stringify(exact)}`);
  }
  // Feed filter: 'demo failure' matches only the seeded error call.
  await page.locator('#lf-filter').fill('demo failure');
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll<HTMLElement>('#lf-feed .lf-row')];
      return rows.length >= 4 && rows.filter((el) => !el.hidden).length === 1;
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('#lf-filter').fill('');
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLElement>('#lf-feed .lf-row')].filter((el) => !el.hidden).length === 3,
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  // Switching sessions shows exactly the other session's single row.
  await page.locator('#lf-session-filter').selectOption('smoke-trace-session-b');
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll<HTMLElement>('#lf-feed .lf-row')];
      const visible = rows.filter((el) => !el.hidden);
      return visible.length === 1 && visible[0]!.dataset.session === 'smoke-trace-session-b';
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('#lf-session-filter').selectOption('smoke-trace-session');
  await page.locator('[data-view="graph"]').click();
  await waitForGraph(page);
}

async function assertTraceView(page: Page): Promise<void> {
  await page.locator('[data-view="trace"]').click();
  await page.waitForFunction(
    () =>
      document.querySelector<HTMLElement>('#trace-view')?.style.display === 'block' &&
      document.querySelectorAll('#trace-list .trace-row').length > 0,
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const timeline = await page.evaluate(() => ({
    rows: document.querySelectorAll('#trace-list .trace-row').length,
    pickerVisible: (document.querySelector<HTMLElement>('#session-picker')?.style.display ?? 'none') !== 'none',
    calls: document.getElementById('tr-stat-calls')?.textContent || '',
    errors: document.getElementById('tr-stat-errors')?.textContent || '',
    longGaps: document.querySelectorAll('#trace-list .gap.long').length,
    errRows: document.querySelectorAll('#trace-list .result.err').length,
  }));
  // Seeded session: 4 calls, one >10s gap, one error-tier result,
  // one cross-project call.
  if (timeline.rows < 4 || !timeline.pickerVisible) {
    throw new Error(`trace timeline did not render the seeded session: ${JSON.stringify(timeline)}`);
  }
  // The picker leads with the human handle (label > client), not the
  // opaque id; the masthead identity line names the client + project.
  const identity = await page.evaluate(() => ({
    option: (document.querySelector('#session-picker option:checked') as HTMLOptionElement | null)?.textContent || '',
    label: document.getElementById('session-label')?.textContent || '',
  }));
  if (!identity.option.startsWith('smoke ·') || !identity.label.includes('smoke-client')) {
    throw new Error(`session identity not rendered: ${JSON.stringify(identity)}`);
  }
  if (timeline.calls !== '4' || timeline.errors !== '1' || timeline.longGaps < 1 || timeline.errRows < 1) {
    throw new Error(`trace masthead stats or row markers wrong: ${JSON.stringify(timeline)}`);
  }
  // Timeline filter: 'find' matches only the seeded step 1 (the
  // other tools are cartograph_graph / cartograph_status).
  await page.locator('#tr-filter').fill('find');
  await page.waitForFunction(
    () => {
      const rows = [...document.querySelectorAll<HTMLElement>('#trace-list .trace-row')];
      return rows.length >= 3 && rows.filter((el) => !el.hidden).length === 1;
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const filterCount = await page.evaluate(() => document.getElementById('tr-filter-count')?.textContent || '');
  if (filterCount !== '1/4') throw new Error(`trace filter count wrong: ${JSON.stringify(filterCount)}`);
  await page.locator('#tr-filter').fill('');
  await page.waitForFunction(
    () => [...document.querySelectorAll<HTMLElement>('#trace-list .trace-row')].every((el) => !el.hidden),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  // Step 4 targeted ANOTHER project via projectPath — its row wears
  // the cross-project badge and its graph chips are disabled (this
  // viewer shows a different project's graph).
  await page.locator('#trace-list .trace-row[data-i="3"]').click();
  await page.waitForFunction(
    () => {
      const chip = document.querySelector<HTMLButtonElement>('#trace-detail .trace-link');
      return Boolean(chip && chip.disabled);
    },
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  const xproj = await page.evaluate(() => ({
    rowBadges: document.querySelectorAll('#trace-list .trace-row .xproj').length,
    note: document.querySelector('.trace-detail-xproj-note')?.textContent || '',
    projectKv: [...document.querySelectorAll('.trace-detail-kv .v')].some((el) =>
      el.textContent?.includes('/elsewhere/project'),
    ),
  }));
  if (xproj.rowBadges < 1 || !xproj.note.includes('project') || !xproj.projectKv) {
    throw new Error(`cross-project marking missing: ${JSON.stringify(xproj)}`);
  }
  // Step 2 carries args {symbol: 'compute', direction: 'callers'} →
  // the detail card must render the args JSON and a graph-link chip
  // for the symbol, which lands on the Graph tab focused on it.
  await page.locator('#trace-list .trace-row[data-i="1"]').click();
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('#trace-detail pre')) &&
      Boolean(document.querySelector('.trace-link[data-symbol="compute"]')),
    undefined,
    { timeout: SEARCH_TIMEOUT_MS },
  );
  await page.locator('.trace-link[data-symbol="compute"]').click();
  await waitForGraph(page);
  const traceHidden = await page.evaluate(
    () => document.querySelector<HTMLElement>('#trace-view')?.style.display !== 'block',
  );
  if (!traceHidden) throw new Error('the graph-link chip did not switch to the graph tab');
}

async function assertMobilePanels(page: Page): Promise<void> {
  await page.locator('[data-mobile-panel="filters"]').click();
  await page.waitForFunction(
    () => document.querySelector('#stage')?.classList.contains('mobile-filters-open'),
    undefined,
    {
      timeout: MOBILE_QUERY_TIMEOUT_MS,
    },
  );
  const filtersBox = await page.locator('.leftrail').boundingBox();
  if (!filtersBox || filtersBox.y < MIN_DRAWER_TOP_Y || filtersBox.height < MIN_DETAIL_DRAWER_HEIGHT) {
    throw new Error(`mobile filters drawer geometry looked wrong: ${JSON.stringify(filtersBox)}`);
  }
  const closeBox = await page.locator('#btn-mobile-close').boundingBox();
  if (!closeBox || closeBox.width < 24 || closeBox.height < 24) {
    throw new Error(`mobile drawer close control was not usable: ${JSON.stringify(closeBox)}`);
  }
  await page.locator('#btn-mobile-close').click();
  await page.waitForFunction(
    () =>
      !document.querySelector('#stage')?.classList.contains('mobile-filters-open') &&
      !document.querySelector('#stage')?.classList.contains('mobile-detail-open') &&
      !document.querySelector('#canvas-col')?.classList.contains('with-codepane'),
    undefined,
    { timeout: MOBILE_QUERY_TIMEOUT_MS },
  );
  await page.locator('[data-mobile-panel="fit"]').click();
  await waitForGraph(page);
}

function hasCartographDb(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.cartograph', 'cartograph.db'));
}

function isThisCartographRepo(projectPath: string): boolean {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8')) as { name?: string };
    return pkg.name === '@adder-factory/cartograph';
  } catch {
    return false;
  }
}

function shouldRunRealProjectSmoke(projectPath: string): boolean {
  if (envFlag(VIEWER_SMOKE_REAL_PROJECT_REQUIRED_ENV)) return true;
  if (process.env[VIEWER_SMOKE_REAL_PROJECT_ENV] === '0') return false;
  if (envFlag(VIEWER_SMOKE_REAL_PROJECT_ENV)) return true;
  return isThisCartographRepo(projectPath) && hasCartographDb(projectPath);
}

async function runRealProjectLayoutSnapshots(projectPath: string): Promise<void> {
  if (!hasCartographDb(projectPath)) {
    if (envFlag(VIEWER_SMOKE_REAL_PROJECT_REQUIRED_ENV)) {
      throw new Error(`real-project viewer smoke requires ${path.join(projectPath, '.cartograph', 'cartograph.db')}`);
    }
    printLine('viewer-smoke real-project SKIP: .cartograph/cartograph.db not found');
    return;
  }

  const playwright = await loadPlaywright();
  if (!playwright) return;

  const handle = await startViewerServer(projectPath, { port: 0 });
  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  try {
    for (const snapshot of REAL_PROJECT_LAYOUT_SNAPSHOTS) {
      const targetUrl = `${handle.url}${'hash' in snapshot ? snapshot.hash : ''}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await waitForGraph(page);
      if ('search' in snapshot) await focusSymbolViaSearch(page, snapshot.search);
      await assertDiagnosticSnapshot(page, snapshot);
      await captureViewerScreenshot(page, `real-project-${snapshot.name}`);
    }
    printLine('viewer-smoke real-project PASS');
  } catch (err) {
    const files = await writeViewerSmokeFailureArtifacts(page, 'real-project', err).catch((artifactErr) => [
      `artifact capture failed: ${String(artifactErr)}`,
    ]);
    printLine(`viewer-smoke real-project artifacts: ${files.join(', ')}`);
    throw err;
  } finally {
    await browser.close();
    await handle.close();
  }
}

async function runSmoke(url: string): Promise<void> {
  const playwright = await loadPlaywright();
  if (!playwright) return;

  const browser = await playwright.chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: DESKTOP_VIEWPORT });
  const errors: string[] = [];
  page.on('console', (msg) => {
    const text = consoleText(msg);
    if (text.toLowerCase().includes('error')) errors.push(text);
  });
  page.on('pageerror', (err) => errors.push(consoleText(err)));

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await runViewerSmokeLayoutWorkflow({
      page,
      url,
      assertBugReportCopy,
      assertCalmerDefaultUi,
      assertDenseGraphFixtureSpreads,
      assertDensityControls,
      assertEdgeKindFilters,
      assertEdgeLensControl,
      assertGraphExports,
      assertGraphLayoutNotLinear,
      assertGraphLayoutStableAcrossReload,
      assertLayoutQualityAndDiagnostics,
      assertPinnedLayoutControls,
      assertSearchDisambiguation,
      assertSyntheticForceLayoutDoesNotCollapse,
      assertViewerStateStore,
      assertZoomControls,
      captureViewerScreenshot,
      exposeAdvancedViewerControls,
      waitForGraph,
      waitForSelector: (selector) => page.waitForSelector(selector, { state: 'visible', timeout: SEARCH_TIMEOUT_MS }),
    });
    await runViewerSmokeFeaturesWorkflow({
      page,
      url,
      assertDetailGrouping,
      assertEdgeInspector,
      assertEscapeClearsSelection,
      assertFindingsInteraction,
      assertGraphSnapshotReplay,
      assertGraphToolStates,
      assertGroupCollapse,
      assertHealthFilters,
      assertHealthView,
      assertInteractionRaceStability,
      assertLiveView,
      assertTraceView,
      assertKindFilters,
      assertLocalStateCorruptionRecovery,
      assertNavigationHistoryRefocusesGraph,
      assertResetView,
      assertResetViewerLocalState,
      assertSelectedNeighborhood,
      assertSubpanelSymbolNavigation,
      assertTooltips,
      captureViewerScreenshot,
      exposeAdvancedViewerControls,
      focusSymbolViaSearch,
      setSimpleViewerChrome,
    });
    await runViewerSmokeMobileWorkflow({
      page,
      assertGraphFitsViewport,
      assertMobilePanels,
      assertVisibleEdgesConnect,
      captureViewerScreenshot,
      detailOpenFastTimeoutMs: DETAIL_OPEN_FAST_TIMEOUT_MS,
      minCodeDrawerHeight: MIN_CODE_DRAWER_HEIGHT,
      minDetailDrawerHeight: MIN_DETAIL_DRAWER_HEIGHT,
      minDrawerTopY: MIN_DRAWER_TOP_Y,
      mobileQueryTimeoutMs: MOBILE_QUERY_TIMEOUT_MS,
      mobileViewport: MOBILE_VIEWPORT,
      waitForGraph,
    });

    if (errors.length > 0) throw new Error(`browser reported errors:\n${errors.join('\n')}`);
    printLine('viewer-smoke PASS');
  } catch (err) {
    const files = await writeViewerSmokeFailureArtifacts(page, 'fixture', err).catch((artifactErr) => [
      `artifact capture failed: ${String(artifactErr)}`,
    ]);
    printLine(`viewer-smoke artifacts: ${files.join(', ')}`);
    throw err;
  } finally {
    await browser.close();
  }
}

let handle: ViewerHandle | null = null;
const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-smoke-'));
try {
  writeFixture(projectPath);
  await buildFixtureIndex(projectPath);
  seedTraceFixture(projectPath);
  handle = await startViewerServer(projectPath, { port: 0 });
  await runSmoke(handle.url);
  const realProjectPath = process.cwd();
  if (shouldRunRealProjectSmoke(realProjectPath)) await runRealProjectLayoutSnapshots(realProjectPath);
} finally {
  if (handle) await handle.close();
  fs.rmSync(projectPath, { recursive: true, force: true });
}
