/* Saved Views, Path Finder, Impact Mode, Compare View, and Minimap. */

const SAVED_VIEWS_KEY = 'cartograph-viewer-saved-views-v1';
const GRAPH_SNAPSHOT_KEY = 'cartograph-viewer-graph-snapshot-v1';
const SAVED_VIEWS_LIMIT = 24;
const FEATURE_ELEMENT_CLASSES = 'feature-path-node impact-node compare-node';
const FEATURE_EDGE_CLASSES = 'feature-path-edge impact-edge';
const featureAddedElementIds = new Set();
let activeImpactMode = null;
let minimapFrame = 0;
let minimapTransform = null;

function featurePanel() {
  return document.getElementById('feature-panel');
}

function setViewerResetStatus(message, state = 'info') {
  const el = document.getElementById('viewer-reset-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = state;
  el.hidden = false;
}

function viewerLocalStateKeys() {
  const keys = new Set([
    SAVED_VIEWS_KEY,
    GRAPH_SNAPSHOT_KEY,
    'cartograph-viewer-density-v1',
    'cartograph-viewer-detail-grouping-v1',
    'cartograph-viewer-edge-lens-v1',
    'cartograph-viewer-editor-v1',
    'cartograph-viewer-graph-snapshot-v1',
    'cartograph-viewer-layout-quality-v1',
    'cartograph-viewer-pinned-layouts-v1',
    'cartograph-viewer-saved-views-v1',
    'cartograph-viewer-splitters-v1',
  ]);
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key?.startsWith('cartograph-viewer-')) keys.add(key);
    }
  } catch {}
  return [...keys].filter(Boolean);
}

async function resetViewerLocalState() {
  const keys = viewerLocalStateKeys();
  try {
    keys.forEach((key) => localStorage.removeItem(key));
  } catch {}
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {}
  setGraphLayoutQuality('balanced', { relayout: false });
  graphDensityMode = 'core';
  syncViewerGraphState({ densityMode: graphDensityMode });
  syncDensityControl();
  setGraphEdgeLensMode('all', { apply: false });
  setDetailGroupingMode('grouped');
  breadcrumbScope = null;
  syncViewerGraphState({ breadcrumbScope });
  markBreadcrumbScope();
  collapsedGroupIds.clear();
  removeCollapsedGroupProxies();
  syncGroupCollapseClasses();
  clearFeatureOverlay();
  clearBiomarkerFilter();
  clearEdgeInspection();
  renderSavedViews();
  syncGraphSnapshotControls();
  await resetGraphView();
  // The setters above (and resetGraphView's writeHashState) re-persist
  // their defaults — strip storage and the URL again so the button
  // actually delivers "no saved state, no URL state".
  try {
    viewerLocalStateKeys().forEach((key) => localStorage.removeItem(key));
  } catch {}
  try {
    history.replaceState(null, '', `${location.pathname}${location.search}`);
  } catch {}
  renderSavedViews();
  syncGraphSnapshotControls();
  setViewerResetStatus(`Cleared ${keys.length} saved viewer setting${keys.length === 1 ? '' : 's'}.`, 'ok');
  flashActionButton(document.getElementById('btn-reset-local-state'), 'Reset');
}

function featureRowsHtml(rows) {
  return rows.map((row) => {
    const name = escapeHtml(row.name || row.label || row.id || '');
    const loc = escapeHtml(row.loc || row.meta || '');
    const symbol = row.id ? ` data-symbol="${escapeHtml(row.id)}"` : '';
    const tag = row.id ? 'button type="button"' : 'div';
    return `<${tag} class="feature-row"${symbol}><div class="name">${name}</div><div class="loc">${loc}</div></${row.id ? 'button' : 'div'}>`;
  }).join('');
}

function renderFeaturePanel(title, count, rows, emptyText = 'No results', opts = {}) {
  const panel = featurePanel();
  if (!panel) return;
  const state = opts.state || (rows.length > 0 ? 'ready' : 'empty');
  const body = state === 'loading'
    ? `<div class="feature-panel-empty">${escapeHtml(emptyText)}</div>`
    : rows.length > 0
    ? `<div class="feature-list">${featureRowsHtml(rows)}</div>`
    : `<div class="feature-panel-empty">${escapeHtml(emptyText)}</div>`;
  panel.dataset.state = state;
  panel.innerHTML = `
    <div class="feature-panel-head">
      <span>${escapeHtml(title)}</span>
      <span class="feature-panel-count">${escapeHtml(count || '')}</span>
    </div>
    ${body}
  `;
  panel.hidden = false;
}

