/* ───────── Top-level tabs ───────── */

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const view = t.dataset.view;
    const stage = document.querySelector('.stage');
    const health = document.getElementById('health-view');
    // Trace bar is only relevant on the Agent trace tab — let the
    // canvas claim the full vertical otherwise. The .with-tracebar
    // class on the stage drives the grid template.
    stage.classList.toggle('with-tracebar', view === 'trace');
    // Code panel only makes sense on the Graph tab.
    const colEl = document.getElementById('canvas-col');
    if (view !== 'graph') colEl.classList.remove('with-codepane');
    else if (LIVE_MODE && liveSymbolCache?.id && !sourcePanelDismissed && !isMobileViewport()) {
      colEl.classList.add('with-codepane');
    }
    if (view === 'health') {
      stage.style.display = 'none';
      health.style.display = 'block';
      if (LIVE_MODE) loadHealthLive();
    } else {
      stage.style.display = 'grid';
      health.style.display = 'none';
      // The canvas just got resized when grid-template-rows changed;
      // ask cy to re-fit so nothing clips off-screen.
      resizeGraphSoon();
      if (view === 'trace') {
        if (LIVE_MODE) loadSessionsLive();
        else if (activeStep < 0) activateTraceStep(5); // step 6 (impact) is the most visually interesting
      } else {
        // graph: clear active step
        activeStep = -1;
        document.querySelectorAll('.trace-row').forEach(el => el.classList.remove('active'));
        cy.nodes().removeClass('dim');
        cy.edges().removeClass('dim').removeClass('highlight');
        document.getElementById('canvas-banner').classList.remove('show');
      }
    }
    writeHashState();
  });
});

globalThis.__cartographViewerSmoke = {
  cy,
  actions: viewerActions,
  bugReportPayload: viewerBugReportPayload,
  clearEdgeInspection,
  diagnostics: graphLayoutDiagnostics,
  features: globalThis.__cartographViewerFeatures || null,
  graphJsonPayload,
  graphPngDataUrl() {
    return cy.png({ bg: '#0b0f17', full: false, scale: 2 });
  },
  graphSvgText,
  resetGraphView,
  state: () => viewerState.snapshot(),
  selectionState() {
    const current = viewerCurrentSymbolId();
    const live = viewerLiveSymbolCache();
    const nav = viewerState.state.navigation;
    return {
      currentSymbolId: current,
      liveSymbolId: live?.id || null,
      detailMode,
      focusIds: cy.nodes('.focus').map((node) => node.id()),
      selectedEdgeCount: cy.edges('.selected-edge').filter((edge) => edge.style('display') !== 'none').length,
      graphHasCurrent: current ? cy.getElementById(current).length > 0 : false,
      hash: location.hash,
      detailName: document.getElementById('d-name')?.textContent || '',
      navHistory: nav.history.map((entry) => entry.id),
      navLabels: nav.history.map((entry) => entry.label || entry.id),
      navIndex: nav.index,
    };
  },
  toggleGroupCollapse,
  selectEdge(edgeId) {
    selectedEdgeId = edgeId;
    hoveredEdgeId = null;
    syncViewerEdgeInspectionState(hoveredEdgeId, selectedEdgeId);
    renderActiveEdgeInspection();
    renderEdgeDetail(cy.getElementById(edgeId));
  },
};

/* default selection — only for the file:// fallback. Live mode picks
   its own initial selection inside bootLive() once the graph loads.
   Keep this last so every control used by applyFilters/writeHashState
   has been initialized. */
syncEdgeKindFilters();
if (LIVE_MODE) void bootLive();
else {
  renderFileScopeFilters(demoScopeDirs());
  selectSymbol('extractFromSource');
}
