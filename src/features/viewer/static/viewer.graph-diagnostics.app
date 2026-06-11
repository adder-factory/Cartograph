/* Graph diagnostics and viewer bug reports
   Split from viewer.graph-core.app to keep the graph viewer modules small. */

const GRAPH_INVARIANT_SAMPLE_LIMIT = 8;
let lastGraphInvariantState = {
  counts: {},
  errors: [],
  label: 'initial',
  ok: true,
  timestamp: 0,
  warnings: [],
};

function graphDiagnosticSpread(values) {
  return values.length > 0 ? Math.max(...values) - Math.min(...values) : 0;
}

function renderedNodeOverlapStats(nodes = visibleGraphContentNodes()) {
  const boxes = nodes
    .map((node) => ({
      id: node.id(),
      label: node.data('label'),
      box: node.renderedBoundingBox({ includeLabels: false, includeOverlays: false }),
    }))
    .filter((entry) =>
      entry.box &&
      Number.isFinite(entry.box.x1) &&
      Number.isFinite(entry.box.y1) &&
      Number.isFinite(entry.box.x2) &&
      Number.isFinite(entry.box.y2)
    );
  let count = 0;
  const sample = [];
  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    for (let j = i + 1; j < boxes.length; j++) {
      const b = boxes[j];
      const overlapX = Math.min(a.box.x2, b.box.x2) - Math.max(a.box.x1, b.box.x1);
      const overlapY = Math.min(a.box.y2, b.box.y2) - Math.max(a.box.y1, b.box.y1);
      if (overlapX <= 0.75 || overlapY <= 0.75) continue;
      count++;
      if (sample.length < 8) {
        sample.push({
          a: { id: a.id, label: a.label },
          b: { id: b.id, label: b.label },
          overlapX,
          overlapY,
        });
      }
    }
  }
  return { count, sample };
}

function graphInvariantVisibleNode(node) {
  return Boolean(node && node.length !== 0 && node.style('display') !== 'none' && !node.hasClass('collapse-hidden'));
}

function pushGraphInvariantFinding(list, message, data = null) {
  if (list.length >= GRAPH_INVARIANT_SAMPLE_LIMIT) return;
  list.push(data ? { message, ...data } : { message });
}

