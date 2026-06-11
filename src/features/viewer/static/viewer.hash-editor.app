/* URL hash state — reflects the full viewer state so an agent can
   navigate by setting location.hash and a human can share a deep
   link to the same view. The load path is symmetric: parse the hash,
   apply controls, fetch the matching graph, then select focus. */
let applyingHashState = false;

function readHashState() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return {};
  const out = {};
  try {
    const params = new URLSearchParams(h);
    for (const [k, v] of params) out[k] = v;
  } catch {
    for (const part of h.split('&')) {
      const [k, ...rest] = part.split('=');
      try {
        if (k) out[decodeURIComponent(k)] = decodeURIComponent(rest.join('='));
      } catch {}
    }
  }
  return out;
}

function hashList(raw) {
  if (raw == null) return null;
  if (raw === '') return [];
  return raw.split(',').map((v) => v.trim()).filter(Boolean);
}

function activeTabView() {
  return document.querySelector('.tab.active')?.dataset.view || 'graph';
}

function checkedHashValues(selector, datasetKey) {
  return Array.from(document.querySelectorAll(selector))
    .filter((el) => el.checked)
    .map((el) => el.dataset[datasetKey])
    .filter(Boolean);
}

function setCheckedHashValues(selector, datasetKey, raw) {
  const values = hashList(raw);
  if (values === null) return;
  const set = new Set(values);
  document.querySelectorAll(selector).forEach((el) => {
    el.checked = set.has(el.dataset[datasetKey]);
  });
}

/* Hidden chips serialize as their first kind token (stable across
   chip reorders/insertions, unlike the positional indexes used
   before). Reads accept the legacy numeric-index form too so old
   saved views keep working. */
function hiddenKindKeys() {
  return Array.from(document.querySelectorAll('#kind-chips .kind-chip'))
    .map((chip) => chip.dataset.active === '1' ? null : (kindSetForChip(chip)[0] || null))
    .filter((v) => v !== null);
}

function setHiddenKindsFromHash(raw) {
  const values = hashList(raw);
  if (values === null) return;
  const hidden = new Set(values);
  document.querySelectorAll('#kind-chips .kind-chip').forEach((chip, i) => {
    const key = kindSetForChip(chip)[0] || '';
    chip.dataset.active = hidden.has(key) || hidden.has(String(i)) ? '0' : '1';
  });
}

function applyHashStateControls(s) {
  applyingHashState = true;
  try {
    if (s.density && Object.hasOwn(DENSITY_LIMITS, s.density)) {
      graphDensityMode = s.density;
      try { localStorage.setItem(DENSITY_KEY, graphDensityMode); } catch {}
      syncViewerGraphState({ densityMode: graphDensityMode });
      syncDensityControl();
    }
    if (s.detail && ['grouped', 'expanded'].includes(s.detail)) {
      setDetailGroupingMode(s.detail);
    }
    if (s.layout && Object.hasOwn(LAYOUT_QUALITY_MODES, s.layout)) {
      setGraphLayoutQuality(s.layout, { relayout: false });
    }
    if (s.edgeLens && Object.hasOwn(EDGE_LENS_MODES, s.edgeLens)) {
      setGraphEdgeLensMode(s.edgeLens, { apply: false });
    }
    setHiddenKindsFromHash(s.hideKinds);
    setEdgeKindsFromHash(s.edges);
    setCollapsedGroupsFromHash(s.collapsedGroups || s.collapsed);
    setCheckedHashValues('[data-filter-health]', 'filterHealth', s.health);
    setFileScopesFromHash(s.files);
    breadcrumbScope = s.scope || s.crumb || null;
    syncViewerGraphState({ breadcrumbScope });
    const input = document.getElementById('search-input');
    if (input) {
      if (breadcrumbScope) input.value = `path:${breadcrumbScope}`;
      else if (input.value?.startsWith('path:')) input.value = '';
    }
    markBreadcrumbScope();
    applyFilters();
    if (s.tab && ['graph', 'trace', 'health'].includes(s.tab)) clickTab(s.tab);
  } finally {
    applyingHashState = false;
  }
}

