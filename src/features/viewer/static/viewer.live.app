/* ───────── Live mode (served via http: from `cartograph viewer`) ─────────
   When opened via file://, the viewer falls back to the hardcoded
   NODES/EDGES/TRACE above. When served by the cartograph viewer CLI it
   fetches /api/status, /api/graph, /api/symbol/:id, /api/findings,
   /api/sessions/:id from the server instead — every visible panel
   (graph, detail, Health tab, Agent-trace tab) is populated from
   real DB state. */

const LIVE_MODE = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
let liveSymbolCache = null;       // last /api/symbol/:id response (used by renderSubpanel)
const liveNodeIndex = new Map();  // id → {label, kind, file, line, centrality}
const MIN_GROUP_CHILDREN = 2;
let lastGraphPayload = null;

/** Map an API node payload to a Cytoscape element. Graph payloads now
    carry compact finding summaries, so the left-rail health filter
    can reflect the current graph instead of static project-wide
    placeholders. */
function groupForFile(file) {
  if (!file) return null;
  const parts = String(file).split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0] === 'src' && parts[1]) return `src/${parts[1]}`;
  if (parts[0] === '__tests__') return '__tests__';
  return parts[0];
}

function healthForPayloadNode(n) {
  if (['error', 'warning', 'info', 'healthy'].includes(n.health)) return n.health;
  const findings = Array.isArray(n.findings) ? n.findings : [];
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  if (findings.some((f) => f.severity === 'info')) return 'info';
  return 'healthy';
}

function liveNodeToElem(n, parentId = null) {
  const findings = Array.isArray(n.findings) ? n.findings : [];
  const health = healthForPayloadNode(n);
  liveNodeIndex.set(n.id, n);
  return {
    data: {
      id: n.id,
      label: n.label,
      kind: n.kind,
      health,
      findingCount: findings.length,
      file: n.file,
      centrality: n.centrality || 0,
      parent: parentId || undefined,
    },
  };
}

function graphElementsFromPayload(g) {
  liveNodeIndex.clear();
  const groups = new Map();
  const groupCounts = new Map();
  for (const n of g.nodes ?? []) {
    const group = groupForFile(n.file);
    if (group) groupCounts.set(group, (groupCounts.get(group) || 0) + 1);
  }
  const nodes = (g.nodes ?? []).map((n) => {
    const group = groupForFile(n.file);
    const groupId = group && (groupCounts.get(group) || 0) >= MIN_GROUP_CHILDREN ? `group:${group}` : null;
    if (group && groupId && !groups.has(groupId)) {
      groups.set(groupId, {
        data: {
          id: groupId,
          label: group,
          baseLabel: group,
          childCount: groupCounts.get(group) || 0,
          isGroup: 1,
        },
      });
    }
    return liveNodeToElem(n, groupId);
  });
  const edges = (g.edges ?? []).map((e) => ({
    data: { id: edgeElementId(e.source, e.target, e.kind), source: e.source, target: e.target, kind: e.kind },
  }));
  return [...groups.values(), ...nodes, ...edges];
}

function renderGraphPayload(g, counterHtml) {
  lastGraphPayload = JSON.parse(JSON.stringify(g || {}));
  if (g.focus) currentSymbolId = g.focus;
  syncViewerGraphState({ lastPayload: lastGraphPayload });
  syncViewerSelectionState(currentSymbolId, liveSymbolCache);
  clearEdgeInspection();
  cy.elements().remove();
  cy.add(graphElementsFromPayload(g));
  applyPendingCollapsedGroups();
  syncEdgeKindFilters();
  currentGraphLayoutKey = graphLayoutKeyForPayload(g);
  refreshGraphLayoutKey();
  applyPinnedLayoutPositions();
  relayoutAndFit();
  setBaseCounter(counterHtml);
  applyFilters();
  resizeGraphSoon();
  if ((g.nodes ?? []).length === 0) setGraphState('empty', g.error || 'No graph nodes matched this view.');
  else setGraphState(null);
}

function graphRequestUrl(focus = null, depth = 2) {
  const params = new URLSearchParams();
  params.set('mode', graphDensityMode);
  const limit = DENSITY_LIMITS[graphDensityMode] ?? DENSITY_LIMITS.core;
  if (Number.isFinite(limit)) params.set('limit', String(limit));
  if (focus) {
    params.set('focus', focus);
    params.set('depth', String(depth));
  }
  return `/api/graph?${params.toString()}`;
}

