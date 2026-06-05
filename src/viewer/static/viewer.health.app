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

function renderHealthSeverity(findings) {
  const counts = findings?.bySeverity || {};
  const severities = [
    { key: 'error', label: 'Errors', className: 'err' },
    { key: 'warning', label: 'Warnings', className: 'warn' },
    { key: 'info', label: 'Info', className: 'info' },
  ];
  const total = severities.reduce((sum, item) => sum + Number(counts[item.key] || 0), 0);
  severities.forEach((item) => {
    const segment = document.querySelector(`#hc-severity-stack .${item.className}`);
    if (segment) segment.style.width = `${percentage(counts[item.key], total)}%`;
  });
  const list = document.getElementById('hc-severity-list');
  if (!list) return;
  list.innerHTML = severities.map((item) => {
    const value = Number(counts[item.key] || 0);
    return `
      <div class="health-severity-row">
        <span>${item.label}</span>
        <span class="health-mini-bar"><span class="${item.className}" style="width:${percentage(value, total)}%"></span></span>
        <span class="count">${formatNumber(value)}</span>
      </div>
    `;
  }).join('');
}

function renderHealthBiomarkers(counts) {
  const list = document.getElementById('hc-biomarkers');
  if (!list) return;
  const rows = Object.entries(counts || {})
    .filter(([, count]) => Number(count) > 0)
    .sort(([, a], [, b]) => Number(b) - Number(a));
  if (rows.length === 0) {
    list.innerHTML = '<div class="health-empty">No biomarker findings in this index.</div>';
    return;
  }
  const total = rows.reduce((sum, [, count]) => sum + Number(count), 0);
  list.innerHTML = rows.slice(0, 12).map(([name, count], i) => `
    <div class="health-row">
      <div>
        <div class="name">${escapeHtml(biomarkerLabel(name))}</div>
        <div class="meta">${i === 0 ? 'top contributor' : `${percentage(count, total).toFixed(1)}% of findings`}</div>
      </div>
      <div class="value">${formatNumber(count)}</div>
    </div>
  `).join('');
}

function renderHealthHotspots(hotspots) {
  const list = document.getElementById('hc-hotspots-list');
  if (!list) return;
  const rows = hotspots || [];
  if (rows.length === 0) {
    list.innerHTML = '<div class="health-empty">No hotspots from churn and centrality data yet.</div>';
    return;
  }
  const maxRisk = Math.max(...rows.map((row) => Number(row.risk || 0)), 0.0001);
  list.innerHTML = rows.slice(0, 12).map((row) => `
    <div class="health-row hotspot">
      <div>
        <div class="name" title="${escapeHtml(row.filePath || '')}">${escapeHtml(row.filePath || 'unknown file')}</div>
        <div class="meta">${formatNumber(row.commits)} commits · ${formatNumber(row.loc)} LOC · touched ${escapeHtml(formatRelative(row.lastTouchedTs))}</div>
      </div>
      <div class="health-hotspot-risk">
        <span class="health-risk-bar" aria-hidden="true"><span style="width:${percentage(row.risk, maxRisk)}%"></span></span>
        <span class="value">${formatMetric(row.risk, 3)}</span>
      </div>
    </div>
  `).join('');
}

function renderHealthDashboard(findings, hotspotsPayload) {
  const f = findings || {};
  const bySeverity = f.bySeverity || {};
  const hotspots = hotspotsPayload?.hotspots || [];
  const codeHealth = Number(f.codeHealth ?? 0);
  const totalFindings = Number(f.totalFindings || 0);
  const nodesWithFindings = Number(f.nodesWithFindings || 0);
  const totalNodes = Number(f.totalNodes || 0);
  const totalFiles = Number(f.totalFiles || 0);
  setText('hc-health', `${codeHealth.toFixed(1)} / 10`);
  setText('hc-health-sub', totalFindings > 0
    ? `${formatNumber(nodesWithFindings)} flagged symbols out of ${formatNumber(totalNodes)} indexed`
    : `${formatNumber(totalNodes)} indexed symbols with no biomarker findings`);
  const fill = document.getElementById('hc-health-fill');
  if (fill) {
    fill.style.width = `${Math.max(0, Math.min(100, codeHealth * 10))}%`;
    fill.style.background = codeHealth >= 8 ? 'var(--ok)' : codeHealth >= 6 ? 'var(--warn)' : 'var(--err)';
  }
  setText('hc-errors', formatNumber(bySeverity.error || 0));
  setText('hc-errors-sub', 'error-tier findings');
  setText('hc-warnings', formatNumber(bySeverity.warning || 0));
  setText('hc-warnings-sub', 'warning-tier findings');
  setText('hc-info', formatNumber(bySeverity.info || 0));
  setText('hc-info-sub', 'informational findings');
  setText('hc-total', formatNumber(totalFindings));
  setText('hc-total-sub', `${formatNumber(Object.keys(f.byBiomarker || {}).length)} biomarker types`);
  setText('hc-nodes', formatNumber(nodesWithFindings));
  setText('hc-nodes-sub', `${percentage(nodesWithFindings, totalNodes).toFixed(1)}% of indexed symbols`);
  setText('hc-total-nodes', formatNumber(totalNodes));
  setText('hc-total-nodes-sub', `${formatNumber(nodesWithFindings)} currently flagged`);
  setText('hc-total-files', formatNumber(totalFiles));
  setText('hc-hotspots', formatNumber(hotspots.length));
  setText('hc-hotspots-sub', hotspots[0]
    ? `top risk: ${hotspots[0].filePath}`
    : 'central + actively churning files');
  renderHealthSeverity(f);
  renderHealthBiomarkers(f.byBiomarker);
  renderHealthHotspots(hotspots);
  document.getElementById('health-view')?.setAttribute('data-loaded', '1');
}

/** Pull /api/findings + /api/hotspots and render the Health dashboard.
    No-ops gracefully on fetch failure so an offline file:// run keeps
    the static starter values legible. */
async function loadHealthLive() {
  try {
    const [fr, hr] = await Promise.all([
      fetch('/api/findings'),
      fetch('/api/hotspots?limit=50'),
    ]);
    if (!fr.ok) {
      setText('hc-health', 'Unavailable');
      setText('hc-health-sub', `findings endpoint failed: HTTP ${fr.status}`);
      const fill = document.getElementById('hc-health-fill');
      if (fill) {
        fill.style.width = '0%';
        fill.style.background = 'var(--text-dim)';
      }
      const hotspots = hr.ok ? await hr.json() : null;
      renderHealthHotspots(hotspots?.hotspots || []);
      document.getElementById('health-view')?.setAttribute('data-loaded', '1');
      return;
    }
    const findings = await fr.json();
    const hotspots = hr.ok ? await hr.json() : null;
    renderHealthDashboard(findings, hotspots);
  } catch (err) {
    console.warn('viewer: loadHealthLive failed', err);
  }
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
