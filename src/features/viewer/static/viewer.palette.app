/* Command palette — Cmd/Ctrl+K opens. Typing fuzzy-filters
   across two source lists:
   - Recents: every symbol the user has selected this session.
   - Actions: named UI commands (switch tab, fit graph, etc.).
   ↑/↓ navigate, Enter selects, Esc closes. Borrowed shape from
   Linear / VS Code / Slack — the universal "jump anywhere"
   keyboard pattern. */
const ACTIONS = [
  { id: 'tab-graph',  label: 'Switch to Graph tab',  shortcut: 'g g', run: () => clickTab('graph') },
  { id: 'tab-trace',  label: 'Switch to Agent trace tab', shortcut: 'g t', run: () => clickTab('trace') },
  { id: 'tab-live',   label: 'Switch to Live activity tab', shortcut: 'g l', run: () => clickTab('live') },
  { id: 'tab-health', label: 'Switch to Health tab', shortcut: 'g h', run: () => clickTab('health') },
  { id: 'fit',        label: 'Fit graph to viewport', shortcut: '0',   run: fitGraph },
  { id: 'zoom-in',    label: 'Zoom in',  shortcut: '+', run: () => zoomBy(1.25) },
  { id: 'zoom-out',   label: 'Zoom out', shortcut: '-', run: () => zoomBy(0.8) },
  { id: 'show-code',  label: 'Show source code panel', run: () => document.getElementById('btn-show-code')?.click() },
  { id: 'hide-code',  label: 'Hide source code panel', run: () => document.getElementById('btn-code-close')?.click() },
  { id: 'focus-search', label: 'Focus the symbol search', shortcut: '/', run: () => document.getElementById('search-input')?.focus() },
  { id: 'focus-ask',    label: 'Focus the Ask AI input', run: () => document.getElementById('ask-input')?.focus() },
  { id: 'open-editor', label: 'Open selected symbol in editor', run: () => openSelectedInEditor(document.getElementById('btn-open-editor')) },
  { id: 'export-graph-png', label: 'Export graph as PNG', run: () => exportGraphPng(document.getElementById('btn-graph-png')) },
  { id: 'export-graph-svg', label: 'Export graph as SVG', run: () => exportGraphSvg(document.getElementById('btn-graph-svg')) },
  { id: 'export-graph-json', label: 'Export graph as JSON', run: () => exportGraphJson(document.getElementById('btn-graph-json')) },
  { id: 'copy-link',  label: 'Copy link to current view', run: () => document.getElementById('btn-copy-link')?.click() },
  { id: 'copy-mcp',   label: 'Copy MCP query for current symbol', run: () => document.getElementById('btn-copy-mcp')?.click() },
  { id: 'nav-back',   label: 'Navigate back', shortcut: 'Alt+←', run: () => navTo(-1) },
  { id: 'nav-fwd',    label: 'Navigate forward', shortcut: 'Alt+→', run: () => navTo(+1) },
  { id: 'clear-scope', label: 'Clear breadcrumb scope', run: () => { breadcrumbScope = null; syncViewerGraphState({ breadcrumbScope }); markBreadcrumbScope(); applyFilters(); writeHashState(); } },
];

const recentSymbols = []; // [{ id, label, file, kind }] newest first
function pushRecent(symbol) {
  if (!symbol?.id) return;
  const idx = recentSymbols.findIndex((r) => r.id === symbol.id);
  if (idx >= 0) recentSymbols.splice(idx, 1);
  recentSymbols.unshift({ id: symbol.id, label: symbol.label, file: symbol.file, kind: symbol.kind });
  if (recentSymbols.length > 50) recentSymbols.length = 50;
}

function clickTab(view) {
  document.querySelector(`.tab[data-view="${view}"]`)?.click();
}

function openPalette() {
  document.getElementById('palette-backdrop').hidden = false;
  document.querySelector('.palette').open = true;
  document.getElementById('palette-input').value = '';
  paletteActiveIndex = 0;
  renderPalette('');
  setTimeout(() => document.getElementById('palette-input').focus(), 0);
}
function closePalette() {
  document.querySelector('.palette').open = false;
  document.getElementById('palette-backdrop').hidden = true;
}

