/* Selection history stack — back/forward navigation, browser-style.
   Push on every NEW selection; back/forward replay through the
   stack without re-pushing. The `_navigating` flag suppresses the
   push when a selection comes from the back/forward buttons
   themselves. */
const navHistory = [];
let navIndex = -1;
let _navigating = false;
syncViewerNavigationState(navHistory, navIndex);

function navEntryLabel(entry) {
  return String(entry?.label || entry?.id || 'symbol');
}

function navUpdateButtons() {
  syncViewerNavigationState(navHistory, navIndex);
  const back = document.getElementById('btn-nav-back');
  const fwd = document.getElementById('btn-nav-fwd');
  const backTarget = navHistory[navIndex - 1] || null;
  const fwdTarget = navHistory[navIndex + 1] || null;
  back.disabled = !backTarget;
  fwd.disabled = !fwdTarget;
  back.dataset.tooltip = backTarget ? `Back to ${navEntryLabel(backTarget)} (Alt+←)` : 'No previous symbol';
  fwd.dataset.tooltip = fwdTarget ? `Forward to ${navEntryLabel(fwdTarget)} (Alt+→)` : 'No next symbol';
}
function navPush(symbolId, label = symbolId) {
  if (_navigating) return;
  // Truncate any forward history when a fresh selection lands.
  navHistory.splice(navIndex + 1);
  const last = navHistory[navHistory.length - 1];
  if (last?.id === symbolId) {
    last.label = label || last.label || symbolId;
    navUpdateButtons();
    return;
  }
  navHistory.push({ id: symbolId, label: label || symbolId });
  navIndex = navHistory.length - 1;
  navUpdateButtons();
}
async function navTo(delta) {
  const next = navIndex + delta;
  if (next < 0 || next >= navHistory.length) return;
  const entry = navHistory[next];
  if (!entry?.id) return;
  navIndex = next;
  _navigating = true;
  try {
    if (LIVE_MODE) await focusGraphOnSymbol(entry.id, navEntryLabel(entry));
    else if (typeof selectSymbol === 'function') selectSymbol(entry.id);
  } finally {
    _navigating = false;
    navUpdateButtons();
    if (typeof validateGraphState === 'function') validateGraphState('navigation');
  }
}
document.getElementById('btn-nav-back').addEventListener('click', () => navTo(-1));
document.getElementById('btn-nav-fwd') .addEventListener('click', () => navTo(+1));

let symbolSelectRequestSeq = 0;

async function selectSymbolLive(symbolId) {
  const requestSeq = ++symbolSelectRequestSeq;
  try {
    const r = await apiFetch(`/api/symbol/${encodeURIComponent(symbolId)}`);
    if (!r.ok) return;
    const p = await r.json();
    if (requestSeq !== symbolSelectRequestSeq) return;
    liveSymbolCache = p;
    currentSymbolId = p.id;
    syncViewerSelectionState(currentSymbolId, liveSymbolCache);
    detailMode = 'symbol';
    selectedEdgeCache = null;
    setDetailActionsEnabled(true);
    setSymbolDetailTabs();
    renderGraphTrail();
    navPush(p.id, p.label);
    pushRecent(p);
    writeHashState();
    document.getElementById('d-name').textContent = p.label;
    const signatureSuffix = p.signature ? `  ${p.signature.replaceAll(/\s+/g, ' ').trim()}` : '';
    const subtitle = `${p.kind} · ${p.file}:${p.line ?? '?'}${signatureSuffix}`;
    document.getElementById('d-loc').textContent = subtitle;
    renderBreadcrumb(p.file, p.label);
    renderDocstringPreview(p.docstring, p.id);
    resetCodePanel(p.id);
    document.getElementById('d-cent').textContent = (p.centrality ?? 0).toFixed(4);
    const errs = (p.findings ?? []).filter(f => f.severity === 'error').length;
    const warns = (p.findings ?? []).filter(f => f.severity === 'warning').length;
    const infos = (p.findings ?? []).filter(f => f.severity === 'info').length;
    // Tiers mirror the graph's health coloring (and the file:// path's
    // mapping): info-only findings are not a perfect 10.
    let health10 = '10/10';
    if (errs > 0) health10 = '3/10';
    else if (warns > 0) health10 = '6/10';
    else if (infos > 0) health10 = '8/10';
    const healthEl = document.getElementById('d-health');
    healthEl.textContent = health10;
    let healthClass = 'ok';
    if (errs > 0) healthClass = 'err';
    else if (warns > 0) healthClass = 'warn';
    healthEl.className = `v ${healthClass}`;
    if (typeof updateAskTarget === 'function') updateAskTarget(p.label || 'this symbol');
    document.getElementById('d-cov').textContent = p.coverage && p.coverage.ratio != null
      ? `${Math.round(p.coverage.ratio * 100)}%`
      : '—';
    document.getElementById('d-callers-ct').textContent = `(${(p.callers ?? []).length})`;
    document.getElementById('d-callees-ct').textContent = `(${(p.callees ?? []).length})`;
    document.getElementById('d-findings-ct').textContent = `(${(p.findings ?? []).length})`;
    const m = p.metrics ?? {};
    document.getElementById('m-loc').textContent     = m.loc ?? '—';
    document.getElementById('m-cyc').textContent     = m.cyclomatic ?? '—';
    document.getElementById('m-nest').textContent    = m.maxNesting ?? '—';
    document.getElementById('m-first').textContent   = formatRelative(m.fileFirstSeenTs);
    document.getElementById('m-last').textContent    = formatRelative(m.fileLastTouchedTs);
    document.getElementById('m-commits').textContent = m.fileCommits ?? '—';
    const activeSub = document.querySelector('.subtab.active')?.dataset.sub || 'callers';
    renderSubpanelLive(activeSub);
    cy.nodes().removeClass('focus');
    cy.getElementById(p.id).addClass('focus');
    applyFilters();
    resizeGraphSoon();
    revealSelectionPanelOnMobile();
  } catch (err) {
    console.warn('viewer: selectSymbolLive failed', err);
  }
}

