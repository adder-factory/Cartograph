/* Edge inspection and graph pointer interactions
   Split from viewer.graph-core.app to keep the graph viewer modules small. */

let hoveredEdgeId = null;
let selectedEdgeId = null;
let detailMode = 'symbol';
let selectedEdgeCache = null;
syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId);

function nodeDisplayLabel(node) {
  return String(node?.data?.('label') || node?.id?.() || '');
}

function edgeKind(edge) {
  return String(edge?.data?.('kind') || 'edge');
}

function edgeEndpointMeta(node) {
  const indexed = liveNodeIndex.get(node.id());
  const fallback = LIVE_MODE ? null : NODES.find((n) => n.id === node.id());
  const data = indexed || fallback || {};
  return {
    id: node.id(),
    label: String(data.label || node.data('label') || node.id()),
    kind: String(data.kind || node.data('kind') || 'symbol'),
    file: data.file || node.data('file') || '',
    line: data.line ?? node.data('line') ?? null,
  };
}

function edgeDetailPayload(edge) {
  const count = Number(edge.data('count') || 1);
  return {
    id: edge.id(),
    kind: edgeKind(edge),
    count,
    collapsed: Boolean(edge.data('collapsedEdge')),
    source: edgeEndpointMeta(edge.source()),
    target: edgeEndpointMeta(edge.target()),
  };
}

function detailLocation(meta) {
  const loc = meta.file ? `${meta.file}:${meta.line ?? '?'}` : 'group aggregate';
  return `${meta.kind} · ${loc}`;
}

function setDetailActionsEnabled(enabled) {
  ['btn-open-editor', 'btn-copy-link', 'btn-copy-mcp', 'editor-picker'].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !enabled;
  });
}

function setSymbolDetailTabs() {
  const tabs = [
    ['callers', 'Callers', 'd-callers-ct'],
    ['callees', 'Callees', 'd-callees-ct'],
    ['findings', 'Findings', 'd-findings-ct'],
    ['coverage', 'Coverage', null],
  ];
  document.querySelectorAll('.subtab').forEach((tab, i) => {
    const [sub, label, countId] = tabs[i] || tabs[0];
    tab.dataset.sub = sub;
    const count = countId ? ` <span class="ct" id="${countId}">(0)</span>` : '';
    tab.innerHTML = `${label}${count}`;
    tab.classList.toggle('active', i === 0);
  });
}

function setEdgeDetailTabs(edge) {
  const tabs = [
    ['source', 'Source', null],
    ['target', 'Target', null],
    ['edge', 'Edge', null],
    ['graph', 'Graph', null],
  ];
  document.querySelectorAll('.subtab').forEach((tab, i) => {
    const [sub, label] = tabs[i] || tabs[0];
    tab.dataset.sub = sub;
    tab.textContent = label;
    tab.classList.toggle('active', i === 0);
  });
}

function refRowForEdgeEndpoint(meta, role) {
  const title = `${role}: ${meta.label}`;
  const loc = meta.file ? `${meta.file}:${meta.line ?? '?'}` : 'collapsed group';
  const symbolAttr = meta.file ? ` data-symbol="${escapeHtml(meta.id)}" role="button" tabindex="0"` : '';
  const focusHint = meta.file ? ' — click to focus' : '';
  return `<div class="ref-row"${symbolAttr} title="${escapeHtml(title)}${focusHint}"><div class="name">${escapeHtml(role)}: ${escapeHtml(meta.label)}</div><div class="loc">${escapeHtml(loc)}</div></div>`;
}

function renderEdgeSubpanel(sub = 'source') {
  const edge = selectedEdgeCache;
  if (!edge) {
    SUBPANEL.innerHTML = '<div class="empty">No edge selected</div>';
    return;
  }
  if (sub === 'source') {
    SUBPANEL.innerHTML = refRowForEdgeEndpoint(edge.source, 'Source');
    return;
  }
  if (sub === 'target') {
    SUBPANEL.innerHTML = refRowForEdgeEndpoint(edge.target, 'Target');
    return;
  }
  if (sub === 'edge') {
    SUBPANEL.innerHTML = `
      <div class="ref-row"><div class="name">${escapeHtml(edge.kind)}</div><div class="loc">${edge.collapsed ? 'aggregate edge' : 'direct edge'} · ${edge.count} underlying edge${edge.count === 1 ? '' : 's'}</div></div>
      <div class="ref-row"><div class="name">${escapeHtml(edge.source.label)} → ${escapeHtml(edge.target.label)}</div><div class="loc">${escapeHtml(edge.id)}</div></div>
    `;
    return;
  }
  SUBPANEL.innerHTML = `
    <div class="ref-row"><div class="name">Visible graph</div><div class="loc">${visibleGraphNodes().length} nodes · ${visibleGraphEdges().length} edges</div></div>
    <div class="ref-row"><div class="name">Filters</div><div class="loc">${checkedHashValues('[data-filter-edge]', 'filterEdge').join(', ') || 'no edge kinds selected'}</div></div>
  `;
}