function hideFeaturePanel() {
  const panel = featurePanel();
  if (!panel) return;
  panel.hidden = true;
  delete panel.dataset.state;
  panel.innerHTML = '';
}

function setFeatureBusy(kind, busy) {
  const selectors = {
    compare: ['#btn-compare-view'],
    impact: ['[data-impact-mode]'],
    path: ['#btn-path-run'],
  }[kind] || [];
  selectors.forEach((selector) => {
    document.querySelectorAll(selector).forEach((button) => {
      button.disabled = busy;
      button.dataset.busy = busy ? '1' : '0';
    });
  });
}

function featureNodeLabel(node) {
  return String(node?.label || node?.name || node?.id || '');
}

function featureNodeLoc(node) {
  const file = node?.file || '';
  const line = node?.line == null ? '?' : node.line;
  return file ? `${node.kind || 'symbol'} · ${file}:${line}` : node?.kind || 'symbol';
}

function rememberFeatureNode(node) {
  if (!node?.id) return;
  if (LIVE_MODE && typeof liveNodeIndex !== 'undefined' && liveNodeIndex instanceof Map) {
    liveNodeIndex.set(node.id, node);
  }
}

function featureNodeToElement(node) {
  if (typeof liveNodeToElem === 'function') return liveNodeToElem(node);
  return {
    data: {
      id: node.id,
      label: featureNodeLabel(node),
      kind: node.kind || 'function',
      health: node.health || 'healthy',
      findingCount: Array.isArray(node.findings) ? node.findings.length : 0,
      file: node.file || '',
      centrality: node.centrality || 0,
    },
  };
}

/* The user's edge-kind choices captured before a feature force-enables
   kinds its payload needs; restored when the overlay clears. Null when
   no feature owns the checkboxes (or the user manually toggled one —
   manual interaction takes ownership back, see
   invalidateFeatureEdgeKindSnapshot). */
let featureEdgeKindSnapshot = null;

function invalidateFeatureEdgeKindSnapshot() {
  featureEdgeKindSnapshot = null;
}

function enableFeatureEdgeKinds(edges) {
  const kinds = new Set(edges.map((edge) => edge.kind || 'edge').filter(Boolean));
  if (kinds.size === 0) return;
  const inputs = Array.from(document.querySelectorAll('[data-filter-edge]'));
  if (featureEdgeKindSnapshot === null) {
    featureEdgeKindSnapshot = new Map(inputs.map((input) => [input.dataset.filterEdge, input.checked]));
  }
  let changed = false;
  inputs.forEach((input) => {
    if (kinds.has(input.dataset.filterEdge) && !input.checked) {
      input.checked = true;
      changed = true;
    }
  });
  // Reflect the force-enable in the URL — otherwise the hash lies
  // about the visible filters until an unrelated interaction rewrites it.
  if (changed && typeof writeHashState === 'function') writeHashState();
}

function revealFeatureElements(nodeIds, edgeIds) {
  nodeIds.forEach((id) => {
    const node = cy.getElementById(id);
    if (node.length === 0) return;
    node.ancestors().style('display', 'element').removeClass('collapse-hidden');
    node.style('display', 'element').removeClass('collapse-hidden label-hidden');
  });
  edgeIds.forEach((id) => {
    const edge = cy.getElementById(id);
    if (edge.length === 0) return;
    if (edge.source().style('display') === 'none' || edge.target().style('display') === 'none') return;
    edge.style('display', 'element');
  });
}

function ensureFeatureGraphElements(nodes = [], edges = []) {
  let added = false;
  const nodeIds = new Set();
  const edgeIds = new Set();
  cy.batch(() => {
    nodes.forEach((node) => {
      if (!node?.id) return;
      rememberFeatureNode(node);
      nodeIds.add(node.id);
      const existing = cy.getElementById(node.id);
      if (existing.length > 0) {
        existing.data({
          label: featureNodeLabel(node),
          kind: node.kind || existing.data('kind'),
          health: node.health || existing.data('health') || 'healthy',
          file: node.file || existing.data('file') || '',
          centrality: node.centrality ?? existing.data('centrality') ?? 0,
        });
        return;
      }
      cy.add(featureNodeToElement(node));
      featureAddedElementIds.add(node.id);
      added = true;
    });

    edges.forEach((edge) => {
      if (!edge?.source || !edge?.target) return;
      if (cy.getElementById(edge.source).length === 0 || cy.getElementById(edge.target).length === 0) return;
      const id = edgeElementId(edge.source, edge.target, edge.kind || 'edge');
      edgeIds.add(id);
      if (cy.getElementById(id).length > 0) return;
      cy.add({ data: { id, source: edge.source, target: edge.target, kind: edge.kind || 'edge' } });
      featureAddedElementIds.add(id);
      added = true;
    });
  });
  if (nodes.length > 0 || edges.length > 0) {
    syncEdgeKindFilters();
    enableFeatureEdgeKinds(edges);
    applyFilters();
    revealFeatureElements(nodeIds, edgeIds);
    if (added) relayoutAndFit();
    else updateLabelVisibility();
    requestGraphMinimapDraw();
  }
  return { nodeIds, edgeIds, added };
}