function validateGraphState(label = 'runtime', opts = {}) {
  const errors = [];
  const warnings = [];
  const seenIds = new Set();
  let duplicateIdCount = 0;
  let visibleEdgeCount = 0;
  let visibleNodeCount = 0;
  let hiddenEndpointCount = 0;
  let collapsedLeakCount = 0;
  let nonFinitePositionCount = 0;

  cy.elements().forEach((element) => {
    const id = element.id();
    if (!id) return;
    if (seenIds.has(id)) {
      duplicateIdCount++;
      pushGraphInvariantFinding(errors, 'duplicate element id', { id });
    }
    seenIds.add(id);
  });

  visibleGraphContentNodes().forEach((node) => {
    visibleNodeCount++;
    const pos = node.position();
    const rendered = node.renderedPosition?.() || pos;
    if (
      !Number.isFinite(pos.x) ||
      !Number.isFinite(pos.y) ||
      !Number.isFinite(rendered.x) ||
      !Number.isFinite(rendered.y)
    ) {
      nonFinitePositionCount++;
      pushGraphInvariantFinding(errors, 'node position is not finite', { id: node.id(), position: pos, rendered });
    }
  });

  const current = viewerCurrentSymbolId();
  if (current) {
    const selected = cy.getElementById(current);
    if (selected.length === 0) {
      pushGraphInvariantFinding(warnings, 'selected symbol is not in current graph', { id: current });
    } else if (!graphInvariantVisibleNode(selected)) {
      pushGraphInvariantFinding(errors, 'selected symbol is hidden', { id: current });
    }
  }

  const selectedEdge = viewerState.state.edgeInspection.selectedEdgeId;
  if (selectedEdge) {
    const edge = cy.getElementById(selectedEdge);
    if (edge.length === 0) {
      pushGraphInvariantFinding(warnings, 'selected edge is not in current graph', { id: selectedEdge });
    } else if (edge.style('display') === 'none') {
      pushGraphInvariantFinding(warnings, 'selected edge is hidden', { id: selectedEdge });
    }
  }

  cy.edges().forEach((edge) => {
    if (edge.style('display') === 'none') return;
    visibleEdgeCount++;
    const source = edge.source();
    const target = edge.target();
    const sourceVisible = graphInvariantVisibleNode(source);
    const targetVisible = graphInvariantVisibleNode(target);
    if (!sourceVisible || !targetVisible) {
      hiddenEndpointCount++;
      pushGraphInvariantFinding(errors, 'visible edge has hidden endpoint', {
        id: edge.id(),
        source: source.id(),
        sourceVisible,
        target: target.id(),
        targetVisible,
      });
    }
    if (!edge.data('collapsedEdge') && !edge.data('detailBucketEdge')) {
      const sourceCollapsed = typeof collapsedParentForNode === 'function' ? collapsedParentForNode(source) : null;
      const targetCollapsed = typeof collapsedParentForNode === 'function' ? collapsedParentForNode(target) : null;
      if (sourceCollapsed || targetCollapsed) {
        collapsedLeakCount++;
        pushGraphInvariantFinding(errors, 'collapsed group leaked a child edge', {
          id: edge.id(),
          source: source.id(),
          sourceGroup: sourceCollapsed?.id?.() || null,
          target: target.id(),
          targetGroup: targetCollapsed?.id?.() || null,
        });
      }
    }
  });

  lastGraphInvariantState = {
    counts: {
      collapsedLeakCount,
      duplicateIdCount,
      hiddenEndpointCount,
      nonFinitePositionCount,
      visibleEdgeCount,
      visibleNodeCount,
    },
    errors,
    label: String(label),
    ok: errors.length === 0,
    timestamp: Date.now(),
    warnings,
  };

  if (opts.throwOnError && errors.length > 0) {
    throw new Error(`graph invariant failed after ${label}: ${JSON.stringify(lastGraphInvariantState)}`);
  }
  return lastGraphInvariantState;
}

