/* ───────── Filters ───────── */

const minCentrality = 0;
const DENSITY_KEY = 'cartograph-viewer-density-v1';
const DENSITY_LIMITS = { focus: 32, core: 80, all: Number.POSITIVE_INFINITY };
const DENSITY_LABELS = {
  focus: 'Focus keeps the tightest high-centrality slice plus the selected neighborhood.',
  core: 'Core keeps the most central symbols plus the selected neighborhood.',
  all: 'All shows every symbol that passes the active filters.',
};
const EDGE_LENS_KEY = 'cartograph-viewer-edge-lens-v1';
const EDGE_LENS_MODES = {
  all: 'All visible edges.',
  selected: 'Selected symbol edges.',
};
const DETAIL_GROUPING_KEY = 'cartograph-viewer-detail-grouping-v1';
const DETAIL_GROUP_MIN_SIZE = 2;
const DETAIL_GROUP_KINDS = new Set(['variable', 'constant', 'field', 'property', 'parameter', 'enum_member']);
const DETAIL_KIND_LABELS = {
  variable: 'variables',
  constant: 'constants',
  field: 'fields',
  property: 'properties',
  parameter: 'parameters',
  enum_member: 'enum members',
};
let pendingHashEdgeKinds = null;
let graphDensityMode = (() => {
  try {
    const saved = localStorage.getItem(DENSITY_KEY);
    if (saved && Object.hasOwn(DENSITY_LIMITS, saved)) return saved;
    if (saved) viewerStorageRemove(DENSITY_KEY);
    return 'core';
  } catch {
    return 'core';
  }
})();
let graphEdgeLensMode = (() => {
  try {
    const saved = localStorage.getItem(EDGE_LENS_KEY);
    if (saved && Object.hasOwn(EDGE_LENS_MODES, saved)) return saved;
    if (saved) viewerStorageRemove(EDGE_LENS_KEY);
    return 'all';
  } catch {
    return 'all';
  }
})();
let detailGroupingMode = (() => {
  try {
    const saved = localStorage.getItem(DETAIL_GROUPING_KEY);
    if (saved === 'expanded') return 'expanded';
    if (saved && saved !== 'grouped') viewerStorageRemove(DETAIL_GROUPING_KEY);
    return 'grouped';
  } catch {
    return 'grouped';
  }
})();
syncViewerGraphState({
  breadcrumbScope: typeof breadcrumbScope === 'undefined' ? null : breadcrumbScope,
  densityMode: graphDensityMode,
  detailGroupingMode,
  edgeLensMode: graphEdgeLensMode,
});

function selectedNeighborhoodIds() {
  if (!currentSymbolId) return new Set();
  const selected = cy.getElementById(currentSymbolId);
  if (selected.length === 0) return new Set();
  return new Set(selected.closedNeighborhood('node').filter((n) =>
    !n.data('isGroup') && !n.data('collapsedProxy') && !n.data('detailBucket')
  ).map((n) => n.id()));
}