async function bootLive() {
  // Status → top-bar
  try {
    const r = await apiFetch('/api/status');
    if (r.ok) {
      const s = await r.json();
      liveProjectRoot = s.projectRoot || '';
      document.querySelector('.topbar .path').textContent = s.projectRoot;
      document.querySelector('.topbar .stats').innerHTML =
        `<b>${s.files}</b> files · <b>${s.nodes.toLocaleString()}</b> nodes · <b>${s.edges.toLocaleString()}</b> edges`;
      renderFileScopeFilters(s.dirs);
    }
  } catch (err) { console.debug('status endpoint unavailable', err); }

  const hashState = readHashState();
  applyHashStateControls(hashState);

  // Replace the hardcoded graph with /api/graph (no focus → top-central neighborhood)
  try {
    setGraphState('loading', 'Loading graph...');
    const r = await apiFetch(graphRequestUrl());
    if (!r.ok) {
      setGraphState('err', `Failed to load graph: HTTP ${r.status}`);
      return;
    }
    const g = await r.json();
    renderGraphPayload(g, `Showing ${g.nodes.length} nodes · ${(g.edges ?? []).length} edges`);

    // If the URL carries a focus, restore that view; otherwise
    // pick the highest-centrality node from the response.
    if (hashState.focus) {
      await focusGraphOnSymbol(hashState.focus, hashState.focus);
    } else {
      const first = g.nodes[0];
      if (first) await selectSymbolLive(first.id);
    }
    restoreMobilePanelFromHash(hashState.panel);
    writeHashState();
  } catch (err) {
    console.warn('viewer: bootLive failed', err);
    setGraphState('err', `Failed to load graph: ${String(err)}`);
  }

  // Trace bar: load whatever session the DB has so the user doesn't
  // need to switch tabs to see anything. loadSessionsLive handles the
  // empty-DB case with a helpful pointer to `cartograph serve --mcp`.
  loadSessionsLive();
}

/** Fetch /api/sessions and populate the session picker; auto-select
    the latest session and load its calls into the trace bar.
    Empty-state when no MCP server has logged anything yet. */
let liveTraceCalls = [];      // current session's calls (cached)
let liveTraceActiveStep = -1; // 0-indexed pointer into liveTraceCalls
let liveSessions = [];        // cache of /api/sessions for picker rendering
let currentSymbolId = null;   // selected node id in either live or file:// mode
syncViewerSelectionState(currentSymbolId, liveSymbolCache);
syncViewerGraphState({ lastPayload: lastGraphPayload });

async function loadSessionsLive() {
  const tl = document.getElementById('trace-list');
  const sessLabel = document.getElementById('session-label');
  const picker = document.getElementById('session-picker');
  tl.innerHTML = '<div class="empty">Loading sessions...</div>';
  try {
    const sr = await apiFetch('/api/sessions?limit=20');
    if (!sr.ok) throw new Error(`status ${sr.status}`);
    liveSessions = (await sr.json()).sessions ?? [];
    if (liveSessions.length === 0) {
      sessLabel.textContent = '— no recorded sessions yet —';
      sessLabel.style.display = '';
      picker.style.display = 'none';
      tl.innerHTML = `<div class="empty">No agent trace recorded yet. Start an MCP client (e.g. <code>cartograph serve --mcp</code>) and make a few tool calls to populate this view.</div>`;
      liveTraceCalls = []; liveTraceActiveStep = -1;
      return;
    }
    // Render picker options + show it; hide the static label.
    picker.innerHTML = liveSessions.map((s) => {
      const ago = formatRelative(s.lastActivityTs);
      return `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)} · ${s.toolCount} calls · ${escapeHtml(ago)}</option>`;
    }).join('');
    picker.style.display = '';
    sessLabel.style.display = 'none';
    // Auto-load the latest (first) session.
    picker.value = liveSessions[0].id;
    await loadSession(liveSessions[0].id);
  } catch (err) {
    console.warn('viewer: loadSessionsLive failed', err);
    tl.innerHTML = `<div class="empty">Failed to load sessions: ${escapeHtml(String(err))}</div>`;
  }
}

/** Fetch one session's calls and render them in the trace bar.
    The session must already exist in liveSessions so we know the
    persisted tool_count for the divergence check. */
