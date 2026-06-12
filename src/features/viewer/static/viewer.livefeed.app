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
  if (follow && lfGraphCy && lfMode !== 'feed' && lfCurrentNodeId) {
    const node = lfGraphCy.getElementById(lfCurrentNodeId);
    if (node.length > 0) lfGraphCy.animate({ center: { eles: node }, duration: LF_FOLLOW_CAM_MS, easing: 'ease-in-out-quad' });
  }
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
  lfStopTicker();
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
const LF_TRAIL_MAX = 40;
const LF_TRAIL_MIN_OPACITY = 0.18;
const LF_TRAIL_FADE_STEP = 0.08;
const LF_FOLLOW_CAM_MS = 420;
const LF_PACKET_MS = 460;
const LF_AMBIENT_PACKET_EVERY_MS = 2600;
const LF_GHOST_AFTER_MS = 60000;
const LF_GHOST_PASS_EVERY_MS = 2000;
const LF_DASH_SPEED = 0.55;
const LF_REDUCED_MOTION = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
const LF_MODE_KEY = 'cartograph-viewer-live-mode-v1';
const LF_MODES = ['feed', 'split', 'graph'];

const lfBodyEl = document.getElementById('lf-body');
const lfGraphWrapEl = document.getElementById('lf-graph-wrap');
let lfMode = readViewerJsonStorage(LF_MODE_KEY, 'feed', { validate: (v) => LF_MODES.includes(v) });
let lfGraphCy = null;
let lfGraphLayoutTimer = null;
let lfGraphLog = [];      // {tool, toolLabel, hue, target} per call, capped
let lfTargetOrder = [];   // target node ids in insertion order (prune oldest)
let lfSymbolCache = new Map(); // symbol name → /api/symbol payload | null
let lfPrevSymbolNodeId = null; // traversal trail: last symbol touched
let lfTrailEdges = [];         // trail edge ids, oldest first
let lfTrailSeq = 0;
let lfCurrentNodeId = null;    // "where the agent is" marker
let lfGraphHasLaidOut = false;
let lfLayoutRef = null;        // running (animated) layout, stopped before re-run
let lfTickerRaf = null;        // rAF loop: marching dashes, breathing, ambience
let lfPacketSeq = 0;
let lfDashOffset = 0;
let lfLastGhostPass = 0;
let lfLastAmbient = 0;
const lfLastTouch = new Map(); // node id → last activity ts (ghosting)

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
  lfGraphClearElements();
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
  lfTouch(toolNode);
  if (fresh) lfGraphFlash(toolNode);
  if (!entry.target) return;
  let targetNode = lfGraphCy.getElementById(entry.target.id);
  if (targetNode.length === 0) {
    // Spawn near the agent's current position so new symbols grow
    // outward from the walk instead of flying in from origin.
    const anchor = lfCurrentNodeId ? lfGraphCy.getElementById(lfCurrentNodeId) : null;
    const anchorPos = anchor && anchor.length > 0 ? anchor.position() : null;
    targetNode = lfGraphCy.add({
      group: 'nodes',
      data: { id: entry.target.id, label: entry.target.label, size: 18, focus: entry.target.focus },
      classes: entry.target.type,
      position: anchorPos
        ? { x: anchorPos.x + 70 * (Math.random() - 0.5) + 50, y: anchorPos.y + 70 * (Math.random() - 0.5) }
        : undefined,
    });
    lfTargetOrder.push(entry.target.id);
    lfGraphPrune();
    lfEnterNode(targetNode);
  }
  lfTouch(targetNode);
  if (entry.target.type === 'symbol') {
    lfGraphResolveSymbol(entry.target.label, entry.target.id, targetNode);
    // Traversal trail: one hop edge per symbol→symbol move, in tool
    // color, newest bright and older hops fading out.
    if (lfPrevSymbolNodeId && lfPrevSymbolNodeId !== entry.target.id &&
        lfGraphCy.getElementById(lfPrevSymbolNodeId).length > 0) {
      const trailId = `trail:${lfTrailSeq++}`;
      const trailEdge = lfGraphCy.add({
        group: 'edges',
        data: { id: trailId, source: lfPrevSymbolNodeId, target: entry.target.id, color: `hsl(${entry.hue} 70% 60%)` },
        classes: 'trail',
      });
      lfTrailEdges.push(trailId);
      while (lfTrailEdges.length > LF_TRAIL_MAX) {
        const dead = lfGraphCy.getElementById(lfTrailEdges.shift());
        if (dead.length > 0) lfGraphCy.remove(dead);
      }
      lfTrailFade();
      if (fresh) {
        lfGraphFlash(trailEdge);
        lfFirePacket(trailEdge, '#7df9ff', LF_PACKET_MS);
      }
    }
    lfPrevSymbolNodeId = entry.target.id;
  }
  const edgeId = `e:${toolId}->${entry.target.id}`;
  let edge = lfGraphCy.getElementById(edgeId);
  if (edge.length === 0) {
    edge = lfGraphCy.add({ group: 'edges', data: { id: edgeId, source: toolId, target: entry.target.id, w: 1, n: 0 } });
  }
  edge.data('n', (edge.data('n') || 0) + 1);
  edge.data('w', Math.min(6, 1 + Math.log2(1 + edge.data('n'))));
  lfGraphSetCurrent(entry.target.id, fresh);
  if (fresh) {
    lfGraphFlash(targetNode);
    lfGraphFlash(edge);
    lfPing(targetNode);
    lfFirePacket(edge, `hsl(${entry.hue} 80% 65%)`, LF_PACKET_MS);
  }
}