function syncDetailControl() {
  document.querySelectorAll('[data-detail-mode]').forEach((btn) => {
    const on = btn.dataset.detailMode === detailGroupingMode;
    btn.dataset.active = on ? '1' : '0';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const note = document.getElementById('detail-note');
  if (note) {
    note.textContent = detailGroupingMode === 'grouped'
      ? 'Grouped keeps low-signal leaf nodes in local file buckets.'
      : 'Expanded shows every variable, field, constant, and parameter as a real node.';
  }
}

function setDetailGroupingMode(mode) {
  detailGroupingMode = mode === 'expanded' ? 'expanded' : 'grouped';
  try { localStorage.setItem(DETAIL_GROUPING_KEY, detailGroupingMode); } catch {}
  syncViewerGraphState({ detailGroupingMode });
  syncDetailControl();
}

function shouldGroupDetailNode(node, selectedNeighborhood) {
  if (detailGroupingMode !== 'grouped') return false;
  if (!DETAIL_GROUP_KINDS.has(String(node.data('kind') || ''))) return false;
  if (node.id() === currentSymbolId) return false;
  if (selectedNeighborhood?.has(node.id())) return false;
  return true;
}

function detailBucketKeyForNode(node) {
  const file = String(node.data('file') || 'unknown');
  const kind = String(node.data('kind') || 'detail');
  return `${file}|${kind}`;
}

function detailBucketIdForKey(key) {
  return `detail-bucket:${hashString(key)}`;
}

function detailBucketFileLabel(file) {
  const leaf = String(file || '').split('/').filter(Boolean).pop() || '';
  return leaf.replace(/\.[^.]+$/, '') || 'unknown';
}

function detailBucketLabel(kind, count, file) {
  const label = DETAIL_KIND_LABELS[kind] || `${kind}s`;
  return `${label} · ${detailBucketFileLabel(file)} (${count})`;
}

function clearDetailBuckets() {
  cy.edges().filter((edge) => edge.data('detailBucketEdge')).remove();
  cy.nodes().filter((node) => node.data('detailBucket')).remove();
  graphContentNodes().forEach((node) => node.removeData('detailBucketId'));
}

function addDetailBucket(key, rows) {
  const nodes = rows.map((row) => row.n);
  const first = nodes[0];
  const kind = String(first.data('kind') || 'detail');
  const file = first.data('file') || '';
  const id = detailBucketIdForKey(key);
  const parent = first.parent();
  const parentId = parent.length > 0 ? parent.id() : undefined;
  const position = nodes.reduce((acc, node) => {
    const p = node.position();
    acc.x += p.x;
    acc.y += p.y;
    return acc;
  }, { x: 0, y: 0 });
  position.x /= Math.max(1, nodes.length);
  position.y /= Math.max(1, nodes.length);
  nodes.forEach((node) => node.data('detailBucketId', id));
  return cy.add({
    group: 'nodes',
    data: {
      id,
      label: detailBucketLabel(kind, nodes.length, file),
      kind: 'detail_bucket',
      health: 'healthy',
      file,
      centrality: Math.max(...nodes.map((node) => Number(node.data('centrality') || 0)), 0),
      parent: parentId,
      detailBucket: 1,
      bucketKind: kind,
      bucketKey: key,
      bucketNodeIds: nodes.map((node) => node.id()).join('\n'),
      childCount: nodes.length,
    },
    position,
  });
}

function syncDetailBuckets(candidateBuckets) {
  clearDetailBuckets();
  let visibleBuckets = 0;
  for (const [key, rows] of candidateBuckets) {
    if (rows.length < DETAIL_GROUP_MIN_SIZE) continue;
    const bucket = addDetailBucket(key, rows);
    bucket.style('display', 'element');
    visibleBuckets++;
  }
  return visibleBuckets;
}

function detailBucketForNode(node) {
  const id = node?.data?.('detailBucketId');
  if (!id) return null;
  const bucket = cy.getElementById(id);
  return bucket.length > 0 ? bucket : null;
}

function endpointForDetailBucketEdge(node) {
  return detailBucketForNode(node) || node;
}

function rebuildDetailBucketEdges() {
  cy.edges().filter((edge) => edge.data('detailBucketEdge')).remove();
  const byId = new Map();
  cy.edges().filter((edge) => !edge.data('collapsedEdge') && !edge.data('detailBucketEdge')).forEach((edge) => {
    const source = endpointForDetailBucketEdge(edge.source());
    const target = endpointForDetailBucketEdge(edge.target());
    if (!source || !target || source.id() === target.id()) return;
    if (source.id() === edge.source().id() && target.id() === edge.target().id()) return;
    const kind = edgeKind(edge);
    const id = edgeElementId(source.id(), target.id(), kind, 'detail-edge');
    const existing = byId.get(id);
    if (existing) {
      existing.data.count += 1;
      return;
    }
    byId.set(id, {
      group: 'edges',
      data: {
        id,
        source: source.id(),
        target: target.id(),
        kind,
        count: 1,
        detailBucketEdge: 1,
      },
    });
  });
  if (byId.size > 0) cy.add([...byId.values()]);
}

function updateSelectedNeighborhoodHighlight() {
  cy.nodes().removeClass('selected-neighbor');
  cy.edges().removeClass('selected-edge');
  if (!currentSymbolId) return;
  const selected = cy.getElementById(currentSymbolId);
  if (selected.length === 0 || selected.style('display') === 'none') return;
  selected.addClass('focus');
  selected.connectedEdges().forEach((edge) => {
    if (edge.style('display') === 'none') return;
    edge.addClass('selected-edge');
    edge.connectedNodes().forEach((node) => {
      if (node.id() === currentSymbolId || node.style('display') === 'none' || node.hasClass('collapse-hidden')) return;
      node.addClass('selected-neighbor');
    });
  });
}

function syncDensityControl() {
  document.querySelectorAll('[data-density-mode]').forEach((btn) => {
    const on = btn.dataset.densityMode === graphDensityMode;
    btn.dataset.active = on ? '1' : '0';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  const note = document.getElementById('density-note');
  if (note) note.textContent = DENSITY_LABELS[graphDensityMode] ?? DENSITY_LABELS.core;
}

function syncEdgeLensControl() {
  document.querySelectorAll('[data-edge-lens]').forEach((btn) => {
    const on = btn.dataset.edgeLens === graphEdgeLensMode;
    btn.dataset.active = on ? '1' : '0';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function setGraphEdgeLensMode(mode, opts = {}) {
  graphEdgeLensMode = Object.hasOwn(EDGE_LENS_MODES, mode) ? mode : 'all';
  try { localStorage.setItem(EDGE_LENS_KEY, graphEdgeLensMode); } catch {}
  syncViewerGraphState({ edgeLensMode: graphEdgeLensMode });
  syncEdgeLensControl();
  if (opts.apply !== false) {
    applyFilters();
    if (typeof writeHashState === 'function') writeHashState();
  }
}

function edgeKindRank(kind) {
  const idx = EDGE_KIND_ORDER.indexOf(kind);
  return idx === -1 ? EDGE_KIND_ORDER.length : idx;
}

function setEdgeKindsFromHash(raw) {
  const values = hashList(raw);
  if (values === null) return;
  pendingHashEdgeKinds = values;
  const inputs = Array.from(document.querySelectorAll('[data-filter-edge]'));
  if (inputs.length === 0) return;
  const selected = new Set(values);
  let matchedCurrentControls = values.length === 0;
  inputs.forEach((input) => {
    const checked = selected.has(input.dataset.filterEdge);
    input.checked = checked;
    if (checked) matchedCurrentControls = true;
  });
  if (matchedCurrentControls) pendingHashEdgeKinds = null;
}

function setAllEdgeKindFilters(checked) {
  document.querySelectorAll('[data-filter-edge]').forEach((input) => {
    input.checked = checked;
  });
}

function syncEdgeKindFilters() {
  const container = document.getElementById('edge-kind-filters');
  if (!container) return;
  const counts = new Map();
  cy.edges().forEach((edge) => {
    const kind = edge.data('kind') || 'edge';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  });
  const kinds = [...counts.keys()].sort((a, b) => edgeKindRank(a) - edgeKindRank(b) || a.localeCompare(b));
  if (kinds.length === 0) {
    container.innerHTML = '<div class="rail-row">No edges in graph</div>';
    return;
  }
  const previousInputs = Array.from(container.querySelectorAll('[data-filter-edge]'));
  const previousChecked = new Set(previousInputs.filter((input) => input.checked).map((input) => input.dataset.filterEdge));
  const allPreviousSelected = previousInputs.length > 0 && previousInputs.every((input) => input.checked);
  const selected = pendingHashEdgeKinds !== null
    ? new Set(pendingHashEdgeKinds)
    : previousInputs.length > 0
      ? new Set(kinds.filter((kind) => allPreviousSelected || previousChecked.has(kind)))
      : new Set(kinds);
  pendingHashEdgeKinds = null;
  container.innerHTML = kinds.map((kind) => `
    <label class="rail-row" data-tooltip="Show or hide ${escapeHtml(kind)} edges">
      <input type="checkbox" data-filter-edge="${escapeHtml(kind)}" ${selected.has(kind) ? 'checked' : ''}>
      <span class="edge-kind-swatch ${escapeHtml(edgeLineStyleForKind(kind))}" style="color:${escapeHtml(edgeColorForKind(kind))}"></span>
      ${escapeHtml(kind)}
      <span class="count">${counts.get(kind) || 0}</span>
    </label>
  `).join('');
}

function kindSetForChip(chip) {
  return String(chip.dataset.filterKinds || '')
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
}

function syncKindChipCounts() {
  const counts = new Map();
  graphContentNodes().forEach((node) => {
    const kind = node.data('kind') || 'unknown';
    counts.set(kind, (counts.get(kind) || 0) + 1);
  });
  document.querySelectorAll('#kind-chips .kind-chip').forEach((chip) => {
    const total = kindSetForChip(chip).reduce((sum, kind) => sum + (counts.get(kind) || 0), 0);
    chip.dataset.available = total > 0 ? '1' : '0';
    chip.setAttribute('aria-disabled', total > 0 ? 'false' : 'true');
    const countEl = chip.querySelector('[data-kind-count]');
    if (countEl) countEl.textContent = String(total);
  });
}

function syncHealthFilterCounts() {
  const counts = new Map([
    ['error', 0],
    ['warning', 0],
    ['info', 0],
    ['healthy', 0],
  ]);
  graphContentNodes().forEach((node) => {
    const health = node.data('health') || 'healthy';
    counts.set(health, (counts.get(health) || 0) + 1);
  });
  document.querySelectorAll('[data-filter-health]').forEach((input) => {
    const health = input.dataset.filterHealth;
    const count = counts.get(health) || 0;
    const row = input.closest('.rail-row');
    const countEl = row?.querySelector('[data-health-count]');
    if (countEl) countEl.textContent = formatNumber(count);
    input.disabled = count === 0;
    input.setAttribute('aria-disabled', count === 0 ? 'true' : 'false');
    row?.classList.toggle('health-unavailable', count === 0);
  });
}

function applyFilters() {
  // Active kinds come from the chip group: each chip's
  // data-filter-kinds is a comma-separated list (e.g. "class,struct,
  // enum") and inactive chips contribute none. The legacy
  // data-filter-kind checkbox path is gone — chips replaced it.
  const kinds = new Set();
  document.querySelectorAll('.kind-chip[data-active="1"]').forEach((chip) => {
    kindSetForChip(chip).forEach((k) => kinds.add(k));
  });
  syncKindChipCounts();
  syncHealthFilterCounts();
  const healths = new Set(
    Array.from(document.querySelectorAll('[data-filter-health]:checked'))
      .map(el => el.dataset.filterHealth)
  );
  const scopes = Array.from(document.querySelectorAll('[data-filter-scope]:checked'))
    .map(el => el.dataset.filterScope);
  const edgeInputs = Array.from(document.querySelectorAll('[data-filter-edge]'));
  const edgeKinds = new Set(edgeInputs.filter((el) => el.checked).map((el) => el.dataset.filterEdge));
  if (typeof refreshPinnedLayoutForCurrentState === 'function') refreshPinnedLayoutForCurrentState();

  const nodeRows = [];
  const graphNodes = graphContentNodes();
  const groupNodes = cy.nodes().filter((n) => n.data('isGroup'));
  const selectedNeighborhood = selectedNeighborhoodIds();
  const collapsedVisibleGroups = new Set();
  const groupVisibleChildCounts = new Map();
  graphNodes.forEach(n => {
    const kind = n.data('kind');
    const health = n.data('health');
    const file = n.data('file') || '';
    const cent = LIVE_MODE
      ? (liveNodeIndex.get(n.id())?.centrality ?? 0)
      : (NODES.find(x => x.id === n.id())?.centrality ?? 0);
    const inKind = kinds.has(kind);
    const inHealth = healths.has(health);
    const inScope = scopes.length === 0 || scopes.some(s => file.startsWith(s)) || file === '';
    const inCent = cent >= minCentrality;
    // Breadcrumb scope is a stricter override on top of the rail
    // file-scope: when set, only nodes under that exact prefix
    // survive (regardless of which rail scopes are checked).
    const inBreadcrumb = !breadcrumbScope || file.startsWith(breadcrumbScope);
    const baseVisible = inKind && inHealth && inScope && inCent && inBreadcrumb;
    nodeRows.push({ n, baseVisible, cent });
  });

  const baseVisibleRows = nodeRows.filter((row) => row.baseVisible);
  const rowById = new Map(nodeRows.map((row) => [row.n.id(), row]));
  const limit = DENSITY_LIMITS[graphDensityMode] ?? DENSITY_LIMITS.core;
  const densityKeep = new Set();
  if (Number.isFinite(limit)) {
    baseVisibleRows
      .slice()
      .sort((a, b) => b.cent - a.cent || String(a.n.data('label')).localeCompare(String(b.n.data('label'))))
      .slice(0, limit)
      .forEach((row) => densityKeep.add(row.n.id()));
    const neighborhood = selectedNeighborhoodIds();
    for (const row of baseVisibleRows) {
      if (neighborhood.has(row.n.id())) densityKeep.add(row.n.id());
    }
  }

  const detailCandidateBuckets = new Map();
  for (const row of nodeRows) {
    row.visibleBeforeCollapse = Boolean(row.baseVisible) && (!Number.isFinite(limit) || densityKeep.has(row.n.id()));
    row.collapsedParent = row.visibleBeforeCollapse ? collapsedParentForNode(row.n) : null;
    if (!row.visibleBeforeCollapse || row.collapsedParent || !shouldGroupDetailNode(row.n, selectedNeighborhood)) continue;
    const key = detailBucketKeyForNode(row.n);
    if (!detailCandidateBuckets.has(key)) detailCandidateBuckets.set(key, []);
    detailCandidateBuckets.get(key).push(row);
  }
  const groupedDetailNodeIds = new Set();
  for (const rows of detailCandidateBuckets.values()) {
    if (rows.length < DETAIL_GROUP_MIN_SIZE) continue;
    rows.forEach((row) => groupedDetailNodeIds.add(row.n.id()));
  }

  let visibleCount = 0;
  let visibleBeforeCollapseCount = 0;
  graphNodes.forEach(n => {
    const row = rowById.get(n.id());
    const visibleBeforeCollapse = Boolean(row?.visibleBeforeCollapse);
    const collapsedParent = row?.collapsedParent || null;
    const groupedDetail = groupedDetailNodeIds.has(n.id());
    if (visibleBeforeCollapse) {
      visibleBeforeCollapseCount++;
      if (collapsedParent) {
        collapsedVisibleGroups.add(collapsedParent.id());
        groupVisibleChildCounts.set(collapsedParent.id(), (groupVisibleChildCounts.get(collapsedParent.id()) || 0) + 1);
      }
    }
    n.data('filterVisible', visibleBeforeCollapse ? 1 : 0);
    const visible = visibleBeforeCollapse && !collapsedParent && !groupedDetail;
    n.toggleClass('collapse-hidden', false);
    n.style('display', visible ? 'element' : 'none');
    if (visible) visibleCount++;
  });
  const detailBucketCount = syncDetailBuckets(detailCandidateBuckets);
  groupNodes.forEach((group) => {
    const collapsed = collapsedGroupIds.has(group.id());
    const visibleChildCount = groupVisibleChildCounts.get(group.id()) ||
      group.children().filter((child) => child.data('filterVisible')).length;
    group.data('visibleChildCount', visibleChildCount);
    updateGroupCollapseLabel(group);
    const hasVisibleChild = collapsed
      ? collapsedVisibleGroups.has(group.id())
      : group.children().some((child) => child.style('display') !== 'none' && !child.hasClass('collapse-hidden'));
    group.style('display', hasVisibleChild && !collapsed ? 'element' : 'none');
  });
  syncCollapsedGroupProxies(collapsedVisibleGroups);
  rebuildCollapsedBoundaryEdges();
  rebuildDetailBucketEdges();
  let edgeCount = 0;
  let hiddenEdgeByEndpointCount = 0;
  let hiddenEdgeByFilterCount = 0;
  let hiddenEdgeByLensCount = 0;
  const selectedEdgeLensActive = graphEdgeLensMode === 'selected' && Boolean(currentSymbolId);
  cy.edges().forEach(e => {
    const sourceVisible = e.source().style('display') !== 'none' && !e.source().hasClass('collapse-hidden');
    const targetVisible = e.target().style('display') !== 'none' && !e.target().hasClass('collapse-hidden');
    const endpointsVisible = sourceVisible && targetVisible;
    const edgeKindVisible = edgeInputs.length === 0 || edgeKinds.has(e.data('kind') || 'edge');
    const lensVisible =
      !selectedEdgeLensActive ||
      e.source().id() === currentSymbolId ||
      e.target().id() === currentSymbolId;
    const visible = endpointsVisible && edgeKindVisible && lensVisible;
    if (!endpointsVisible) hiddenEdgeByEndpointCount++;
    else if (!edgeKindVisible) hiddenEdgeByFilterCount++;
    else if (!lensVisible) hiddenEdgeByLensCount++;
    e.style('display', visible ? 'element' : 'none');
    if (visible) edgeCount++;
  });
  if (typeof clearHiddenEdgeSelection === 'function') clearHiddenEdgeSelection();
  updateLabelVisibility();
  const hiddenByDensity = baseVisibleRows.length - visibleBeforeCollapseCount;
  const densitySuffix = hiddenByDensity > 0
    ? ` · ${hiddenByDensity} hidden by <b style="color:var(--text)">${graphDensityMode}</b>`
    : '';
  const collapsedVisibleCount = cy.nodes().filter((node) =>
    node.data('collapsedProxy') && node.style('display') !== 'none'
  ).length;
  const visibleDisplayCount = visibleCount + collapsedVisibleCount;
  const detailSuffix = detailBucketCount > 0
    ? ` · ${detailBucketCount} detail bucket${detailBucketCount === 1 ? '' : 's'}`
    : '';
  const collapseSuffix = collapsedVisibleCount > 0
    ? ` · ${collapsedVisibleCount} collapsed group${collapsedVisibleCount === 1 ? '' : 's'}`
    : '';
  document.getElementById('canvas-counter').innerHTML =
    `Showing ${visibleDisplayCount + detailBucketCount} nodes · ${edgeCount} edges${densitySuffix}${collapseSuffix}${detailSuffix}`;
  graphVisibilityStats = {
    collapsedVisibleCount,
    detailBucketCount,
    edgeLensMode: graphEdgeLensMode,
    hiddenEdgeByEndpointCount,
    hiddenEdgeByFilterCount,
    hiddenEdgeByLensCount,
    hiddenNodeByDensityCount: hiddenByDensity,
    totalEdgeCount: cy.edges().length,
    totalNodeCount: graphNodes.length,
    visibleEdgeCount: edgeCount,
    visibleNodeCount: visibleDisplayCount + detailBucketCount,
  };
  syncViewerGraphState({
    breadcrumbScope,
    densityMode: graphDensityMode,
    detailGroupingMode,
    edgeLensMode: graphEdgeLensMode,
    visibilityStats: graphVisibilityStats,
  });
  if (graphNodes.length > 0) {
    if (visibleDisplayCount + detailBucketCount === 0) {
      setGraphState('empty', 'No graph nodes match the active filters. Reset view restores the default graph.');
    } else {
      const state = document.getElementById('graph-state');
      if (!state?.classList.contains('loading') && !state?.classList.contains('err')) setGraphState(null);
    }
  }
  updateSelectedNeighborhoodHighlight();
  if (typeof syncBiomarkerFilterClasses === 'function') syncBiomarkerFilterClasses();
  syncLayoutControls();
  syncGroupControls();
  if (typeof validateGraphState === 'function') validateGraphState('filters');
  syncGraphDiagnosticsPanel();
}

syncDensityControl();
syncEdgeLensControl();
syncDetailControl();

async function reloadGraphForDensity() {
  if (!LIVE_MODE) {
    applyFilters();
    resizeGraphSoon();
    return;
  }
  if (currentSymbolId) {
    await focusGraphOnSymbol(currentSymbolId, liveSymbolCache?.label || currentSymbolId);
    return;
  }
  try {
    setGraphState('loading', 'Loading graph...');
    const r = await apiFetch(graphRequestUrl());
    if (!r.ok) {
      setGraphState('err', `Failed to load graph: HTTP ${r.status}`);
      return;
    }
    const g = await r.json();
    renderGraphPayload(g, `Showing ${g.nodes.length} nodes · ${(g.edges ?? []).length} edges`);
  } catch (err) {
    setGraphState('err', `Failed to load graph: ${String(err)}`);
  }
}

async function resetGraphView() {
  const densityChanged = graphDensityMode !== 'core';
  graphDensityMode = 'core';
  try { localStorage.setItem(DENSITY_KEY, graphDensityMode); } catch {}
  syncViewerGraphState({ densityMode: graphDensityMode });
  syncDensityControl();
  document.querySelectorAll('#kind-chips .kind-chip').forEach((chip) => {
    chip.dataset.active = '1';
  });
  document.querySelectorAll('[data-filter-health], [data-filter-scope]').forEach((input) => {
    input.checked = true;
  });
  setAllEdgeKindFilters(true);
  setGraphEdgeLensMode('all', { apply: false });
  breadcrumbScope = null;
  syncViewerGraphState({ breadcrumbScope });
  markBreadcrumbScope();
  const input = document.getElementById('search-input');
  if (input?.value?.startsWith('path:')) input.value = '';
  collapsedGroupIds.clear();
  removeCollapsedGroupProxies();
  syncGroupCollapseClasses();
  clearBiomarkerFilter();
  clearEdgeInspection();
  cy.nodes().removeClass('dim hovered selected-neighbor');
  cy.edges().removeClass('dim highlight adjacent selected-edge edge-hover-muted');
  setDetailGroupingMode('grouped');
  applyFilters();
  writeHashState();
  if (densityChanged && LIVE_MODE) {
    await reloadGraphForDensity();
  } else {
    relayoutAndFit();
  }
}

document.getElementById('density-control').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-density-mode]');
  if (!btn) return;
  graphDensityMode = btn.dataset.densityMode;
  try { localStorage.setItem(DENSITY_KEY, graphDensityMode); } catch {}
  syncViewerGraphState({ densityMode: graphDensityMode });
  syncDensityControl();
  writeHashState();
  void reloadGraphForDensity();
});
document.getElementById('detail-control').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-detail-mode]');
  if (!btn) return;
  setDetailGroupingMode(btn.dataset.detailMode);
  applyFilters();
  writeHashState();
  relayoutAndFit();
});
document.getElementById('edge-lens-control')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-edge-lens]');
  if (!btn) return;
  setGraphEdgeLensMode(btn.dataset.edgeLens);
});