async function loadSession(sessionId) {
  const tl = document.getElementById('trace-list');
  tl.innerHTML = '<div class="empty">Loading session calls...</div>';
  try {
    const dr = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (!dr.ok) throw new Error(`status ${dr.status}`);
    const detail = await dr.json();
    liveTraceCalls = detail.calls ?? [];
    liveTraceActiveStep = -1;
    const meta = liveSessions.find((s) => s.id === sessionId);
    const persistedCt = meta ? meta.toolCount : liveTraceCalls.length;
    const totalMs = liveTraceCalls.reduce((a, c) => a + (c.durationMs || 0), 0);
    // The picker now carries the session id; the static label only
    // appears in the empty-state. Header on the picker side just
    // shows the call count + duration so we don't repeat the id.
    const sessLabel = document.getElementById('session-label');
    const renderedCt = liveTraceCalls.length;
    const headerCt = renderedCt === persistedCt ? `${renderedCt}` : `${renderedCt} of ${persistedCt}`;
    sessLabel.textContent = ` · ${headerCt} CALLS · ${(totalMs/1000).toFixed(2)}S TOTAL`;
    sessLabel.style.display = '';
    sessLabel.style.color = 'var(--text-muted)';
    renderLiveTraceList();
  } catch (err) {
    console.warn('viewer: loadSession failed', err);
    tl.innerHTML = `<div class="empty">Failed to load session: ${escapeHtml(String(err))}</div>`;
  }
}

document.getElementById('session-picker').addEventListener('change', (e) => {
  loadSession(e.target.value);
});

function renderLiveTraceList() {
  const tl = document.getElementById('trace-list');
  if (liveTraceCalls.length === 0) {
    tl.innerHTML = '<div class="empty">No calls in this session.</div>';
    return;
  }
  const t0 = liveTraceCalls[0]?.ts ?? 0;
  tl.innerHTML = liveTraceCalls.map((c, i) => `
    <div class="trace-row${i === liveTraceActiveStep ? ' active' : ''}" data-i="${i}">
      <span class="delta">+${c.ts - t0}ms</span>
      <span class="step-num">${c.step}</span>
      <span class="tool">${escapeHtml(c.tool ?? '')}</span>
      <span class="args">${escapeHtml(formatArgs(c.args))}</span>
      <span class="result">${escapeHtml(c.result ?? '')}</span>
    </div>
  `).join('');
  tl.querySelectorAll('.trace-row').forEach(el =>
    el.addEventListener('click', () => activateLiveTraceStep(Number.parseInt(el.dataset.i, 10)))
  );
}

function formatArgs(args) {
  if (args == null) return '';
  if (typeof args === 'string') return args;
  try {
    const entries = Object.entries(args);
    if (entries.length === 0) return '{}';
    return entries.map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join(', ');
  } catch {
    return String(args);
  }
}

/** Click a live trace row → highlight its target symbol on the graph
    (parsed from args.symbol if present) AND select it in the right
    pane. No subgraph reduction in live mode (that needs the real
    impact-radius result, which we don't store). */
async function activateLiveTraceStep(i) {
  liveTraceActiveStep = i;
  const c = liveTraceCalls[i];
  if (!c) return;
  document.querySelectorAll('.trace-row').forEach(el =>
    el.classList.toggle('active', Number.parseInt(el.dataset.i, 10) === i));
  const symbol = c.args && typeof c.args === 'object' ? c.args.symbol : null;
  if (typeof symbol === 'string') {
    await focusGraphOnSymbol(symbol, symbol);
  }
}

/** Search → focus a symbol in live mode. Fetches /api/symbol/<query>
    to resolve the id; if found, fetches the focused subgraph and
    re-renders. No-ops in file:// mode (no API to hit). */
async function searchAndFocus(query) {
  const input = document.getElementById('search-input');
  input.classList.remove('error');
  if (!LIVE_MODE) { input.classList.add('error'); return; }
  const trimmed = query.trim();
  if (!trimmed) return;
  try {
    const symRes = await apiFetch(`/api/symbol/${encodeURIComponent(trimmed)}`);
    if (!symRes.ok) { input.classList.add('error'); return; }
    const sym = await symRes.json();
    await focusGraphOnSymbol(sym.id, sym.label);
  } catch (err) {
    console.warn('viewer: searchAndFocus failed', err);
    input.classList.add('error');
    setGraphState('err', `Search failed: ${String(err)}`);
  }
}

const graphTrail = [];
let graphFocusRequestSeq = 0;

function pushGraphTrail(id, label) {
  if (!id) return;
  const idx = graphTrail.findIndex((item) => item.id === id);
  if (idx >= 0) graphTrail.splice(idx, 1);
  graphTrail.unshift({ id, label: label || id });
  if (graphTrail.length > 6) graphTrail.length = 6;
  renderGraphTrail();
}

function renderGraphTrail() {
  const el = document.getElementById('graph-trail');
  el.innerHTML = graphTrail
    .map((item) => `<button type="button" class="${item.id === currentSymbolId ? 'active' : ''}" data-symbol="${escapeHtml(item.id)}" data-tooltip="Focus ${escapeHtml(item.label)}">${escapeHtml(item.label)}</button>`)
    .join('');
}

