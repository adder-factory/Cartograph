/* ───────── Health dashboard ─────────
   Renders the Health tab from /api/status + /api/findings +
   /api/hotspots. Pure DOM painting — no graph coupling. In file://
   mode a small demo payload keeps the layout legible. */

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString();
}

function formatMetric(value, digits = 4) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n.toFixed(digits) : '0.0000';
}

function biomarkerLabel(name) {
  return String(name || 'unknown').replaceAll('_', ' ');
}

function percentage(part, total) {
  if (!total) return 0;
  return Math.max(0, Math.min(100, (Number(part || 0) / total) * 100));
}

function healthGrade(score) {
  if (score >= 8) return 'ok';
  if (score >= 6) return 'warn';
  return 'err';
}

function healthGradeLabel(score) {
  if (score >= 9.5) return 'Excellent';
  if (score >= 8) return 'Healthy';
  if (score >= 6) return 'Fair';
  return 'Needs attention';
}

function setHealthScoreGrade(grade) {
  const score = document.querySelector('.health-score');
  if (score) score.dataset.healthGrade = grade;
  document.getElementById('health-view')?.setAttribute('data-health-grade', grade);
}

/* ── hero: gauge ── */

function renderHealthGauge(codeHealth, sub) {
  const grade = healthGrade(codeHealth);
  setHealthScoreGrade(grade);
  setText('hc-health', codeHealth.toFixed(1));
  setText('hc-grade', healthGradeLabel(codeHealth));
  setText('hc-health-sub', sub);
  const fill = document.getElementById('hc-gauge-fill');
  if (fill) {
    // pathLength=100 → dasharray "<score×10> 100" sweeps the arc.
    const sweep = Math.max(0, Math.min(100, codeHealth * 10));
    // Set on a later frame so the CSS transition animates from 0.
    requestAnimationFrame(() => { fill.style.strokeDasharray = `${sweep} 100`; });
  }
}

/* ── hero: findings card ── */

const SEVERITIES = [
  { key: 'error', label: 'errors', className: 'err' },
  { key: 'warning', label: 'warnings', className: 'warn' },
  { key: 'info', label: 'info', className: 'info' },
];

function renderHealthFindings(findings) {
  const f = findings || {};
  const counts = f.bySeverity || {};
  const total = Number(f.totalFindings || 0);
  const clean = total === 0;
  const types = Object.keys(f.byBiomarker || {}).filter((k) => Number(f.byBiomarker[k]) > 0).length;

  setText('hc-total', formatNumber(total));
  setText('hc-total-unit', total === 1 ? 'open finding' : 'open findings');
  setText('hc-findings-aside', clean ? 'nothing flagged' : `across ${types} biomarker ${types === 1 ? 'rule' : 'rules'}`);
  document.getElementById('hc-findings-total')?.classList.toggle('clean', clean);

  const stack = document.getElementById('hc-severity-stack');
  if (stack) {
    stack.classList.toggle('clean', clean);
    SEVERITIES.forEach((item) => {
      const segment = stack.querySelector(`.${item.className}`);
      if (segment) segment.style.width = clean ? '0%' : `${percentage(counts[item.key], total)}%`;
    });
  }

  const chips = document.getElementById('hc-severity-chips');
  if (chips) {
    chips.innerHTML = SEVERITIES.map((item) => {
      const value = Number(counts[item.key] || 0);
      return `<span class="health-severity-chip ${item.className}${value === 0 ? ' zero' : ''}">` +
        `<span class="dot" aria-hidden="true"></span>${item.label}` +
        `<span class="count">${formatNumber(value)}</span></span>`;
    }).join('');
  }

  const note = document.getElementById('hc-flagged-note');
  if (note) {
    const flagged = Number(f.nodesWithFindings || 0);
    const totalNodes = Number(f.totalNodes || 0);
    note.innerHTML = clean
      ? `<b>0</b> flagged symbols — clean bill of health across ${formatNumber(totalNodes)} indexed symbols.`
      : `<b>${formatNumber(flagged)}</b> flagged symbols · ${percentage(flagged, totalNodes).toFixed(1)}% of ${formatNumber(totalNodes)} indexed`;
  }
}