/* ── Tron layer: packets, pings, entrance, ghosting, ticker ── */

function lfTouch(node) {
  lfLastTouch.set(node.id(), Date.now());
  node.removeClass('ghost');
}

/** New nodes materialize instead of popping in. */
function lfEnterNode(node) {
  if (LF_REDUCED_MOTION) return;
  node.style('opacity', 0);
  node.animate({ style: { opacity: 1 } }, { duration: 260, complete: () => {
    try { node.removeStyle('opacity'); } catch { /* pruned mid-entrance */ }
  } });
}

/** Sonar ripple: prime a tight bright underlay without transition,
    then flip to the expanded transparent state so it animates out. */
function lfPing(node) {
  if (LF_REDUCED_MOTION || node.length === 0) return;
  node.addClass('ping-prime');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    node.removeClass('ping-prime');
    node.addClass('ping');
    setTimeout(() => {
      try { node.removeClass('ping'); } catch { /* pruned */ }
    }, 720);
  }));
}

/** A light pulse racing along an edge — source → midpoint → target —
    then gone. The packet is a tiny glowing node excluded from layout,
    hit-testing, counts, and ghosting. */
function lfFirePacket(edge, color, durationMs) {
  if (LF_REDUCED_MOTION || !lfGraphCy || edge.length === 0) return;
  const srcPos = { ...edge.source().position() };
  const midPos = { ...edge.midpoint() };
  const dstPos = { ...edge.target().position() };
  const packet = lfGraphCy.add({
    group: 'nodes',
    data: { id: `pkt:${lfPacketSeq++}`, color, size: 7 },
    classes: 'packet',
    position: srcPos,
  });
  packet.ungrabify();
  packet.unselectify();
  const dispose = () => {
    try {
      lfGraphCy.remove(packet);
    } catch { /* already gone via clear/rebuild */ }
  };
  packet.animate(
    { position: midPos },
    {
      duration: durationMs / 2,
      easing: 'linear',
      complete: () =>
        packet.animate(
          { position: dstPos },
          { duration: durationMs / 2, easing: 'linear', complete: dispose },
        ),
    },
  );
}

/** Idle nodes dim to ghosts so the active frontier glows. */
function lfGhostPass() {
  const now = Date.now();
  lfGraphCy.nodes().not('.packet').forEach((node) => {
    const touched = lfLastTouch.get(node.id()) || 0;
    node.toggleClass('ghost', node.id() !== lfCurrentNodeId && now - touched > LF_GHOST_AFTER_MS);
  });
}