let paletteActiveIndex = 0;
let paletteVisible = [];

function renderPalette(query) {
  const list = document.getElementById('palette-list');
  const q = query.trim().toLowerCase();
  const fuzzy = (text) => !q || text.toLowerCase().includes(q);
  const fuzzyMatch = (text) => fuzzy(text);

  const matchedActions = ACTIONS.filter((a) => fuzzyMatch(a.label));
  const matchedRecents = recentSymbols.filter((r) => fuzzyMatch(r.label) || fuzzyMatch(r.file || ''));

  paletteVisible = [];
  let html = '';
  if (matchedActions.length > 0) {
    html += `<div class="palette-section">Actions</div>`;
    matchedActions.forEach((a) => {
      const idx = paletteVisible.length;
      paletteVisible.push({ kind: 'action', payload: a });
      const shortcutHtml = a.shortcut ? `<span class="it-shortcut">${escapeHtml(a.shortcut)}</span>` : '';
      html += `<div class="palette-item" data-i="${idx}"><span class="it-icon">⚙</span> ${escapeHtml(a.label)} ${shortcutHtml}</div>`;
    });
  }
  if (matchedRecents.length > 0) {
    html += `<div class="palette-section">Recent symbols</div>`;
    matchedRecents.forEach((r) => {
      const idx = paletteVisible.length;
      paletteVisible.push({ kind: 'symbol', payload: r });
      html += `<div class="palette-item" data-i="${idx}"><span class="it-icon">↗</span> ${escapeHtml(r.label)} <span class="it-meta">${escapeHtml(r.file || '')}</span></div>`;
    });
  }
  // If the user typed something and there are no recents, show a "search live" hint.
  if (matchedActions.length === 0 && matchedRecents.length === 0 && q && LIVE_MODE) {
    paletteVisible.push({ kind: 'live-search', payload: q });
    html = `<div class="palette-item active" data-i="0"><span class="it-icon">🔎</span> Search live: <b>${escapeHtml(q)}</b></div>`;
    paletteActiveIndex = 0;
  }
  list.innerHTML = html;
  highlightPaletteRow();
}
function highlightPaletteRow() {
  document.querySelectorAll('.palette-item').forEach((el, i) => {
    el.classList.toggle('active', i === paletteActiveIndex);
  });
  // Scroll the active row into view.
  const active = document.querySelector('.palette-item.active');
  active?.scrollIntoView({ block: 'nearest' });
}

function selectPalette(item) {
  if (!item) return;
  closePalette();
  if (item.kind === 'action') item.payload.run();
  else if (item.kind === 'symbol') {
    if (LIVE_MODE) searchAndFocus(item.payload.id);
    else if (typeof selectSymbol === 'function') selectSymbol(item.payload.id);
  } else if (item.kind === 'live-search' && LIVE_MODE) {
    searchAndFocus(item.payload);
  }
}

document.getElementById('palette-input').addEventListener('input', (e) => {
  paletteActiveIndex = 0;
  renderPalette(e.target.value);
});
document.getElementById('palette-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
  else if (e.key === 'ArrowDown') {
    e.preventDefault();
    paletteActiveIndex = Math.min(paletteVisible.length - 1, paletteActiveIndex + 1);
    highlightPaletteRow();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    paletteActiveIndex = Math.max(0, paletteActiveIndex - 1);
    highlightPaletteRow();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    selectPalette(paletteVisible[paletteActiveIndex]);
  }
});
document.getElementById('palette-list').addEventListener('click', (e) => {
  const row = e.target.closest('.palette-item[data-i]');
  if (!row) return;
  selectPalette(paletteVisible[Number.parseInt(row.dataset.i, 10)]);
});
document.getElementById('palette-backdrop').addEventListener('click', (e) => {
  if (e.target.id === 'palette-backdrop') closePalette();
});

// Open Cmd/Ctrl+K from anywhere — including from inputs, since
// that's the universal gesture users expect to work everywhere.
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if (document.getElementById('palette-backdrop').hidden) openPalette();
    else closePalette();
  }
});