function renderSubpanelLive(sub) {
  const p = liveSymbolCache;
  if (!p) { SUBPANEL.innerHTML = '<div class="empty">No selection</div>'; return; }
  // All API string fields go through escapeHtml — symbol names from
  // indexed source could contain '<' / '>' (e.g. C++ template params,
  // operator overloads). Local-only viewer so the attack surface is
  // small but the principle stands.
  const esc = (v) => escapeHtml(String(v ?? '?'));
  // data-symbol carries the node id so the click delegate below can
  // navigate without re-resolving by name (collisions on common
  // names would otherwise route to the wrong symbol).
  const refRow = (n) => `<div class="ref-row" data-symbol="${esc(n.id)}" role="button" tabindex="0" title="${esc(n.label || n.id)} — click to focus"><div class="name">${esc(n.label || n.id)}</div><div class="loc">${esc(n.file)}:${esc(n.line ?? '?')}</div></div>`;
  SUBPANEL.innerHTML = renderLiveSubpanelHtml(sub, p, esc, refRow);
}

function renderLiveSubpanelHtml(sub, p, esc, refRow) {
  if (sub === 'callers') return (p.callers ?? []).map(refRow).join('') || '<div class="empty">No callers</div>';
  if (sub === 'callees') return (p.callees ?? []).map(refRow).join('') || '<div class="empty">No callees</div>';
  if (sub === 'findings') return renderLiveFindingsHtml(p, esc);
  if (sub === 'coverage') return renderLiveCoverageHtml(p, esc);
  return '';
}

function renderLiveFindingsHtml(p, esc) {
  const findings = p.findings ?? [];
  return findings.length === 0
    ? '<div class="empty">No findings — code health 10/10</div>'
    : findings.map(f => `<div class="ref-row" data-biomarker="${esc(f.biomarker)}" role="button" tabindex="0" title="Filter graph by ${esc(f.biomarker)}"><div class="name">${esc(f.biomarker)}</div><div class="loc">severity: ${esc(f.severity)} · metric ${esc(f.metric)} · click to filter</div></div>`).join('');
}

function renderLiveCoverageHtml(p, esc) {
  const cov = p.coverage;
  if (!cov) return '<div class="empty">No coverage data — run <code>cartograph coverage --mode load --report-path &lt;lcov&gt;</code> to ingest.</div>';

  const pct = typeof cov.ratio === 'number' ? `${Math.round(cov.ratio * 100)}%` : '—';
  const branches = typeof cov.totalBranches === 'number'
    ? `${cov.coveredBranches}/${cov.totalBranches} branches covered`
    : 'branch coverage not in source';
  return `<div class="ref-row"><div class="name">Lines: ${esc(pct)}</div><div class="loc">${cov.coveredLines}/${cov.totalLines} lines · source: ${esc(cov.source)}</div></div>` +
    `<div class="ref-row"><div class="name">Branches</div><div class="loc">${esc(branches)}</div></div>`;
}

/* ───────── Detail pane ───────── */

const SUBPANEL = document.getElementById('subpanel');