/** One rAF loop while the graph is visible: marching light along the
    recent trail, the current node breathing, and an ambient packet
    re-running a recent hop every couple of seconds. */
function lfTickerStep(ts) {
  lfTickerRaf = null;
  if (!lfGraphCy || !lfActive || lfMode === 'feed' || LF_REDUCED_MOTION) return;
  lfDashOffset -= LF_DASH_SPEED;
  if (lfDashOffset < -10000) lfDashOffset = 0;
  for (const id of lfTrailEdges.slice(-12)) {
    const edge = lfGraphCy.getElementById(id);
    if (edge.length > 0) edge.style('line-dash-offset', lfDashOffset);
  }
  if (lfCurrentNodeId) {
    const node = lfGraphCy.getElementById(lfCurrentNodeId);
    if (node.length > 0 && !node.hasClass('ping') && !node.hasClass('ping-prime')) {
      node.style('underlay-opacity', 0.14 + 0.1 * (Math.sin(ts / 320) + 1) / 2);
      node.style('underlay-color', '#7df9ff');
      node.style('underlay-padding', 8);
    }
  }
  if (ts - lfLastAmbient > LF_AMBIENT_PACKET_EVERY_MS && lfTrailEdges.length > 0) {
    lfLastAmbient = ts;
    const recent = lfTrailEdges.slice(-8);
    const pick = recent[Math.floor(Math.random() * recent.length)];
    const edge = lfGraphCy.getElementById(pick);
    if (edge.length > 0) lfFirePacket(edge, 'rgba(125, 249, 255, 0.6)', LF_PACKET_MS * 1.6);
  }
  if (ts - lfLastGhostPass > LF_GHOST_PASS_EVERY_MS) {
    lfLastGhostPass = ts;
    lfGhostPass();
  }
  lfTickerRaf = requestAnimationFrame(lfTickerStep);
}

function lfStartTicker() {
  if (lfTickerRaf || LF_REDUCED_MOTION) return;
  lfTickerRaf = requestAnimationFrame(lfTickerStep);
}

function lfStopTicker() {
  if (lfTickerRaf) {
    cancelAnimationFrame(lfTickerRaf);
    lfTickerRaf = null;
  }
  // Don't freeze a mid-breath glow on the current node.
  if (lfGraphCy && lfCurrentNodeId) {
    const node = lfGraphCy.getElementById(lfCurrentNodeId);
    if (node.length > 0) {
      node.removeStyle('underlay-opacity');
      node.removeStyle('underlay-color');
      node.removeStyle('underlay-padding');
    }
  }
}

/** Re-apply the fade gradient over the trail, newest hop brightest. */
function lfTrailFade() {
  lfTrailEdges = lfTrailEdges.filter((id) => lfGraphCy.getElementById(id).length > 0);
  const count = lfTrailEdges.length;
  lfTrailEdges.forEach((id, i) => {
    lfGraphCy.getElementById(id).style('opacity', Math.max(LF_TRAIL_MIN_OPACITY, 1 - (count - 1 - i) * LF_TRAIL_FADE_STEP));
  });
}

/** Mark the node the agent touched last and glide the camera to it
    (Follow drives both the feed autoscroll and this chase-cam). */
function lfGraphSetCurrent(nodeId, fresh) {
  if (lfCurrentNodeId && lfCurrentNodeId !== nodeId) {
    const prev = lfGraphCy.getElementById(lfCurrentNodeId);
    if (prev.length > 0) {
      prev.removeClass('lf-current');
      // The ticker breathes via inline underlay styles — clear them so
      // the node falls back to its stylesheet (hub glow etc).
      prev.removeStyle('underlay-opacity');
      prev.removeStyle('underlay-color');
      prev.removeStyle('underlay-padding');
    }
  }
  lfCurrentNodeId = nodeId;
  const node = lfGraphCy.getElementById(nodeId);
  if (node.length === 0) return;
  node.addClass('lf-current');
  if (fresh && lfFollow && lfMode !== 'feed') {
    const zoom = Math.min(1.35, Math.max(0.9, lfGraphCy.zoom()));
    lfGraphCy.stop(false, false);
    lfGraphCy.animate(
      { zoom: { level: zoom, position: { ...node.position() } } },
      { duration: LF_FOLLOW_CAM_MS, easing: 'ease-in-out-quad' },
    );
  }
}