/* Path/Impact/Compare share one panel and one overlay. Every overlay
   clear bumps this token; an in-flight feature fetch from before the
   clear must not paint its (now stale) response over the newer one. */
let featureRequestSeq = 0;

function clearFeatureOverlay(opts = {}) {
  featureRequestSeq++;
  // The bump above tells any in-flight feature fetch to discard its
  // response — including its finally-block cleanup, so the loading
  // banner must be cleared here or it would stay up forever.
  clearFeatureLoading();
  const hidePanel = opts.hidePanel !== false;
  cy.nodes().removeClass(FEATURE_ELEMENT_CLASSES);
  cy.edges().removeClass(FEATURE_EDGE_CLASSES);
  if (opts.removeAdded !== false && featureAddedElementIds.size > 0) {
    const elements = [...featureAddedElementIds]
      .map((id) => cy.getElementById(id))
      .reduce((collection, element) => collection.union(element), cy.collection());
    elements.remove();
    featureAddedElementIds.clear();
  }
  activeImpactMode = null;
  document.querySelectorAll('[data-impact-mode]').forEach((button) => {
    button.dataset.active = '0';
    button.setAttribute('aria-pressed', 'false');
  });
  if (featureEdgeKindSnapshot !== null) {
    // Give the user back the edge-kind choices the feature overrode.
    document.querySelectorAll('[data-filter-edge]').forEach((input) => {
      const previous = featureEdgeKindSnapshot.get(input.dataset.filterEdge);
      if (previous !== undefined) input.checked = previous;
    });
    featureEdgeKindSnapshot = null;
    if (typeof writeHashState === 'function') writeHashState();
  }
  if (hidePanel) hideFeaturePanel();
  syncEdgeKindFilters();
  applyFilters();
  requestGraphMinimapDraw();
}

function readSavedViews() {
  const parsed = readViewerJsonStorage(SAVED_VIEWS_KEY, [], { validate: Array.isArray });
  return parsed
    .filter((item) => item && typeof item === 'object' && typeof item.hash === 'string')
    .slice(0, SAVED_VIEWS_LIMIT);
}

function writeSavedViews(views) {
  writeViewerJsonStorage(SAVED_VIEWS_KEY, views.slice(0, SAVED_VIEWS_LIMIT));
}

function renderSavedViews() {
  const select = document.getElementById('saved-view-select');
  if (!select) return;
  const views = readSavedViews();
  if (views.length === 0) {
    select.innerHTML = '<option value="">No saved views</option>';
    select.disabled = true;
    document.getElementById('btn-load-view').disabled = true;
    document.getElementById('btn-delete-view').disabled = true;
    setSavedViewStatus('No saved views.', 'empty');
    return;
  }
  select.disabled = false;
  document.getElementById('btn-load-view').disabled = false;
  document.getElementById('btn-delete-view').disabled = false;
  select.innerHTML = views
    .map((view) => `<option value="${escapeHtml(view.id)}">${escapeHtml(view.name || 'Untitled')}</option>`)
    .join('');
  const status = document.getElementById('saved-view-status');
  if (status?.dataset.state === 'empty') status.hidden = true;
}

