/* ───────── Agent trace timeline (Agent trace tab) ─────────
   Full-page timeline over recorded MCP sessions. Rows render from
   the live /api/sessions data (viewer.live.app) or the hardcoded
   demo TRACE (viewer.demo-data.app) in file:// mode. This module
   owns the shared row/detail templates, the demo path, replay, and
   export; the live fetch path lives in viewer.live.app. */

const traceList = document.getElementById('trace-list');
const traceDetailEl = document.getElementById('trace-detail');

function escapeHtml(s) { return String(s ?? '').replaceAll(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }

/** Deterministic hue per tool name — shared with the Live feed so a
    tool keeps one color across both views (same hash as lfToolHue;
    duplicated because livefeed loads after this module). */
function traceToolHue(tool) {
  let h = 0;
  const s = String(tool || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 997;
  return (h * 47 + 13) % 360;
}

function traceShortTool(tool) { return String(tool || '').replace(/^cartograph_/, ''); }

function traceFormatMs(ms) {
  const n = Number(ms || 0);
  if (n >= 10000) return `${(n / 1000).toFixed(0)}s`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`;
  return `${Math.round(n)}ms`;
}

/** Gap between consecutive calls → "+1.2s" / "+3m 12s"; long pauses
    (agent thinking / off doing other work) get the .long accent. */
function traceFormatGap(ms) {
  const n = Math.max(0, Number(ms || 0));
  if (n >= 3600000) return `+${Math.floor(n / 3600000)}h ${Math.round((n % 3600000) / 60000)}m`;
  if (n >= 60000) return `+${Math.floor(n / 60000)}m ${Math.round((n % 60000) / 1000)}s`;
  if (n >= 1000) return `+${(n / 1000).toFixed(1)}s`;
  return `+${Math.round(n)}ms`;
}

const TRACE_LONG_GAP_MS = 10000;

/** One timeline row. All fields are PRE-ESCAPED strings except step
    and hue; clock/gap/dur may be '' (demo rows have no timestamps). */
function traceRowHtml(i, row) {
  return `
    <div class="trace-row${row.active ? ' active' : ''}" data-i="${i}">
      <span class="step-num">${escapeHtml(row.step)}</span>
      <span class="t">${escapeHtml(row.clock)}</span>
      <span class="gap${row.longGap ? ' long' : ''}">${escapeHtml(row.gap)}</span>
      <span class="tool" style="--tool-hue:${row.hue}">${escapeHtml(row.tool)}</span>
      <span class="args" title="${escapeHtml(row.args)}">${escapeHtml(row.args)}</span>
      <span class="dur${row.durClass || ''}">${escapeHtml(row.dur)}</span>
      <span class="result${row.isErr ? ' err' : ''}" title="${escapeHtml(row.result)}">${escapeHtml(row.result)}</span>
    </div>
  `;
}

function traceDurClass(durationMs) {
  if (durationMs == null) return '';
  if (durationMs < 100) return ' fast';
  if (durationMs > 1500) return ' slow';
  return '';
}

/** Step-detail sidebar. `d` = {tool, clock, step, total, durationMs,
    args (object|string|null), result, isErr, sessionId, symbol}. */
function renderTraceStepDetail(d) {
  if (!traceDetailEl) return;
  if (!d) {
    traceDetailEl.innerHTML = '<div class="health-empty">Select a step to inspect its full arguments and result.</div>';
    return;
  }
  let argsPretty = '';
  if (d.args != null) {
    try {
      argsPretty = typeof d.args === 'string' ? d.args : JSON.stringify(d.args, null, 2);
    } catch {
      argsPretty = String(d.args);
    }
  }
  const kv = [
    ['step', `${d.step}${d.total ? ` of ${d.total}` : ''}`],
    d.durationMs != null ? ['duration', traceFormatMs(d.durationMs)] : null,
    d.sessionId ? ['session', d.sessionId] : null,
    d.result ? ['result', d.result] : null,
  ].filter(Boolean);
  traceDetailEl.innerHTML = `
    <div class="trace-detail-head" style="--tool-hue:${traceToolHue(d.tool)}">
      <span class="tool">${escapeHtml(d.tool)}</span>
      ${d.clock ? `<span class="when">${escapeHtml(d.clock)}</span>` : ''}
    </div>
    <div class="trace-detail-kv">
      ${kv.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v${k === 'result' && d.isErr ? ' err' : ''}" title="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('')}
    </div>
    ${argsPretty ? `<div class="trace-detail-label">Arguments</div><pre>${escapeHtml(argsPretty)}</pre>` : ''}
    ${d.symbol ? `<button class="btn primary" id="trace-focus-graph" data-symbol="${escapeHtml(d.symbol)}">⤴ View on graph</button>` : ''}
  `;
}

/* "View on graph": jump to the Graph tab focused on the step's
   symbol. Demo steps already applied their subgraph dim in
   activateTraceStep; live steps fetch the neighborhood here. */
traceDetailEl?.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('#trace-focus-graph') : null;
  if (!btn) return;
  const symbol = btn.dataset.symbol;
  document.querySelector('.tab[data-view="graph"]')?.click();
  if (LIVE_MODE && symbol && typeof focusGraphOnSymbol === 'function') void focusGraphOnSymbol(symbol, symbol);
  else if (!LIVE_MODE && typeof selectSymbol === 'function' && symbol) selectSymbol(symbol);
});

/* ───────── file:// demo path ───────── */

function renderTrace() {
  traceList.innerHTML = TRACE.map((t, i) => traceRowHtml(i, {
    step: t.step,
    clock: '',
    gap: t.delta,
    longGap: false,
    hue: traceToolHue(t.tool),
    tool: traceShortTool(t.tool),
    args: t.args,
    dur: '',
    durClass: '',
    result: t.result,
    isErr: false,
    active: i === activeStep,
  })).join('');
  traceList.querySelectorAll('.trace-row').forEach(el =>
    el.addEventListener('click', () => activateTraceStep(Number.parseInt(el.dataset.i, 10)))
  );
  setText('tr-stat-calls', String(TRACE.length));
  setText('tr-stat-time', '—');
  setText('tr-stat-span', '—');
  setText('tr-stat-errors', '0');
}

let activeStep = -1;

function activateTraceStep(i, fromCy = false) {
  activeStep = i;
  const t = TRACE[i];
  document.querySelectorAll('.trace-row').forEach(el => el.classList.toggle('active', Number.parseInt(el.dataset.i, 10) === i));
  const row = traceList.querySelector(`.trace-row[data-i="${i}"]`);
  if (row && !fromCy) row.scrollIntoView({ block: 'nearest' });

  renderTraceStepDetail({
    tool: t.tool,
    clock: '',
    step: t.step,
    total: TRACE.length,
    durationMs: null,
    args: t.args,
    result: t.result,
    isErr: false,
    sessionId: null,
    symbol: t.focus || null,
  });

  // visualise on graph: highlight subgraph, dim everything else. The
  // graph is on another tab now — the dim persists so "View on graph"
  // lands on the step's neighborhood.
  if (t.subgraph) {
    const set = new Set(t.subgraph);
    cy.nodes().forEach(n => n.toggleClass('dim', !set.has(n.id())));
    cy.edges().forEach(e => {
      const both = set.has(e.source().id()) && set.has(e.target().id());
      e.toggleClass('dim', !both);
      e.toggleClass('highlight', both);
    });
    document.getElementById('canvas-banner').classList.add('show');
    document.getElementById('canvas-counter').innerHTML =
      `Replay step ${escapeHtml(t.step)} · <b style="color:var(--text)">${escapeHtml(t.tool)}</b> · showing ${t.subgraph.length} nodes`;
  } else {
    cy.nodes().removeClass('dim');
    cy.edges().removeClass('dim').removeClass('highlight');
    document.getElementById('canvas-banner').classList.remove('show');
    applyFilters();
  }

  if (t.focus && !fromCy) selectSymbol(t.focus);
}

function setBaseCounter(html) { document.getElementById('canvas-counter').innerHTML = html; }

/* clear replay when clicking on the empty graph background */
cy.on('tap', (e) => {
  if (e.target === cy) {
    // A running replay would re-dim the graph 850ms after this clear.
    stopTraceReplay();
    clearEdgeInspection();
    activeStep = -1;
    document.querySelectorAll('.trace-row').forEach(el => el.classList.remove('active'));
    cy.nodes().removeClass('dim');
    cy.edges().removeClass('dim').removeClass('highlight');
    document.getElementById('canvas-banner').classList.remove('show');
    applyFilters();
  }
});

/* ───────── Replay button ───────── */

let replayTimer = null;

function stopTraceReplay() {
  if (!replayTimer) return;
  clearInterval(replayTimer);
  replayTimer = null;
  document.getElementById('btn-replay').textContent = '▶ Replay';
}

document.getElementById('btn-replay').addEventListener('click', () => {
  // Toggle pause/resume regardless of mode
  if (replayTimer) {
    stopTraceReplay();
    return;
  }
  // Pick the call list to step through based on mode
  const calls = LIVE_MODE ? liveTraceCalls : TRACE;
  if (!calls || calls.length === 0) return;
  const stepFn = LIVE_MODE ? activateLiveTraceStep : activateTraceStep;
  // Resume from wherever the user paused (or restart after the end);
  // a step function may be async (live mode fetches) — surface its
  // failure and stop rather than piling steps onto a broken state.
  const startStep = LIVE_MODE ? liveTraceActiveStep : activeStep;
  let i = startStep >= 0 && startStep < calls.length - 1 ? startStep : 0;
  document.getElementById('btn-replay').textContent = '⏸ Pause';
  const runStep = (idx) => Promise.resolve(stepFn(idx)).catch((err) => {
    console.warn('viewer: trace replay step failed', err);
    stopTraceReplay();
  });
  void runStep(i);
  replayTimer = setInterval(() => {
    i++;
    if (i >= calls.length) {
      stopTraceReplay();
      return;
    }
    void runStep(i);
  }, 850);
});

document.getElementById('btn-export').addEventListener('click', () => {
  // Export whatever trace the user is looking at — TRACE in file://
  // mode, the live session's calls in live mode.
  const data = LIVE_MODE ? liveTraceCalls : TRACE;
  if (!data || data.length === 0) return;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'agent-trace.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

if (!LIVE_MODE) renderTrace();
