/* ───────── Trace timeline ───────── */

const traceList = document.getElementById('trace-list');
function renderTrace() {
  traceList.innerHTML = TRACE.map((t, i) => `
    <div class="trace-row" data-i="${i}">
      <span class="delta">${t.delta}</span>
      <span class="step-num">${t.step}</span>
      <span class="tool">${t.tool}</span>
      <span class="args">${escapeHtml(t.args)}</span>
      <span class="result">${escapeHtml(t.result)}</span>
    </div>
  `).join('');
  traceList.querySelectorAll('.trace-row').forEach(el =>
    el.addEventListener('click', () => activateTraceStep(Number.parseInt(el.dataset.i, 10)))
  );
}
function escapeHtml(s) { return s.replaceAll(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
renderTrace();

let activeStep = -1;

function activateTraceStep(i, fromCy = false) {
  activeStep = i;
  const t = TRACE[i];
  document.querySelectorAll('.trace-row').forEach(el => el.classList.toggle('active', Number.parseInt(el.dataset.i, 10) === i));
  const row = traceList.querySelector(`.trace-row[data-i="${i}"]`);
  if (row && !fromCy) row.scrollIntoView({ block: 'nearest' });

  // visualise on graph: highlight subgraph, dim everything else
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
      `Replay step ${t.step} · <b style="color:var(--text)">${t.tool}</b> · showing ${t.subgraph.length} nodes`;
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
document.getElementById('btn-replay').addEventListener('click', () => {
  // Toggle pause/resume regardless of mode
  if (replayTimer) {
    clearInterval(replayTimer); replayTimer = null;
    document.getElementById('btn-replay').textContent = '▶ Replay';
    return;
  }
  // Pick the call list to step through based on mode
  const calls = LIVE_MODE ? liveTraceCalls : TRACE;
  if (!calls || calls.length === 0) return;
  const stepFn = LIVE_MODE ? activateLiveTraceStep : activateTraceStep;
  let i = 0;
  document.getElementById('btn-replay').textContent = '⏸ Pause';
  stepFn(i);
  replayTimer = setInterval(() => {
    i++;
    if (i >= calls.length) {
      clearInterval(replayTimer); replayTimer = null;
      document.getElementById('btn-replay').textContent = '▶ Replay';
      return;
    }
    stepFn(i);
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
