/* Viewer chrome simplification.
   This module reorganizes existing controls into a calmer default shell
   without changing the graph/filter behavior those controls already own. */

const VIEWER_UI_MODE_KEY = 'cartograph-viewer-ui-mode-v1';
const VIEWER_UI_MODES = new Set(['simple', 'advanced']);

function readViewerUiMode() {
  if (typeof readViewerJsonStorage === 'function') {
    return readViewerJsonStorage(VIEWER_UI_MODE_KEY, 'simple', {
      validate: (value) => VIEWER_UI_MODES.has(value),
    });
  }
  try {
    const value = JSON.parse(localStorage.getItem(VIEWER_UI_MODE_KEY) || '"simple"');
    return VIEWER_UI_MODES.has(value) ? value : 'simple';
  } catch {
    return 'simple';
  }
}

function writeViewerUiMode(mode) {
  if (typeof writeViewerJsonStorage === 'function') return writeViewerJsonStorage(VIEWER_UI_MODE_KEY, mode);
  try {
    localStorage.setItem(VIEWER_UI_MODE_KEY, JSON.stringify(mode));
    return true;
  } catch {
    return false;
  }
}

function sectionForControl(id) {
  return document.getElementById(id)?.closest('.rail-section') || null;
}

function sectionWithChild(selector) {
  return document.querySelector(selector)?.closest('.rail-section') || null;
}

function createRailGroup(id, label, summary, open = false) {
  const section = document.createElement('section');
  section.className = 'rail-section';
  section.dataset.railSection = id;

  const title = document.createElement('div');
  title.className = 'rail-title';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'rail-toggle';
  toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
  toggle.dataset.railToggle = id;

  const labelWrap = document.createElement('span');
  labelWrap.className = 'rail-toggle-label';
  const labelText = document.createElement('span');
  labelText.textContent = label;
  labelWrap.appendChild(labelText);
  if (summary) {
    const summaryText = document.createElement('span');
    summaryText.className = 'rail-toggle-summary';
    summaryText.textContent = summary;
    labelWrap.appendChild(summaryText);
  }

  const caret = document.createElement('span');
  caret.className = 'rail-caret';
  caret.setAttribute('aria-hidden', 'true');
  caret.innerHTML = '<i data-lucide="chevron-down" aria-hidden="true"></i><span class="icon-fallback" aria-hidden="true">v</span>';

  toggle.append(labelWrap, caret);
  title.appendChild(toggle);

  const body = document.createElement('div');
  body.className = 'rail-body';
  body.dataset.railBody = id;

  section.append(title, body);
  setRailSectionCollapsed(section, !open);

  toggle.addEventListener('click', () => {
    setRailSectionCollapsed(section, !section.classList.contains('collapsed'));
  });

  return { body, section };
}

