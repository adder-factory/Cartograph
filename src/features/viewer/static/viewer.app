/* ───────── Top-level tabs ───────── */

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    const view = t.dataset.view;
    const stage = document.querySelector('.stage');
    // Code panel only makes sense on the Graph tab.
    const colEl = document.getElementById('canvas-col');
    if (view !== 'graph') colEl.classList.remove('with-codepane');
    else if (LIVE_MODE && liveSymbolCache?.id && !sourcePanelDismissed && !isMobileViewport()) {
      colEl.classList.add('with-codepane');
    }
    const liveView = document.getElementById('live-view');
    const traceView = document.getElementById('trace-view');
    const systemView = document.getElementById('system-view');
    // Health + Settings are sub-views of System now; the System sub-nav
    // (viewer.status.app) owns showing + lazy-loading each panel.
    liveView.style.display = view === 'live' ? 'block' : 'none';
    traceView.style.display = view === 'trace' ? 'block' : 'none';
    systemView.style.display = view === 'system' ? 'flex' : 'none';
    if (view === 'live') liveFeedActivate();
    else liveFeedDeactivate();
    // A replay stepping its timer while another tab is up would keep
    // mutating rows (and, in file:// mode, re-dimming the graph).
    if (view !== 'trace') stopTraceReplay();
    if (view === 'system' || view === 'live' || view === 'trace') {
      stage.style.display = 'none';
      if (view === 'system') showSystemView();
      if (view === 'trace') {
        if (LIVE_MODE) loadSessionsLive();
        else if (activeStep < 0) activateTraceStep(5); // step 6 (impact) is the most visually interesting
      }
    } else {
      stage.style.display = 'grid';
      // The canvas was hidden while a full-page tab was up; ask cy to
      // re-fit so nothing clips off-screen. Replay decoration (dim +
      // banner) deliberately survives the switch — "View on graph"
      // lands on the selected step's neighborhood; a background tap
      // or Escape clears it.
      resizeGraphSoon();
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