/* ── hero: index card ── */

function renderHealthIndex(status) {
  const readiness = status?.readiness || {
    grade: 'warn',
    label: 'Unknown',
    summary: 'Status endpoint did not return readiness details.',
    nextSteps: ['cartograph doctor .'],
  };
  const readinessEl = document.getElementById('hc-readiness');
  if (readinessEl) {
    readinessEl.textContent = readiness.label || 'Unknown';
    readinessEl.classList.remove('ok', 'warn', 'err');
    readinessEl.classList.add(readiness.grade || 'warn');
  }

  setText('hc-total-files', status ? formatNumber(status.files) : '—');
  setText('hc-total-nodes', status ? formatNumber(status.nodes) : '—');
  setText('hc-total-edges', status ? formatNumber(status.edges) : '—');
  const langs = Array.isArray(status?.languages) ? status.languages : [];
  const langsEl = document.getElementById('hc-languages');
  if (langsEl) {
    langsEl.textContent = status ? formatNumber(langs.length) : '—';
    langsEl.title = langs.join(', ');
  }

  const next = document.getElementById('hc-readiness-next');
  if (next) {
    const step = Array.isArray(readiness.nextSteps) && readiness.nextSteps.length > 0 ? readiness.nextSteps[0] : '';
    const showStep = readiness.grade !== 'ok' && step;
    next.hidden = !showStep;
    if (showStep) next.textContent = step;
  }

  const metaBits = [
    status?.indexedAt ? `Indexed ${formatRelative(status.indexedAt)}` : null,
    status?.head ? `HEAD ${String(status.head).slice(0, 7)}` : null,
    langs.length > 0 ? langs.slice(0, 3).join(', ') + (langs.length > 3 ? ` +${langs.length - 3} more` : '') : null,
  ].filter(Boolean);
  setText('hc-index-meta', metaBits.join(' · ') || (status ? '' : 'Status endpoint unavailable.'));
}

/* ── lower panels ── */

function miniSeverityStack(split, total) {
  if (!split || !total) return '';
  const parts = SEVERITIES.map((item) => {
    const v = Number(split[item.key === 'error' ? 'error' : item.key] || 0);
    return `<span class="${item.className}" style="width:${percentage(v, total)}%"></span>`;
  }).join('');
  return `<div class="health-mini-stack" aria-hidden="true">${parts}</div>`;
}

function severitySplitMeta(split) {
  if (!split) return '';
  const bits = [];
  if (split.error) bits.push(`${formatNumber(split.error)} err`);
  if (split.warning) bits.push(`${formatNumber(split.warning)} warn`);
  if (split.info) bits.push(`${formatNumber(split.info)} info`);
  return bits.join(' · ');
}

function renderHealthBiomarkers(findings) {
  const list = document.getElementById('hc-biomarkers');
  if (!list) return;
  const counts = findings?.byBiomarker || {};
  const splits = findings?.byBiomarkerSeverity || {};
  const rows = Object.entries(counts)
    .filter(([, count]) => Number(count) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a));
  setText('hc-biomarkers-aside', rows.length > 0 ? `${rows.length} active ${rows.length === 1 ? 'rule' : 'rules'}` : '');
  if (rows.length === 0) {
    list.innerHTML = '<div class="health-empty"><span class="ok-mark">✓</span> No biomarker findings in this index.<br>' +
      'Every rule that ran came back clean.</div>';
    return;
  }
  list.innerHTML = rows.slice(0, 12).map(([name, count]) => {
    const split = splits[name];
    return `
    <div class="health-row">
      <div>
        <div class="name">${escapeHtml(biomarkerLabel(name))}</div>
        ${miniSeverityStack(split, Number(count))}
        <div class="meta">${escapeHtml(severitySplitMeta(split))}</div>
      </div>
      <div class="value">${formatNumber(count)}</div>
    </div>
  `;
  }).join('');
}