function restoreMobilePanelFromHash(panel) {
  if (!panel || !['detail', 'source', 'filters'].includes(panel) || !isMobileViewport()) return;
  if (mobilePanelState() === panel) {
    syncMobilePanelButtons();
    return;
  }
  applyingHashState = true;
  try {
    openMobilePanel(panel);
  } finally {
    applyingHashState = false;
  }
}

function writeHashState() {
  if (applyingHashState) return;
  const parts = [];
  parts.push(`tab=${encodeURIComponent(activeTabView())}`);
  parts.push(`density=${encodeURIComponent(viewerGraphMode('densityMode', graphDensityMode))}`);
  parts.push(`detail=${encodeURIComponent(viewerGraphMode('detailGroupingMode', detailGroupingMode))}`);
  parts.push(`layout=${encodeURIComponent(viewerGraphMode('layoutQuality', graphLayoutQuality))}`);
  parts.push(`edgeLens=${encodeURIComponent(viewerGraphMode('edgeLensMode', graphEdgeLensMode))}`);
  const panel = mobilePanelState();
  if (panel) parts.push(`panel=${encodeURIComponent(panel)}`);
  const focus = viewerLiveSymbolCache()?.id || viewerCurrentSymbolId();
  if (focus) parts.push(`focus=${encodeURIComponent(focus)}`);
  const scope = viewerGraphMode('breadcrumbScope', breadcrumbScope);
  if (scope) parts.push(`scope=${encodeURIComponent(scope)}`);
  const collapsed = collapsedGroupList();
  if (collapsed.length > 0) parts.push(`collapsedGroups=${encodeURIComponent(collapsed.join(','))}`);
  const hiddenKinds = hiddenKindKeys();
  if (hiddenKinds.length > 0) parts.push(`hideKinds=${encodeURIComponent(hiddenKinds.join(','))}`);
  parts.push(`health=${encodeURIComponent(checkedHashValues('[data-filter-health]', 'filterHealth').join(','))}`);
  parts.push(`files=${encodeURIComponent(checkedHashValues('[data-filter-scope]', 'filterScope').join(','))}`);
  parts.push(`edges=${encodeURIComponent(checkedHashValues('[data-filter-edge]', 'filterEdge').join(','))}`);
  const next = '#' + parts.join('&');
  if (location.hash !== next) {
    // Use replaceState so URL-driven hops don't pollute browser history
    // beyond what navPush already manages.
    history.replaceState(null, '', next);
  }
}

async function applyHashState() {
  if (!LIVE_MODE) return;
  const s = readHashState();
  applyHashStateControls(s);
  if (s.focus) await searchAndFocus(s.focus);
  restoreMobilePanelFromHash(s.panel);
}

/* "Copy link" — copies the current view's URL (with the hash state
   we just set) to the clipboard. The button briefly turns green
   so the user knows it landed. */
async function copyToClipboard(text, btn) {
  try { await navigator.clipboard.writeText(text); }
  catch (err) {
    console.debug('navigator clipboard unavailable', err);
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    } catch (fallbackErr) {
      console.debug('clipboard fallback failed', fallbackErr);
    }
  }
  if (btn) {
    const label = actionButtonLabel(btn);
    const orig = label?.textContent || btn.textContent;
    if (label) label.textContent = 'Copied';
    else btn.textContent = 'Copied';
    btn.classList.add('copied');
    setTimeout(() => {
      if (label) label.textContent = orig;
      else btn.textContent = orig;
      btn.classList.remove('copied');
    }, 1200);
  }
}

function actionButtonLabel(btn) {
  if (!btn) return null;
  return btn.querySelector('span:not(.icon-fallback)') || null;
}