function graphLayoutDiagnostics(label = '') {
  const visibleNodes = visibleGraphContentNodes();
  const positions = visibleNodes.map((node) => {
    const p = node.renderedPosition();
    return { id: node.id(), label: node.data('label'), x: p.x, y: p.y };
  });
  const xs = positions.map((pos) => pos.x);
  const ys = positions.map((pos) => pos.y);
  const diagonalResiduals = positions.map((pos) => pos.y - pos.x);
  const antiDiagonalResiduals = positions.map((pos) => pos.y + pos.x);
  const renderedWidth = graphDiagnosticSpread(xs);
  const renderedHeight = graphDiagnosticSpread(ys);
  const diagonalSpread = graphDiagnosticSpread(diagonalResiduals);
  const antiDiagonalSpread = graphDiagnosticSpread(antiDiagonalResiduals);
  const narrowestLineSpread = Math.min(diagonalSpread, antiDiagonalSpread);
  const minSpan = Math.min(renderedWidth, renderedHeight);
  const nodeOverlaps = renderedNodeOverlapStats(visibleNodes);
  const hiddenLabelCount = cy.nodes('.label-hidden').filter((node) =>
    node.style('display') !== 'none' && !node.hasClass('collapse-hidden')
  ).length;

  const visibleEdges = cy.edges().filter((edge) => edge.style('display') !== 'none');
  let hiddenEndpointCount = 0;
  let badBoxCount = 0;
  let shortEndpointCount = 0;
  visibleEdges.forEach((edge) => {
    const source = edge.source();
    const target = edge.target();
    const sourceVisible = source.style('display') !== 'none' && !source.hasClass('collapse-hidden');
    const targetVisible = target.style('display') !== 'none' && !target.hasClass('collapse-hidden');
    if (!sourceVisible || !targetVisible) hiddenEndpointCount++;
    const box = edge.renderedBoundingBox({ includeLabels: false, includeOverlays: false });
    if (
      !box ||
      !Number.isFinite(box.x1) ||
      !Number.isFinite(box.y1) ||
      (Math.abs(box.x2 - box.x1) < 1 && Math.abs(box.y2 - box.y1) < 1)
    ) {
      badBoxCount++;
    }
    if (source.id() === target.id()) return;
    const sourceEndpoint = edge.renderedSourceEndpoint?.();
    const targetEndpoint = edge.renderedTargetEndpoint?.();
    if (!sourceEndpoint || !targetEndpoint) return;
    if (Math.hypot(sourceEndpoint.x - targetEndpoint.x, sourceEndpoint.y - targetEndpoint.y) < 2) {
      shortEndpointCount++;
    }
  });

  return {
    label: String(label),
    currentSymbolId: viewerCurrentSymbolId(),
    graphLayoutKey: currentGraphLayoutKey,
    layoutEngine: lastGraphLayoutRun.engine,
    layoutQualityMode: graphLayoutQuality,
    lastLayoutDurationMs: lastGraphLayoutRun.durationMs,
    layoutWatchdog: typeof graphLayoutWatchdogState === 'undefined' ? null : graphLayoutWatchdogState,
    visibleNodeCount: visibleNodes.length,
    visibleEdgeCount: visibleEdges.length,
    totalNodeCount: graphVisibilityStats.totalNodeCount,
    totalEdgeCount: graphVisibilityStats.totalEdgeCount,
    hiddenEdgeByEndpointCount: graphVisibilityStats.hiddenEdgeByEndpointCount,
    hiddenEdgeByFilterCount: graphVisibilityStats.hiddenEdgeByFilterCount,
    hiddenEdgeByLensCount: graphVisibilityStats.hiddenEdgeByLensCount,
    hiddenNodeByDensityCount: graphVisibilityStats.hiddenNodeByDensityCount,
    hiddenLabelCount,
    renderedWidth,
    renderedHeight,
    diagonalSpread,
    antiDiagonalSpread,
    narrowestLineSpread,
    linearityScore: minSpan > 0 ? narrowestLineSpread / minSpan : 0,
    hiddenEndpointCount,
    nodeOverlapCount: nodeOverlaps.count,
    nodeOverlapSample: nodeOverlaps.sample,
    badBoxCount,
    shortEndpointCount,
    disconnectedVisibleEdgeCount: hiddenEndpointCount + badBoxCount + shortEndpointCount,
    invariantErrorCount: lastGraphInvariantState.errors.length,
    invariantWarningCount: lastGraphInvariantState.warnings.length,
    invariantState: lastGraphInvariantState,
    pinnedNodeCount: pinnedGraphNodes().length,
    zoom: cy.zoom(),
    pan: cy.pan(),
    sample: positions.slice(0, 8),
  };
}

function graphDiagnosticsNumber(value) {
  if (!Number.isFinite(Number(value))) return '0';
  return Math.round(Number(value)).toLocaleString();
}

function graphDiagnosticsDuration(ms) {
  if (!Number.isFinite(Number(ms)) || Number(ms) <= 0) return 'pending';
  return `${Math.round(Number(ms))}ms`;
}