document.getElementById('graph-trail').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-symbol]');
  if (!btn || !LIVE_MODE) return;
  focusGraphOnSymbol(btn.dataset.symbol, btn.textContent || btn.dataset.symbol);
});

async function focusGraphOnSymbol(symbolId, label = symbolId) {
  if (!LIVE_MODE || !symbolId) return;
  const requestSeq = ++graphFocusRequestSeq;
  const isCurrentGraphRequest = () => requestSeq === graphFocusRequestSeq;
  setGraphState('loading', `Loading neighborhood for ${label}...`);
  const graphRes = await apiFetch(graphRequestUrl(symbolId, 2));
  if (!isCurrentGraphRequest()) return;
  if (!graphRes.ok) {
    setGraphState('err', `Failed to load neighborhood: HTTP ${graphRes.status}`);
    return;
  }
  const g = await graphRes.json();
  if (!isCurrentGraphRequest()) return;
  if (g.error) {
    setGraphState('err', g.error);
    return;
  }
  currentSymbolId = g.focus || symbolId;
  syncViewerSelectionState(currentSymbolId, liveSymbolCache);
  renderGraphPayload(
    g,
    `Showing ${g.nodes.length} nodes · ${(g.edges ?? []).length} edges · focus <b style="color:var(--text)">${escapeHtml(label)}</b>`,
  );
  pushGraphTrail(g.focus || symbolId, label);
  await selectSymbolLive(g.focus || symbolId);
}

const searchInputEl = document.getElementById('search-input');
const searchSuggestEl = document.getElementById('search-suggest');
let searchSuggestItems = [];
let searchSuggestIndex = -1;
let searchSuggestTimer = null;
let searchSuggestAbort = null;
let searchSuggestSeq = 0;

function closeSearchSuggest() {
  searchSuggestEl.hidden = true;
  searchSuggestEl.innerHTML = '';
  searchSuggestItems = [];
  searchSuggestIndex = -1;
}

function highlightSearchSuggest() {
  searchSuggestEl.querySelectorAll('.search-suggest-row').forEach((row, i) => {
    const active = i === searchSuggestIndex;
    row.classList.toggle('active', active);
  });
}

function searchSuggestRank(item, query) {
  const q = query.trim().toLowerCase();
  const label = String(item.label || item.id || '').toLowerCase();
  const file = String(item.file || '').toLowerCase();
  const kind = String(item.kind || '').toLowerCase();
  if (label === q) return 0;
  if (label.startsWith(q)) return 1;
  if (label.includes(q)) return 2;
  if (file.includes(q)) return 3;
  if (kind.includes(q)) return 4;
  return 5;
}

function sortSearchSuggestions(items, query) {
  return items.slice().sort((a, b) =>
    searchSuggestRank(a, query) - searchSuggestRank(b, query) ||
    String(a.label || a.id || '').localeCompare(String(b.label || b.id || '')) ||
    String(a.file || '').localeCompare(String(b.file || '')) ||
    Number(a.line || 0) - Number(b.line || 0)
  );
}

function highlightSearchLabel(label, query) {
  const raw = String(label || '');
  const q = query.trim();
  if (!q) return escapeHtml(raw);
  const idx = raw.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return escapeHtml(raw);
  return `${escapeHtml(raw.slice(0, idx))}<mark>${escapeHtml(raw.slice(idx, idx + q.length))}</mark>${escapeHtml(raw.slice(idx + q.length))}`;
}

function renderSearchSuggest(items, message = '', query = searchInputEl.value) {
  const ranked = sortSearchSuggestions(items, query);
  searchSuggestItems = ranked;
  searchSuggestIndex = items.length > 0 ? 0 : -1;
  if (ranked.length === 0) {
    if (!message) return closeSearchSuggest();
    searchSuggestEl.innerHTML = `<div class="search-suggest-empty">${escapeHtml(message)}</div>`;
    searchSuggestEl.hidden = false;
    return;
  }
  const exactCount = ranked.filter((item) => searchSuggestRank(item, query) === 0).length;
  searchSuggestEl.innerHTML = ranked.map((item, i) => {
    const label = item.label || item.id;
    const exact = searchSuggestRank(item, query) === 0;
    const file = item.file || '';
    const line = item.line == null ? '?' : item.line;
    const score = typeof item.score === 'number' ? item.score.toFixed(2) : '';
    return `
    <button type="button" class="search-suggest-row${i === searchSuggestIndex ? ' active' : ''}" data-i="${i}">
      <div class="search-suggest-name">${highlightSearchLabel(label, query)}${exact && exactCount > 1 ? '<span class="search-suggest-exact">exact</span>' : ''}</div>
      <div class="search-suggest-kind">${escapeHtml(item.kind || '')} <span class="search-suggest-line">:${escapeHtml(String(line))}</span></div>
      <div class="search-suggest-file">${escapeHtml(file)}</div>
      ${score ? `<div class="search-suggest-score">score ${escapeHtml(score)}</div>` : ''}
    </button>
  `;
  }).join('');
  searchSuggestEl.hidden = false;
}

