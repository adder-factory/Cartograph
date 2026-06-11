/* Graph layout, fit, zoom, and pinned positions
   Split from viewer.graph-core.app to keep the graph viewer modules small. */

const LAYOUT_COLLISION_MAX_NODES = 360;
const LAYOUT_COLLISION_ITERATIONS = 56;
const LAYOUT_COLLISION_PADDING = 18;
const LAYOUT_COLLISION_LABEL_PADDING = 18;
const LAYOUT_COLLISION_MIN_MOVE = 0.05;
const LAYOUT_WATCHDOG_MIN_NODES = 8;
const LAYOUT_WATCHDOG_MIN_SPAN = 80;
const LAYOUT_WATCHDOG_MIN_LINE_SPREAD = 8;
const LAYOUT_WATCHDOG_LINE_SPREAD_RATIO = 0.04;
const LAYOUT_WATCHDOG_POSITION_LIMIT = 600;
const LAYOUT_QUALITY_KEY = 'cartograph-viewer-layout-quality-v1';
const LAYOUT_QUALITY_MODES = {
  fast: {
    label: 'Fast',
    note: 'Fast layout.',
    spacing: 0.82,
    edgeLength: 0.84,
    repulsion: 0.72,
    iterations: 0.48,
    collisionIterations: 30,
    fcoseQuality: 'default',
  },
  balanced: {
    label: 'Balanced',
    note: 'Balanced layout.',
    spacing: 1,
    edgeLength: 1,
    repulsion: 1,
    iterations: 1,
    collisionIterations: LAYOUT_COLLISION_ITERATIONS,
    fcoseQuality: null,
  },
  spread: {
    label: 'Spread',
    note: 'Spread layout.',
    spacing: 1.34,
    edgeLength: 1.28,
    repulsion: 1.55,
    iterations: 1.18,
    collisionIterations: 78,
    fcoseQuality: 'proof',
  },
};
let graphLayoutQuality = (() => {
  try {
    const saved = localStorage.getItem(LAYOUT_QUALITY_KEY);
    if (saved && Object.hasOwn(LAYOUT_QUALITY_MODES, saved)) return saved;
    if (saved) viewerStorageRemove(LAYOUT_QUALITY_KEY);
    return 'balanced';
  } catch {
    return 'balanced';
  }
})();
syncViewerGraphState({ layoutQuality: graphLayoutQuality });
let lastGraphLayoutRun = {
  durationMs: 0,
  engine: 'pending',
  quality: graphLayoutQuality,
  timestamp: 0,
  watchdogReason: '',
  watchdogRetried: false,
};
let graphLayoutWatchdogState = {
  after: null,
  before: null,
  reason: '',
  retried: false,
  skipped: '',
  timestamp: 0,
};
let graphVisibilityStats = {
  hiddenEdgeByEndpointCount: 0,
  hiddenEdgeByFilterCount: 0,
  hiddenEdgeByLensCount: 0,
  hiddenNodeByDensityCount: 0,
  totalEdgeCount: 0,
  totalNodeCount: 0,
  visibleEdgeCount: 0,
  visibleNodeCount: 0,
};

function layoutQualityConfig() {
  return LAYOUT_QUALITY_MODES[graphLayoutQuality] || LAYOUT_QUALITY_MODES.balanced;
}

function scaleLayoutValue(value, factor, min = 1) {
  return Math.max(min, Math.round(value * factor));
}