function graphDiagnosticsWarnings(diagnostics) {
  const warnings = [];
  if (diagnostics.layoutWatchdog?.reason) {
    warnings.push(
      diagnostics.layoutWatchdog.retried
        ? `layout watchdog retried: ${diagnostics.layoutWatchdog.reason}`
        : `layout watchdog skipped: ${diagnostics.layoutWatchdog.skipped || diagnostics.layoutWatchdog.reason}`
    );
  }
  if (diagnostics.invariantErrorCount > 0) {
    warnings.push(`${diagnostics.invariantErrorCount} graph invariant error${diagnostics.invariantErrorCount === 1 ? '' : 's'}`);
  }
  if (diagnostics.totalNodeCount >= 120 || diagnostics.visibleNodeCount >= 100) {
    warnings.push(`${diagnostics.visibleNodeCount}/${diagnostics.totalNodeCount || diagnostics.visibleNodeCount} nodes in view`);
  }
  if (diagnostics.totalEdgeCount >= 300 || diagnostics.visibleEdgeCount >= 250) {
    warnings.push(`${diagnostics.visibleEdgeCount}/${diagnostics.totalEdgeCount || diagnostics.visibleEdgeCount} edges in view`);
  }
  if (diagnostics.lastLayoutDurationMs > 800) {
    warnings.push(`layout took ${graphDiagnosticsDuration(diagnostics.lastLayoutDurationMs)}`);
  }
  if (diagnostics.hiddenLabelCount > 0) {
    warnings.push(`${diagnostics.hiddenLabelCount} labels hidden`);
  }
  if (diagnostics.nodeOverlapCount > 0) {
    warnings.push(`${diagnostics.nodeOverlapCount} node overlaps`);
  }
  if (diagnostics.disconnectedVisibleEdgeCount > 0) {
    warnings.push(`${diagnostics.disconnectedVisibleEdgeCount} edge geometry issues`);
  }
  return warnings;
}

function graphDiagnosticsAlertWarnings(diagnostics) {
  const warnings = [];
  if (diagnostics.layoutWatchdog?.reason && diagnostics.layoutWatchdog.retried) {
    warnings.push('layout retried');
  }
  if (diagnostics.invariantErrorCount > 0) {
    warnings.push(`${diagnostics.invariantErrorCount} invariant error${diagnostics.invariantErrorCount === 1 ? '' : 's'}`);
  } else if (diagnostics.invariantWarningCount > 0) {
    warnings.push(`${diagnostics.invariantWarningCount} invariant warning${diagnostics.invariantWarningCount === 1 ? '' : 's'}`);
  }
  if (diagnostics.nodeOverlapCount > 0) {
    warnings.push(`${diagnostics.nodeOverlapCount} overlaps`);
  }
  if (diagnostics.disconnectedVisibleEdgeCount > 0) {
    warnings.push(`${diagnostics.disconnectedVisibleEdgeCount} edge issues`);
  }
  return warnings;
}

function syncGraphHealthPill(diagnostics) {
  const pill = document.getElementById('graph-health-pill');
  if (!pill) return;
  const warnings = graphDiagnosticsAlertWarnings(diagnostics);
  if (warnings.length === 0) {
    pill.hidden = true;
    const label = pill.querySelector('[data-graph-health-label]');
    if (label) label.textContent = 'Graph healthy';
    else pill.textContent = 'Graph healthy';
    delete pill.dataset.state;
    return;
  }
  pill.hidden = false;
  pill.dataset.state = 'warn';
  const label = pill.querySelector('[data-graph-health-label]');
  const text = warnings.length === 1 ? warnings[0] : `${warnings.length} graph warnings`;
  if (label) label.textContent = text;
  else pill.textContent = text;
  pill.dataset.tooltip = warnings.join(' · ');
}