function flashActionButton(btn, text = 'Done') {
  if (!btn) return;
  const label = actionButtonLabel(btn);
  const orig = label?.textContent || btn.textContent;
  if (label) label.textContent = text;
  else btn.textContent = text;
  btn.classList.add('copied');
  setTimeout(() => {
    if (label) label.textContent = orig;
    else btn.textContent = orig;
    btn.classList.remove('copied');
  }, 1200);
}

const EDITOR_KEY = 'cartograph-viewer-editor-v1';
const EDITOR_SCHEMES = { vscode: 'vscode', cursor: 'cursor', windsurf: 'windsurf' };

function selectedSymbolLocation() {
  const p = liveSymbolCache;
  if (p?.file) return { file: p.file, line: p.line || 1, label: p.label || p.id || 'symbol' };
  const fallback = NODES.find((n) => n.id === currentSymbolId)
    || NODES.find((n) => n.label === document.getElementById('d-name')?.textContent);
  if (!fallback?.file) return null;
  return { file: fallback.file, line: fallback.line || 1, label: fallback.label || fallback.id || 'symbol' };
}

function projectRootForEditor() {
  return liveProjectRoot || document.querySelector('.topbar .path')?.textContent?.trim() || '';
}

function absoluteSymbolPath(file) {
  const f = String(file || '');
  if (!f) return '';
  if (f.startsWith('/') || /^[A-Za-z]:[\\/]/.test(f)) return f;
  const root = projectRootForEditor().replace(/[/\\]+$/, '');
  if (!root || root.includes('/Users/foo/')) return f;
  return `${root}/${f.replace(/^[/\\]+/, '')}`;
}

function encodeEditorPath(absPath) {
  return String(absPath)
    .replaceAll('\\', '/')
    .split('/')
    .map((part, i) => (i === 0 && part === '' ? '' : encodeURIComponent(part)))
    .join('/');
}

function selectedEditorScheme() {
  const picker = document.getElementById('editor-picker');
  return EDITOR_SCHEMES[picker?.value] || EDITOR_SCHEMES.vscode;
}

function openSelectedInEditor(btn = null) {
  const loc = selectedSymbolLocation();
  if (!loc) return;
  const abs = absoluteSymbolPath(loc.file);
  if (!abs || !abs.startsWith('/')) {
    copyToClipboard(`${loc.file}:${loc.line}`, btn);
    return;
  }
  const url = `${selectedEditorScheme()}://file${encodeEditorPath(abs)}:${loc.line}:1`;
  globalThis.location.href = url;
  flashActionButton(btn, 'Opening');
}

function initEditorPicker() {
  const picker = document.getElementById('editor-picker');
  if (!picker) return;
  try {
    const saved = localStorage.getItem(EDITOR_KEY);
    if (saved && EDITOR_SCHEMES[saved]) picker.value = saved;
  } catch {}
  picker.addEventListener('change', () => {
    try { localStorage.setItem(EDITOR_KEY, picker.value); } catch {}
  });
}

document.getElementById('btn-open-editor').addEventListener('click', (e) => {
  openSelectedInEditor(e.currentTarget);
});
initEditorPicker();

document.getElementById('btn-copy-link').addEventListener('click', (e) => {
  writeHashState();
  copyToClipboard(location.href, e.currentTarget);
});

/* "Copy MCP" — emits a JSON tool-call snippet for the current
   symbol that an agent can paste straight into a cartograph MCP
   client. Defaults to cartograph_node (good detail-fetch); the
   user can edit the tool name in the result. */
document.getElementById('btn-copy-mcp').addEventListener('click', (e) => {
  const sym = liveSymbolCache?.label || (LIVE_MODE ? null : 'extractFromSource');
  if (!sym) return;
  const snippet = JSON.stringify({
    tool: 'cartograph_node',
    args: { symbol: sym, code: true },
    note: 'Replace `tool` with cartograph_callers / cartograph_callees / cartograph_impact / cartograph_biomarkers as needed.',
  }, null, 2);
  copyToClipboard(snippet, e.currentTarget);
});
