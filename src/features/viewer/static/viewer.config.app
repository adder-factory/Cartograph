/* ───────── Config editor ─────────
   Edit the curated subset of .cartograph/config.json and re-index from
   the viewer. Mirrors viewer.health.app's pure-DOM pattern. The server
   whitelists + validates every write; this layer is convenience only.
   In file:// mode a small demo state keeps the page legible. */

/* escapeHtml is provided by viewer.health.app (loaded first) — guard in
   case load order ever changes. */
if (typeof escapeHtml !== 'function') {
  globalThis.escapeHtml = (s) =>
    String(s ?? '').replaceAll(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

const CFG_BYTES_PER_MB = 1024 * 1024;

let cfgState = null;
let cfgReindexing = false;
let cfgShownMaxSize = '';

function cfgEl(id) {
  return document.getElementById(id);
}

function cfgSecs(ms) {
  return (Number(ms || 0) / 1000).toFixed(1);
}

function cfgSetBanner(kind, html) {
  const banner = cfgEl('cfg-banner');
  if (!banner) return;
  if (!html) {
    banner.hidden = true;
    banner.innerHTML = '';
    return;
  }
  banner.hidden = false;
  banner.className = `config-banner ${kind}`;
  banner.innerHTML = html;
}

/* ── read-only database panel ── */

function cfgRenderDatabase(db) {
  const el = cfgEl('cfg-database');
  if (!el) return;
  const rows = [];
  const add = (key, value) => {
    if (value === undefined || value === null || value === '') return;
    rows.push(`<div class="config-db-row"><span class="k">${escapeHtml(key)}</span><span class="v mono">${escapeHtml(String(value))}</span></div>`);
  };
  if (!db || !db.provider) {
    add('provider', 'sqlite (default)');
  } else {
    add('provider', db.provider);
    add('url', db.url);
    add('schema', db.schema);
    add('pgvector', db.pgvector);
  }
  el.innerHTML = rows.join('');
}

/* ── form <-> state ── */

function cfgPopulateForm(state) {
  const c = state.config || {};
  cfgEl('cfg-include').value = (c.include || []).join('\n');
  cfgEl('cfg-exclude').value = (c.exclude || []).join('\n');

  const mb = Number(c.maxFileSize || 0) / CFG_BYTES_PER_MB;
  cfgShownMaxSize = mb ? String(Number(mb.toFixed(3))) : '';
  const sizeInput = cfgEl('cfg-maxfilesize');
  sizeInput.value = cfgShownMaxSize;
  const capMb = Math.max(1, Math.round((state.maxFileSizeCap || 0) / CFG_BYTES_PER_MB));
  sizeInput.max = String(capMb);
  setText('cfg-maxsize-hint', `max ${state.maxFileSizeCapLabel || `${capMb}mb`}`);

  cfgEl('cfg-enableBiomarkers').checked = c.enableBiomarkers !== false;
  cfgEl('cfg-enableCoChange').checked = c.enableCoChange !== false;
  cfgRenderDatabase(state.database);
}

function cfgFormToBody() {
  const lines = (id) =>
    cfgEl(id)
      .value.split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

  const body = {
    include: lines('cfg-include'),
    exclude: lines('cfg-exclude'),
    enableBiomarkers: cfgEl('cfg-enableBiomarkers').checked,
    enableCoChange: cfgEl('cfg-enableCoChange').checked,
  };

  // Reuse the original byte value when the field was not edited, so a
  // lossy MB round-trip can't register as a spurious change.
  const shown = cfgEl('cfg-maxfilesize').value.trim();
  if (shown === cfgShownMaxSize) {
    if (cfgState?.config && typeof cfgState.config.maxFileSize === 'number') {
      body.maxFileSize = cfgState.config.maxFileSize;
    }
  } else {
    const mb = parseFloat(shown);
    if (Number.isFinite(mb)) body.maxFileSize = Math.round(mb * CFG_BYTES_PER_MB);
  }
  return body;
}

function cfgApplyEditable(allow) {
  cfgEl('config-view')?.classList.toggle('readonly', !allow);
  cfgEl('cfg-readonly-badge').hidden = allow;
  for (const node of document.querySelectorAll('#cfg-form textarea, #cfg-form input')) {
    node.disabled = !allow;
  }
  cfgEl('cfg-actions').hidden = !allow;
  if (!allow) {
    cfgSetBanner(
      'info',
      'Config editing is disabled because the viewer is not bound to localhost. ' +
        'Launch with <code class="mono">--allow-config-edit</code> to enable it.',
    );
  }
}

/* ── load ── */

async function cfgLoad() {
  try {
    const res = await apiFetch('/api/config');
    if (!res.ok) {
      cfgSetBanner('err', `Could not load config: HTTP ${res.status}`);
      return;
    }
    const state = await res.json();
    cfgState = state;
    cfgPopulateForm(state);
    cfgApplyEditable(!!state.allowConfigEdit);
    cfgReindexing = !!state.reindexing;
    if (state.allowConfigEdit && cfgReindexing) {
      cfgSetBanner('info', 'A re-index is currently running — open the Health tab to watch fresh stats land.');
    }
    cfgEl('config-view')?.setAttribute('data-loaded', '1');
  } catch (err) {
    console.warn('viewer: cfgLoad failed', err);
    cfgSetBanner('err', 'Config endpoint unavailable.');
  }
}

/* The entry point invoked from viewer.app's tab handler. */
function loadConfigLive() {
  if (!LIVE_MODE) {
    cfgRenderDemo();
    return;
  }
  cfgLoad();
}

/* ── save ── */

async function cfgSave() {
  if (!cfgState?.allowConfigEdit) return;
  const btn = cfgEl('cfg-save');
  btn.disabled = true;
  cfgSetBanner('info', 'Saving…');
  cfgEl('cfg-apply').hidden = true;
  try {
    const res = await apiFetch('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfgFormToBody()),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      cfgSetBanner('err', `Save failed: ${escapeHtml(data.error || `HTTP ${res.status}`)}`);
      return;
    }
    await cfgLoad(); // re-read so the form reflects any server normalization
    cfgShowApply(data.applyClass);
  } catch (err) {
    cfgSetBanner('err', `Save failed: ${escapeHtml(err?.message || String(err))}`);
  } finally {
    btn.disabled = false;
  }
}

function cfgShowApply(applyClass) {
  const apply = cfgEl('cfg-apply');
  if (!apply) return;
  apply.hidden = true;
  apply.innerHTML = '';
  if (applyClass === 'reindex') {
    // A full re-index (clearStructural) is the only reliably-correct apply
    // for a config change: an incremental sync does not clear structural /
    // derived tables, so disabling a hook or tightening `exclude` would
    // leave stale findings/nodes behind. So offer only the full re-index.
    cfgSetBanner('ok', '✓ Saved. Re-index for the change to take effect.');
    apply.hidden = false;
    apply.innerHTML =
      '<button type="button" class="config-btn primary" id="cfg-reindex-full">Re-index now</button>';
    cfgEl('cfg-reindex-full').addEventListener('click', () => cfgRunReindex('index'));
  } else if (applyClass === 'restart') {
    cfgSetBanner('warn', '✓ Saved. Database settings changed — restart the viewer to apply them.');
  } else if (applyClass === 'hot') {
    cfgSetBanner('ok', '✓ Saved and applied — no re-index needed.');
  } else {
    cfgSetBanner('ok', '✓ Saved. No changes to apply.');
  }
}

/* ── re-index (SSE progress) ── */

async function cfgRunReindex(mode) {
  if (cfgReindexing) return;
  cfgReindexing = true;
  cfgSetApplyButtonsDisabled(true);
  cfgSetProgress(0, 0, mode === 'index' ? 'Starting full re-index…' : 'Starting sync…', '');
  cfgEl('cfg-progress').hidden = false;
  try {
    const res = await apiFetch('/api/reindex', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok || !res.body) {
      const data = await res.json().catch(() => ({}));
      cfgEl('cfg-progress').hidden = true;
      const note = res.status === 409 ? 'A re-index is already running.' : data.error || `HTTP ${res.status}`;
      cfgSetBanner('warn', escapeHtml(note));
      return;
    }
    await cfgConsumeStream(res.body, mode);
  } catch (err) {
    cfgEl('cfg-progress').hidden = true;
    cfgSetBanner('err', `Re-index failed: ${escapeHtml(err?.message || String(err))}`);
  } finally {
    cfgReindexing = false;
    cfgSetApplyButtonsDisabled(false);
  }
}

function cfgSetApplyButtonsDisabled(disabled) {
  for (const btn of document.querySelectorAll('#cfg-apply button')) btn.disabled = disabled;
}

async function cfgConsumeStream(body, mode) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx = buf.indexOf('\n\n');
    while (idx >= 0) {
      cfgHandleFrame(buf.slice(0, idx), mode);
      buf = buf.slice(idx + 2);
      idx = buf.indexOf('\n\n');
    }
  }
}