/** Upgrade a touched symbol to its indexed identity (kind shape,
    health border, centrality size — the main graph's own style) once
    /api/symbol resolves it. Cached per name; unresolved names keep
    the generic dot. */
function lfGraphResolveSymbol(name, nodeId, node) {
  if (lfSymbolCache.has(name)) {
    lfGraphApplyResolution(nodeId, lfSymbolCache.get(name));
    return;
  }
  if (!LIVE_MODE) return;
  void (async () => {
    let payload = null;
    try {
      const res = await apiFetch(`/api/symbol/${encodeURIComponent(name)}`);
      if (res.ok) payload = await res.json();
    } catch {
      /* unresolved — keep the generic style */
    }
    lfSymbolCache.set(name, payload);
    if (lfSymbolCache.size > 500) lfSymbolCache = new Map([...lfSymbolCache].slice(-250));
    lfGraphApplyResolution(nodeId, payload);
  })();
}

function lfGraphApplyResolution(nodeId, payload) {
  if (!lfGraphCy || !payload) return;
  const node = lfGraphCy.getElementById(nodeId);
  if (node.length === 0) return;
  node.data('kind', payload.kind);
  node.data('centrality', payload.centrality || 0);
  node.data('health', healthForPayloadNode(payload));
  if (payload.label) node.data('label', payload.label);
  node.removeClass('symbol');
  node.addClass('code');
}

function lfGraphScheduleLayout() {
  if (!lfGraphCy || lfGraphLayoutTimer) return;
  lfGraphLayoutTimer = setTimeout(() => {
    lfGraphLayoutTimer = null;
    if (!lfGraphCy || !lfActive || lfMode === 'feed') return;
    try {
      lfLayoutRef?.stop();
    } catch { /* never ran */ }
    // While following, fitting would yank the chase-cam off the
    // action — relax positions, then re-center on the current node.
    const fitNow = !lfGraphHasLaidOut || !lfFollow;
    // Packets are transient sparks — the layout must not drag them.
    const eles = lfGraphCy.elements().not('.packet');
    const animate = !LF_REDUCED_MOTION;
    let layout;
    try {
      layout = eles.layout({
        name: 'fcose',
        quality: 'default',
        animate,
        animationDuration: 650,
        randomize: false,
        fit: fitNow,
        padding: 28,
      });
    } catch {
      layout = eles.layout({ name: 'cose', animate, randomize: false, fit: fitNow, padding: 28 });
    }
    lfLayoutRef = layout;
    layout.one('layoutstop', () => {
      if (!fitNow && lfFollow && lfCurrentNodeId && lfGraphCy) {
        const node = lfGraphCy.getElementById(lfCurrentNodeId);
        if (node.length > 0) lfGraphCy.center(node);
      }
    });
    layout.run();
    lfGraphHasLaidOut = true;
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
          'transition-property': 'opacity, width, height, background-color, border-color',
          'transition-duration': '300ms',
        },
      },
      { selector: 'node.tool', style: { shape: 'round-rectangle', 'background-color': 'data(color)' } },
      { selector: 'node.symbol', style: { shape: 'ellipse', 'background-color': '#183654', 'border-width': 1.5, 'border-color': '#75bdff' } },
      // Resolved symbols wear the main graph's exact identity — kind
      // shape + fill, health border, centrality size (viewer.graph-core).
      { selector: 'node.code', style: viewerBaseNodeStyle() },
      { selector: 'node.file', style: { shape: 'rectangle', 'background-color': '#20252b', 'border-width': 1, 'border-color': '#788592' } },
      { selector: 'node.query', style: { shape: 'diamond', 'background-color': '#20252b', 'border-width': 1, 'border-color': '#9faab6' } },
      { selector: 'node.fresh', style: { 'border-width': 3, 'border-color': '#5dd6aa' } },
      {
        selector: 'node.lf-current',
        style: {
          'border-width': 4,
          'border-color': '#75bdff',
          'underlay-color': '#75bdff',
          'underlay-opacity': 0.18,
          'underlay-padding': 8,
          'z-index': 10,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 'data(w)',
          'line-color': '#323a43',
          'line-opacity': 0.35,
          'curve-style': 'bezier',
          'target-arrow-shape': 'triangle',
          'target-arrow-color': '#323a43',
          'arrow-scale': 0.7,
        },
      },
      {
        selector: 'edge.trail',
        style: {
          width: 2.5,
          'line-color': 'data(color)',
          'line-opacity': 1,
          'line-style': 'dashed',
          'line-dash-pattern': [9, 6],
          'target-arrow-color': 'data(color)',
          'target-arrow-shape': 'triangle',
          'arrow-scale': 0.9,
          'z-index': 5,
        },
      },
      { selector: 'edge.fresh', style: { 'line-color': '#7df9ff', 'target-arrow-color': '#7df9ff', width: 3.5 } },
      { selector: 'node.ghost', style: { opacity: 0.3, 'text-opacity': 0.25 } },
      {
        selector: 'node.packet',
        style: {
          shape: 'ellipse',
          width: 7,
          height: 7,
          label: '',
          'background-color': 'data(color)',
          'border-width': 0,
          'underlay-color': 'data(color)',
          'underlay-opacity': 0.55,
          'underlay-padding': 5,
          events: 'no',
          'z-index': 30,
        },
      },
      {
        selector: 'node.ping-prime',
        style: { 'underlay-color': '#7df9ff', 'underlay-opacity': 0.55, 'underlay-padding': 3, 'transition-duration': '0ms' },
      },
      {
        selector: 'node.ping',
        style: {
          'underlay-color': '#7df9ff',
          'underlay-opacity': 0,
          'underlay-padding': 36,
          'transition-property': 'underlay-opacity, underlay-padding',
          'transition-duration': '700ms',
        },
      },
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
  lfGraphClearElements();
}