function setSavedViewStatus(message, state = 'info') {
  const el = document.getElementById('saved-view-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = state;
  el.hidden = false;
}

function setSnapshotStatus(message, state = 'info') {
  const el = document.getElementById('snapshot-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = state;
  el.hidden = false;
}

function readGraphSnapshot() {
  return readViewerJsonStorage(GRAPH_SNAPSHOT_KEY, null, {
    validate: (value) => value == null || (typeof value === 'object' && !Array.isArray(value)),
  });
}

function writeGraphSnapshot(snapshot) {
  writeViewerJsonStorage(GRAPH_SNAPSHOT_KEY, snapshot);
}

function syncGraphSnapshotControls() {
  const snapshot = readGraphSnapshot();
  const replay = document.getElementById('btn-load-snapshot');
  const del = document.getElementById('btn-delete-snapshot');
  if (replay) replay.disabled = !snapshot;
  if (del) del.disabled = !snapshot;
  if (!snapshot) setSnapshotStatus('No graph snapshot saved.', 'empty');
}

function saveGraphSnapshot() {
  const graph = typeof graphJsonPayload === 'function' ? graphJsonPayload() : null;
  if (!graph || !Array.isArray(graph.nodes) || graph.nodes.length === 0) {
    setSnapshotStatus('Nothing visible to save.', 'err');
    return;
  }
  const snapshot = {
    version: 1,
    savedAt: new Date().toISOString(),
    label: liveSymbolCache?.label || currentSymbolId || 'Graph snapshot',
    hash: location.hash || '#',
    sourcePayload: typeof lastGraphPayload === 'undefined' ? null : lastGraphPayload,
    viewerState: typeof viewerState === 'undefined' ? null : viewerState.snapshot(),
    graph,
  };
  writeGraphSnapshot(snapshot);
  setSnapshotStatus(`Saved ${snapshot.label}.`, 'ok');
  syncGraphSnapshotControls();
  flashActionButton(document.getElementById('btn-save-snapshot'), 'Saved');
}

function snapshotNodeElement(node, nodeIds = new Set()) {
  if (!node?.id) return null;
  const parent = node.parent && nodeIds.has(node.parent) ? node.parent : undefined;
  return {
    group: 'nodes',
    data: {
      id: node.id,
      label: node.label || node.id,
      kind: node.kind || 'function',
      health: node.health || 'healthy',
      findingCount: node.findingCount || 0,
      file: node.file || '',
      centrality: node.centrality || 0,
      parent,
      isGroup: node.group ? 1 : undefined,
      collapsedProxy: node.collapsedProxy ? 1 : undefined,
      detailBucket: node.detailBucket ? 1 : undefined,
      bucketKind: node.bucketKind || undefined,
      sourceGroup: node.sourceGroup || undefined,
      childCount: node.childCount || undefined,
    },
    position: node.position || undefined,
  };
}

function snapshotEdgeElement(edge) {
  if (!edge?.source || !edge?.target) return null;
  return {
    group: 'edges',
    data: {
      id: edge.id || edgeElementId(edge.source, edge.target, edge.kind || 'edge'),
      source: edge.source,
      target: edge.target,
      kind: edge.kind || 'edge',
      count: edge.count || undefined,
      collapsedEdge: edge.collapsedEdge ? 1 : undefined,
      detailBucketEdge: edge.detailBucketEdge ? 1 : undefined,
    },
  };
}

function markSnapshotCounter() {
  const counter = document.getElementById('canvas-counter');
  if (counter && !counter.textContent.includes('Snapshot')) {
    counter.innerHTML = `Snapshot · ${counter.innerHTML}`;
  }
}

async function replayGraphSnapshot() {
  const snapshot = readGraphSnapshot();
  if (!snapshot?.graph?.nodes?.length) {
    setSnapshotStatus('No graph snapshot saved.', 'err');
    syncGraphSnapshotControls();
    return;
  }
  const nodeIds = new Set(snapshot.graph.nodes.map((node) => node.id).filter(Boolean));
  const nodes = snapshot.graph.nodes.map((node) => snapshotNodeElement(node, nodeIds)).filter(Boolean);
  const edges = snapshot.graph.edges
    .filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target))
    .map(snapshotEdgeElement)
    .filter(Boolean);
  history.replaceState(null, '', snapshot.hash || '#');
  const state = readHashState();
  try {
    applyHashStateControls(state);
    clearEdgeInspection();
    cy.elements().remove();
    cy.add([...nodes, ...edges]);
    currentSymbolId = snapshot.graph.focus || snapshot.sourcePayload?.focus || state.focus || null;
    syncViewerSelectionState(currentSymbolId, liveSymbolCache);
    currentGraphLayoutKey = `snapshot:${hashString(JSON.stringify({
      edges: edges.map((edge) => edge.data.id).sort(),
      focus: currentSymbolId,
      nodes: snapshot.graph.nodes.map((node) => node.id).sort(),
    }))}`;
    refreshGraphLayoutKey();
    syncEdgeKindFilters();
    setBaseCounter(`Snapshot · ${nodes.length} nodes · ${edges.length} edges`);
    applyFilters();
    markSnapshotCounter();
    const focus = currentSymbolId ? cy.getElementById(currentSymbolId) : null;
    if (focus?.length) focus.addClass('focus');
    fitGraph();
    updateLabelVisibility();
    requestGraphMinimapDraw();
    if (LIVE_MODE && currentSymbolId) await selectSymbolLive(currentSymbolId);
    markSnapshotCounter();
    setSnapshotStatus(`Replayed ${snapshot.label || 'snapshot'}.`, 'ok');
  } catch (err) {
    setSnapshotStatus(`Replay failed: ${String(err)}`, 'err');
  }
}

