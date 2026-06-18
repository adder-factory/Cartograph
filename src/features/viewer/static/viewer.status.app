/* ───────── System view ─────────
   Sub-navigation (Overview / Health / Settings) for the merged System
   tab, plus the Overview (status) page sourced from /api/status +
   /api/system. Health + Settings keep their own modules (loaded first);
   this layer toggles the panels and lazy-loads each on first show.
   escapeHtml / formatCompactCount / formatRelative / apiFetch / LIVE_MODE
   are provided by earlier modules. */

let systemSubview = 'overview';

function setSystemSubview(name) {
  systemSubview = name || 'overview';
  for (const btn of document.querySelectorAll('#system-subnav .system-subtab')) {
    btn.classList.toggle('active', btn.dataset.subview === systemSubview);
  }
  for (const panel of document.querySelectorAll('#system-view .system-panel')) {
    panel.hidden = panel.dataset.subview !== systemSubview;
  }
  if (systemSubview === 'overview') loadOverview();
  else if (systemSubview === 'health') {
    if (LIVE_MODE && typeof loadHealthLive === 'function') loadHealthLive();
  } else if (systemSubview === 'settings') {
    if (typeof loadConfigLive === 'function') loadConfigLive();
  }
  if (typeof writeHashState === 'function') writeHashState();
}
globalThis.setSystemSubview = setSystemSubview;
globalThis.viewerSystemSubview = () => systemSubview;
// Set the pending sub-view WITHOUT loading it — clickTab arms this so the
// subsequent tab activation opens it directly (no redundant Overview load).
globalThis.armSystemSubview = (name) => { systemSubview = name || 'overview'; };

/* Invoked by the top-bar tab handler when the System tab is opened. */
function showSystemView() {
  setSystemSubview(systemSubview || 'overview');
}
globalThis.showSystemView = showSystemView;

for (const btn of document.querySelectorAll('#system-subnav .system-subtab')) {
  btn.addEventListener('click', () => setSystemSubview(btn.dataset.subview));
}

/* ── Overview (status) ── */