function renderEdgeDetail(edge) {
  const detail = edgeDetailPayload(edge);
  selectedEdgeCache = detail;
  detailMode = 'edge';
  document.getElementById('canvas-col')?.classList.remove('with-codepane');
  setDetailActionsEnabled(false);
  setEdgeDetailTabs(edge);
  document.getElementById('d-breadcrumb').innerHTML = '<span class="seg">Graph</span><span class="sep">/</span><span class="seg last">Edge</span>';
  document.getElementById('d-name').textContent = `${detail.source.label} → ${detail.target.label}`;
  document.getElementById('d-loc').textContent = `${detail.kind} edge${detail.collapsed ? ' · collapsed aggregate' : ''}`;
  document.getElementById('d-health').textContent = detail.kind;
  document.getElementById('d-health').className = 'v';
  document.getElementById('d-cent').textContent = detail.count > 1 ? `${detail.count}x` : '1x';
  document.getElementById('d-cov').textContent = detail.collapsed ? 'aggregate' : 'direct';
  document.getElementById('m-loc').textContent = '—';
  document.getElementById('m-cyc').textContent = '—';
  document.getElementById('m-nest').textContent = '—';
  document.getElementById('m-commits').textContent = '—';
  document.getElementById('m-first').textContent = '—';
  document.getElementById('m-last').textContent = '—';
  const doc = document.getElementById('d-doc');
  doc.style.display = '';
  doc.textContent = `${detailLocation(detail.source)} → ${detailLocation(detail.target)}`;
  renderEdgeSubpanel('source');
  updateAskTarget('this edge');
  syncMobilePanelButtons();
  // resize without refit — inspecting an edge while zoomed in must not
  // snap the camera back to a full fit.
  resizeGraphSoon(false);
  writeHashState();
  revealSelectionPanelOnMobile();
}

function clearEdgeInspectionClasses() {
  // Includes the hover classes: a node hidden or removed under the
  // cursor never receives mouseout, so hover muting would otherwise
  // dim the whole graph until the next hover.
  cy.edges().removeClass('edge-inspected edge-muted edge-hover-muted');
  cy.nodes().removeClass('edge-endpoint adjacent hovered');
  const container = cy.container();
  if (container) container.style.cursor = '';
}

function renderActiveEdgeInspection() {
  clearEdgeInspectionClasses();
  const activeId = hoveredEdgeId || selectedEdgeId;
  const inspector = document.getElementById('edge-inspector');
  if (!inspector || !activeId) {
    if (inspector) inspector.hidden = true;
    return;
  }
  const edge = cy.getElementById(activeId);
  if (edge.length === 0 || edge.style('display') === 'none') {
    inspector.hidden = true;
    return;
  }

  edge.addClass('edge-inspected');
  cy.edges().difference(edge).addClass('edge-muted');
  edge.connectedNodes().addClass('edge-endpoint');

  const source = nodeDisplayLabel(edge.source());
  const target = nodeDisplayLabel(edge.target());
  const count = Number(edge.data('count') || 1);
  const kind = count > 1 ? `${edgeKind(edge)} x${count}` : edgeKind(edge);
  const locked = Boolean(selectedEdgeId && activeId === selectedEdgeId && !hoveredEdgeId);
  inspector.innerHTML = `
    <span class="edge-kind">${escapeHtml(kind)}</span>
    <span class="edge-path" title="${escapeHtml(`${source} -> ${target}`)}">
      ${escapeHtml(source)} <span class="edge-arrow">→</span> ${escapeHtml(target)}
    </span>
    <span class="edge-state">${locked ? 'selected' : 'hover'}</span>
  `;
  inspector.hidden = false;
}

function clearEdgeInspection() {
  hoveredEdgeId = null;
  selectedEdgeId = null;
  syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId);
  clearEdgeInspectionClasses();
  const inspector = document.getElementById('edge-inspector');
  if (inspector) inspector.hidden = true;
}

function clearHiddenEdgeSelection() {
  if (!selectedEdgeId) return;
  const edge = cy.getElementById(selectedEdgeId);
  if (edge.length > 0 && edge.style('display') !== 'none') return;
  clearEdgeInspection();
  if (detailMode === 'edge' && typeof restoreSymbolDetailAfterEdgeSelection === 'function') {
    restoreSymbolDetailAfterEdgeSelection();
  }
}

cy.on('dbltap', 'node', (evt) => {
  const n = evt.target;
  cy.fit(n.closedNeighborhood(), 80);
  updateLabelVisibility();
});

// Hover state: highlight the node and its incident edges. cleaner
// than a popper tooltip and stays in-canvas.
cy.on('mouseover', 'node', (evt) => {
  const n = evt.target;
  n.addClass('hovered');
  n.connectedEdges().addClass('adjacent');
  cy.edges().not(n.connectedEdges()).addClass('edge-hover-muted');
  document.getElementById('cy').style.cursor = 'pointer';
});
cy.on('mouseout', 'node', (evt) => {
  const n = evt.target;
  n.removeClass('hovered');
  n.connectedEdges().removeClass('adjacent');
  cy.edges().removeClass('edge-hover-muted');
  document.getElementById('cy').style.cursor = '';
});

cy.on('mouseover', 'edge', (evt) => {
  hoveredEdgeId = evt.target.id();
  syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId);
  renderActiveEdgeInspection();
  document.getElementById('cy').style.cursor = 'pointer';
});
cy.on('mouseout', 'edge', () => {
  hoveredEdgeId = null;
  syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId);
  renderActiveEdgeInspection();
  document.getElementById('cy').style.cursor = '';
});
cy.on('tap', 'edge', (evt) => {
  selectedEdgeId = evt.target.id();
  hoveredEdgeId = null;
  syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId);
  renderActiveEdgeInspection();
  renderEdgeDetail(evt.target);
});