function deleteGraphSnapshot() {
  try { localStorage.removeItem(GRAPH_SNAPSHOT_KEY); } catch {}
  setSnapshotStatus('Deleted graph snapshot.', 'ok');
  syncGraphSnapshotControls();
}

function currentSavedViewHash() {
  if (typeof writeHashState === 'function') writeHashState();
  return location.hash || '#';
}

function saveCurrentView() {
  const input = document.getElementById('saved-view-name');
  const name = (input?.value || '').trim() || liveSymbolCache?.label || currentSymbolId || 'Graph view';
  const hash = currentSavedViewHash();
  const views = readSavedViews().filter((view) => view.name !== name);
  const id = hashString(`${name}:${hash}`);
  views.unshift({ id, name, hash, updatedAt: Date.now() });
  writeSavedViews(views);
  if (input) input.value = name;
  renderSavedViews();
  const select = document.getElementById('saved-view-select');
  if (select) select.value = id;
  setSavedViewStatus(`Saved ${name}.`, 'ok');
  flashActionButton(document.getElementById('btn-save-view'), 'Saved');
}

async function loadSavedView() {
  const select = document.getElementById('saved-view-select');
  const view = readSavedViews().find((item) => item.id === select?.value);
  if (!view) {
    setSavedViewStatus('Choose a saved view first.', 'err');
    return;
  }
  setSavedViewStatus(`Loading ${view.name || 'saved view'}...`, 'info');
  // replaceState, not location.hash: a hash assignment pushes a
  // history entry AND fires hashchange, whose listener would race a
  // second apply/fetch pipeline against the explicit one below.
  history.replaceState(null, '', view.hash || '#');
  const state = readHashState();
  applyHashStateControls(state);
  if (LIVE_MODE && state.focus) await focusGraphOnSymbol(state.focus, state.focus);
  else if (LIVE_MODE && typeof reloadGraphForDensity === 'function') await reloadGraphForDensity();
  else applyFilters();
  restoreMobilePanelFromHash(state.panel);
  setSavedViewStatus(`Loaded ${view.name || 'saved view'}.`, 'ok');
}

function deleteSavedView() {
  const select = document.getElementById('saved-view-select');
  const existing = readSavedViews();
  const deleted = existing.find((item) => item.id === select?.value);
  if (!deleted) {
    setSavedViewStatus('Choose a saved view first.', 'err');
    return;
  }
  const views = existing.filter((item) => item.id !== select?.value);
  writeSavedViews(views);
  renderSavedViews();
  if (views.length > 0) setSavedViewStatus(`Deleted ${deleted.name || 'saved view'}.`, 'ok');
}

function setFeatureLoading(title, message) {
  renderFeaturePanel(title, '', [], message, { state: 'loading' });
  setGraphState('loading', message);
}

function clearFeatureLoading() {
  const state = document.getElementById('graph-state');
  if (state?.classList.contains('loading')) setGraphState(null);
}

async function runPathFinder() {
  if (!LIVE_MODE) {
    renderFeaturePanel('Path', '', [], 'Path Finder needs the live viewer server.', { state: 'error' });
    return;
  }
  const fromInput = document.getElementById('path-from');
  const toInput = document.getElementById('path-to');
  const from = (fromInput?.value || '').trim() || liveSymbolCache?.id || currentSymbolId || '';
  const to = (toInput?.value || '').trim();
  if (!from || !to) {
    renderFeaturePanel('Path', '', [], 'Choose two symbols.', { state: 'empty' });
    return;
  }
  if (fromInput && !fromInput.value) fromInput.value = liveSymbolCache?.label || currentSymbolId || from;
  clearFeatureOverlay({ hidePanel: false });
  const requestSeq = featureRequestSeq;
  const isCurrent = () => requestSeq === featureRequestSeq;
  setFeatureBusy('path', true);
  setFeatureLoading('Path', 'Finding path...');
  try {
    const params = new URLSearchParams({ from, to });
    const res = await apiFetch(`/api/path?${params.toString()}`);
    if (!isCurrent()) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!isCurrent()) return;
    if (payload.error) {
      renderFeaturePanel('Path', '', [], payload.error, { state: 'error' });
      return;
    }
    const { nodeIds, edgeIds } = ensureFeatureGraphElements(payload.nodes || [], payload.edges || []);
    nodeIds.forEach((id) => cy.getElementById(id).addClass('feature-path-node'));
    edgeIds.forEach((id) => cy.getElementById(id).addClass('feature-path-edge'));
    if (nodeIds.size > 0) cy.fit([...nodeIds].map((id) => cy.getElementById(id)).reduce((c, n) => c.union(n), cy.collection()), 88);
    renderFeaturePanel(
      'Path',
      payload.found ? `${payload.hopCount || 0} hops` : 'not found',
      (payload.nodes || []).map((node) => ({ id: node.id, name: featureNodeLabel(node), loc: featureNodeLoc(node) })),
      'No path found.',
      { state: payload.found ? 'ready' : 'empty' },
    );
  } catch (err) {
    if (isCurrent()) renderFeaturePanel('Path', '', [], `Path failed: ${String(err)}`, { state: 'error' });
  } finally {
    setFeatureBusy('path', false);
    if (isCurrent()) {
      clearFeatureLoading();
      requestGraphMinimapDraw();
    }
  }
}