function graphDiagnosticsRows(diagnostics) {
  const warnings = graphDiagnosticsWarnings(diagnostics);
  return [
    ['Visible nodes', `${graphDiagnosticsNumber(diagnostics.visibleNodeCount)} / ${graphDiagnosticsNumber(diagnostics.totalNodeCount || diagnostics.visibleNodeCount)}`],
    ['Visible edges', `${graphDiagnosticsNumber(diagnostics.visibleEdgeCount)} / ${graphDiagnosticsNumber(diagnostics.totalEdgeCount || diagnostics.visibleEdgeCount)}`],
    ['Hidden by edge filter', graphDiagnosticsNumber(diagnostics.hiddenEdgeByFilterCount)],
    ['Hidden by edge lens', graphDiagnosticsNumber(diagnostics.hiddenEdgeByLensCount)],
    ['Hidden endpoints', graphDiagnosticsNumber(diagnostics.hiddenEdgeByEndpointCount)],
    ['Hidden by density', graphDiagnosticsNumber(diagnostics.hiddenNodeByDensityCount)],
    ['Pinned nodes', graphDiagnosticsNumber(diagnostics.pinnedNodeCount)],
    ['Layout', `${diagnostics.layoutEngine || 'unknown'} · ${layoutQualityConfig().label}`],
    ['Last layout', graphDiagnosticsDuration(diagnostics.lastLayoutDurationMs)],
    ['Watchdog', diagnostics.layoutWatchdog?.reason ? (diagnostics.layoutWatchdog.retried ? 'retried' : `skipped · ${diagnostics.layoutWatchdog.skipped || 'locked'}`) : 'clear', Boolean(diagnostics.layoutWatchdog?.reason)],
    ['Invariants', diagnostics.invariantErrorCount > 0 ? `${diagnostics.invariantErrorCount} errors` : `${diagnostics.invariantWarningCount || 0} warnings`, diagnostics.invariantErrorCount > 0],
    ['Labels hidden', graphDiagnosticsNumber(diagnostics.hiddenLabelCount), diagnostics.hiddenLabelCount > 0],
    ['Overlaps', graphDiagnosticsNumber(diagnostics.nodeOverlapCount), diagnostics.nodeOverlapCount > 0],
    ['Warnings', warnings.length > 0 ? warnings.join(' · ') : 'none', warnings.length > 0, true],
  ];
}

function syncGraphDiagnosticsPanel(precomputedDiagnostics = null) {
  const panel = document.getElementById('graph-diagnostics');
  const summary = document.getElementById('graph-diagnostics-summary');
  const button = document.getElementById('btn-graph-diagnostics');
  if (!panel && !summary && !button) return;
  const diagnostics = precomputedDiagnostics || graphLayoutDiagnostics('panel');
  syncGraphHealthPill(diagnostics);
  if (summary) {
    const overlap = diagnostics.nodeOverlapCount > 0 ? ` · ${diagnostics.nodeOverlapCount} overlaps` : '';
    summary.textContent = `${diagnostics.visibleNodeCount}n ${diagnostics.visibleEdgeCount}e${overlap}`;
  }
  if (button) {
    const open = panel ? !panel.hidden : false;
    const label = button.querySelector('[data-diagnostics-label]');
    if (label) label.textContent = open ? 'Hide diagnostics' : 'Show diagnostics';
    else button.textContent = open ? 'Hide diagnostics' : 'Show diagnostics';
    button.dataset.active = open ? '1' : '0';
  }
  if (!panel || panel.hidden) return;
  panel.innerHTML = graphDiagnosticsRows(diagnostics).map(([label, value, warn, wide]) => `
    <div class="graph-diagnostics-row${wide ? ' wide' : ''}" data-warn="${warn ? '1' : '0'}">
      <span>${escapeHtml(label)}</span>
      <b>${escapeHtml(value)}</b>
    </div>
  `).join('');
}

function toggleGraphDiagnosticsPanel(force) {
  const panel = document.getElementById('graph-diagnostics');
  if (!panel) return;
  panel.hidden = typeof force === 'boolean' ? !force : !panel.hidden;
  syncGraphDiagnosticsPanel();
}

function setBugReportStatus(message, state = 'info') {
  const el = document.getElementById('bug-report-status');
  if (!el) return;
  el.textContent = message;
  el.dataset.state = state;
  el.hidden = false;
}