function hotspotNameHtml(filePath) {
  const path = String(filePath || 'unknown file');
  const slash = path.lastIndexOf('/');
  if (slash < 0) return `<b>${escapeHtml(path)}</b>`;
  return `<span class="dir">${escapeHtml(path.slice(0, slash + 1))}</span><b>${escapeHtml(path.slice(slash + 1))}</b>`;
}

function renderHealthHotspots(hotspots) {
  const list = document.getElementById('hc-hotspots-list');
  if (!list) return;
  const rows = hotspots || [];
  setText('hc-hotspots-aside', rows.length > 0 ? 'churn × centrality' : '');
  if (rows.length === 0) {
    list.innerHTML = '<div class="health-empty">No hotspots from churn and centrality data yet.</div>';
    return;
  }
  const maxRisk = Math.max(...rows.map((row) => Number(row.risk || 0)), 0.0001);
  list.innerHTML = rows.slice(0, 20).map((row, i) => `
    <div class="health-row hotspot">
      <div>
        <div class="name" title="${escapeHtml(row.filePath || '')}"><span class="rank">${String(i + 1).padStart(2, '0')}</span>${hotspotNameHtml(row.filePath)}</div>
        <div class="meta">${formatNumber(row.commits)} commits · ${formatNumber(row.loc)} LOC · touched ${escapeHtml(formatRelative(row.lastTouchedTs))}</div>
      </div>
      <div class="health-row-end">
        <span class="health-risk-bar" aria-hidden="true"><span style="width:${percentage(row.risk, maxRisk)}%"></span></span>
        <span class="value">${formatMetric(row.risk, 3)}</span>
      </div>
    </div>
  `).join('');
}

function renderHealthKinds(status) {
  const list = document.getElementById('hc-kinds');
  if (!list) return;
  const byKind = status?.nodesByKind || {};
  const rows = Object.entries(byKind)
    .filter(([, count]) => Number(count) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a));
  setText('hc-kinds-aside', status ? `${formatNumber(status.nodes)} symbols` : '');
  if (rows.length === 0) {
    list.innerHTML = '<div class="health-empty">No symbols indexed yet.</div>';
    return;
  }
  const max = Number(rows[0][1]) || 1;
  list.innerHTML = rows.slice(0, 10).map(([kind, count]) => `
    <div class="health-row">
      <div><div class="name">${escapeHtml(biomarkerLabel(kind))}</div></div>
      <div class="health-row-end">
        <span class="health-kind-bar" aria-hidden="true"><span style="width:${percentage(count, max)}%"></span></span>
        <span class="value">${formatNumber(count)}</span>
      </div>
    </div>
  `).join('');
}

/* ── orchestration ── */

function renderHealthDashboard(findings, hotspotsPayload, statusPayload = null) {
  const f = findings || {};
  const codeHealth = Number(f.codeHealth ?? 0);
  const totalFindings = Number(f.totalFindings || 0);
  const nodesWithFindings = Number(f.nodesWithFindings || 0);
  const totalNodes = Number(f.totalNodes || 0);
  renderHealthGauge(codeHealth, totalFindings > 0
    ? `${formatNumber(nodesWithFindings)} flagged symbols out of ${formatNumber(totalNodes)} indexed`
    : `${formatNumber(totalNodes)} indexed symbols with no biomarker findings`);
  renderHealthFindings(f);
  renderHealthIndex(statusPayload);
  renderHealthBiomarkers(f);
  renderHealthHotspots(hotspotsPayload?.hotspots || []);
  renderHealthKinds(statusPayload);
  document.getElementById('health-view')?.setAttribute('data-loaded', '1');
}

function renderHealthUnavailable(message, statusPayload = null) {
  setHealthScoreGrade('err');
  setText('hc-health', '—');
  setText('hc-grade', 'Unavailable');
  setText('hc-health-sub', message);
  const fill = document.getElementById('hc-gauge-fill');
  if (fill) fill.style.strokeDasharray = '0 100';
  renderHealthFindings({ bySeverity: {}, totalFindings: 0, byBiomarker: {} });
  setText('hc-findings-aside', 'not loaded');
  renderHealthIndex(statusPayload);
  renderHealthBiomarkers(null);
  renderHealthHotspots([]);
  renderHealthKinds(statusPayload);
  document.getElementById('health-view')?.setAttribute('data-loaded', '1');
}