async function runImpactMode(mode) {
  if (!LIVE_MODE) {
    renderFeaturePanel('Impact', '', [], 'Impact Mode needs the live viewer server.', { state: 'error' });
    return;
  }
  const focus = liveSymbolCache?.id || currentSymbolId;
  if (!focus) {
    renderFeaturePanel('Impact', '', [], 'Select a symbol first.', { state: 'empty' });
    return;
  }
  if (activeImpactMode === mode) {
    clearFeatureOverlay();
    return;
  }
  clearFeatureOverlay({ hidePanel: false });
  const requestSeq = featureRequestSeq;
  const isCurrent = () => requestSeq === featureRequestSeq;
  activeImpactMode = mode;
  document.querySelectorAll('[data-impact-mode]').forEach((button) => {
    const active = button.dataset.impactMode === mode;
    button.dataset.active = active ? '1' : '0';
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  setFeatureBusy('impact', true);
  setFeatureLoading('Impact', 'Loading impact graph...');
  try {
    const params = new URLSearchParams({ focus, mode, depth: '2', limit: '120' });
    const res = await apiFetch(`/api/impact?${params.toString()}`);
    if (!isCurrent()) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!isCurrent()) return;
    if (payload.error) {
      renderFeaturePanel('Impact', '', [], payload.error, { state: 'error' });
      return;
    }
    const { nodeIds, edgeIds } = ensureFeatureGraphElements(payload.nodes || [], payload.edges || []);
    nodeIds.forEach((id) => cy.getElementById(id).addClass('impact-node'));
    edgeIds.forEach((id) => cy.getElementById(id).addClass('impact-edge'));
    const rows = (payload.nodes || [])
      .filter((node) => node.id !== payload.focus?.id)
      .sort((a, b) => (b.centrality || 0) - (a.centrality || 0))
      .slice(0, 30)
      .map((node) => ({ id: node.id, name: featureNodeLabel(node), loc: featureNodeLoc(node) }));
    renderFeaturePanel('Impact', `${Math.max(0, nodeIds.size - 1)} nodes`, rows, 'No impact nodes.', {
      state: rows.length > 0 ? 'ready' : 'empty',
    });
  } catch (err) {
    if (isCurrent()) renderFeaturePanel('Impact', '', [], `Impact failed: ${String(err)}`, { state: 'error' });
  } finally {
    setFeatureBusy('impact', false);
    if (isCurrent()) {
      clearFeatureLoading();
      requestGraphMinimapDraw();
    }
  }
}

async function runCompareView() {
  if (!LIVE_MODE) {
    renderFeaturePanel('Compare', '', [], 'Compare View needs the live viewer server.', { state: 'error' });
    return;
  }
  clearFeatureOverlay({ hidePanel: false });
  const requestSeq = featureRequestSeq;
  const isCurrent = () => requestSeq === featureRequestSeq;
  setFeatureBusy('compare', true);
  setFeatureLoading('Compare', 'Loading compare view...');
  try {
    const res = await apiFetch('/api/compare?limit=120');
    if (!isCurrent()) return;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const payload = await res.json();
    if (!isCurrent()) return;
    // Any server-side error must surface — rendering the normal path
    // with an empty list reads as an affirmative "No changes against
    // HEAD." (gitAvailable only matters for wording, not routing.)
    if (payload.error) {
      renderFeaturePanel('Compare', '', [], payload.error, { state: 'error' });
      return;
    }
    const changedFiles = payload.changedFiles || [];
    const changedPaths = new Set(changedFiles.map((file) => file.path));
    const nodes = changedFiles.flatMap((file) => file.nodes || []);
    ensureFeatureGraphElements(nodes, []);
    graphContentNodes().forEach((node) => {
      if (changedPaths.has(node.data('file'))) node.addClass('compare-node');
    });
    nodes.forEach((node) => cy.getElementById(node.id).addClass('compare-node'));
    const rows = nodes.length > 0
      ? nodes.map((node) => ({ id: node.id, name: featureNodeLabel(node), loc: featureNodeLoc(node) }))
      : changedFiles.map((file) => ({
          name: `${file.status} ${file.path}`,
          loc: `${file.nodeCount || 0} indexed symbols`,
        }));
    renderFeaturePanel('Compare', `${changedFiles.length} files`, rows, 'No changes against HEAD.', {
      state: rows.length > 0 ? 'ready' : 'empty',
    });
  } catch (err) {
    if (isCurrent()) renderFeaturePanel('Compare', '', [], `Compare failed: ${String(err)}`, { state: 'error' });
  } finally {
    setFeatureBusy('compare', false);
    if (isCurrent()) {
      clearFeatureLoading();
      requestGraphMinimapDraw();
    }
  }
}

function featurePanelActivateSymbol(symbolId) {
  if (!symbolId) return;
  if (LIVE_MODE) void focusGraphOnSymbol(symbolId, symbolId);
  else if (typeof selectSymbol === 'function') selectSymbol(symbolId);
}

featurePanel()?.addEventListener('click', (event) => {
  const row = event.target.closest('[data-symbol]');
  if (row) featurePanelActivateSymbol(row.dataset.symbol);
});
featurePanel()?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const row = event.target.closest('[data-symbol]');
  if (!row) return;
  event.preventDefault();
  featurePanelActivateSymbol(row.dataset.symbol);
});