function viewerBugReportPayload() {
  const diagnostics = graphLayoutDiagnostics('bug-report');
  return {
    version: 1,
    copiedAt: new Date().toISOString(),
    url: location.href,
    hash: location.hash || '',
    viewport: {
      height: window.innerHeight,
      width: window.innerWidth,
      devicePixelRatio: window.devicePixelRatio || 1,
      mobile: typeof isMobileViewport === 'function' ? isMobileViewport() : false,
    },
    browser: navigator.userAgent,
    selected: {
      id: viewerCurrentSymbolId(),
      label: viewerLiveSymbolCache()?.label || cy.getElementById(viewerCurrentSymbolId() || '').data('label') || null,
      file: viewerLiveSymbolCache()?.file || cy.getElementById(viewerCurrentSymbolId() || '').data('file') || null,
    },
    view: {
      density: typeof graphDensityMode === 'undefined' ? null : viewerGraphMode('densityMode', graphDensityMode),
      detail: typeof detailGroupingMode === 'undefined' ? null : viewerGraphMode('detailGroupingMode', detailGroupingMode),
      edgeLens: typeof graphEdgeLensMode === 'undefined' ? null : viewerGraphMode('edgeLensMode', graphEdgeLensMode),
      layout: viewerGraphMode('layoutQuality', graphLayoutQuality),
      activeTab: document.querySelector('.tab.active')?.dataset.view || 'graph',
      breadcrumbScope: typeof breadcrumbScope === 'undefined' ? null : viewerGraphMode('breadcrumbScope', breadcrumbScope),
    },
    filters: typeof currentGraphFilterState === 'function' ? currentGraphFilterState() : null,
    state: typeof viewerState === 'undefined' ? null : viewerState.snapshot(),
    diagnostics,
    invariants: validateGraphState('bug-report'),
    layoutWatchdog: typeof graphLayoutWatchdogState === 'undefined' ? null : graphLayoutWatchdogState,
    graph: typeof graphJsonPayload === 'function'
      ? (() => {
          const payload = graphJsonPayload();
          return { edgeCount: payload.edges?.length || 0, nodeCount: payload.nodes?.length || 0 };
        })()
      : null,
  };
}

async function copyBugReportText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    try {
      // execCommand reports failure via its return value, not a throw —
      // returning true unconditionally showed "copied" with an empty
      // clipboard.
      return document.execCommand('copy');
    } finally {
      textarea.remove();
    }
  }
}

async function copyGraphBugReport() {
  const payload = viewerBugReportPayload();
  try {
    await copyBugReportText(JSON.stringify(payload, null, 2));
    setBugReportStatus('Bug report copied.', 'ok');
    flashActionButton(document.getElementById('btn-copy-bug-report'), 'Copied');
  } catch (err) {
    setBugReportStatus(`Copy failed: ${String(err)}`, 'err');
  }
}

initializeGraphLayoutState();
syncLayoutQualityControl();
document.getElementById('layout-quality-control')?.addEventListener('click', (event) => {
  const btn = event.target.closest('[data-layout-quality]');
  if (!btn) return;
  setGraphLayoutQuality(btn.dataset.layoutQuality);
});
document.getElementById('btn-zoom-in')?.addEventListener('click', () => zoomBy(1.25));
document.getElementById('btn-zoom-out')?.addEventListener('click', () => zoomBy(0.8));
document.getElementById('btn-zoom-fit')?.addEventListener('click', fitGraph);
document.getElementById('btn-layout-pin')?.addEventListener('click', pinVisibleGraphPositions);
document.getElementById('btn-layout-unlock')?.addEventListener('click', unlockPinnedGraphPositions);
document.getElementById('btn-layout-reset')?.addEventListener('click', resetPinnedGraphLayout);
document.getElementById('btn-graph-diagnostics')?.addEventListener('click', () => toggleGraphDiagnosticsPanel());
document.getElementById('btn-copy-bug-report')?.addEventListener('click', () => void copyGraphBugReport());
document.getElementById('graph-health-pill')?.addEventListener('click', () => {
  if (typeof setViewerUiMode === 'function') setViewerUiMode('advanced', { openAdvanced: true });
  if (typeof openViewerRailSection === 'function') openViewerRailSection('advanced');
  toggleGraphDiagnosticsPanel(true);
});
registerViewerAction('copyGraphBugReport', copyGraphBugReport);
registerViewerAction('fitGraph', fitGraph);
registerViewerAction('validateGraphState', validateGraphState);
registerViewerAction('relayoutAndFit', relayoutAndFit);
registerViewerAction('toggleGraphDiagnosticsPanel', toggleGraphDiagnosticsPanel);
globalThis.validateGraphState = validateGraphState;
setTimeout(relayoutAndFit, 50);