async function loadSearchSuggestions(query) {
  if (!LIVE_MODE) return;
  const q = query.trim();
  searchSuggestAbort?.abort();
  searchSuggestAbort = null;
  const requestSeq = ++searchSuggestSeq;
  if (q.length < 2) {
    closeSearchSuggest();
    return;
  }
  searchSuggestAbort = new AbortController();
  try {
    const res = await apiFetch(`/api/search?q=${encodeURIComponent(q)}&limit=8`, { signal: searchSuggestAbort.signal });
    if (requestSeq !== searchSuggestSeq || searchInputEl.value.trim() !== q) return;
    if (!res.ok) {
      renderSearchSuggest([], `Search failed: HTTP ${res.status}`);
      return;
    }
    const data = await res.json();
    if (requestSeq !== searchSuggestSeq || searchInputEl.value.trim() !== q) return;
    renderSearchSuggest(data.results || [], 'No matching symbols', q);
  } catch (err) {
    if (err?.name === 'AbortError') return;
    renderSearchSuggest([], `Search failed: ${String(err)}`);
  }
}

function pickSearchSuggestion(item) {
  if (!item) return;
  searchInputEl.value = item.label || item.id;
  closeSearchSuggest();
  focusGraphOnSymbol(item.id, item.label || item.id);
}

searchInputEl.addEventListener('input', (e) => {
  window.clearTimeout(searchSuggestTimer);
  searchSuggestTimer = window.setTimeout(() => loadSearchSuggestions(e.target.value), 140);
});

searchInputEl.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' && !searchSuggestEl.hidden) {
    e.preventDefault();
    searchSuggestIndex = Math.min(searchSuggestItems.length - 1, searchSuggestIndex + 1);
    highlightSearchSuggest();
    return;
  }
  if (e.key === 'ArrowUp' && !searchSuggestEl.hidden) {
    e.preventDefault();
    searchSuggestIndex = Math.max(0, searchSuggestIndex - 1);
    highlightSearchSuggest();
    return;
  }
  if (e.key === 'Escape' && !searchSuggestEl.hidden) {
    e.preventDefault();
    closeSearchSuggest();
    return;
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    if (!searchSuggestEl.hidden && searchSuggestItems[searchSuggestIndex]) {
      pickSearchSuggestion(searchSuggestItems[searchSuggestIndex]);
    } else {
      closeSearchSuggest();
      searchAndFocus(e.target.value);
    }
  }
});

searchSuggestEl.addEventListener('mousedown', (e) => {
  const row = e.target.closest('.search-suggest-row[data-i]');
  if (!row) return;
  e.preventDefault();
  pickSearchSuggestion(searchSuggestItems[Number.parseInt(row.dataset.i, 10)]);
});

document.addEventListener('mousedown', (e) => {
  if (e.target.closest('.searchgroup')) return;
  closeSearchSuggest();
});

/* Click delegate on the right pane: caller/callee rows carry
   data-symbol, findings rows carry data-biomarker. In live mode
   symbol rows re-anchor the graph; in file:// mode they update the
   static detail pane. Finding rows apply the same biomarker filter as
   the Ask panel's intent shortcuts. */
function handleSubpanelAction(row) {
  if (!row) return;
  const biomarker = row.dataset.biomarker;
  if (biomarker) {
    if (LIVE_MODE) void applyBiomarkerFilter(biomarker, document.getElementById('ask-history'));
    return;
  }
  const symbolId = row.dataset.symbol;
  if (!symbolId) return;
  if (LIVE_MODE) void searchAndFocus(symbolId);
  else if (typeof selectSymbol === 'function') selectSymbol(symbolId);
}

document.getElementById('subpanel').addEventListener('click', (e) => {
  handleSubpanelAction(e.target.closest('.ref-row[data-symbol], .ref-row[data-biomarker]'));
});
document.getElementById('subpanel').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.closest('.ref-row[data-symbol], .ref-row[data-biomarker]');
  if (!row) return;
  e.preventDefault();
  handleSubpanelAction(row);
});