function minimapVisibleNodes() {
  return visibleGraphContentNodes().filter((node) => node.style('display') !== 'none' && !node.hasClass('collapse-hidden'));
}

function minimapVisibleEdges() {
  return cy.edges().filter((edge) => edge.style('display') !== 'none');
}

function minimapNodeColor(node) {
  if (node.hasClass('feature-path-node')) return '#34d399';
  if (node.hasClass('impact-node')) return '#60a5fa';
  if (node.hasClass('compare-node')) return '#f59e0b';
  if (node.hasClass('focus') || node.selected()) return '#ffffff';
  return fillForKind(node.data('kind'));
}

function minimapEdgeColor(edge) {
  if (edge.hasClass('feature-path-edge')) return '#34d399';
  if (edge.hasClass('impact-edge')) return '#60a5fa';
  return edgeColorForKind(edge.data('kind'));
}

function graphMinimapBounds(nodes) {
  const positions = nodes.map((node) => node.position());
  if (positions.length === 0) return null;
  const xs = positions.map((pos) => pos.x);
  const ys = positions.map((pos) => pos.y);
  let x1 = Math.min(...xs);
  let x2 = Math.max(...xs);
  let y1 = Math.min(...ys);
  let y2 = Math.max(...ys);
  if (Math.abs(x2 - x1) < 1) { x1 -= 80; x2 += 80; }
  if (Math.abs(y2 - y1) < 1) { y1 -= 80; y2 += 80; }
  const pad = Math.max(80, Math.max(x2 - x1, y2 - y1) * 0.08);
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}

