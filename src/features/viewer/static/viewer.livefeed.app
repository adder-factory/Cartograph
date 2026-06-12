/* ───────── Live activity feed (Live tab) ─────────
   Streams mcp_tool_calls rows over SSE from /api/live/stream and
   renders them as a following feed. The server replays a backlog
   snapshot on connect, then pushes `call` events as an MCP client
   uses cartograph on this project. Dedupe across reconnects is by
   (session, step) key, mirroring the server's cursor semantics.

   Globals used at runtime (load order is safe — calls happen after
   all classic scripts ran): apiFetch (viewer.api.app), escapeHtml
   (viewer.trace.app), formatArgs + focusGraphOnSymbol
   (viewer.live.app), setText/formatNumber/formatRelative
   (viewer.health.app), LIVE_MODE (viewer.live.app). */

const LF_MAX_ROWS = 400;
const LF_AVG_WINDOW = 50;
const LF_RETRY_BASE_MS = 1000;
const LF_RETRY_MAX_MS = 8000;
const LF_SEEN_CAP = 4000;
const LF_RATE_WINDOW_MS = 60000;

const lfFeedEl = document.getElementById('lf-feed');
const lfEmptyEl = document.getElementById('lf-empty');
const lfIndicatorEl = document.getElementById('lf-indicator');
const lfConnEl = document.getElementById('lf-conn');
const lfJumpEl = document.getElementById('lf-jump');
const lfHoldBtn = document.getElementById('lf-hold');

let lfActive = false;          // Live tab currently visible
let lfAbort = null;            // AbortController for the open stream
let lfRetryMs = LF_RETRY_BASE_MS;
let lfRetryTimer = null;
let lfStatsTimer = null;
let lfFollow = true;           // auto-scroll to newest rows
let lfSeen = new Set();        // "session:step" keys already rendered
let lfRowCount = 0;            // rendered .lf-row elements (cap)
let lfCallCount = 0;           // calls seen since open/clear (stat)
let lfRecentTs = [];           // call timestamps inside the rate window
let lfDurations = [];          // sliding window for the avg stat
let lfToolCounts = new Map();  // tool → call count (tool mix card)
let lfLastSessionId = null;    // session separator bookkeeping
let lfSessionMeta = null;      // active session card payload

function lfKey(c) { return `${c.sessionId}:${c.step}`; }

function lfShortTool(tool) {
  return String(tool || '').replace(/^cartograph_/, '');
}