document.querySelectorAll('[data-filter-health], [data-filter-scope]')
  .forEach(el => el.addEventListener('change', () => {
    applyFilters();
    writeHashState();
  }));

document.getElementById('edge-kind-filters').addEventListener('change', (e) => {
  if (!e.target.matches('[data-filter-edge]')) return;
  applyFilters();
  writeHashState();
});
document.getElementById('btn-edge-all')?.addEventListener('click', () => {
  setAllEdgeKindFilters(true);
  applyFilters();
  writeHashState();
});
document.getElementById('btn-edge-none')?.addEventListener('click', () => {
  setAllEdgeKindFilters(false);
  applyFilters();
  writeHashState();
});
document.getElementById('btn-reset-view')?.addEventListener('click', () => { void resetGraphView(); });
document.getElementById('btn-canvas-reset')?.addEventListener('click', () => { void resetGraphView(); });

// Click delegate on the chip group — toggles data-active and re-applies.
document.getElementById('kind-chips').addEventListener('click', (e) => {
  const chip = e.target.closest('.kind-chip');
  if (!chip) return;
  if (chip.dataset.available === '0') return;
  chip.dataset.active = chip.dataset.active === '1' ? '0' : '1';
  applyFilters();
  writeHashState();
});

// Centrality + coverage sliders dropped in the redesign — they
// added rail noise without enabling a real workflow. minCentrality
// stays at the default 0.0 so applyFilters keeps every node by
// default; future iteration can reintroduce as a "show only the
// most-central N" toggle if there's demand.