function syncLayoutQualityControl() {
  document.querySelectorAll('[data-layout-quality]').forEach((btn) => {
    const on = btn.dataset.layoutQuality === graphLayoutQuality;
    btn.dataset.active = on ? '1' : '0';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const note = document.getElementById('layout-quality-note');
  const config = layoutQualityConfig();
  if (note) note.textContent = config.note;
}

function setGraphLayoutQuality(mode, opts = {}) {
  if (!Object.hasOwn(LAYOUT_QUALITY_MODES, mode)) mode = 'balanced';
  const changed = graphLayoutQuality !== mode;
  graphLayoutQuality = mode;
  try { localStorage.setItem(LAYOUT_QUALITY_KEY, graphLayoutQuality); } catch {}
  syncViewerGraphState({ layoutQuality: graphLayoutQuality });
  syncLayoutQualityControl();
  if (changed && opts.relayout !== false) {
    clearPinnedLayoutForCurrentGraph();
    graphContentNodes().unlock().removeClass('pinned');
    relayoutAndFit();
    if (typeof writeHashState === 'function') writeHashState();
  }
}

const PINNED_LAYOUTS_KEY = 'cartograph-viewer-pinned-layouts-v1';
const PINNED_LAYOUT_VERSION = 2;
const PINNED_LAYOUT_LIMIT = 32;
let currentGraphLayoutKey = null;

function graphLayoutScope() {
  return liveProjectRoot || document.querySelector('.topbar .path')?.textContent || location.pathname || 'viewer';
}

function checkedLayoutValues(selector, datasetKey) {
  return Array.from(document.querySelectorAll(selector))
    .filter((el) => el.checked)
    .map((el) => el.dataset[datasetKey])
    .filter(Boolean)
    .sort();
}

function activeLayoutKindChips() {
  return Array.from(document.querySelectorAll('#kind-chips .kind-chip'))
    .map((chip, index) => chip.dataset.active === '1' ? String(index) : null)
    .filter((value) => value !== null);
}

function graphLayoutStateFingerprint() {
  const density = typeof graphDensityMode === 'undefined' ? 'core' : graphDensityMode;
  const detail = typeof detailGroupingMode === 'undefined' ? 'grouped' : detailGroupingMode;
  const scope = typeof breadcrumbScope === 'undefined' ? '' : (breadcrumbScope || '');
  const collapsed = typeof collapsedGroupIds === 'undefined' ? [] : [...collapsedGroupIds].map(String).sort();
  return [
    `v:${PINNED_LAYOUT_VERSION}`,
    `density:${density}`,
    `detail:${detail}`,
    `kinds:${activeLayoutKindChips().join(',')}`,
    `health:${checkedLayoutValues('[data-filter-health]', 'filterHealth').join(',')}`,
    `files:${checkedLayoutValues('[data-filter-scope]', 'filterScope').join(',')}`,
    `edges:${checkedLayoutValues('[data-filter-edge]', 'filterEdge').join(',')}`,
    `scope:${scope}`,
    `collapsed:${collapsed.join(',')}`,
  ].join('|');
}

function graphLayoutKeyForParts(nodeIds, edgeParts) {
  const nodes = [...nodeIds].map(String).sort().join('|');
  const edges = [...edgeParts].map(String).sort().join('|');
  return `${hashString(graphLayoutScope())}:${hashString(nodes)}:${hashString(edges)}:${hashString(graphLayoutStateFingerprint())}`;
}

function graphLayoutKeyForPayload(g) {
  const nodeIds = (g.nodes ?? []).map((n) => n.id);
  const edgeParts = (g.edges ?? []).map((e) => `${e.source}>${e.target}:${e.kind || ''}`);
  return graphLayoutKeyForParts(nodeIds, edgeParts);
}

function graphLayoutKeyForCurrentGraph() {
  const nodeIds = graphContentNodes().map((n) => n.id());
  const edgeParts = cy.edges()
    .filter((e) => !e.data('collapsedEdge') && !e.data('detailBucketEdge'))
    .map((e) => `${e.source().id()}>${e.target().id()}:${e.data('kind') || ''}`);
  return graphLayoutKeyForParts(nodeIds, edgeParts);
}

function refreshGraphLayoutKey() {
  currentGraphLayoutKey = graphLayoutKeyForCurrentGraph();
  return currentGraphLayoutKey;
}

function sanitizePinnedLayoutStore(store) {
  if (!store || typeof store !== 'object' || Array.isArray(store)) return {};
  const entries = Object.entries(store)
    .filter(([, entry]) => entry && typeof entry === 'object' && entry.positions && typeof entry.positions === 'object')
    .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
    .slice(0, PINNED_LAYOUT_LIMIT);
  const sanitized = {};
  for (const [key, entry] of entries) {
    const positions = Object.entries(entry.positions)
      .filter(([, pos]) => pos && Number.isFinite(pos.x) && Number.isFinite(pos.y))
      .slice(0, LAYOUT_WATCHDOG_POSITION_LIMIT);
    if (positions.length === 0) continue;
    sanitized[key] = {
      version: entry.version || PINNED_LAYOUT_VERSION,
      updatedAt: Number.isFinite(entry.updatedAt) ? entry.updatedAt : 0,
      nodeCount: Number.isFinite(entry.nodeCount) ? entry.nodeCount : positions.length,
      positions: Object.fromEntries(positions),
    };
  }
  return sanitized;
}

function readPinnedLayoutStore() {
  const raw = readViewerJsonStorage(PINNED_LAYOUTS_KEY, {}, {
    validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
  });
  const sanitized = sanitizePinnedLayoutStore(raw);
  try {
    if (JSON.stringify(raw) !== JSON.stringify(sanitized)) writeViewerJsonStorage(PINNED_LAYOUTS_KEY, sanitized);
  } catch {}
  return sanitized;
}

function writePinnedLayoutStore(store) {
  try {
    const entries = Object.entries(store)
      .sort((a, b) => (b[1]?.updatedAt || 0) - (a[1]?.updatedAt || 0))
      .slice(0, PINNED_LAYOUT_LIMIT);
    localStorage.setItem(PINNED_LAYOUTS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {}
}

function pinnedLayoutEntry() {
  if (!currentGraphLayoutKey) return null;
  const entry = readPinnedLayoutStore()[currentGraphLayoutKey];
  return entry && typeof entry === 'object' ? entry : null;
}

function hasPinnedLayoutEntry() {
  const entry = pinnedLayoutEntry();
  return Boolean(entry && entry.positions && Object.keys(entry.positions).length > 0);
}

function savePinnedLayoutPositions() {
  refreshGraphLayoutKey();
  if (!currentGraphLayoutKey) return;
  const positions = {};
  graphContentNodes().forEach((node) => {
    if (!node.hasClass('pinned') && !node.locked()) return;
    const pos = node.position();
    if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    positions[node.id()] = { x: Math.round(pos.x * 100) / 100, y: Math.round(pos.y * 100) / 100 };
  });
  const store = readPinnedLayoutStore();
  if (Object.keys(positions).length === 0) {
    delete store[currentGraphLayoutKey];
  } else {
    store[currentGraphLayoutKey] = {
      version: PINNED_LAYOUT_VERSION,
      updatedAt: Date.now(),
      nodeCount: graphContentNodes().length,
      positions,
    };
  }
  writePinnedLayoutStore(store);
}

function clearPinnedLayoutForCurrentGraph() {
  refreshGraphLayoutKey();
  if (!currentGraphLayoutKey) return;
  const store = readPinnedLayoutStore();
  delete store[currentGraphLayoutKey];
  writePinnedLayoutStore(store);
}

function applyPinnedLayoutPositions() {
  graphContentNodes().unlock().removeClass('pinned');
  const entry = pinnedLayoutEntry();
  const positions = entry?.positions && typeof entry.positions === 'object' ? entry.positions : {};
  graphContentNodes().forEach((node) => {
    const pos = positions[node.id()];
    if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return;
    node.position({ x: pos.x, y: pos.y });
    node.lock();
    node.addClass('pinned');
  });
  syncLayoutControls();
}

function refreshPinnedLayoutForCurrentState() {
  const previousKey = currentGraphLayoutKey;
  refreshGraphLayoutKey();
  if (previousKey !== currentGraphLayoutKey) {
    applyPinnedLayoutPositions();
    return true;
  }
  syncLayoutControls();
  return false;
}

function pinnedGraphNodes() {
  return graphContentNodes().filter((node) => node.hasClass('pinned') || node.locked());
}

function syncLayoutControls() {
  const pinBtn = document.getElementById('btn-layout-pin');
  const unlockBtn = document.getElementById('btn-layout-unlock');
  const resetBtn = document.getElementById('btn-layout-reset');
  if (!pinBtn || !unlockBtn || !resetBtn) return;
  const visible = visibleGraphContentNodes().length;
  const pinned = pinnedGraphNodes().length;
  pinBtn.disabled = visible === 0;
  unlockBtn.disabled = pinned === 0;
  resetBtn.disabled = graphContentNodes().length === 0 && !hasPinnedLayoutEntry();
  pinBtn.dataset.active = pinned > 0 ? '1' : '0';
  unlockBtn.dataset.active = '0';
  resetBtn.dataset.active = '0';
  pinBtn.dataset.tooltip = pinned > 0
    ? `Lock visible node positions (${pinned} already pinned)`
    : 'Lock visible node positions';
  unlockBtn.dataset.tooltip = pinned > 0
    ? `Unlock ${pinned} pinned node${pinned === 1 ? '' : 's'}`
    : 'Unlock pinned node positions';
  resetBtn.dataset.tooltip = 'Clear pinned positions and rerun layout';
}

function pinVisibleGraphPositions() {
  refreshGraphLayoutKey();
  const nodes = visibleGraphContentNodes();
  if (nodes.length === 0) return;
  nodes.forEach((node) => {
    node.lock();
    node.addClass('pinned');
  });
  savePinnedLayoutPositions();
  syncLayoutControls();
}

function unlockPinnedGraphPositions() {
  const pinned = pinnedGraphNodes();
  if (pinned.length === 0) return;
  pinned.unlock().removeClass('pinned');
  savePinnedLayoutPositions();
  syncLayoutControls();
}

function resetPinnedGraphLayout() {
  clearPinnedLayoutForCurrentGraph();
  graphContentNodes().unlock().removeClass('pinned');
  relayoutAndFit();
  savePinnedLayoutPositions();
  syncLayoutControls();
}

function initializeGraphLayoutState() {
  refreshGraphLayoutKey();
  applyPinnedLayoutPositions();
}

function graphFitClampBounds() {
  const min = typeof VIEWER_MIN_ZOOM === 'number' ? VIEWER_MIN_ZOOM : 0.04;
  return isMobileViewport() ? { min, max: 0.96 } : { min, max: 1.08 };
}

function fitGraph() {
  cy.resize();
  const bounds = graphFitClampBounds();
  fitAndClamp(bounds.min, bounds.max);
  updateLabelVisibility();
}

function resizeGraphSoon(fit = true) {
  setTimeout(() => {
    cy.resize();
    if (fit) fitGraph();
    else updateLabelVisibility();
  }, 16);
}


function zoomBy(factor) {
  const cur = cy.zoom();
  const next = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), cur * factor));
  // Zoom toward the center of the viewport, not the cursor — feels
  // less jumpy when triggered from a button instead of a wheel.
  cy.zoom({ level: next, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
}

cy.on('dragfree', 'node', (evt) => {
  const n = evt.target;
  // detailBucket nodes are excluded from graphContentNodes(), so a
  // locked bucket would be uncounted by "Unlock N pinned" and
  // unreleasable — never pin them.
  if (n.data('isGroup') || n.data('collapsedProxy') || n.data('detailBucket')) return;
  n.lock();
  n.addClass('pinned');
  savePinnedLayoutPositions();
  syncLayoutControls();
});

let labelVisibilityRaf = 0;
cy.on('zoom', () => {
  if (labelVisibilityRaf) return;
  labelVisibilityRaf = requestAnimationFrame(() => {
    labelVisibilityRaf = 0;
    updateLabelVisibility();
  });
});

function fitAndClamp(zMin, zMax) {
  const elements = visibleGraphElements();
  cy.fit(elements, fitPadding());
  const z = cy.zoom();
  if (z > zMax)      { cy.zoom(zMax); cy.center(elements); }
  else if (z < zMin) { cy.zoom(zMin); cy.center(elements); }
}

function graphLayoutStats() {
  const nodes = graphContentNodes();
  const groups = cy.nodes().filter((n) => n.data('isGroup'));
  const edges = cy.edges();
  return { nodeCount: nodes.length, groupCount: groups.length, edgeCount: edges.length };
}

function visibleIncidentEdgeCount(n) {
  return n.connectedEdges().filter((edge) => edge.style('display') !== 'none').length;
}

function updateLabelVisibility() {
  const visibleNodes = graphContentNodes().filter((n) =>
    n.style('display') !== 'none' && !n.hasClass('collapse-hidden')
  );
  const groupNodes = cy.nodes().filter((n) => n.data('isGroup'));
  const zoom = cy.zoom();
  const dense = visibleNodes.length > 28 || zoom < 0.64;
  const labelBudget = zoom < 0.46 ? 10 : zoom < 0.7 ? 18 : 30;
  const incidentCounts = new Map(visibleNodes.map((n) => [n.id(), visibleIncidentEdgeCount(n)]));
  const ranked = visibleNodes
    .slice()
    .sort((a, b) =>
      (incidentCounts.get(b.id()) || 0) - (incidentCounts.get(a.id()) || 0) ||
      (b.data('centrality') || 0) - (a.data('centrality') || 0) ||
      String(a.data('label')).localeCompare(String(b.data('label'))),
    )
    .slice(0, labelBudget);
  const keyLabels = new Set(ranked.map((n) => n.id()));
  if (currentSymbolId) keyLabels.add(currentSymbolId);
  visibleNodes.forEach((node) => {
    const show = !dense || keyLabels.has(node.id()) || node.hasClass('focus') || node.hasClass('hovered');
    node.toggleClass('label-hidden', !show);
    node.toggleClass('label-key', show && (keyLabels.has(node.id()) || node.hasClass('focus')));
  });
  groupNodes.forEach((group) => {
    const visibleChildren = group.children().filter((child) =>
      child.style('display') !== 'none' && !child.hasClass('collapse-hidden')
    ).length;
    const collapsed = collapsedGroupIds.has(group.id());
    group.toggleClass('label-hidden', !collapsed && (visibleChildren < 2 || zoom < 0.48 || visibleNodes.length > 55));
  });
}

function layoutOptionsForGraph() {
  const { nodeCount, groupCount, edgeCount } = graphLayoutStats();
  const padding = fitPadding();
  const edgeDensity = edgeCount / Math.max(1, nodeCount);
  const heavyGraph = nodeCount > 55 || edgeDensity > 1.4;
  const veryHeavyGraph = nodeCount > 95 || edgeDensity > 2.2;
  const groupBoost = groupCount > 0 ? 1 : 0;
  const quality = layoutQualityConfig();
  if (nodeCount <= 2) {
    return {
      name: 'circle',
      animate: false,
      fit: true,
      padding,
      avoidOverlap: true,
      avoidOverlapPadding: scaleLayoutValue(24, quality.spacing, 16),
      nodeDimensionsIncludeLabels: true,
    };
  }
  if (nodeCount <= 10) {
    return {
      name: 'concentric',
      animate: false,
      fit: true,
      padding,
      minNodeSpacing: scaleLayoutValue(110, quality.spacing, 70),
      avoidOverlap: true,
      avoidOverlapPadding: scaleLayoutValue(20, quality.spacing, 14),
      nodeDimensionsIncludeLabels: true,
      concentric: (ele) => (ele.id() === currentSymbolId ? 3 : (ele.data('centrality') || 0)),
      levelWidth: () => 1,
    };
  }
  if (edgeCount < Math.max(4, nodeCount / 3) && groupCount <= 2) {
    return {
      name: 'grid',
      animate: false,
      fit: true,
      padding,
      avoidOverlap: true,
      avoidOverlapPadding: scaleLayoutValue(24, quality.spacing, 16),
      nodeDimensionsIncludeLabels: true,
      condense: false,
      rows: Math.ceil(Math.sqrt(nodeCount)),
    };
  }
  const baseNodeSeparation = groupBoost
    ? (veryHeavyGraph ? 285 : heavyGraph ? 250 : 220)
    : (veryHeavyGraph ? 245 : heavyGraph ? 215 : 170);
  const baseIdealEdgeLength = groupBoost
    ? (veryHeavyGraph ? 310 : heavyGraph ? 275 : 235)
    : (veryHeavyGraph ? 265 : heavyGraph ? 230 : 185);
  const baseNodeRepulsion = groupBoost
    ? (veryHeavyGraph ? 42000 : heavyGraph ? 34000 : 23000)
    : (veryHeavyGraph ? 36000 : heavyGraph ? 30000 : 19000);
  const nodeSeparation = scaleLayoutValue(baseNodeSeparation, quality.spacing, 120);
  const idealEdgeLength = scaleLayoutValue(baseIdealEdgeLength, quality.edgeLength, 120);
  const nodeRepulsion = scaleLayoutValue(baseNodeRepulsion, quality.repulsion, 12000);
  const baseIterations = veryHeavyGraph ? 6200 : heavyGraph ? 5200 : 4000;
  return fcoseLayoutOpts({
    padding,
    quality: quality.fcoseQuality || (nodeCount > 140 ? 'default' : 'proof'),
    randomize: false,
    nodeDimensionsIncludeLabels: true,
    nodeSeparation,
    idealEdgeLength,
    nodeRepulsion,
    gravity: groupBoost ? (heavyGraph ? 0.035 : 0.055) : (heavyGraph ? 0.07 : 0.11),
    gravityRange: heavyGraph ? 4.4 : 3.4,
    gravityCompound: groupBoost ? 0.35 : 0.5,
    numIter: scaleLayoutValue(baseIterations, quality.iterations, 1600),
    tilingPaddingVertical: scaleLayoutValue(groupBoost ? 56 : 38, quality.spacing, 24),
    tilingPaddingHorizontal: scaleLayoutValue(groupBoost ? 56 : 38, quality.spacing, 24),
  });
}

function isForceLayoutName(name) {
  return name === 'fcose' || name === 'cose';
}

function seedForceLayoutPositions(salt = '') {
  const nodes = graphContentNodes()
    .filter((node) => !node.locked())
    .sort((a, b) => String(a.id()).localeCompare(String(b.id())));
  if (nodes.length < 3) return;

  const radius = Math.max(280, Math.sqrt(nodes.length) * 80);
  const goldenAngle = Math.PI * (3 - Math.sqrt(5));
  nodes.forEach((node, index) => {
    const hash = hashNumber(`${graphLayoutScope()}:${salt}:${node.id()}`);
    const angle = index * goldenAngle + ((hash & 0xffff) / 0xffff) * 0.35;
    const ring = Math.sqrt((index + 0.5) / nodes.length);
    const jitter = (((hash >>> 16) & 0xff) / 255 - 0.5) * 44;
    const r = radius * ring + jitter;
    node.position({
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
    });
  });
}

function visibleLayoutContentNodes() {
  return visibleGraphContentNodes().filter((node) => !node.data('detailBucket'));
}

function layoutCollisionNodes() {
  return visibleLayoutContentNodes()
    .slice()
    .sort((a, b) => String(a.id()).localeCompare(String(b.id())))
    .slice(0, LAYOUT_COLLISION_MAX_NODES);
}

function layoutCollisionRadius(node) {
  const bodySize = Math.max(Number(node.outerWidth?.() || node.width?.() || 42), Number(node.outerHeight?.() || node.height?.() || 42));
  const degreePadding = Math.min(24, Math.sqrt(visibleIncidentEdgeCount(node)) * 3.2);
  const label = String(node.data('label') || node.id() || '');
  const labelPadding = Math.min(44, LAYOUT_COLLISION_LABEL_PADDING + Math.max(0, label.length - 8) * 0.85);
  return bodySize / 2 + LAYOUT_COLLISION_PADDING + degreePadding + labelPadding;
}

function layoutCollisionDirection(a, b) {
  const angle = (hashNumber(`${a.id()}:${b.id()}`) / 0xffffffff) * Math.PI * 2;
  return { x: Math.cos(angle), y: Math.sin(angle) };
}

function moveLayoutCollisionNode(node, dx, dy) {
  if (node.locked()) return 0;
  const pos = node.position();
  node.position({ x: pos.x + dx, y: pos.y + dy });
  return Math.hypot(dx, dy);
}

function relaxLayoutNodeCollisions() {
  const nodes = layoutCollisionNodes();
  if (nodes.length < 2) return;
  const radii = new Map(nodes.map((node) => [node.id(), layoutCollisionRadius(node)]));
  const maxIterations = layoutQualityConfig().collisionIterations || LAYOUT_COLLISION_ITERATIONS;
  cy.startBatch();
  try {
  for (let iter = 0; iter < maxIterations; iter++) {
    let maxMove = 0;
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const aRadius = radii.get(a.id()) || 0;
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        if (a.locked() && b.locked()) continue;
        const bRadius = radii.get(b.id()) || 0;
        const aPos = a.position();
        const bPos = b.position();
        let dx = bPos.x - aPos.x;
        let dy = bPos.y - aPos.y;
        let distance = Math.hypot(dx, dy);
        if (distance < 0.001) {
          const dir = layoutCollisionDirection(a, b);
          dx = dir.x;
          dy = dir.y;
          distance = 1;
        }
        const minDistance = aRadius + bRadius;
        const overlap = minDistance - distance;
        if (overlap <= 0) continue;
        const ux = dx / distance;
        const uy = dy / distance;
        const push = Math.min(96, overlap * 0.58);
        if (a.locked()) {
          maxMove = Math.max(maxMove, moveLayoutCollisionNode(b, ux * push, uy * push));
        } else if (b.locked()) {
          maxMove = Math.max(maxMove, moveLayoutCollisionNode(a, -ux * push, -uy * push));
        } else {
          const split = push / 2;
          maxMove = Math.max(
            maxMove,
            moveLayoutCollisionNode(a, -ux * split, -uy * split),
            moveLayoutCollisionNode(b, ux * split, uy * split),
          );
        }
      }
    }
    if (maxMove < LAYOUT_COLLISION_MIN_MOVE) break;
  }
  } finally {
    cy.endBatch();
  }
}

function isDegenerateLinearLayout(nodes = visibleLayoutContentNodes()) {
  if (nodes.length < 8) return false;
  const positions = nodes.map((node) => node.position());
  const xs = positions.map((pos) => pos.x);
  const ys = positions.map((pos) => pos.y);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
  if (width < 80 || height < 80) return true;

  const diagonalResiduals = positions.map((pos) => pos.y - pos.x);
  const antiDiagonalResiduals = positions.map((pos) => pos.y + pos.x);
  const residualSpread = (values) => Math.max(...values) - Math.min(...values);
  const narrowestLineSpread = Math.min(
    residualSpread(diagonalResiduals),
    residualSpread(antiDiagonalResiduals),
  );
  return narrowestLineSpread < Math.max(6, Math.min(width, height) * 0.03);
}

function graphLayoutWatchdogDiagnostics(label) {
  const diagnostics = typeof graphLayoutDiagnostics === 'function' ? graphLayoutDiagnostics(label) : null;
  // Strip the embedded watchdog state: it contains the PREVIOUS
  // before/after diagnostics, which embed the state before that, and
  // so on — each relayout otherwise nests one level deeper until
  // bug-report serialization runs out of memory.
  if (diagnostics) diagnostics.layoutWatchdog = null;
  return diagnostics;
}

function graphLayoutWatchdogReason(diagnostics) {
  if (!diagnostics || diagnostics.visibleNodeCount < LAYOUT_WATCHDOG_MIN_NODES) return '';
  if (diagnostics.disconnectedVisibleEdgeCount > 0) return 'visible edge geometry failed';
  if (diagnostics.nodeOverlapCount > 0) return 'visible nodes overlap';
  const minSpan = Math.min(diagnostics.renderedWidth, diagnostics.renderedHeight);
  const lineThreshold = Math.max(LAYOUT_WATCHDOG_MIN_LINE_SPREAD, minSpan * LAYOUT_WATCHDOG_LINE_SPREAD_RATIO);
  if (
    diagnostics.renderedWidth < LAYOUT_WATCHDOG_MIN_SPAN ||
    diagnostics.renderedHeight < LAYOUT_WATCHDOG_MIN_SPAN ||
    diagnostics.narrowestLineSpread < lineThreshold
  ) {
    return 'layout collapsed toward a line';
  }
  return '';
}

function graphLayoutWatchdogOptions(baseOptions) {
  const { name: _baseName, ...baseLayoutOptions } = baseOptions;
  const { nodeCount, groupCount, edgeCount } = graphLayoutStats();
  const edgeDensity = edgeCount / Math.max(1, nodeCount);
  const heavyGraph = nodeCount > 55 || edgeDensity > 1.4;
  const veryHeavyGraph = nodeCount > 95 || edgeDensity > 2.2;
  const groupBoost = groupCount > 0 ? 1 : 0;
  const nodeSeparation = groupBoost
    ? (veryHeavyGraph ? 390 : heavyGraph ? 340 : 285)
    : (veryHeavyGraph ? 340 : heavyGraph ? 295 : 245);
  const idealEdgeLength = groupBoost
    ? (veryHeavyGraph ? 420 : heavyGraph ? 365 : 310)
    : (veryHeavyGraph ? 360 : heavyGraph ? 315 : 265);
  const nodeRepulsion = groupBoost
    ? (veryHeavyGraph ? 64000 : heavyGraph ? 52000 : 40000)
    : (veryHeavyGraph ? 56000 : heavyGraph ? 47000 : 36000);
  return fcoseLayoutOpts({
    ...baseLayoutOptions,
    fit: true,
    gravity: groupBoost ? (heavyGraph ? 0.025 : 0.035) : (heavyGraph ? 0.04 : 0.06),
    gravityCompound: groupBoost ? 0.26 : 0.38,
    gravityRange: heavyGraph ? 5.2 : 4.2,
    idealEdgeLength,
    nodeRepulsion,
    nodeSeparation,
    numIter: veryHeavyGraph ? 7600 : heavyGraph ? 6600 : 5600,
    padding: fitPadding(),
    quality: 'proof',
    // randomize:false — runGraphLayout seeds salted positions for the
    // watchdog retry; randomizing would throw that determinism away.
    randomize: false,
    tilingPaddingHorizontal: groupBoost ? 74 : 56,
    tilingPaddingVertical: groupBoost ? 74 : 56,
  });
}

function runGraphLayout(options, salt = '') {
  if (isForceLayoutName(options.name)) seedForceLayoutPositions(salt);
  cy.layout(options).run();
  if (isForceLayoutName(options.name) && isDegenerateLinearLayout()) {
    // randomize:false — the salted re-seed IS the retry's variation;
    // randomize:true would discard those seeded positions and make the
    // retry nondeterministic.
    seedForceLayoutPositions(`${salt}:linear-retry`);
    cy.layout({ ...options, randomize: false }).run();
  }
  relaxLayoutNodeCollisions();
  const bounds = graphFitClampBounds();
  fitAndClamp(bounds.min, bounds.max);
  updateLabelVisibility();
}

function relayoutAndFit() {
  const options = layoutOptionsForGraph();
  const started = performance.now();
  runGraphLayout(options, 'primary');
  let watchdogReason = '';
  let watchdogRetried = false;
  let watchdogSkipped = '';
  let beforeWatchdog = graphLayoutWatchdogDiagnostics('layout-watchdog-before');
  watchdogReason = graphLayoutWatchdogReason(beforeWatchdog);
  if (watchdogReason) {
    if (pinnedGraphNodes().length > 0) {
      watchdogSkipped = 'pinned nodes locked';
    } else {
      watchdogRetried = true;
      runGraphLayout(graphLayoutWatchdogOptions(options), 'watchdog');
    }
  }
  const afterWatchdog = graphLayoutWatchdogDiagnostics('layout-watchdog-after');
  graphLayoutWatchdogState = {
    after: afterWatchdog,
    before: beforeWatchdog,
    reason: watchdogReason,
    retried: watchdogRetried,
    skipped: watchdogSkipped,
    timestamp: Date.now(),
  };
  syncLayoutControls();
  lastGraphLayoutRun = {
    durationMs: performance.now() - started,
    engine: watchdogRetried ? `${options.name}+watchdog` : options.name,
    quality: graphLayoutQuality,
    timestamp: Date.now(),
    watchdogReason,
    watchdogRetried,
  };
  if (typeof validateGraphState === 'function') validateGraphState('layout');
  // Reuse afterWatchdog rather than paying a third full overlap pass —
  // but re-attach the just-assigned watchdog state, since
  // graphLayoutWatchdogDiagnostics nulls the embedded copy (recursion
  // guard) and the panel/health pill read diagnostics.layoutWatchdog.
  syncGraphDiagnosticsPanel({ ...afterWatchdog, layoutWatchdog: graphLayoutWatchdogState });
}
