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
let lfCalls = [];              // {sessionId, ts, durationMs, tool} per call, capped —
                               // the side cards derive from the SELECTED session's slice
let lfLastSessionId = null;    // session separator bookkeeping
let lfSessionPinned = false;   // user explicitly chose a session (stop auto-following)

/* The graph/3D layout modes were removed (user preference: the Live
   tab is the feed). Drop their stale persisted mode key. */
viewerStorageRemove('cartograph-viewer-live-mode-v1');

function lfKey(c) { return `${c.sessionId}:${c.step}`; }

function lfShortTool(tool) {
  return String(tool || '').replace(/^cartograph_/, '');
}

/** Deterministic hue per tool name so colors are stable across runs
    (shared hash with the Agent-trace timeline's traceToolHue). */
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
    if (!lfSessionInfo.has(c.sessionId)) void lfRefreshSessionInfo();
  }
  if (c.sessionId !== lfLastSessionId) {
    lfLastSessionId = c.sessionId;
    const sep = document.createElement('div');
    sep.className = 'lf-session-row';
    sep.dataset.session = c.sessionId ?? '';
    sep.innerHTML = `<span class="lf-session-chip">session ${escapeHtml(c.sessionId ?? '?')}</span><span class="line" aria-hidden="true"></span>`;
    sep.hidden = true;
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
  // Cross-project call: badge it and disarm the symbol-focus click —
  // this viewer shows a different project's graph (helpers live in
  // viewer.trace.app; runtime-only use).
  const xproj = typeof c.project === 'string' && !viewerSameProjectRoot(c.project, liveProjectRoot) ? c.project : '';
  if (xproj) {
    row.dataset.xproj = xproj;
    row.classList.remove('has-symbol');
    row.title = `Cross-project call against ${xproj} — open that project's viewer to inspect it`;
  }
  row.innerHTML =
    `<span class="lf-time">${new Date(c.ts).toTimeString().slice(0, 8)}</span>` +
    `<span class="lf-tool" style="--tool-hue:${lfToolHue(c.tool)}">${escapeHtml(lfShortTool(c.tool))}</span>` +
    `<span class="lf-args" title="${escapeHtml(argsText)}">${xproj ? `<span class="xproj" title="cross-project call against ${escapeHtml(xproj)}">⇄ ${escapeHtml(viewerProjectBasename(xproj))}</span>` : ''}${escapeHtml(argsText)}</span>` +
    `<span class="lf-dur${durClass}">${lfFormatMs(c.durationMs)}</span>` +
    `<span class="lf-res${isErr ? ' err' : ''}" title="${escapeHtml(result)}">${escapeHtml(result)}</span>`;
  row.dataset.search = `${lfShortTool(c.tool)} ${c.tool} ${argsText} ${result}`.toLowerCase();
  row.dataset.session = c.sessionId ?? '';
  if (!lfRowPassesFilters(row)) row.hidden = true;
  lfFeedEl.appendChild(row);
  lfRowCount++;
  lfEnforceRowCap();

  lfCalls.push({ sessionId: c.sessionId ?? '', ts: c.ts, durationMs: Number(c.durationMs) || 0, tool: c.tool });
  if (lfCalls.length > LF_MAX_ROWS) lfCalls.shift();
  if (lfEmptyEl) lfEmptyEl.hidden = true;
  return true;
}

/** The selected session's slice of the call log — every side card
    and stat describes exactly that session. */
function lfSelectedCalls() {
  const session = lfSessionFilterValue();
  return session ? lfCalls.filter((c) => c.sessionId === session) : [];
}