/** Drop drawn elements + traversal state, keep the call log. */
function lfGraphClearElements() {
  lfTargetOrder = [];
  lfTrailEdges = [];
  lfPrevSymbolNodeId = null;
  lfCurrentNodeId = null;
  lfGraphHasLaidOut = false;
  lfLastTouch.clear();
  try {
    lfLayoutRef?.stop();
  } catch { /* never ran */ }
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
    lfStartTicker();
    requestAnimationFrame(() => {
      lfGraphCy?.resize();
      if (lfGraphCy && lfGraphCy.nodes().not('.packet').length > 0) {
        lfGraphCy.elements().not('.packet').layout({ name: 'cose', animate: false, randomize: false, fit: true, padding: 28 }).run();
        lfGraphHasLaidOut = true;
      }
    });
  } else {
    lfStopTicker();
    if (lfFollow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
  }
  if (persist) writeViewerJsonStorage(LF_MODE_KEY, lfMode);
}

document.querySelectorAll('.live-mode-btn').forEach((btn) => {
  btn.addEventListener('click', () => lfSetMode(btn.dataset.lfMode));
});

/* Smoke-test hook — mirrors __cartographViewerSmoke for the main app. */
globalThis.__cartographLiveFeedSmoke = {
  graphNodeCount: () => (lfGraphCy ? lfGraphCy.nodes().not('.packet').length : 0),
  graphEdgeCount: () => (lfGraphCy ? lfGraphCy.edges().length : 0),
  graphNodeInfo: (id) => {
    const node = lfGraphCy?.getElementById(id);
    if (!node || node.length === 0) return null;
    return { kind: node.data('kind') ?? null, health: node.data('health') ?? null, classes: node.classes() };
  },
  trailEdgeCount: () => (lfGraphCy ? lfGraphCy.edges('.trail').length : 0),
  mode: () => lfMode,
};