/** Deterministic hue per tool name so colors are stable across runs. */
function lfToolHue(tool) {
  let h = 0;
  const s = String(tool || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return (h * 47 + 13) % 360;
}

function lfFormatMs(ms) {
  const n = Number(ms || 0);
  if (n >= 10000) return `${(n / 1000).toFixed(0)}s`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

function lfSetConn(state, label) {
  if (lfIndicatorEl) lfIndicatorEl.dataset.state = state;
  if (lfConnEl) lfConnEl.textContent = label;
}

function lfSetFollow(follow) {
  lfFollow = follow;
  if (lfHoldBtn) lfHoldBtn.textContent = follow ? 'Hold' : 'Follow';
  if (lfJumpEl) lfJumpEl.hidden = follow;
  if (follow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
}

/* ── append path ── */

function lfTrimSeen() {
  if (lfSeen.size <= LF_SEEN_CAP) return;
  lfSeen = new Set([...lfSeen].slice(-Math.floor(LF_SEEN_CAP / 2)));
}

function lfEnforceRowCap() {
  while (lfRowCount > LF_MAX_ROWS && lfFeedEl.firstElementChild) {
    const first = lfFeedEl.firstElementChild;
    if (first.classList.contains('lf-row')) lfRowCount--;
    first.remove();
  }
}

function lfAppendCall(c, animate) {
  if (!c || typeof c !== 'object') return false;
  const key = lfKey(c);
  if (lfSeen.has(key)) return false;
  lfSeen.add(key);
  lfTrimSeen();

  if (c.sessionId && !lfSessionsSeen.has(c.sessionId)) {
    lfSessionsSeen.set(c.sessionId, c.ts);
    lfSyncSessionOptions();
  }
  if (c.sessionId !== lfLastSessionId) {
    lfLastSessionId = c.sessionId;
    const sep = document.createElement('div');
    sep.className = 'lf-session-row';
    sep.dataset.session = c.sessionId ?? '';
    sep.innerHTML = `<span class="lf-session-chip">session ${escapeHtml(c.sessionId ?? '?')}</span><span class="line" aria-hidden="true"></span>`;
    sep.hidden = Boolean(lfFilterQuery()) || Boolean(lfSessionFilterValue());
    lfFeedEl.appendChild(sep);
  }

  const row = document.createElement('div');
  row.className = 'lf-row';
  if (!animate) row.style.animation = 'none';
  const symbol = c.args && typeof c.args === 'object' ? c.args.symbol : null;
  if (typeof symbol === 'string' && symbol) {
    row.classList.add('has-symbol');
    row.dataset.symbol = symbol;
    row.title = `Focus ${symbol} on the graph`;
  }
  const durClass = c.durationMs < 100 ? ' fast' : c.durationMs > 1500 ? ' slow' : '';
  const result = String(c.result ?? '');
  const isErr = result.startsWith('⚠');
  const argsText = formatArgs(c.args);
  row.innerHTML =
    `<span class="lf-time">${new Date(c.ts).toTimeString().slice(0, 8)}</span>` +
    `<span class="lf-tool" style="--tool-hue:${lfToolHue(c.tool)}">${escapeHtml(lfShortTool(c.tool))}</span>` +
    `<span class="lf-args" title="${escapeHtml(argsText)}">${escapeHtml(argsText)}</span>` +
    `<span class="lf-dur${durClass}">${lfFormatMs(c.durationMs)}</span>` +
    `<span class="lf-res${isErr ? ' err' : ''}" title="${escapeHtml(result)}">${escapeHtml(result)}</span>`;
  row.dataset.search = `${lfShortTool(c.tool)} ${c.tool} ${argsText} ${result}`.toLowerCase();
  row.dataset.session = c.sessionId ?? '';
  if (!lfRowPassesFilters(row)) row.hidden = true;
  lfFeedEl.appendChild(row);
  lfRowCount++;
  lfEnforceRowCap();
  lfGraphRecord(c, animate);

  lfCallCount++;
  lfRecentTs.push(c.ts);
  lfDurations.push(Number(c.durationMs) || 0);
  if (lfDurations.length > LF_AVG_WINDOW) lfDurations.shift();
  lfToolCounts.set(c.tool, (lfToolCounts.get(c.tool) || 0) + 1);
  if (!lfSessionMeta || lfSessionMeta.id !== c.sessionId) {
    lfSessionMeta = { id: c.sessionId, firstTs: c.ts, calls: 0 };
  }
  lfSessionMeta.calls++;
  lfSessionMeta.lastTs = c.ts;
  if (lfEmptyEl) lfEmptyEl.hidden = true;
  return true;
}

function lfAfterAppend() {
  lfRenderStats();
  lfRenderSession();
  lfRenderToolmix();
  if (lfFilterQuery() || lfSessionFilterValue()) lfUpdateFilterCount();
  if (lfFollow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
}

/* ── side cards + stats ── */

function lfRenderStats() {
  const now = Date.now();
  lfRecentTs = lfRecentTs.filter((t) => now - t < LF_RATE_WINDOW_MS);
  setText('lf-stat-calls', formatNumber(lfCallCount));
  setText('lf-stat-rate', formatNumber(lfRecentTs.length));
  const avg = lfDurations.length > 0 ? lfDurations.reduce((a, b) => a + b, 0) / lfDurations.length : null;
  setText('lf-stat-avg', avg == null ? '—' : lfFormatMs(avg));
}

function lfRenderSession() {
  const el = document.getElementById('lf-session');
  if (!el) return;
  if (!lfSessionMeta) {
    el.textContent = 'No session yet.';
    return;
  }
  el.innerHTML =
    `<span class="id">${escapeHtml(lfSessionMeta.id ?? '?')}</span><br>` +
    `${formatNumber(lfSessionMeta.calls)} ${lfSessionMeta.calls === 1 ? 'call' : 'calls'} in this feed<br>` +
    `last activity ${escapeHtml(formatRelative(lfSessionMeta.lastTs))}`;
}

function lfRenderToolmix() {
  const el = document.getElementById('lf-toolmix');
  if (!el) return;
  if (lfToolCounts.size === 0) {
    el.innerHTML = '<div class="health-empty">No calls observed yet.</div>';
    return;
  }
  const rows = [...lfToolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const max = rows[0][1] || 1;
  el.innerHTML = rows.map(([tool, count]) => `
    <div class="live-toolmix-row" style="--tool-hue:${lfToolHue(tool)}">
      <span class="name">${escapeHtml(lfShortTool(tool))}</span>
      <span class="count">${formatNumber(count)}</span>
      <span class="bar" aria-hidden="true"><span style="width:${Math.round((count / max) * 100)}%"></span></span>
    </div>
  `).join('');
}

/* ── SSE client ── */

function lfHandleFrame(frame) {
  let event = 'message';
  const dataLines = [];
  for (const line of frame.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    /* lines starting with ':' are heartbeats — ignored */
  }
  if (dataLines.length === 0) return;
  let data;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (event === 'backlog') {
    let appended = false;
    for (const c of data.calls || []) appended = lfAppendCall(c, false) || appended;
    if (lfRowCount === 0 && lfEmptyEl) lfEmptyEl.hidden = false;
    if (appended) lfAfterAppend();
  } else if (event === 'call') {
    if (lfAppendCall(data, true)) lfAfterAppend();
  }
}

async function lfRunStream() {
  if (lfAbort) return;
  const ctrl = new AbortController();
  lfAbort = ctrl;
  lfSetConn('idle', 'connecting…');
  try {
    const res = await apiFetch('/api/live/stream', { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    lfSetConn('live', 'live');
    lfRetryMs = LF_RETRY_BASE_MS;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx = buf.indexOf('\n\n');
      while (idx >= 0) {
        lfHandleFrame(buf.slice(0, idx));
        buf = buf.slice(idx + 2);
        idx = buf.indexOf('\n\n');
      }
    }
    throw new Error('stream ended');
  } catch (err) {
    const aborted = ctrl.signal.aborted;
    lfAbort = null;
    if (aborted) return; // deliberate stop (tab switch)
    console.debug('viewer: live stream dropped, retrying', err);
    lfSetConn('error', `reconnecting in ${Math.round(lfRetryMs / 1000)}s…`);
    lfRetryTimer = setTimeout(() => {
      lfRetryTimer = null;
      if (lfActive) void lfRunStream();
    }, lfRetryMs);
    lfRetryMs = Math.min(LF_RETRY_MAX_MS, lfRetryMs * 2);
  }
}

/* ── tab lifecycle (called from viewer.app's tab handler) ── */

function liveFeedActivate() {
  lfActive = true;
  lfSetMode(lfMode, false);
  if (!LIVE_MODE) {
    lfSetConn('idle', 'file:// mode — start `cartograph viewer` for the live feed');
    if (lfEmptyEl) lfEmptyEl.hidden = false;
    return;
  }
  if (!lfAbort && !lfRetryTimer) void lfRunStream();
  if (!lfStatsTimer) {
    lfStatsTimer = setInterval(() => {
      if (lfActive && lfCallCount > 0) lfRenderStats();
    }, 5000);
  }
  if (lfFollow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
}

function liveFeedDeactivate() {
  if (!lfActive) return;
  lfActive = false;
  if (lfAbort) {
    lfAbort.abort();
    lfAbort = null;
  }
  if (lfRetryTimer) {
    clearTimeout(lfRetryTimer);
    lfRetryTimer = null;
  }
  if (lfStatsTimer) {
    clearInterval(lfStatsTimer);
    lfStatsTimer = null;
  }
  lfSetConn('idle', 'paused — reopen to resume');
}

/* ── interactions ── */

lfFeedEl?.addEventListener('click', (e) => {
  const row = e.target instanceof Element ? e.target.closest('.lf-row.has-symbol') : null;
  if (!row) return;
  const symbol = row.dataset.symbol;
  if (!symbol) return;
  document.querySelector('.tab[data-view="graph"]')?.click();
  if (typeof focusGraphOnSymbol === 'function') void focusGraphOnSymbol(symbol, symbol);
});

lfFeedEl?.addEventListener('scroll', () => {
  const nearBottom = lfFeedEl.scrollHeight - lfFeedEl.scrollTop - lfFeedEl.clientHeight < 48;
  if (!nearBottom && lfFollow) lfSetFollow(false);
  else if (nearBottom && !lfFollow) lfSetFollow(true);
});

lfHoldBtn?.addEventListener('click', () => lfSetFollow(!lfFollow));
lfJumpEl?.addEventListener('click', () => lfSetFollow(true));

document.getElementById('lf-clear')?.addEventListener('click', () => {
  // Keep lfSeen — cleared calls must not re-render from the next
  // reconnect's backlog snapshot.
  lfFeedEl.innerHTML = '';
  lfRowCount = 0;
  lfCallCount = 0;
  lfRecentTs = [];
  lfDurations = [];
  lfToolCounts = new Map();
  lfLastSessionId = null;
  lfSessionMeta = null;
  lfRenderStats();
  lfRenderSession();
  lfRenderToolmix();
  lfGraphReset();
  lfSessionsSeen.clear();
  lfSyncSessionOptions();
  lfUpdateFilterCount();
  if (lfEmptyEl) lfEmptyEl.hidden = false;
});

/* ───────── Feed filter ───────── */

const lfFilterInput = document.getElementById('lf-filter');
const lfFilterCount = document.getElementById('lf-filter-count');

function lfFilterQuery() {
  return lfFilterInput?.value.trim().toLowerCase() || '';
}

const lfSessionFilterEl = document.getElementById('lf-session-filter');
const lfSessionsSeen = new Map(); // sessionId → first-seen ts

function lfSessionFilterValue() {
  return lfSessionFilterEl?.value || '';
}

/** Rebuild the session dropdown from the sessions present in the
    feed, newest first, preserving the current selection. */
function lfSyncSessionOptions() {
  if (!lfSessionFilterEl) return;
  const selected = lfSessionFilterEl.value;
  const ids = [...lfSessionsSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  lfSessionFilterEl.innerHTML =
    '<option value="">All sessions</option>' +
    ids.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`).join('');
  if (selected && ids.includes(selected)) lfSessionFilterEl.value = selected;
}

function lfRowPassesFilters(el) {
  const q = lfFilterQuery();
  if (q && !(el.dataset.search || '').includes(q)) return false;
  const session = lfSessionFilterValue();
  if (session && el.dataset.session !== session) return false;
  return true;
}

function lfUpdateFilterCount() {
  if (!lfFilterCount) return;
  if (!lfFilterQuery() && !lfSessionFilterValue()) {
    lfFilterCount.textContent = '';
    return;
  }
  const rows = lfFeedEl.querySelectorAll('.lf-row');
  let shown = 0;
  for (const el of rows) if (!el.hidden) shown++;
  lfFilterCount.textContent = `${shown}/${rows.length}`;
}

function lfApplyFilter() {
  const narrowed = Boolean(lfFilterQuery()) || Boolean(lfSessionFilterValue());
  for (const el of lfFeedEl.querySelectorAll('.lf-row')) {
    el.hidden = !lfRowPassesFilters(el);
  }
  // Session separators are stream landmarks — they only make sense
  // on the full, unfiltered feed.
  for (const el of lfFeedEl.querySelectorAll('.lf-session-row')) el.hidden = narrowed;
  lfUpdateFilterCount();
  if (lfFollow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
}

lfSessionFilterEl?.addEventListener('change', () => {
  lfApplyFilter();
  lfGraphRebuild();
});

lfFilterInput?.addEventListener('input', lfApplyFilter);
lfFilterInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    lfFilterInput.value = '';
    lfApplyFilter();
    lfFilterInput.blur();
  }
});

/* ───────── Activity graph (Both / Graph layout modes) ─────────
   A second, independent cytoscape instance: square tool nodes sized
   by call count, linked to the symbols / files / queries those calls
   touched. Fed from every appended call (cheap upserts into
   lfGraphLog); the cy instance itself is created lazily on the first
   non-feed layout, then replays the log. */

const LF_GRAPH_MAX_TARGETS = 80;
const LF_GRAPH_LOG_CAP = 400;
const LF_GRAPH_FLASH_MS = 900;
const LF_GRAPH_LAYOUT_DEBOUNCE_MS = 600;
const LF_MODE_KEY = 'cartograph-viewer-live-mode-v1';
const LF_MODES = ['feed', 'split', 'graph'];

const lfBodyEl = document.getElementById('lf-body');
const lfGraphWrapEl = document.getElementById('lf-graph-wrap');
let lfMode = readViewerJsonStorage(LF_MODE_KEY, 'feed', { validate: (v) => LF_MODES.includes(v) });
let lfGraphCy = null;
let lfGraphLayoutTimer = null;
let lfGraphLog = [];      // {tool, toolLabel, hue, target} per call, capped
let lfTargetOrder = [];   // target node ids in insertion order (prune oldest)

/** Concrete thing a call touched, if any: symbol > file/dir > query. */
function lfCallTarget(c) {
  const a = c.args && typeof c.args === 'object' ? c.args : null;
  if (!a) return null;
  const sym = a.symbol ?? a.start ?? a.to ?? (Array.isArray(a.symbols) ? a.symbols[0] : null);
  if (typeof sym === 'string' && sym) return { id: `sym:${sym}`, label: sym, type: 'symbol', focus: sym };
  const file = a.file ?? a.dir ?? a.dirPath ?? a.pathFilter;
  if (typeof file === 'string' && file) return { id: `file:${file}`, label: file, type: 'file', focus: null };
  if (typeof a.query === 'string' && a.query) {
    const label = a.query.length > 40 ? `${a.query.slice(0, 40)}…` : a.query;
    return { id: `q:${label}`, label, type: 'query', focus: null };
  }
  return null;
}

function lfGraphRecord(c, fresh) {
  const entry = {
    tool: c.tool,
    toolLabel: lfShortTool(c.tool),
    hue: lfToolHue(c.tool),
    target: lfCallTarget(c),
    sessionId: c.sessionId ?? '',
  };
  lfGraphLog.push(entry);
  if (lfGraphLog.length > LF_GRAPH_LOG_CAP) lfGraphLog.shift();
  const session = lfSessionFilterValue();
  if (session && entry.sessionId !== session) return;
  if (lfGraphCy) {
    lfGraphUpsert(entry, fresh && lfMode !== 'feed');
    if (lfMode !== 'feed') lfGraphScheduleLayout();
  }
}

/** Rebuild the activity graph from the log under the current session
    filter — used when the filter changes (text filter is feed-only;
    the session filter scopes the graph too). */
function lfGraphRebuild() {
  if (!lfGraphCy) return;
  // A pending layout timer is fine — it fires against the rebuilt
  // elements, which is exactly what we want.
  lfGraphCy.elements().remove();
  lfTargetOrder = [];
  const session = lfSessionFilterValue();
  for (const entry of lfGraphLog) {
    if (session && entry.sessionId !== session) continue;
    lfGraphUpsert(entry, false);
  }
  if (lfMode !== 'feed') lfGraphScheduleLayout();
}

function lfGraphFlash(ele) {
  ele.addClass('fresh');
  setTimeout(() => {
    try {
      ele.removeClass('fresh');
    } catch {
      /* element may have been pruned */
    }
  }, LF_GRAPH_FLASH_MS);
}

function lfGraphPrune() {
  while (lfTargetOrder.length > LF_GRAPH_MAX_TARGETS) {
    const id = lfTargetOrder.shift();
    const node = lfGraphCy.getElementById(id);
    if (node.length > 0) lfGraphCy.remove(node); // connected edges go with it
  }
}

function lfGraphUpsert(entry, fresh) {
  const toolId = `tool:${entry.tool}`;
  let toolNode = lfGraphCy.getElementById(toolId);
  if (toolNode.length === 0) {
    toolNode = lfGraphCy.add({
      group: 'nodes',
      data: { id: toolId, label: entry.toolLabel, color: `hsl(${entry.hue} 55% 38%)`, size: 26, calls: 0, focus: null },
      classes: 'tool',
    });
  }
  toolNode.data('calls', (toolNode.data('calls') || 0) + 1);
  toolNode.data('size', Math.min(56, 24 + Math.sqrt(toolNode.data('calls')) * 4));
  if (fresh) lfGraphFlash(toolNode);
  if (!entry.target) return;
  let targetNode = lfGraphCy.getElementById(entry.target.id);
  if (targetNode.length === 0) {
    targetNode = lfGraphCy.add({
      group: 'nodes',
      data: { id: entry.target.id, label: entry.target.label, size: 18, focus: entry.target.focus },
      classes: entry.target.type,
    });
    lfTargetOrder.push(entry.target.id);
    lfGraphPrune();
  }
  const edgeId = `e:${toolId}->${entry.target.id}`;
  let edge = lfGraphCy.getElementById(edgeId);
  if (edge.length === 0) {
    edge = lfGraphCy.add({ group: 'edges', data: { id: edgeId, source: toolId, target: entry.target.id, w: 1, n: 0 } });
  }
  edge.data('n', (edge.data('n') || 0) + 1);
  edge.data('w', Math.min(6, 1 + Math.log2(1 + edge.data('n'))));
  if (fresh) {
    lfGraphFlash(targetNode);
    lfGraphFlash(edge);
  }
}

function lfGraphScheduleLayout() {
  if (!lfGraphCy || lfGraphLayoutTimer) return;
  lfGraphLayoutTimer = setTimeout(() => {
    lfGraphLayoutTimer = null;
    if (!lfGraphCy || !lfActive || lfMode === 'feed') return;
    lfGraphCy.layout({ name: 'cose', animate: false, randomize: false, fit: true, padding: 28 }).run();
  }, LF_GRAPH_LAYOUT_DEBOUNCE_MS);
}

function lfEnsureGraph() {
  if (lfGraphCy || typeof cytoscape !== 'function') return;
  const container = document.getElementById('lf-graph');
  if (!container) return;
  lfGraphCy = cytoscape({
    container,
    elements: [],
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(label)',
          'font-size': 9,
          color: '#c7d0da',
          'text-valign': 'bottom',
          'text-margin-y': 5,
          'text-max-width': 130,
          'text-wrap': 'ellipsis',
          'background-color': '#2b323a',
          width: 'data(size)',
          height: 'data(size)',
        },
      },
      { selector: 'node.tool', style: { shape: 'round-rectangle', 'background-color': 'data(color)' } },
      { selector: 'node.symbol', style: { shape: 'ellipse', 'background-color': '#183654', 'border-width': 1.5, 'border-color': '#75bdff' } },
      { selector: 'node.file', style: { shape: 'rectangle', 'background-color': '#20252b', 'border-width': 1, 'border-color': '#788592' } },
      { selector: 'node.query', style: { shape: 'diamond', 'background-color': '#20252b', 'border-width': 1, 'border-color': '#9faab6' } },
      { selector: 'node.fresh', style: { 'border-width': 3, 'border-color': '#5dd6aa' } },
      {
        selector: 'edge',
        style: {
          width: 'data(w)',
          'line-color': '#323a43',
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': '#323a43',
          'arrow-scale': 0.7,
        },
      },
      { selector: 'edge.fresh', style: { 'line-color': '#5dd6aa', 'target-arrow-color': '#5dd6aa' } },
    ],
  });
  lfGraphCy.on('tap', 'node.symbol', (e) => {
    const focus = e.target.data('focus');
    if (!focus) return;
    document.querySelector('.tab[data-view="graph"]')?.click();
    if (typeof focusGraphOnSymbol === 'function') void focusGraphOnSymbol(focus, focus);
  });
  const session = lfSessionFilterValue();
  for (const entry of lfGraphLog) {
    if (session && entry.sessionId !== session) continue;
    lfGraphUpsert(entry, false);
  }
}

function lfGraphReset() {
  lfGraphLog = [];
  lfTargetOrder = [];
  lfGraphCy?.elements().remove();
}

function lfSetMode(mode, persist = true) {
  lfMode = LF_MODES.includes(mode) ? mode : 'feed';
  lfBodyEl?.setAttribute('data-lf-mode', lfMode);
  if (lfGraphWrapEl) lfGraphWrapEl.hidden = lfMode === 'feed';
  document.querySelectorAll('.live-mode-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.lfMode === lfMode);
  });
  if (lfMode !== 'feed') {
    lfEnsureGraph();
    requestAnimationFrame(() => {
      lfGraphCy?.resize();
      if (lfGraphCy && lfGraphCy.nodes().length > 0) {
        lfGraphCy.layout({ name: 'cose', animate: false, randomize: false, fit: true, padding: 28 }).run();
      }
    });
  } else if (lfFollow && lfFeedEl) {
    lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
  }
  if (persist) writeViewerJsonStorage(LF_MODE_KEY, lfMode);
}

document.querySelectorAll('.live-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => lfSetMode(btn.dataset.lfMode));
});

/* Smoke-test hook — mirrors __cartographViewerSmoke for the main app. */
globalThis.__cartographLiveFeedSmoke = {
  graphNodeCount: () => (lfGraphCy ? lfGraphCy.nodes().length : 0),
  graphEdgeCount: () => (lfGraphCy ? lfGraphCy.edges().length : 0),
  mode: () => lfMode,
};