function lfAfterAppend() {
  lfRenderStats();
  lfRenderSession();
  lfRenderToolmix();
  if (lfFilterQuery()) lfUpdateFilterCount();
  if (lfFollow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
}

/* ── side cards + stats ── */

function lfRenderStats() {
  const calls = lfSelectedCalls();
  const now = Date.now();
  const recent = calls.filter((c) => now - c.ts < LF_RATE_WINDOW_MS);
  const durations = calls.slice(-LF_AVG_WINDOW).map((c) => c.durationMs);
  setText('lf-stat-calls', formatNumber(calls.length));
  setText('lf-stat-rate', formatNumber(recent.length));
  const avg = durations.length > 0 ? durations.reduce((a, b) => a + b, 0) / durations.length : null;
  setText('lf-stat-avg', avg == null ? '—' : lfFormatMs(avg));
}

function lfRenderSession() {
  const el = document.getElementById('lf-session');
  if (!el) return;
  const session = lfSessionFilterValue();
  const calls = lfSelectedCalls();
  if (!session) {
    el.textContent = 'No session yet.';
    return;
  }
  const info = lfSessionInfo.get(session);
  const who = info?.clientName
    ? `${info.clientName}${info.clientVersion ? ` ${info.clientVersion}` : ''}`
    : null;
  const projectName = info?.projectRoot ? info.projectRoot.split('/').filter(Boolean).pop() : null;
  const lastTs = calls.length > 0 ? calls[calls.length - 1].ts : null;
  el.innerHTML =
    `<span class="id">${escapeHtml(session)}</span><br>` +
    `${who ? `${escapeHtml(who)}${info?.label ? ` · ${escapeHtml(info.label)}` : ''}<br>` : info?.label ? `${escapeHtml(info.label)}<br>` : ''}` +
    `${projectName ? `project ${escapeHtml(projectName)}<br>` : ''}` +
    `${formatNumber(calls.length)} ${calls.length === 1 ? 'call' : 'calls'} in this feed<br>` +
    `${lastTs != null ? `last activity ${escapeHtml(formatRelative(lastTs))}` : 'no calls in the visible window'}`;
}

function lfRenderToolmix() {
  const el = document.getElementById('lf-toolmix');
  if (!el) return;
  const counts = new Map();
  for (const c of lfSelectedCalls()) counts.set(c.tool, (counts.get(c.tool) || 0) + 1);
  if (counts.size === 0) {
    el.innerHTML = '<div class="health-empty">No calls observed yet.</div>';
    return;
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
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
  if (!LIVE_MODE) {
    lfSetConn('idle', 'file:// mode — start `cartograph viewer` for the live feed');
    if (lfEmptyEl) lfEmptyEl.hidden = false;
    return;
  }
  if (!lfAbort && !lfRetryTimer) void lfRunStream();
  void lfRefreshSessionInfo();
  if (!lfStatsTimer) {
    lfStatsTimer = setInterval(() => {
      if (lfActive && lfCalls.length > 0) lfRenderStats();
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
  lfCalls = [];
  lfLastSessionId = null;
  lfSessionPinned = false;
  lfRenderStats();
  lfRenderSession();
  lfRenderToolmix();
  lfSessionsSeen.clear();
  lfSyncSessionOptions();
  lfUpdateFilterCount();
  if (lfEmptyEl) lfEmptyEl.hidden = false;
});

/* ───────── Feed filters (text + session) ───────── */

const lfFilterInput = document.getElementById('lf-filter');
const lfFilterCount = document.getElementById('lf-filter-count');

function lfFilterQuery() {
  return lfFilterInput?.value.trim().toLowerCase() || '';
}

const lfSessionFilterEl = document.getElementById('lf-session-filter');
const lfSessionsSeen = new Map(); // sessionId → first-seen ts
const lfSessionInfo = new Map(); // sessionId → {label, clientName, clientVersion, projectRoot, startedTs}

/** Pull session identity (client, label, project) from /api/sessions
    so the dropdown and the active-session card can show something a
    human recognises instead of opaque ids. Best-effort. */
async function lfRefreshSessionInfo() {
  if (!LIVE_MODE) return;
  try {
    const res = await apiFetch('/api/sessions?limit=50');
    if (!res.ok) return;
    const body = await res.json();
    for (const s of body.sessions ?? []) lfSessionInfo.set(s.id, s);
    lfSyncSessionOptions();
    lfRenderSession();
  } catch {
    /* dropdown falls back to raw ids */
  }
}

function lfSessionDisplayName(id) {
  const info = lfSessionInfo.get(id);
  return info?.label || info?.clientName || id;
}

function lfSessionFilterValue() {
  return lfSessionFilterEl?.value || '';
}

/** Rebuild the session dropdown — the feed always shows EXACTLY ONE
    session (no "All sessions" mixing). Newest first; the newest is
    auto-selected and the selection FOLLOWS new sessions until the
    user explicitly picks one. */
function lfSyncSessionOptions() {
  if (!lfSessionFilterEl) return;
  const previous = lfSessionFilterEl.value;
  const ids = [...lfSessionsSeen.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  lfSessionFilterEl.innerHTML = ids
    .map((id) => {
      const name = lfSessionDisplayName(id);
      const text = name === id ? id : `${name} · ${id}`;
      return `<option value="${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(text)}</option>`;
    })
    .join('');
  const keepPinned = lfSessionPinned && previous && ids.includes(previous);
  lfSessionFilterEl.value = keepPinned ? previous : (ids[0] ?? '');
  if (lfSessionFilterEl.value !== previous) {
    lfApplyFilter();
    lfRenderStats();
    lfRenderSession();
    lfRenderToolmix();
  }
}

function lfRowPassesFilters(el) {
  const q = lfFilterQuery();
  if (q && !(el.dataset.search || '').includes(q)) return false;
  // Exactly one session is ever shown; before any session exists the
  // dropdown is empty and so is the feed.
  return el.dataset.session === lfSessionFilterValue();
}

function lfUpdateFilterCount() {
  if (!lfFilterCount) return;
  // Session narrowing is the norm now — only a text query warrants
  // the shown/total readout.
  if (!lfFilterQuery()) {
    lfFilterCount.textContent = '';
    return;
  }
  const rows = lfFeedEl.querySelectorAll('.lf-row');
  let shown = 0;
  for (const el of rows) if (!el.hidden) shown++;
  lfFilterCount.textContent = `${shown}/${rows.length}`;
}

function lfApplyFilter() {
  let visible = 0;
  for (const el of lfFeedEl.querySelectorAll('.lf-row')) {
    el.hidden = !lfRowPassesFilters(el);
    if (!el.hidden) visible++;
  }
  // The feed shows one session at a time — separator chips marked
  // boundaries in the old mixed stream and stay hidden.
  for (const el of lfFeedEl.querySelectorAll('.lf-session-row')) el.hidden = true;
  // A pinned session whose rows were all evicted by the row cap (or
  // hidden by a text filter) must not look like a dead pane.
  if (lfEmptyEl && lfRowCount > 0) lfEmptyEl.hidden = visible > 0;
  lfUpdateFilterCount();
  if (lfFollow && lfFeedEl) lfFeedEl.scrollTop = lfFeedEl.scrollHeight;
}

lfFilterInput?.addEventListener('input', lfApplyFilter);
lfFilterInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    lfFilterInput.value = '';
    lfApplyFilter();
    lfFilterInput.blur();
  }
});

lfSessionFilterEl?.addEventListener('change', () => {
  lfSessionPinned = true;
  lfApplyFilter();
  lfRenderStats();
  lfRenderSession();
  lfRenderToolmix();
});