function ovBytes(n) {
  const bytes = Number(n);
  if (Number.isNaN(bytes) || bytes <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

function ovNum(n) {
  return typeof formatCompactCount === 'function' ? formatCompactCount(n) : String(n ?? '—');
}

function ovTile(value, key, sub) {
  return (
    `<div class="overview-tile"><div class="v">${escapeHtml(String(value))}</div>` +
    `<div class="k">${escapeHtml(key)}</div>` +
    (sub ? `<div class="sub">${escapeHtml(sub)}</div>` : '') +
    '</div>'
  );
}

function setOvHtml(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

async function loadOverview() {
  if (!LIVE_MODE) {
    renderOverviewDemo();
    return;
  }
  try {
    const [statusRes, systemRes] = await Promise.all([apiFetch('/api/status'), apiFetch('/api/system')]);
    const status = statusRes.ok ? await statusRes.json() : null;
    const system = systemRes.ok ? await systemRes.json() : null;
    renderOverview(status, system);
  } catch (err) {
    console.warn('viewer: loadOverview failed', err);
    setOvHtml('ov-readiness', '<div class="overview-empty">Status endpoint unavailable.</div>');
  }
}

function renderOverview(status, system) {
  const tiles = [];
  if (status) {
    tiles.push(ovTile(ovNum(status.files), 'Files'));
    tiles.push(ovTile(ovNum(status.nodes), 'Symbols'));
    tiles.push(ovTile(ovNum(status.edges), 'Edges'));
    tiles.push(ovTile(String((status.languages || []).length), 'Languages'));
  }
  if (system) {
    if (system.dbSizeBytes != null) tiles.push(ovTile(ovBytes(system.dbSizeBytes), 'Database', system.backend || ''));
    if (system.version) tiles.push(ovTile(`v${system.version}`, 'Version'));
  }
  setOvHtml('ov-tiles', tiles.join('') || '<div class="overview-empty">No index stats.</div>');
  renderOvSync(status, system);
  renderOvReadiness(system);
  renderOvLlm(system);
}

function renderOvSync(status, system) {
  const el = document.getElementById('ov-sync');
  if (!el) return;
  const inSync = system ? system.inSync : null;
  const ago =
    status && status.indexedAt && typeof formatRelative === 'function' ? formatRelative(status.indexedAt) : null;
  if (inSync === true) {
    el.hidden = false;
    el.className = 'overview-sync ok';
    el.textContent = ago ? `In sync · ${ago}` : 'In sync';
  } else if (inSync === false) {
    el.hidden = false;
    el.className = 'overview-sync warn';
    el.textContent = 'Index behind HEAD';
  } else {
    el.hidden = true;
  }
}

const OV_READINESS_ROWS = [
  { key: 'summaries', label: 'Summaries' },
  { key: 'embeddings', label: 'Embeddings' },
  { key: 'coverage', label: 'Coverage' },
  { key: 'roles', label: 'Roles' },
  { key: 'directorySummaries', label: 'Dir summaries' },
  { key: 'unresolvedRefs', label: 'Unresolved refs' },
];

function renderOvReadiness(system) {
  const el = document.getElementById('ov-readiness');
  if (!el) return;
  const readiness = system && system.readiness;
  if (!readiness) {
    el.innerHTML = '<div class="overview-empty">Readiness data unavailable.</div>';
    return;
  }
  const rows = [];
  for (const def of OV_READINESS_ROWS) {
    const data = readiness[def.key];
    if (data) rows.push(ovReadinessRow(def, data));
  }
  el.innerHTML = rows.join('') || '<div class="overview-empty">No readiness signals.</div>';
}

function ovReadinessRow(def, d) {
  let pct = null;
  let state = 'full';
  let valText = '';
  let subText = '';
  if (def.key === 'summaries') {
    pct = typeof d.pct === 'number' ? d.pct : null;
    state = d.done === 0 ? 'empty' : d.pending > 0 ? 'partial' : 'full';
    valText = `${ovNum(d.done)} / ${ovNum(d.total)}${pct === null ? '' : ` (${pct}%)`}`;
    const parts = [];
    if (typeof d.weightedPct === 'number') parts.push(`weighted ${d.weightedPct}%`);
    if (d.pending > 0) parts.push(`${ovNum(d.pending)} pending`);
    if (d.breakdown) parts.push(`llm ${ovNum(d.breakdown.llm)} · structural ${ovNum(d.breakdown.structural)}`);
    subText = parts.join(' · ');
  } else if (def.key === 'embeddings') {
    state = d.rows > 0 ? 'full' : 'empty';
    valText = `${ovNum(d.rows)} rows`;
    if (d.reuseCached > 0) subText = `+${ovNum(d.reuseCached)} reuse-cached`;
  } else if (def.key === 'coverage') {
    state = d.symbols > 0 ? 'full' : 'empty';
    valText = `${ovNum(d.symbols)} symbols`;
    if (d.sources && d.sources.length) subText = d.sources.join(', ');
  } else if (def.key === 'roles') {
    state = d.classified > 0 ? 'full' : 'empty';
    valText = `${ovNum(d.classified)} classified`;
  } else if (def.key === 'directorySummaries') {
    state = d.count > 0 ? 'full' : 'empty';
    valText = ovNum(d.count);
  } else if (def.key === 'unresolvedRefs') {
    state = 'info';
    valText = ovNum(d.count);
    subText = 'informational — builtins, external APIs, dynamic dispatch';
  }
  const width = pct === null ? (state === 'empty' ? 0 : 100) : Math.max(2, Math.min(100, pct));
  const bar = `<div class="ov-meter-track"><span class="ov-meter-fill" style="width:${width}%"></span></div>`;
  return (
    '<div class="ov-meter">' +
    `<div class="ov-meter-label"><span class="ov-dot ${state}"></span>${escapeHtml(def.label)}</div>` +
    bar +
    `<div class="ov-meter-val">${escapeHtml(valText)}</div>` +
    (subText ? `<div class="ov-meter-sub">${escapeHtml(subText)}</div>` : '') +
    '</div>'
  );
}

function renderOvLlm(system) {
  const el = document.getElementById('ov-llm');
  if (!el) return;
  if (!system) {
    el.innerHTML = '<div class="overview-empty">LLM status unavailable.</div>';
    setOvAside('ov-llm-aside', '', null);
    return;
  }
  const llm = system.llm;
  if (!llm || !llm.configured) {
    el.innerHTML =
      '<div class="overview-empty">No LLM configured. Run <code class="mono">cartograph llm setup</code> to enable summaries, ask, and semantic search.</div>';
    setOvAside('ov-llm-aside', '', null);
    return;
  }
  const tiers = Array.isArray(llm.tiers) ? llm.tiers : [];
  if (!tiers.length) {
    el.innerHTML = '<div class="overview-empty">No LLM tiers configured.</div>';
    setOvAside('ov-llm-aside', '', null);
    return;
  }
  const anyDown = tiers.some((t) => t.reachable === false);
  setOvAside('ov-llm-aside', anyDown ? 'some backends offline' : 'all reachable', anyDown ? 'err' : 'ok');
  el.innerHTML = tiers.map(ovLlmRow).join('');
}

function setOvAside(id, text, kind) {
  const el = document.getElementById(id);
  if (!el) return;
  if (!text) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.textContent = text;
  el.style.color = kind === 'err' ? 'var(--err)' : kind === 'ok' ? 'var(--ok)' : 'var(--text-faint)';
}

function ovLlmRow(t) {
  const up = t.reachable === true;
  const down = t.reachable === false;
  const stateCls = up ? 'up' : down ? 'down' : '';
  const stateText = up ? 'reachable' : down ? 'offline' : 'unknown';
  const endpoint = t.endpoint ? `<span class="ov-llm-endpoint">${escapeHtml(String(t.endpoint))}</span>` : '';
  return (
    '<div class="ov-llm-row">' +
    `<span class="ov-llm-state ${stateCls}"><span class="dot"></span>${stateText}</span>` +
    `<span class="ov-llm-tier">${escapeHtml(String(t.tier || ''))}</span>` +
    `<span class="ov-llm-model mono">${escapeHtml(String(t.model || '—'))}</span>` +
    endpoint +
    '</div>'
  );
}

function renderOverviewDemo() {
  setOvHtml(
    'ov-tiles',
    ovTile('1.5k', 'Files') + ovTile('27k', 'Symbols') + ovTile('106k', 'Edges') + ovTile('64', 'Languages'),
  );
  const sync = document.getElementById('ov-sync');
  if (sync) {
    sync.hidden = false;
    sync.className = 'overview-sync ok';
    sync.textContent = 'Demo';
  }
  setOvHtml(
    'ov-readiness',
    '<div class="overview-empty">Run <code class="mono">cartograph viewer</code> for live readiness + LLM status.</div>',
  );
  setOvHtml('ov-llm', '<div class="overview-empty">Live mode only.</div>');
}