function clearCurrentSelection() {
  currentSymbolId = null;
  liveSymbolCache = null;
  syncViewerSelectionState(currentSymbolId, liveSymbolCache);
  detailMode = 'symbol';
  selectedEdgeCache = null;
  setDetailActionsEnabled(false);
  setSymbolDetailTabs();
  document.getElementById('d-breadcrumb').innerHTML = '';
  document.getElementById('d-name').textContent = 'No selection';
  document.getElementById('d-loc').textContent = 'Select a node in the graph';
  document.getElementById('d-health').textContent = '—';
  document.getElementById('d-health').className = 'v';
  document.getElementById('d-cent').textContent = '—';
  document.getElementById('d-cov').textContent = '—';
  document.getElementById('d-callers-ct').textContent = '(0)';
  document.getElementById('d-callees-ct').textContent = '(0)';
  document.getElementById('d-findings-ct').textContent = '(0)';
  document.getElementById('m-loc').textContent = '—';
  document.getElementById('m-cyc').textContent = '—';
  document.getElementById('m-nest').textContent = '—';
  document.getElementById('m-first').textContent = '—';
  document.getElementById('m-last').textContent = '—';
  document.getElementById('m-commits').textContent = '—';
  document.getElementById('d-doc').style.display = 'none';
  document.getElementById('d-doc').innerHTML = '';
  SUBPANEL.innerHTML = '<div class="empty">No selection</div>';
  updateAskTarget('this symbol');
  resetCodePanel(null);
  clearEdgeInspection();
  cy.nodes().removeClass('focus dim hovered selected-neighbor edge-endpoint');
  cy.edges().removeClass('dim highlight adjacent selected-edge edge-hover-muted edge-inspected edge-muted');
  applyFilters();
  writeHashState();
  syncMobilePanelButtons();
}

function restoreSymbolDetailAfterEdgeSelection() {
  selectedEdgeCache = null;
  detailMode = 'symbol';
  if (currentSymbolId) {
    if (LIVE_MODE) {
      void selectSymbolLive(currentSymbolId);
    } else if (typeof selectSymbol === 'function') {
      selectSymbol(currentSymbolId);
    }
    return;
  }
  clearCurrentSelection();
}

function renderSubpanel(symbolId, sub) {
  const n = NODES.find(x => x.id === symbolId);
  if (!n) { SUBPANEL.innerHTML = '<div class="empty">No selection</div>'; return; }
  const resolveRef = (entry) => {
    if (typeof entry === 'object' && entry && entry.file) return entry;
    const id = typeof entry === 'string' ? entry : entry?.id;
    return NODES.find(x => x.id === id) || { id, label: id, file: '?', line: '?' };
  };
  if (sub === 'callers') {
    const callers = n.callers || EDGES.filter(([,t]) => t === symbolId).map(([s]) => s);
    SUBPANEL.innerHTML = callers.map(c => {
      const r = resolveRef(c);
      return `<div class="ref-row" data-symbol="${escapeHtml(r.id)}" role="button" tabindex="0" title="${escapeHtml(r.label || r.id)} — click to focus"><div class="name">${r.label || r.id}</div><div class="loc">${r.file}:${r.line ?? '?'}</div></div>`;
    }).join('') || '<div class="empty">No callers</div>';
  } else if (sub === 'callees') {
    const callees = n.callees || EDGES.filter(([s]) => s === symbolId).map(([,t]) => t);
    SUBPANEL.innerHTML = callees.map(c => {
      const r = resolveRef(c);
      return `<div class="ref-row" data-symbol="${escapeHtml(r.id)}" role="button" tabindex="0" title="${escapeHtml(r.label || r.id)} — click to focus"><div class="name">${r.label || r.id}</div><div class="loc">${r.file}:${r.line ?? '?'}</div></div>`;
    }).join('') || '<div class="empty">No callees</div>';
  } else if (sub === 'findings') {
    SUBPANEL.innerHTML = n.health === 'healthy'
      ? '<div class="empty">No findings — code health 10/10</div>'
      : `<div class="ref-row" data-biomarker="large_method" role="button" tabindex="0" title="Filter graph by large_method"><div class="name">large_method</div><div class="loc">severity: warning · LOC ${(n.metrics?.loc ?? 120)} ≥ 100 · click to filter</div></div>`;
  } else if (sub === 'coverage') {
    SUBPANEL.innerHTML = `<div class="ref-row"><div class="name">Statement coverage</div><div class="loc">${Math.round((n.coverage ?? 0)*100)}% &middot; lcov</div></div>`;
  }
}