/** Pull /api/status + /api/findings + /api/hotspots and render the
    Health dashboard. No-ops gracefully on fetch failure so an offline
    file:// run keeps the demo values legible. */
async function loadHealthLive() {
  try {
    const [sr, fr, hr] = await Promise.all([
      apiFetch('/api/status'),
      apiFetch('/api/findings'),
      apiFetch('/api/hotspots?limit=50'),
    ]);
    const status = sr.ok ? await sr.json() : null;
    if (!fr.ok) {
      renderHealthUnavailable(`findings endpoint failed: HTTP ${fr.status}`, status);
      const hotspots = hr.ok ? await hr.json() : null;
      renderHealthHotspots(hotspots?.hotspots || []);
      return;
    }
    const findings = await fr.json();
    const hotspots = hr.ok ? await hr.json() : null;
    renderHealthDashboard(findings, hotspots, status);
  } catch (err) {
    console.warn('viewer: loadHealthLive failed', err);
    renderHealthUnavailable('health endpoints unavailable');
  }
}

/* file:// fallback — populate the dashboard with demo numbers so the
   static mockup reads as a real page. Live mode overwrites on tab
   open. escapeHtml lives in viewer.trace.app, which loads AFTER this
   module — the demo render runs at init, so bring a fallback. */
if (typeof escapeHtml !== 'function') {
  globalThis.escapeHtml = (s) =>
    String(s ?? '').replaceAll(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
if (globalThis.location.protocol === 'file:') {
  renderHealthDashboard(
    {
      codeHealth: 7.4,
      totalFindings: 281,
      nodesWithFindings: 214,
      totalNodes: 25912,
      totalFiles: 1473,
      bySeverity: { error: 43, warning: 183, info: 55 },
      byBiomarker: { brain_method: 92, deep_nesting: 75, long_parameter_list: 58, god_class: 31, feature_envy: 25 },
      byBiomarkerSeverity: {
        brain_method: { error: 18, warning: 52, info: 22 },
        deep_nesting: { error: 11, warning: 49, info: 15 },
        long_parameter_list: { error: 6, warning: 40, info: 12 },
        god_class: { error: 5, warning: 22, info: 4 },
        feature_envy: { error: 3, warning: 20, info: 2 },
      },
    },
    {
      hotspots: [
        { filePath: 'src/extraction/extractor.ts', commits: 41, loc: 1280, lastTouchedTs: Date.now() - 86400000, risk: 0.062 },
        { filePath: 'src/db/queries.ts', commits: 33, loc: 970, lastTouchedTs: Date.now() - 2 * 86400000, risk: 0.057 },
        { filePath: 'src/resolution/name-matcher.ts', commits: 27, loc: 1110, lastTouchedTs: Date.now() - 3 * 86400000, risk: 0.049 },
      ],
    },
    {
      files: 1473,
      nodes: 25912,
      edges: 101898,
      languages: ['TypeScript', 'JavaScript', 'SQL'],
      indexedAt: Date.now() - 3600000,
      head: 'demo0000',
      nodesByKind: { function: 14200, method: 5400, class: 1900, interface: 1200, variable: 2100, type_alias: 1112 },
      readiness: { grade: 'ok', label: 'Ready', summary: 'demo', nextSteps: [] },
    },
  );
}

/** ts (unix seconds OR ms) → "2d ago" / "8mo ago" / "—" if null. */
function formatRelative(ts) {
  if (ts == null) return '—';
  // Heuristic: anything before 2001 in ms is likely a unix-seconds value.
  const ms = ts < 1e12 ? ts * 1000 : ts;
  const dt = Date.now() - ms;
  if (dt < 0) return 'just now';
  const m = Math.floor(dt / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  const y = Math.floor(d / 365);
  return `${y}y ago`;
}
