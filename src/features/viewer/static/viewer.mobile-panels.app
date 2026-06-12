/* Mobile panels and keyboard navigation
   Split from viewer.graph-core.app to keep the graph viewer modules small. */

const MOBILE_MQ = globalThis.matchMedia
  ? globalThis.matchMedia('(max-width: 860px)')
  : { matches: false, addEventListener() {} };

function isMobileViewport() {
  return Boolean(MOBILE_MQ.matches);
}

function fitPadding() {
  return isMobileViewport() ? 32 : 60;
}

function mobilePanelState() {
  const stage = document.getElementById('stage');
  const col = document.getElementById('canvas-col');
  if (col.classList.contains('with-codepane')) return 'source';
  if (stage.classList.contains('mobile-detail-open')) return 'detail';
  if (stage.classList.contains('mobile-filters-open')) return 'filters';
  return null;
}

function syncMobilePanelButtons() {
  const active = isMobileViewport() ? mobilePanelState() : null;
  document.querySelectorAll('[data-mobile-panel]').forEach((btn) => {
    const on = btn.dataset.mobilePanel === active;
    btn.dataset.active = on ? '1' : '0';
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
}

function closeMobilePanels() {
  const stage = document.getElementById('stage');
  const col = document.getElementById('canvas-col');
  stage.classList.remove('mobile-detail-open', 'mobile-filters-open');
  col.classList.remove('with-codepane');
  syncMobilePanelButtons();
  resizeGraphSoon();
  writeHashState();
}

function openSourcePanel() {
  if (!LIVE_MODE) return;
  const symbolId = liveSymbolCache?.id;
  const col = document.getElementById('canvas-col');
  sourcePanelDismissed = false;
  col.classList.add('with-codepane');
  if (LIVE_MODE && symbolId && !codeOriginalHtml) loadSourceLive(symbolId);
  syncMobilePanelButtons();
  resizeGraphSoon();
  writeHashState();
}

function openMobilePanel(panel) {
  if (!isMobileViewport()) {
    if (panel === 'fit') fitGraph();
    else if (panel === 'source') document.getElementById('btn-show-code')?.click();
    return;
  }

  if (panel === 'fit') {
    fitGraph();
    return;
  }

  const stage = document.getElementById('stage');
  const col = document.getElementById('canvas-col');
  const current = mobilePanelState();

  if (current === panel) {
    closeMobilePanels();
    return;
  }

  stage.classList.remove('mobile-detail-open', 'mobile-filters-open');
  col.classList.remove('with-codepane');

  if (panel === 'detail') stage.classList.add('mobile-detail-open');
  else if (panel === 'filters') stage.classList.add('mobile-filters-open');
  else if (panel === 'source') openSourcePanel();

  syncMobilePanelButtons();
  resizeGraphSoon();
  writeHashState();
}

function revealSelectionPanelOnMobile() {
  if (!isMobileViewport()) return;
  const stage = document.getElementById('stage');
  const col = document.getElementById('canvas-col');
  if (col.classList.contains('with-codepane')) {
    syncMobilePanelButtons();
    return;
  }
  stage.classList.remove('mobile-filters-open');
  stage.classList.add('mobile-detail-open');
  syncMobilePanelButtons();
}

document.querySelectorAll('[data-mobile-panel]').forEach((btn) => {
  btn.addEventListener('click', () => openMobilePanel(btn.dataset.mobilePanel));
});
document.getElementById('btn-mobile-close')?.addEventListener('click', closeMobilePanels);

MOBILE_MQ.addEventListener?.('change', () => {
  if (!isMobileViewport()) {
    document.getElementById('stage').classList.remove('mobile-detail-open', 'mobile-filters-open');
    if (LIVE_MODE && liveSymbolCache?.id) document.getElementById('canvas-col').classList.add('with-codepane');
  } else if (document.getElementById('canvas-col').classList.contains('with-codepane')) {
    document.getElementById('canvas-col').classList.remove('with-codepane');
    document.getElementById('stage').classList.add('mobile-detail-open');
  }
  syncMobilePanelButtons();
  resizeGraphSoon();
});

/* Keyboard shortcuts. `/` focuses search, `Esc` clears selection,
   `+/-/0` mirror graph zoom, Alt+arrows mirror history, and the
   `g g` / `g t` / `g l` / `g h` chords (advertised in the command palette)
   switch tabs. */
let pendingChordKey = null;
let pendingChordTimer = null;
const CHORD_TABS = { g: 'graph', t: 'trace', l: 'live', h: 'health' };

function clearPendingChord() {
  pendingChordKey = null;
  if (pendingChordTimer) { clearTimeout(pendingChordTimer); pendingChordTimer = null; }
}

document.addEventListener('keydown', (e) => {
  const target = e.target;
  const inField = target instanceof HTMLElement &&
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);
  if (!inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
    if (pendingChordKey === 'g') {
      const view = CHORD_TABS[e.key.toLowerCase()];
      clearPendingChord();
      if (view) {
        e.preventDefault();
        clickTab(view);
        return;
      }
    } else if (e.key === 'g') {
      pendingChordKey = 'g';
      pendingChordTimer = setTimeout(clearPendingChord, 1000);
      return;
    }
  } else if (pendingChordKey) {
    clearPendingChord();
  }
  if (e.key === '/' && !inField) {
    e.preventDefault();
    // On the Live / Agent-trace tabs, `/` goes to that view's local
    // filter; everywhere else it is the global symbol search.
    const activeView = document.querySelector('.tab.active')?.dataset.view;
    const filterTarget =
      activeView === 'live' ? document.getElementById('lf-filter')
      : activeView === 'trace' ? document.getElementById('tr-filter')
      : null;
    (filterTarget || document.getElementById('search-input'))?.focus();
    return;
  }
  if (e.key === 'Escape') {
    // Escape inside a field (search box, palette, ask input) only
    // dismisses the field-local UI — it must not also destroy the
    // user's symbol selection and detail panes.
    if (inField || e.defaultPrevented) {
      if (inField) target.blur();
      return;
    }
    if (typeof clearCurrentSelection === 'function') clearCurrentSelection();
    else {
      currentSymbolId = null;
      liveSymbolCache = null;
      syncViewerSelectionState(currentSymbolId, liveSymbolCache);
      cy.nodes().removeClass('focus dim hovered selected-neighbor');
      cy.edges().removeClass('dim highlight adjacent selected-edge');
      applyFilters();
      writeHashState();
    }
    document.getElementById('canvas-banner').classList.remove('show');
    return;
  }
  if (inField) return;
  if (e.key === '+' || e.key === '=') { e.preventDefault(); zoomBy(1.25); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); zoomBy(0.8);  return; }
  if (e.key === '0')                  { e.preventDefault(); fitGraph(); return; }
  if (e.altKey && e.key === 'ArrowLeft')  { e.preventDefault(); navTo(-1); return; }
  if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navTo(+1); }
});