function drawGraphMinimap() {
  minimapFrame = 0;
  const canvas = document.getElementById('graph-minimap-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(11, 15, 23, 0.86)';
  ctx.fillRect(0, 0, width, height);

  const nodes = minimapVisibleNodes();
  const bounds = graphMinimapBounds(nodes);
  if (!bounds) {
    minimapTransform = null;
    return;
  }
  const pad = 9;
  const graphWidth = bounds.x2 - bounds.x1;
  const graphHeight = bounds.y2 - bounds.y1;
  const scale = Math.min((width - pad * 2) / graphWidth, (height - pad * 2) / graphHeight);
  const offsetX = (width - graphWidth * scale) / 2;
  const offsetY = (height - graphHeight * scale) / 2;
  const toCanvas = (pos) => ({
    x: offsetX + (pos.x - bounds.x1) * scale,
    y: offsetY + (pos.y - bounds.y1) * scale,
  });
  minimapTransform = { ...bounds, scale, offsetX, offsetY };

  ctx.lineWidth = 1;
  minimapVisibleEdges().forEach((edge) => {
    if (edge.source().style('display') === 'none' || edge.target().style('display') === 'none') return;
    const source = toCanvas(edge.source().position());
    const target = toCanvas(edge.target().position());
    ctx.strokeStyle = minimapEdgeColor(edge);
    ctx.globalAlpha = edge.hasClass('feature-path-edge') || edge.hasClass('impact-edge') ? 0.95 : 0.36;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  });

  ctx.globalAlpha = 1;
  nodes.forEach((node) => {
    const pos = toCanvas(node.position());
    const radius = node.hasClass('focus') || node.hasClass('feature-path-node') ? 3.4 : 2.4;
    ctx.fillStyle = minimapNodeColor(node);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fill();
  });

  const z = cy.zoom();
  const pan = cy.pan();
  const viewport = {
    x1: (0 - pan.x) / z,
    y1: (0 - pan.y) / z,
    x2: (cy.width() - pan.x) / z,
    y2: (cy.height() - pan.y) / z,
  };
  const v1 = toCanvas({ x: viewport.x1, y: viewport.y1 });
  const v2 = toCanvas({ x: viewport.x2, y: viewport.y2 });
  ctx.strokeStyle = 'rgba(236, 239, 243, 0.82)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(v1.x, v1.y, v2.x - v1.x, v2.y - v1.y);
  ctx.setLineDash([]);
}

function requestGraphMinimapDraw() {
  if (minimapFrame) return;
  minimapFrame = requestAnimationFrame(drawGraphMinimap);
}

function panGraphFromMinimap(event) {
  const canvas = document.getElementById('graph-minimap-canvas');
  if (!canvas || !minimapTransform) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const graphX = minimapTransform.x1 + (x - minimapTransform.offsetX) / minimapTransform.scale;
  const graphY = minimapTransform.y1 + (y - minimapTransform.offsetY) / minimapTransform.scale;
  const zoom = cy.zoom();
  cy.pan({
    x: cy.width() / 2 - graphX * zoom,
    y: cy.height() / 2 - graphY * zoom,
  });
  updateLabelVisibility();
  requestGraphMinimapDraw();
}

document.getElementById('btn-save-view')?.addEventListener('click', saveCurrentView);
document.getElementById('btn-reset-local-state')?.addEventListener('click', () => void resetViewerLocalState());
document.getElementById('btn-load-view')?.addEventListener('click', () => void loadSavedView());
document.getElementById('btn-delete-view')?.addEventListener('click', deleteSavedView);
document.getElementById('btn-save-snapshot')?.addEventListener('click', saveGraphSnapshot);
document.getElementById('btn-load-snapshot')?.addEventListener('click', () => void replayGraphSnapshot());
document.getElementById('btn-delete-snapshot')?.addEventListener('click', deleteGraphSnapshot);
document.getElementById('btn-path-run')?.addEventListener('click', () => void runPathFinder());
document.getElementById('btn-feature-clear')?.addEventListener('click', () => clearFeatureOverlay());
document.getElementById('btn-compare-view')?.addEventListener('click', () => void runCompareView());
document.querySelectorAll('[data-impact-mode]').forEach((button) => {
  button.addEventListener('click', () => void runImpactMode(button.dataset.impactMode));
});
document.getElementById('graph-minimap')?.addEventListener('click', panGraphFromMinimap);
document.getElementById('saved-view-name')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  saveCurrentView();
});
document.getElementById('path-to')?.addEventListener('keydown', (event) => {
  if (event.key !== 'Enter') return;
  event.preventDefault();
  void runPathFinder();
});

if (!LIVE_MODE) {
  document.querySelectorAll('#impact-control button, #btn-path-run, #btn-compare-view').forEach((button) => {
    button.disabled = true;
  });
}

cy.on('render pan zoom resize layoutstop add remove position data style', requestGraphMinimapDraw);
renderSavedViews();
syncGraphSnapshotControls();
setTimeout(requestGraphMinimapDraw, 80);

globalThis.__cartographViewerFeatures = {
  clearFeatureOverlay,
  loadSavedView,
  requestGraphMinimapDraw,
  runCompareView,
  runImpactMode,
  runPathFinder,
  saveGraphSnapshot,
  replayGraphSnapshot,
  resetViewerLocalState,
  saveCurrentView,
};

registerViewerAction('clearFeatureOverlay', clearFeatureOverlay);
registerViewerAction('deleteGraphSnapshot', deleteGraphSnapshot);
registerViewerAction('loadSavedView', loadSavedView);
registerViewerAction('replayGraphSnapshot', replayGraphSnapshot);
registerViewerAction('resetViewerLocalState', resetViewerLocalState);
registerViewerAction('runCompareView', runCompareView);
registerViewerAction('runImpactMode', runImpactMode);
registerViewerAction('runPathFinder', runPathFinder);
registerViewerAction('saveCurrentView', saveCurrentView);
registerViewerAction('saveGraphSnapshot', saveGraphSnapshot);
