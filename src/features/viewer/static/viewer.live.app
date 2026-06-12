/* ───────── Live mode (served via http: from `cartograph viewer`) ─────────
   When opened via file://, the viewer falls back to the hardcoded
   NODES/EDGES/TRACE above. When served by the cartograph viewer CLI it
   fetches /api/status, /api/graph, /api/symbol/:id, /api/findings,
   /api/sessions/:id from the server instead — every visible panel
   (graph, detail, Health tab, Agent-trace tab) is populated from
   real DB state. */

const LIVE_MODE = globalThis.location.protocol === 'http:' || globalThis.location.protocol === 'https:';
let liveSessionScope = null;      // /api/status sessionScope — non-null when this viewer serves ONE session
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
  return dedupeElementsById([...groups.values(), ...nodes, ...edges]);
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
      liveSessionScope = s.sessionScope || null;
      applySessionScopeChrome();
      // Browser tab = project name (plus the session when scoped), so
      // several viewers stay distinguishable; the URL stays localhost.
      const projectName = liveProjectRoot.split('/').filter(Boolean).pop() || 'cartograph';
      document.title = liveSessionScope
        ? `${projectName} · ${liveSessionScope.selector} — cartograph`
        : `${projectName} — cartograph`;
      document.querySelector('.topbar .path').textContent = s.projectRoot;
      const statsEl = document.querySelector('.topbar .stats');
      statsEl.innerHTML =
        `<b>${s.files}</b> files · <b>${s.nodes.toLocaleString()}</b> nodes · <b>${s.edges.toLocaleString()}</b> edges`;
      const indexedBits = [
        s.indexedAt ? `Indexed ${formatRelative(s.indexedAt)}` : null,
        s.head ? `HEAD ${String(s.head).slice(0, 7)}` : null,
      ].filter(Boolean);
      if (indexedBits.length > 0) statsEl.setAttribute('data-tooltip', indexedBits.join(' · '));
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

  // Agent trace: prefetch whatever session the DB has so the tab is
  // populated on first open. loadSessionsLive handles the empty-DB
  // case with a helpful pointer to `cartograph serve --mcp`.
  loadSessionsLive();
}

/** Fetch /api/sessions and populate the session picker; auto-select
    the latest session and load its calls into the trace timeline.
    Empty-state when no MCP server has logged anything yet. */
let liveTraceCalls = [];      // current session's calls (cached)
let liveTraceActiveStep = -1; // 0-indexed pointer into liveTraceCalls
let liveSessions = [];        // cache of /api/sessions for picker rendering
let currentSymbolId = null;   // selected node id in either live or file:// mode
syncViewerSelectionState(currentSymbolId, liveSymbolCache);
syncViewerGraphState({ lastPayload: lastGraphPayload });

/* Sequence guard shared by the session list and session detail
   fetches — rapid picker changes / repeated tab activations
   otherwise leave whichever response resolved LAST on screen,
   regardless of which session the picker shows. */
let sessionRequestSeq = 0;

async function loadSessionsLive() {
  const tl = document.getElementById('trace-list');
  const sessLabel = document.getElementById('session-label');
  const picker = document.getElementById('session-picker');
  const requestSeq = ++sessionRequestSeq;
  tl.innerHTML = '<div class="empty">Loading sessions...</div>';
  try {
    const sr = await apiFetch('/api/sessions?limit=20');
    if (requestSeq !== sessionRequestSeq) return;
    if (!sr.ok) throw new Error(`status ${sr.status}`);
    liveSessions = (await sr.json()).sessions ?? [];
    if (requestSeq !== sessionRequestSeq) return;
    if (liveSessions.length === 0) {
      sessLabel.textContent = liveSessionScope
        ? `— waiting for session “${liveSessionScope.selector}” —`
        : '— no recorded sessions yet —';
      sessLabel.style.display = '';
      picker.style.display = 'none';
      tl.innerHTML = liveSessionScope
        ? `<div class="empty">This viewer is scoped to session <code>${escapeHtml(liveSessionScope.selector)}</code>, which has not made a tool call yet. It appears here the moment it does.</div>`
        : `<div class="empty">No agent trace recorded yet. Start an MCP client (e.g. <code>cartograph serve --mcp</code>) and make a few tool calls to populate this view.</div>`;
      liveTraceCalls = []; liveTraceActiveStep = -1;
      setText('tr-stat-calls', '—');
      setText('tr-stat-time', '—');
      setText('tr-stat-span', '—');
      setText('tr-stat-errors', '—');
      renderTraceStepDetail(null);
      return;
    }
    // Render picker options + show it; hide the static label. Lead
    // with what a human can recognise — label, then the MCP client
    // that ran the session, then when — and keep the opaque id as the
    // option tooltip (it also shows in the step-detail kv).
    picker.innerHTML = liveSessions.map((s) => {
      const ago = formatRelative(s.lastActivityTs);
      const who = s.label || s.clientName || s.id;
      const started = formatSessionClock(s.startedTs);
      return `<option value="${escapeHtml(s.id)}" title="${escapeHtml(s.id)}">${escapeHtml(who)} · ${escapeHtml(started)} · ${escapeHtml(String(s.toolCount))} calls · ${escapeHtml(ago)}</option>`;
    }).join('');
    picker.style.display = '';
    sessLabel.style.display = 'none';
    // Keep the user's chosen session when it still exists in the
    // refreshed list (tab re-activation used to force-reset to the
    // latest); otherwise fall back to the latest.
    const previous = picker.dataset.selectedSession;
    const selected = previous && liveSessions.some((s) => s.id === previous) ? previous : liveSessions[0].id;
    picker.value = selected;
    await loadSession(selected);
  } catch (err) {
    console.warn('viewer: loadSessionsLive failed', err);
    tl.innerHTML = `<div class="empty">Failed to load sessions: ${escapeHtml(String(err))}</div>`;
  }
}