function setRailSectionCollapsed(section, collapsed) {
  if (!section) return;
  section.classList.toggle('collapsed', Boolean(collapsed));
  const toggle = section.querySelector('.rail-toggle');
  if (toggle) toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

function openViewerRailSection(id) {
  const section = document.querySelector(`[data-rail-section="${id}"]`);
  if (!section) return false;
  if (id === 'advanced' && section.hidden) {
    setViewerUiMode('advanced', { openAdvanced: false });
  }
  setRailSectionCollapsed(section, false);
  return true;
}

function closeViewerRailSection(id) {
  const section = document.querySelector(`[data-rail-section="${id}"]`);
  if (!section) return false;
  setRailSectionCollapsed(section, true);
  return true;
}

function createRailSubblock(title = '') {
  const block = document.createElement('div');
  block.className = 'rail-subblock';
  if (title) {
    const subtitle = document.createElement('div');
    subtitle.className = 'rail-subtitle';
    subtitle.textContent = title;
    block.appendChild(subtitle);
  }
  return block;
}

function appendOriginalSection(body, source, fallbackTitle = '') {
  if (!body || !source) return null;
  const title = Array.from(source.children).find((child) => child.classList?.contains('rail-title'));
  const block = createRailSubblock(fallbackTitle || title?.textContent?.trim() || '');
  while (source.firstChild) {
    const child = source.firstChild;
    if (child === title) {
      source.removeChild(child);
      continue;
    }
    block.appendChild(child);
  }
  body.appendChild(block);
  return block;
}

function appendMovedNodes(body, title, nodes) {
  if (!body || nodes.length === 0) return null;
  const block = createRailSubblock(title);
  for (const node of nodes) block.appendChild(node);
  body.appendChild(block);
  return block;
}

function splitGraphToolsSection(featureSection, advancedBody, savedBody) {
  if (!featureSection) return;
  const advancedNodes = [];
  const snapshotNodes = [];
  let inSnapshot = false;
  for (const child of Array.from(featureSection.children)) {
    if (child.classList?.contains('rail-title')) continue;
    if (child.classList?.contains('tool-label') && child.textContent.trim() === 'Snapshot') {
      inSnapshot = true;
      continue;
    }
    (inSnapshot ? snapshotNodes : advancedNodes).push(child);
  }
  appendMovedNodes(advancedBody, 'Graph tools', advancedNodes);
  appendMovedNodes(savedBody, 'Snapshot', snapshotNodes);
}

function appendResetControls(resetSection, viewBody, advancedBody) {
  if (!resetSection) return;
  const resetView = document.getElementById('btn-reset-view');
  const resetSaved = document.getElementById('btn-reset-local-state');
  const resetStatus = document.getElementById('viewer-reset-status');
  appendMovedNodes(viewBody, '', [resetView].filter(Boolean));
  appendMovedNodes(advancedBody, 'Local data', [resetSaved, resetStatus].filter(Boolean));
}

function simplifyViewerRail() {
  const rail = document.querySelector('.leftrail');
  if (!rail || rail.querySelector('[data-rail-section="view"]')) return;

  const resetSection = sectionForControl('btn-reset-view');
  const savedSection = sectionForControl('saved-view-select');
  const featureSection = sectionForControl('impact-control');
  const densitySection = sectionForControl('density-control');
  const layoutSection = sectionForControl('layout-quality-control');
  const groupsSection = sectionForControl('group-control');
  const detailSection = sectionForControl('detail-control');
  const kindSection = sectionForControl('kind-chips');
  const edgeSection = sectionForControl('edge-kind-filters');
  const healthSection = sectionWithChild('[data-filter-health]');
  // Anchor on the container id — scope rows render after boot (per-
  // project dirs), so a row selector would find nothing here and the
  // rail rebuild would silently drop the section.
  const scopeSection = sectionForControl('file-scope-filters');
  const diagnosticsSection = sectionForControl('btn-graph-diagnostics');
  const legendSection = Array.from(rail.querySelectorAll(':scope > .rail-section')).find((section) =>
    section.querySelector('.rail-title')?.textContent?.trim().startsWith('Health (border)')
  );

  const view = createRailGroup('view', 'View', 'density and reset', true);
  const filters = createRailGroup('filters', 'Filters', 'kinds, edges, health', false);
  const saved = createRailGroup('saved', 'Saved', 'views and snapshots', false);
  const advanced = createRailGroup('advanced', 'Advanced', 'paths, layout, diagnostics', false);

  appendResetControls(resetSection, view.body, advanced.body);
  appendOriginalSection(view.body, densitySection);

  appendOriginalSection(filters.body, detailSection);
  appendOriginalSection(filters.body, groupsSection);
  appendOriginalSection(filters.body, kindSection);
  appendOriginalSection(filters.body, edgeSection);
  appendOriginalSection(filters.body, healthSection);
  appendOriginalSection(filters.body, scopeSection);

  appendOriginalSection(saved.body, savedSection);
  splitGraphToolsSection(featureSection, advanced.body, saved.body);

  appendOriginalSection(advanced.body, layoutSection);
  appendOriginalSection(advanced.body, legendSection);
  appendOriginalSection(advanced.body, diagnosticsSection);

  rail.replaceChildren(view.section, filters.section, saved.section, advanced.section);
  setViewerUiMode(readViewerUiMode(), { openAdvanced: false, persist: false });
}

function setViewerUiMode(mode, opts = {}) {
  const nextMode = mode === 'advanced' ? 'advanced' : 'simple';
  document.body.dataset.viewerMode = nextMode;

  const button = document.getElementById('btn-viewer-mode');
  if (button) {
    const label = button.querySelector('[data-ui-mode-label]');
    if (label) label.textContent = nextMode === 'advanced' ? 'Advanced' : 'Simple';
    else button.textContent = nextMode === 'advanced' ? 'Advanced' : 'Simple';
    button.dataset.mode = nextMode;
    button.dataset.tooltip = nextMode === 'advanced' ? 'Hide advanced viewer controls' : 'Show advanced viewer controls';
    button.setAttribute('aria-pressed', nextMode === 'advanced' ? 'true' : 'false');
  }

  const advanced = document.querySelector('[data-rail-section="advanced"]');
  if (advanced) {
    advanced.hidden = nextMode !== 'advanced';
    advanced.dataset.advancedHidden = nextMode === 'advanced' ? '0' : '1';
    if (nextMode === 'simple') closeViewerRailSection('advanced');
    if (nextMode === 'advanced' && opts.openAdvanced) openViewerRailSection('advanced');
  }

  if (opts.persist !== false) writeViewerUiMode(nextMode);
  document.dispatchEvent(new CustomEvent('viewer-ui-mode-change', { detail: { mode: nextMode } }));
  return nextMode;
}

function hydrateViewerIcons() {
  if (!globalThis.lucide || typeof globalThis.lucide.createIcons !== 'function') return false;
  globalThis.lucide.createIcons({
    attrs: {
      'aria-hidden': 'true',
      'stroke-width': 2,
    },
  });
  document.body.classList.add('icons-ready');
  return true;
}

function toggleViewerUiMode() {
  const current = document.body.dataset.viewerMode === 'advanced' ? 'advanced' : 'simple';
  return setViewerUiMode(current === 'advanced' ? 'simple' : 'advanced', { openAdvanced: true });
}

function setGraphToolsPopover(open) {
  const popover = document.getElementById('graph-tools-popover');
  const button = document.getElementById('btn-graph-tools');
  if (!popover) return false;
  popover.hidden = !open;
  if (button) button.setAttribute('aria-expanded', open ? 'true' : 'false');
  return !popover.hidden;
}

function toggleGraphToolsPopover(force) {
  const popover = document.getElementById('graph-tools-popover');
  const open = typeof force === 'boolean' ? force : Boolean(popover?.hidden);
  return setGraphToolsPopover(open);
}

function initializeGraphToolsPopover() {
  const tools = document.getElementById('graph-tools');
  const button = document.getElementById('btn-graph-tools');
  if (!tools || !button) return;
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleGraphToolsPopover();
  });
  document.addEventListener('click', (event) => {
    if (document.getElementById('graph-tools-popover')?.hidden) return;
    if (tools.contains(event.target)) return;
    setGraphToolsPopover(false);
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') setGraphToolsPopover(false);
  });
}

simplifyViewerRail();
hydrateViewerIcons();
initializeGraphToolsPopover();
document.getElementById('btn-viewer-mode')?.addEventListener('click', toggleViewerUiMode);

registerViewerAction('setViewerUiMode', setViewerUiMode);
registerViewerAction('toggleViewerUiMode', toggleViewerUiMode);
registerViewerAction('openViewerRailSection', openViewerRailSection);
registerViewerAction('closeViewerRailSection', closeViewerRailSection);
registerViewerAction('toggleGraphToolsPopover', toggleGraphToolsPopover);
registerViewerAction('hydrateViewerIcons', hydrateViewerIcons);
globalThis.setViewerUiMode = setViewerUiMode;
globalThis.toggleViewerUiMode = toggleViewerUiMode;
globalThis.openViewerRailSection = openViewerRailSection;
globalThis.closeViewerRailSection = closeViewerRailSection;
globalThis.toggleGraphToolsPopover = toggleGraphToolsPopover;
globalThis.hydrateViewerIcons = hydrateViewerIcons;