function selectSymbol(symbolId) {
  const n = NODES.find(x => x.id === symbolId);
  if (!n) return;
  currentSymbolId = n.id;
  syncViewerSelectionState(currentSymbolId, liveSymbolCache);
  detailMode = 'symbol';
  selectedEdgeCache = null;
  setDetailActionsEnabled(true);
  setSymbolDetailTabs();
  renderGraphTrail();
  navPush(n.id, n.label);
  writeHashState();
  renderBreadcrumb(n.file, n.label);
  renderDocstringPreview(null, n.id);  // hardcoded NODES don't carry docstrings
  resetCodePanel(n.id);          // file:// mode: source isn't fetched
  document.getElementById('d-name').textContent = n.label;
  document.getElementById('d-loc').textContent = `${n.kind} · ${n.file}:${n.line ?? '?'}`;
  document.getElementById('d-cent').textContent = n.centrality?.toFixed?.(4) ?? '—';
  const health10 = ({ healthy: '10/10', info: '8/10', warning: '6/10', error: '3/10' })[n.health] || '—';
  document.getElementById('d-health').textContent = health10;
  document.getElementById('d-cov').textContent = `${Math.round((n.coverage ?? 0)*100)}%`;
  const callerCt = (n.callers || EDGES.filter(([,t]) => t === symbolId).map(([s]) => s)).length;
  const calleeCt = (n.callees || EDGES.filter(([s]) => s === symbolId).map(([,t]) => t)).length;
  document.getElementById('d-callers-ct').textContent = `(${callerCt})`;
  document.getElementById('d-callees-ct').textContent = `(${calleeCt})`;
  document.getElementById('d-findings-ct').textContent = `(${n.health === 'healthy' ? 0 : 1})`;
  if (n.metrics) {
    document.getElementById('m-loc').textContent     = n.metrics.loc;
    document.getElementById('m-cyc').textContent     = n.metrics.cyc;
    document.getElementById('m-nest').textContent    = n.metrics.nest;
    document.getElementById('m-first').textContent   = n.metrics.first;
    document.getElementById('m-last').textContent    = n.metrics.last;
    document.getElementById('m-commits').textContent = n.metrics.commits;
  }
  const activeSub = document.querySelector('.subtab.active')?.dataset.sub || 'callers';
  renderSubpanel(symbolId, activeSub);

  cy.nodes().removeClass('focus');
  cy.getElementById(symbolId).addClass('focus');
  applyFilters();
  resizeGraphSoon();
  revealSelectionPanelOnMobile();
}

document.querySelectorAll('.subtab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.subtab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    if (detailMode === 'edge') {
      renderEdgeSubpanel(t.dataset.sub);
      return;
    }
    if (LIVE_MODE) {
      renderSubpanelLive(t.dataset.sub);
    } else {
      const id = document.getElementById('d-name').textContent;
      const realId = NODES.find(n => n.label === id)?.id || id;
      renderSubpanel(realId, t.dataset.sub);
    }
  });
});

cy.on('tap', 'node', (evt) => {
  clearEdgeInspection();
  if (evt.target.data('detailBucket')) {
    const childIds = String(evt.target.data('bucketNodeIds') || '').split('\n').filter(Boolean);
    setDetailGroupingMode('expanded');
    applyFilters();
    writeHashState();
    const children = cy.collection(childIds.map((id) => cy.getElementById(id)).filter((node) => node.length > 0));
    if (children.length > 0) {
      cy.fit(children, 90);
      updateLabelVisibility();
    } else {
      relayoutAndFit();
    }
    return;
  }
  if (evt.target.data('collapsedProxy')) {
    toggleGroupCollapse(evt.target.data('sourceGroup'), false);
    return;
  }
  if (evt.target.data('isGroup')) {
    toggleGroupCollapse(evt.target);
    return;
  }
  if (LIVE_MODE) {
    focusGraphOnSymbol(evt.target.id(), evt.target.data('label') || evt.target.id());
  } else {
    selectSymbol(evt.target.id());
    // also activate the matching trace step if any
    const traceForNode = TRACE.findIndex(t => t.focus === evt.target.id());
    if (traceForNode >= 0) activateTraceStep(traceForNode, /* from cy */ true);
  }
});

registerViewerAction('clearCurrentSelection', clearCurrentSelection);
registerViewerAction('navBack', () => navTo(-1));
registerViewerAction('navForward', () => navTo(1));
registerViewerAction('selectSymbol', selectSymbol);
registerViewerAction('selectSymbolLive', selectSymbolLive);
