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

/** Same project root modulo trailing slashes; a null/empty call
    project means "the session's own project" → same. */
function viewerSameProjectRoot(callProject, viewerRoot) {
  if (!callProject) return true;
  const norm = (p) => String(p || '').replace(/\/+$/, '');
  return norm(callProject) === norm(viewerRoot);
}

function viewerProjectBasename(p) {
  return String(p || '').split('/').filter(Boolean).pop() || String(p || '');
}

/** One timeline row. All fields are escaped here; clock/gap/dur may
    be '' (demo rows have no timestamps). `searchExtra` carries the
    full tool name so both "find" and "cartograph_find" filter-match. */
function traceRowHtml(i, row) {
  const search = `${row.tool} ${row.searchExtra || ''} ${row.args} ${row.result}`.toLowerCase();
  return `
    <div class="trace-row${row.active ? ' active' : ''}" data-i="${i}" data-search="${escapeHtml(search)}">
      <span class="step-num">${escapeHtml(row.step)}</span>
      <span class="t">${escapeHtml(row.clock)}</span>
      <span class="gap${row.longGap ? ' long' : ''}">${escapeHtml(row.gap)}</span>
      <span class="tool" style="--tool-hue:${row.hue}">${escapeHtml(row.tool)}</span>
      <span class="args" title="${escapeHtml(row.args)}">${row.xproj ? `<span class="xproj" title="cross-project call against ${escapeHtml(row.xproj)}">⇄ ${escapeHtml(viewerProjectBasename(row.xproj))}</span>` : ''}${escapeHtml(row.args)}</span>
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

/** Everything in a call's args that addresses a spot on the graph:
    direct symbol refs, path endpoints, multi-symbol lists, name-mode
    search queries, and file/dir scopes (resolved by name on click —
    file nodes are part of the graph too). Deduped, order-preserving,
    capped for the chip row. */
const TRACE_GRAPH_LINK_CAP = 10;

function traceGraphTargets(args) {
  if (!args || typeof args !== 'object') return [];
  const out = [];
  const seen = new Set();
  const push = (value) => {
    if (typeof value !== 'string' || !value || seen.has(value)) return;
    seen.add(value);
    out.push(value);
  };
  push(args.symbol);
  push(args.start);
  push(args.to);
  if (Array.isArray(args.symbols)) for (const s of args.symbols) push(s);
  // A by-name search query IS a symbol name; content/env/sql queries
  // are regexes or keys — not graph spots.
  if (args.by === 'name') push(args.query);
  push(args.file);
  push(args.dir);
  push(args.dirPath);
  push(args.pathFilter);
  return out.slice(0, TRACE_GRAPH_LINK_CAP);
}

/** Step-detail sidebar. `d` = {tool, clock, step, total, durationMs,
    args (object|string|null), result, isErr, sessionId, targets}. */
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
    // Cross-project call — the projectPath tool arg targeted another
    // cartograph project; absent means the session's own project.
    d.project ? ['project', d.project] : null,
    d.result ? ['result', d.result] : null,
  ].filter(Boolean);
  const crossProject = Boolean(d.crossProject);
  traceDetailEl.innerHTML = `
    <div class="trace-detail-head" style="--tool-hue:${traceToolHue(d.tool)}">
      <span class="tool">${escapeHtml(d.tool)}</span>
      ${d.clock ? `<span class="when">${escapeHtml(d.clock)}</span>` : ''}
    </div>
    <div class="trace-detail-kv">
      ${kv.map(([k, v]) => `<span class="k">${escapeHtml(k)}</span><span class="v${k === 'result' && d.isErr ? ' err' : ''}${k === 'project' && crossProject ? ' xproj-v' : ''}" title="${escapeHtml(v)}">${escapeHtml(v)}</span>`).join('')}
    </div>
    ${argsPretty ? `<div class="trace-detail-label">Arguments</div><pre>${escapeHtml(argsPretty)}</pre>` : ''}
    ${Array.isArray(d.targets) && d.targets.length > 0
      ? crossProject
        ? `<div class="trace-detail-label">On the graph</div><div class="trace-detail-links">${d.targets
            .map((t) => `<button class="trace-link" disabled title="Recorded against ${escapeHtml(d.project || 'another project')} — this viewer shows a different project's graph. Open that project's viewer to inspect it.">⇄ ${escapeHtml(t)}</button>`)
            .join('')}</div><div class="trace-detail-xproj-note">These targets live in ${escapeHtml(viewerProjectBasename(d.project))} — not this project's graph.</div>`
        : `<div class="trace-detail-label">On the graph</div><div class="trace-detail-links">${d.targets
            .map((t) => `<button class="trace-link" data-symbol="${escapeHtml(t)}" title="Focus ${escapeHtml(t)} on the graph">⤴ ${escapeHtml(t)}</button>`)
            .join('')}</div>`
      : ''}
  `;
}

/* Graph link chips: jump to the Graph tab focused on the clicked
   target. Demo steps already applied their subgraph dim in
   activateTraceStep; live steps fetch the neighborhood here. */
traceDetailEl?.addEventListener('click', (e) => {
  const btn = e.target instanceof Element ? e.target.closest('.trace-link') : null;
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
    searchExtra: t.tool,
  })).join('');
  traceList.querySelectorAll('.trace-row').forEach(el =>
    el.addEventListener('click', () => activateTraceStep(Number.parseInt(el.dataset.i, 10)))
  );
  traceApplyFilter();
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
    targets: t.focus ? [t.focus] : [],
  });

  // visualise on graph: highlight subgraph, dim everything else. The
  // graph is on another tab now — the dim persists so the graph-link
  // chip lands on the step's neighborhood.
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

/* ───────── Timeline filter ───────── */

const traceFilterInput = document.getElementById('tr-filter');
const traceFilterCount = document.getElementById('tr-filter-count');

function traceFilterQuery() {
  return traceFilterInput?.value.trim().toLowerCase() || '';
}

function traceApplyFilter() {
  const q = traceFilterQuery();
  const rows = [...traceList.querySelectorAll('.trace-row')];
  let shown = 0;
  for (const el of rows) {
    const match = !q || (el.dataset.search || '').includes(q);
    el.hidden = !match;
    if (match) shown++;
  }
  if (traceFilterCount) traceFilterCount.textContent = q ? `${shown}/${rows.length}` : '';
}

traceFilterInput?.addEventListener('input', () => {
  // A running replay walks a captured step order — cancel it before
  // the filter changes which rows are visible.
  stopTraceReplay();
  traceApplyFilter();
});
traceFilterInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.stopPropagation();
    traceFilterInput.value = '';
    traceApplyFilter();
    traceFilterInput.blur();
  }
});

/** Step indices replay should walk: all of them, or — when the
    timeline filter is active — only the visible matches. */
function traceReplayOrder(total) {
  if (!traceFilterQuery()) return Array.from({ length: total }, (_, idx) => idx);
  return [...traceList.querySelectorAll('.trace-row')]
    .filter((el) => !el.hidden)
    .map((el) => Number.parseInt(el.dataset.i, 10))
    .sort((a, b) => a - b);
}

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
  // Pick the call list to step through based on mode; an active
  // timeline filter narrows the walk to the visible steps.
  const calls = LIVE_MODE ? liveTraceCalls : TRACE;
  if (!calls || calls.length === 0) return;
  const order = traceReplayOrder(calls.length);
  if (order.length === 0) return;
  const stepFn = LIVE_MODE ? activateLiveTraceStep : activateTraceStep;
  // Resume from wherever the user paused (or restart after the end);
  // a step function may be async (live mode fetches) — surface its
  // failure and stop rather than piling steps onto a broken state.
  const startStep = LIVE_MODE ? liveTraceActiveStep : activeStep;
  let pos = order.indexOf(startStep);
  // indexOf miss (e.g. the filter changed since the pause) restarts
  // from the head of the filtered set on purpose.
  if (pos < 0 || pos >= order.length - 1) pos = 0;
  document.getElementById('btn-replay').textContent = '⏸ Pause';
  const runStep = (idx) => Promise.resolve(stepFn(idx)).catch((err) => {
    console.warn('viewer: trace replay step failed', err);
    stopTraceReplay();
  });
  void runStep(order[pos]);
  replayTimer = setInterval(() => {
    pos++;
    if (pos >= order.length) {
      stopTraceReplay();
      return;
    }
    void runStep(order[pos]);
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