function cfgHandleFrame(raw, mode) {
  let event = 'message';
  const dataLines = [];
  for (const line of raw.split('\n')) {
    if (line.startsWith(':')) continue; // heartbeat / comment
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (dataLines.length === 0) return;
  let data;
  try {
    data = JSON.parse(dataLines.join('\n'));
  } catch {
    return;
  }
  if (event === 'progress') {
    cfgSetProgress(data.current, data.total, cfgPhaseLabel(data.phase), data.currentFile || '');
  } else if (event === 'done') {
    cfgSetProgress(1, 1, 'Done', '');
    cfgSetBanner('ok', cfgDoneSummary(data, mode));
    cfgEl('cfg-apply').hidden = true;
    cfgLoad();
    if (LIVE_MODE) {
      // The reindex changed the underlying graph, so the Health view, the
      // rendered graph, and the top-bar counts are all stale. Refresh them
      // in place — reloadGraphForDensity re-fetches /api/graph while
      // preserving the current focus and filters.
      if (typeof loadHealthLive === 'function') loadHealthLive();
      if (typeof reloadGraphForDensity === 'function') void reloadGraphForDensity();
      void cfgRefreshTopbarStats();
    }
  } else if (event === 'busy') {
    cfgEl('cfg-progress').hidden = true;
    cfgSetBanner('warn', escapeHtml(data.message || 'Another indexer is running.'));
  } else if (event === 'error') {
    cfgEl('cfg-progress').hidden = true;
    cfgSetBanner('err', `Re-index error: ${escapeHtml(data.message || 'unknown error')}`);
  }
}

function cfgPhaseLabel(phase) {
  return (
    {
      scanning: 'Scanning files…',
      parsing: 'Parsing…',
      storing: 'Storing symbols…',
      resolving: 'Resolving references…',
    }[phase] || 'Indexing…'
  );
}

function cfgSetProgress(current, total, label, file) {
  setText('cfg-progress-phase', label);
  const cur = Number(current || 0);
  const tot = Number(total || 0);
  setText('cfg-progress-count', tot > 0 ? `${cur.toLocaleString()} / ${tot.toLocaleString()}` : '');
  const pct = tot > 0 ? Math.max(0, Math.min(100, (cur / tot) * 100)) : cur > 0 ? 100 : 6;
  const fill = cfgEl('cfg-progress-fill');
  if (fill) fill.style.width = `${pct}%`;
  setText('cfg-progress-file', file || '');
}

/** Refresh the top-bar files/nodes/edges counts after a reindex. (The
    project identity in the bar doesn't change, so only the counts.) */
async function cfgRefreshTopbarStats() {
  try {
    const r = await apiFetch('/api/status');
    if (!r.ok) return;
    const s = await r.json();
    const statsEl = document.querySelector('.topbar .stats');
    if (statsEl && typeof formatCompactCount === 'function') {
      statsEl.innerHTML =
        `<span class="stat"><b>${formatCompactCount(s.files)}</b> files</span>` +
        `<span class="stat"><b>${formatCompactCount(s.nodes)}</b> nodes</span>` +
        `<span class="stat"><b>${formatCompactCount(s.edges)}</b> edges</span>`;
    }
  } catch (err) {
    console.debug('viewer: cfgRefreshTopbarStats failed', err);
  }
}

function cfgDoneSummary(d, mode) {
  if (mode === 'sync') {
    const changed = Number(d.filesAdded || 0) + Number(d.filesModified || 0);
    return `✓ Sync complete — ${formatNumber(changed)} changed, ${formatNumber(d.filesRemoved)} removed in ${cfgSecs(d.durationMs)}s.`;
  }
  return (
    `✓ Re-index complete — ${formatNumber(d.filesIndexed)} files, ` +
    `${formatNumber(d.nodesCreated)} symbols, ${formatNumber(d.edgesCreated)} edges in ${cfgSecs(d.durationMs)}s.`
  );
}

/* ── file:// demo ── */

function cfgRenderDemo() {
  const demo = {
    allowConfigEdit: true,
    reindexing: false,
    config: {
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.min.js'],
      maxFileSize: 5 * CFG_BYTES_PER_MB,
      enableBiomarkers: true,
      enableCoChange: true,
    },
    database: { provider: 'sqlite' },
    maxFileSizeCap: 10 * CFG_BYTES_PER_MB,
    maxFileSizeCapLabel: '10mb',
  };
  cfgState = demo;
  cfgPopulateForm(demo);
  cfgApplyEditable(true);
  cfgSetBanner('info', 'Demo view (file://). Run <code class="mono">cartograph viewer</code> for live config editing.');
  cfgEl('config-view')?.setAttribute('data-loaded', '1');
}

/* ── wiring (DOM exists — scripts load at end of <body>) ── */

cfgEl('cfg-save')?.addEventListener('click', cfgSave);
cfgEl('cfg-reset')?.addEventListener('click', () => {
  if (!cfgState) return;
  cfgPopulateForm(cfgState);
  cfgEl('cfg-apply').hidden = true;
  cfgSetBanner('', '');
});