/** Fetch one session's calls and render them in the trace timeline.
    The session must already exist in liveSessions so we know the
    persisted tool_count for the divergence check. */
async function loadSession(sessionId) {
  const tl = document.getElementById('trace-list');
  const picker = document.getElementById('session-picker');
  if (picker) picker.dataset.selectedSession = sessionId;
  const requestSeq = ++sessionRequestSeq;
  tl.innerHTML = '<div class="empty">Loading session calls...</div>';
  try {
    const dr = await apiFetch(`/api/sessions/${encodeURIComponent(sessionId)}`);
    if (requestSeq !== sessionRequestSeq) return;
    if (!dr.ok) throw new Error(`status ${dr.status}`);
    const detail = await dr.json();
    if (requestSeq !== sessionRequestSeq) return;
    liveTraceCalls = detail.calls ?? [];
    liveTraceActiveStep = -1;
    const meta = liveSessions.find((s) => s.id === sessionId);
    const persistedCt = meta ? meta.toolCount : liveTraceCalls.length;
    const totalMs = liveTraceCalls.reduce((a, c) => a + (c.durationMs || 0), 0);
    // The masthead stats carry the session numbers now; the static
    // label only appears in the empty-state.
    const renderedCt = liveTraceCalls.length;
    const headerCt = renderedCt === persistedCt ? `${renderedCt}` : `${renderedCt} of ${persistedCt}`;
    const spanMs = renderedCt > 1 ? liveTraceCalls[renderedCt - 1].ts - liveTraceCalls[0].ts : 0;
    const errCt = liveTraceCalls.filter((c) => String(c.result ?? '').startsWith('⚠')).length;
    setText('tr-stat-calls', headerCt);
    setText('tr-stat-time', traceFormatMs(totalMs));
    setText('tr-stat-span', renderedCt > 1 ? traceFormatGap(spanMs).slice(1) : '—');
    setText('tr-stat-errors', String(errCt));
    // The static label now carries the session's identity line:
    // which client ran it and against which project root.
    const sessLabel = document.getElementById('session-label');
    const sessMeta = liveSessions.find((s) => s.id === sessionId);
    const identityBits = [
      sessMeta?.clientName
        ? `${sessMeta.clientName}${sessMeta.clientVersion ? ` ${sessMeta.clientVersion}` : ''}`
        : 'unknown client',
      sessMeta?.projectRoot ? sessMeta.projectRoot.split('/').filter(Boolean).pop() : null,
    ].filter(Boolean);
    sessLabel.textContent = identityBits.join(' · ');
    sessLabel.style.display = '';
    renderLiveTraceList();
    renderTraceStepDetail(null);
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
    renderTraceStepDetail(null);
    return;
  }
  tl.innerHTML = liveTraceCalls.map((c, i) => {
    const prev = liveTraceCalls[i - 1];
    const gapMs = prev ? c.ts - prev.ts : 0;
    return traceRowHtml(i, {
      step: c.step,
      clock: new Date(c.ts).toTimeString().slice(0, 8),
      gap: prev ? traceFormatGap(gapMs) : '',
      longGap: gapMs >= TRACE_LONG_GAP_MS,
      hue: traceToolHue(c.tool),
      tool: traceShortTool(c.tool),
      args: formatArgs(c.args),
      dur: traceFormatMs(c.durationMs),
      durClass: traceDurClass(c.durationMs),
      result: c.result ?? '',
      isErr: String(c.result ?? '').startsWith('⚠'),
      active: i === liveTraceActiveStep,
      searchExtra: c.tool,
      xproj: typeof c.project === 'string' && !viewerSameProjectRoot(c.project, liveProjectRoot) ? c.project : '',
    });
  }).join('');
  tl.querySelectorAll('.trace-row').forEach(el =>
    el.addEventListener('click', () => activateLiveTraceStep(Number.parseInt(el.dataset.i, 10)))
  );
  traceApplyFilter();
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

/** Click a live trace row → highlight it and fill the step-detail
    sidebar. Graph focus is via the explicit "On the graph" link chips
    in the detail card — auto-fetching a neighborhood on every step
    was wasteful with the graph on another tab, and replay would have
    raced one fetch per 850ms tick. */
async function activateLiveTraceStep(i) {
  liveTraceActiveStep = i;
  const c = liveTraceCalls[i];
  if (!c) return;
  document.querySelectorAll('.trace-row').forEach(el =>
    el.classList.toggle('active', Number.parseInt(el.dataset.i, 10) === i));
  document.querySelector(`.trace-row[data-i="${i}"]`)?.scrollIntoView({ block: 'nearest' });
  renderTraceStepDetail({
    tool: c.tool,
    clock: new Date(c.ts).toTimeString().slice(0, 8),
    step: c.step,
    total: liveTraceCalls.length,
    durationMs: c.durationMs,
    args: c.args,
    result: c.result ?? '',
    isErr: String(c.result ?? '').startsWith('⚠'),
    sessionId: document.getElementById('session-picker')?.dataset.selectedSession ?? null,
    project: typeof c.project === 'string' && c.project ? c.project : null,
    crossProject: typeof c.project === 'string' && !viewerSameProjectRoot(c.project, liveProjectRoot),
    targets: traceGraphTargets(c.args),
  });
}

/** Scoped viewer chrome: the session dropdown is meaningless when
    the server only serves one session — hide it and say so. */
function applySessionScopeChrome() {
  if (!liveSessionScope) return;
  const dropdown = document.getElementById('lf-session-filter');
  if (dropdown) dropdown.style.display = 'none';
  const hint = document.querySelector('.live-hint');
  if (hint) hint.textContent = `scoped to session ${liveSessionScope.selector} — other sessions are not served`;
  const traceTitle = document.querySelector('.trace-title');
  if (traceTitle) traceTitle.textContent = `Agent trace · ${liveSessionScope.selector}`;
}

/** ts → "Jun 12 02:05" for session pickers. */
function formatSessionClock(ts) {
  if (ts == null) return '—';
  const d = new Date(ts);
  const month = d.toLocaleString('en-US', { month: 'short' });
  const pad = (n) => String(n).padStart(2, '0');
  return `${month} ${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Search → focus a symbol in live mode. Fetches /api/symbol/<query>
    to resolve the id; if found, fetches the focused subgraph and
    re-renders. No-ops in file:// mode (no API to hit). */
async function searchAndFocus(query) {
  const input = document.getElementById('search-input');
  input.classList.remove('error');
  if (!LIVE_MODE) { input.classList.add('error'); return false; }
  const trimmed = query.trim();
  if (!trimmed) return false;
  try {
    const symRes = await apiFetch(`/api/symbol/${encodeURIComponent(trimmed)}`);
    if (!symRes.ok) { input.classList.add('error'); return false; }
    const sym = await symRes.json();
    return await focusGraphOnSymbol(sym.id, sym.label);
  } catch (err) {
    console.warn('viewer: searchAndFocus failed', err);
    input.classList.add('error');
    setGraphState('err', `Search failed: ${String(err)}`);
    return false;
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
  if (!LIVE_MODE || !symbolId) return false;
  const requestSeq = ++graphFocusRequestSeq;
  const isCurrentGraphRequest = () => requestSeq === graphFocusRequestSeq;
  setGraphState('loading', `Loading neighborhood for ${label}...`);
  try {
    const graphRes = await apiFetch(graphRequestUrl(symbolId, 2));
    if (!isCurrentGraphRequest()) return false;
    if (!graphRes.ok) {
      setGraphState('err', `Failed to load neighborhood: HTTP ${graphRes.status}`);
      return false;
    }
    const g = await graphRes.json();
    if (!isCurrentGraphRequest()) return false;
    if (g.error) {
      setGraphState('err', g.error);
      return false;
    }
    currentSymbolId = g.focus || symbolId;
    syncViewerSelectionState(currentSymbolId, liveSymbolCache);
    renderGraphPayload(
      g,
      `Showing ${g.nodes.length} nodes · ${(g.edges ?? []).length} edges · focus <b style="color:var(--text)">${escapeHtml(label)}</b>`,
    );
    pushGraphTrail(g.focus || symbolId, label);
    await selectSymbolLive(g.focus || symbolId);
    return true;
  } catch (err) {
    // Without this, a network blip left the "Loading neighborhood…"
    // overlay up forever (no path back to setGraphState(null)).
    console.warn('viewer: focusGraphOnSymbol failed', err);
    if (isCurrentGraphRequest()) setGraphState('err', `Failed to load neighborhood: ${String(err)}`);
    return false;
  }
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
