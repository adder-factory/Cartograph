/* ───────── Cytoscape init ───────── */

/* Two-axis color encoding:
   - FILL = symbol kind (function/method/class/interface/file/...)
   - BORDER = health (error/warning/healthy)
   So a "warning class" reads as a violet rounded square with an
   orange ring, a "healthy function" reads as a blue circle with no
   ring. Two signals, no shouting match between them. */
const KIND_FILL = {
  function:   '#5fadff', // accent blue
  method:     '#4cd1be', // teal
  class:      '#c084fc', // violet
  interface:  '#a3e635', // lime
  type:       '#a3e635',
  type_alias: '#a3e635',
  trait:      '#a3e635',
  struct:     '#c084fc',
  enum:       '#c084fc',
  variable:   '#fbbf24', // amber
  constant:   '#fbbf24',
  field:      '#fbbf24',
  property:   '#fbbf24',
  parameter:  '#fbbf24',
  detail_bucket: '#fbbf24',
  enum_member: '#fbbf24',
  protocol:   '#a3e635',
  file:       '#94a3b8', // slate
  module:     '#94a3b8',
  namespace:  '#94a3b8',
  import:     '#94a3b8',
  export:     '#94a3b8',
  route:      '#f472b6', // pink (entry-shaped)
  component:  '#f472b6',
  table:      '#94a3b8',
  resource:   '#94a3b8',
};
const KIND_DEFAULT_FILL = '#5fadff';
/* Border color signals health. Healthy = no visible ring. */
const HEALTH_BORDER = {
  error:   '#ef4444',
  warning: '#f59e0b',
  info:    '#60a5fa',
  healthy: 'rgba(11,15,23,0.5)',
};
function fillForKind(kind) { return KIND_FILL[kind] ?? KIND_DEFAULT_FILL; }

/* Shape = kind family, redundant with fill hue so the encoding holds
   for color-blind users and in screenshots:
   circles = callables · rounded squares = type containers · diamonds =
   contracts · rectangles = files/modules · barrels = data stores ·
   hexagons = entry points · tags = module wiring. */
const KIND_SHAPE = {
  class: 'round-rectangle', struct: 'round-rectangle', enum: 'round-rectangle',
  interface: 'diamond', trait: 'diamond', type_alias: 'diamond', protocol: 'diamond',
  file: 'rectangle', module: 'rectangle', namespace: 'rectangle',
  table: 'barrel', resource: 'barrel',
  route: 'round-hexagon', component: 'round-hexagon',
  import: 'round-tag', export: 'round-tag',
};
function shapeForKind(kind) { return KIND_SHAPE[kind] ?? 'ellipse'; }

/* Hub emphasis: a faint kind-colored halo that grows with PageRank
   centrality, so load-bearing symbols read at a glance even when the
   size difference is subtle. Zero below the threshold — leaves stay
   clean. State classes (focus, pinned, path/impact, …) override the
   underlay wholesale, so the halo never fights selection styling. */
const HUB_GLOW_MIN_CENTRALITY = 0.002;
const HUB_GLOW_MAX_CENTRALITY = 0.02;
function hubGlowStrength(centrality) {
  const c = Math.max(0, Math.min(HUB_GLOW_MAX_CENTRALITY, centrality || 0));
  if (c < HUB_GLOW_MIN_CENTRALITY) return 0;
  return (c - HUB_GLOW_MIN_CENTRALITY) / (HUB_GLOW_MAX_CENTRALITY - HUB_GLOW_MIN_CENTRALITY);
}
function hubGlowOpacity(centrality) {
  const t = hubGlowStrength(centrality);
  return t === 0 ? 0 : 0.07 + t * 0.1;
}
function hubGlowPadding(centrality) {
  const t = hubGlowStrength(centrality);
  return t === 0 ? 0 : Math.round(5 + t * 9);
}
function borderForHealth(health) { return HEALTH_BORDER[health] ?? HEALTH_BORDER.healthy; }
function borderWidthForHealth(health) {
  if (health === 'error') return 3;
  if (health === 'warning') return 2;
  return 1;
}

const EDGE_KIND_ORDER = [
  'calls', 'references', 'imports', 'instantiates', 'field_access',
  'type_of', 'returns', 'extends', 'implements', 'overrides',
  'decorates', 'contains', 'exports', 'tests', 'similar_to', 'def_use',
];
const EDGE_KIND_VISUAL = {
  calls:        { color: '#8ebfe9', line: 'solid' },
  references:  { color: '#b8c0cb', line: 'dashed' },
  imports:     { color: '#a3e635', line: 'dashed' },
  instantiates:{ color: '#d0a2ff', line: 'solid' },
  field_access:{ color: '#fbbf24', line: 'dotted' },
  type_of:     { color: '#65dfd0', line: 'dashed' },
  returns:     { color: '#7bbcff', line: 'dotted' },
  contains:    { color: '#8a94a3', line: 'dashed' },
  extends:     { color: '#f472b6', line: 'solid' },
  implements:  { color: '#f472b6', line: 'dashed' },
};
const EDGE_DEFAULT_VISUAL = { color: '#7d8da3', line: 'solid' };
function edgeVisual(kind) { return EDGE_KIND_VISUAL[kind] || EDGE_DEFAULT_VISUAL; }
function edgeColorForKind(kind) { return edgeVisual(kind).color; }
function edgeLineStyleForKind(kind) { return edgeVisual(kind).line; }
const EDGE_ROUTE_DISTANCE = {
  calls: 30,
  references: 22,
  imports: 34,
  instantiates: 38,
  field_access: 26,
  type_of: 28,
  returns: 32,
  contains: 18,
  extends: 42,
  implements: 46,
  tests: 36,
  similar_to: 24,
  def_use: 26,
};

function signedEdgeRouteDistance(edge) {
  const kind = edge?.data?.('kind') || 'edge';
  const base = EDGE_ROUTE_DISTANCE[kind] ?? 28;
  const countBoost = Math.min(36, Math.max(0, Number(edge?.data?.('count') || 1) - 1) * 4);
  const seed = String(edge?.id?.() || kind);
  const first = hashString(seed).charCodeAt(0) || 0;
  const sign = first % 2 === 0 ? 1 : -1;
  return sign * (base + countBoost);
}
function edgeRouteDistance(edge) {
  return signedEdgeRouteDistance(edge);
}
function edgeRouteWeight(edge) {
  const seed = hashString(String(edge?.id?.() || edge?.data?.('kind') || 'edge'));
  const n = seed.charCodeAt(seed.length - 1) || 0;
  return 0.44 + (n % 7) * 0.02;
}

function edgeElementId(source, target, kind, prefix = 'edge') {
  return `${prefix}:${hashString(`${source}\n${target}\n${kind || 'edge'}`)}`;
}

/* Drop elements whose id was already seen. cytoscape() and cy.add()
   THROW on a duplicate id — one repeated edge tuple from a payload (or
   a 32-bit hash collision) would otherwise blank the entire graph. */
function dedupeElementsById(elements) {
  const seen = new Set();
  return elements.filter((el) => {
    const id = el?.data?.id;
    if (id == null) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

/* Node size scales with PageRank centrality: hubs visibly bigger
   than leaves. sqrt mapping gives perceptual range without the
   biggest hub eating the canvas. Top centrality on this codebase is
   ~0.02; min visible size 38px, max 80px. */
function sizeForCentrality(c) {
  const v = Math.max(0, Math.min(0.02, c || 0));
  return Math.round(38 + Math.sqrt(v / 0.02) * 42);
}

/* Layout options for fCoSE — Cytoscape's recommended force-directed
   layout. Tuned for code graphs: hubs repel hard so spokes spread,
   ideal edge length keeps near neighbors visually paired, padding
   gives the right pane breathing room. Falls back to built-in 'cose'
   if the fCoSE extension didn't load (CDN failure). */
function fcoseLayoutOpts(overrides = {}) {
  const hasFcose = globalThis.cytoscapeFcose !== undefined
                || globalThis['cytoscape-fcose'] !== undefined;
  const base = hasFcose ? {
    name: 'fcose',
    quality: 'proof',          // run more iterations for cleaner final positions
    animate: false,
    randomize: true,
    padding: 60,
    nodeDimensionsIncludeLabels: true,
    uniformNodeDimensions: false,
    nodeSeparation: 140,        // enough breathing room without shrinking the final fit
    idealEdgeLength: 170,       // keep neighborhoods readable at normal zoom
    nodeRepulsion: 14000,       // hubs push neighbors away, but not off-canvas
    gravity: 0.16,              // pull sparse spokes back into the useful viewport
    gravityRange: 3.2,
    gravityCompound: 0.5,
    numIter: 4000,              // more iterations → simulation settles cleanly
    tile: true,
    tilingPaddingVertical: 30,
    tilingPaddingHorizontal: 30,
    fit: true,
  } : {
    name: 'cose',
    animate: false, padding: 60,
    idealEdgeLength: 160, nodeRepulsion: 24000, edgeElasticity: 80,
    gravity: 0.18, numIter: 80, randomize: false, fit: true,
  };
  return { ...base, ...overrides };
}

const VIEWER_MIN_ZOOM = 0.04;

const cy = cytoscape({
  container: document.getElementById('cy'),
  elements: dedupeElementsById([
    ...NODES.map(n => ({ data: { id: n.id, label: n.label, kind: n.kind, health: n.health, file: n.file, centrality: n.centrality || 0 } })),
    ...EDGES.map(([s, t, k]) => ({ data: { id: edgeElementId(s, t, k), source: s, target: t, kind: k } })),
  ]),
  style: [
    {
      selector: 'node',
      style: {
        'label': 'data(label)',
        'background-color': ele => fillForKind(ele.data('kind')),
        // Files/modules are context, symbols are content — let the
        // containers recede a touch so colored symbols pop.
        'background-opacity': ele => (KIND_SHAPE[ele.data('kind')] === 'rectangle' ? 0.72 : 0.94),
        'color': '#dde3ee',
        'font-size': 12,
        'font-weight': 500,
        'font-family': '-apple-system, system-ui, sans-serif',
        'text-valign': 'bottom',
        'text-halign': 'center',
        'text-margin-y': 4,
        'text-wrap': 'ellipsis',
        'text-max-width': 140,
        // Outline labels instead of background boxes: same contrast on
        // the dark canvas without the haze of gray rectangles at density.
        'text-outline-color': '#0b0f17',
        'text-outline-width': 2,
        'text-background-opacity': 0,
        'border-width': ele => borderWidthForHealth(ele.data('health')),
        'border-color': ele => borderForHealth(ele.data('health')),
        'width':  ele => sizeForCentrality(ele.data('centrality')),
        'height': ele => sizeForCentrality(ele.data('centrality')),
        'shape':  ele => shapeForKind(ele.data('kind')),
        'underlay-color': ele => fillForKind(ele.data('kind')),
        'underlay-opacity': ele => hubGlowOpacity(ele.data('centrality')),
        'underlay-padding': ele => hubGlowPadding(ele.data('centrality')),
        'transition-property': 'background-color, border-color, border-width, opacity, width, height',
        'transition-duration': '200ms',
      }
    },
    {
      selector: 'node[isGroup]',
      style: {
        'label': 'data(label)',
        'shape': 'round-rectangle',
        'background-color': '#20242a',
        'background-opacity': 0.16,
        'border-width': 1,
        'border-color': '#3a414a',
        'border-style': 'dashed',
        'color': '#9aa3ad',
        'font-size': 12,
        'font-weight': 600,
        'text-valign': 'top',
        'text-halign': 'left',
        'text-margin-x': 8,
        'text-margin-y': 8,
        'text-background-opacity': 0,
        'padding': 18,
        'compound-sizing-wrt-labels': 'include',
        'events': 'yes',
        'z-index': 1,
      }
    },
    {
      selector: 'node[collapsedProxy]',
      style: {
        'label': 'data(label)',
        'shape': 'round-rectangle',
        'width': 184,
        'height': 84,
        'background-color': '#20242a',
        'background-opacity': 0.78,
        'border-width': 2,
        'border-color': '#5fadff',
        'border-style': 'solid',
        'color': '#dde3ee',
        'font-size': 13,
        'font-weight': 700,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 154,
        'text-background-color': '#0b0f17',
        'text-background-opacity': 0.62,
        'text-background-padding': 4,
        'underlay-color': '#5fadff',
        'underlay-opacity': 0.12,
        'underlay-padding': 12,
        'z-index': 90,
      }
    },
    {
      selector: 'node[detailBucket]',
      style: {
        'label': 'data(label)',
        'shape': 'round-rectangle',
        'width': 118,
        'height': 56,
        'background-color': '#1f2a31',
        'background-opacity': 0.9,
        'border-width': 1.5,
        'border-color': '#fbbf24',
        'border-style': 'dotted',
        'color': '#f3d28b',
        'font-size': 11.5,
        'font-weight': 700,
        'text-valign': 'center',
        'text-halign': 'center',
        'text-wrap': 'wrap',
        'text-max-width': 96,
        'text-background-color': '#0b0f17',
        'text-background-opacity': 0.4,
        'text-background-padding': 3,
        'underlay-color': '#fbbf24',
        'underlay-opacity': 0.08,
        'underlay-padding': 8,
        'z-index': 82,
      }
    },
    {
      selector: 'node:active',
      style: { 'overlay-opacity': 0 } // suppress the default tap halo
    },
    {
      selector: 'node.hovered',
      style: {
        'border-color': '#dde3ee',
        'border-width': 2.5,
        'z-index': 50,
      }
    },
    {
      selector: 'node.pinned',
      style: {
        'border-color': '#fbbf24',
        'underlay-color': '#fbbf24',
        'underlay-opacity': 0.14,
        'underlay-padding': 6,
      }
    },
    {
      selector: 'node.selected-neighbor',
      style: {
        'border-color': '#8ebfe9',
        'border-width': 2.25,
        'underlay-color': '#5fadff',
        'underlay-opacity': 0.08,
        'underlay-padding': 5,
        'z-index': 70,
      }
    },
    {
      selector: 'node.feature-path-node',
      style: {
        'border-color': '#34d399',
        'border-width': 3,
        'underlay-color': '#34d399',
        'underlay-opacity': 0.18,
        'underlay-padding': 8,
        'z-index': 92,
      }
    },
    {
      selector: 'node.impact-node',
      style: {
        'border-color': '#60a5fa',
        'border-width': 2.75,
        'underlay-color': '#60a5fa',
        'underlay-opacity': 0.14,
        'underlay-padding': 7,
        'z-index': 86,
      }
    },
    {
      selector: 'node.compare-node',
      style: {
        'border-color': '#f59e0b',
        'border-width': 2.75,
        'underlay-color': '#f59e0b',
        'underlay-opacity': 0.16,
        'underlay-padding': 7,
        'z-index': 88,
      }
    },
    {
      selector: 'node:selected, node.focus',
      style: {
        'background-color': '#4ea8ff',
        'border-color': '#dde3ee',
        'border-width': 3,
        'underlay-color': '#4ea8ff',
        'underlay-opacity': 0.18,
        'underlay-padding': 8,
        /* Label sits BELOW the node on the dark page background,
           so we keep it light for contrast — switching to dark
           (which makes sense for inside-node labels) made the
           label disappear against the canvas. */
        'color': '#ffffff',
        'text-background-color': '#0b0f17',
        'text-background-opacity': 0.85,
        'z-index': 100,
      }
    },
    {
      selector: 'node.edge-endpoint',
      style: {
        'border-color': '#fbbf24',
        'border-width': 2.5,
        'underlay-color': '#fbbf24',
        'underlay-opacity': 0.16,
        'underlay-padding': 7,
        'z-index': 95,
      }
    },
    {
      selector: 'node.label-key',
      style: {
        'font-size': 13,
        'text-outline-width': 2.5,
        'z-index': 80,
      }
    },
    {
      selector: 'node.label-hidden',
      style: {
        'label': '',
        'text-opacity': 0,
        'text-background-opacity': 0,
      }
    },
    {
      selector: 'node.dim',
      style: { 'opacity': 0.15 }
    },
    {
      selector: 'node.collapse-hidden',
      style: {
        'visibility': 'hidden',
        'events': 'no',
        'label': '',
        'text-opacity': 0,
      }
    },
    {
      selector: 'edge',
      style: {
        'width': 2.35,
        'line-color': ele => edgeColorForKind(ele.data('kind')),
        'line-style': ele => edgeLineStyleForKind(ele.data('kind')),
        'curve-style': 'unbundled-bezier',
        'control-point-distances': edgeRouteDistance,
        'control-point-weights': edgeRouteWeight,
        'source-distance-from-node': 0,
        'target-distance-from-node': 0,
        'target-arrow-shape': 'triangle',
        'target-arrow-color': ele => edgeColorForKind(ele.data('kind')),
        'arrow-scale': 0.95,
        'opacity': 0.9,
        'z-index': 20,
        'transition-property': 'opacity, line-color, width, line-style, target-arrow-color',
        'transition-duration': '200ms',
      }
    },
    {
      selector: 'edge.adjacent',
      style: { 'line-color': '#a8d4f5', 'target-arrow-color': '#a8d4f5', 'opacity': 1, 'width': 2.9 }
    },
    {
      selector: 'edge.selected-edge',
      style: { 'line-color': '#a8d4f5', 'target-arrow-color': '#a8d4f5', 'opacity': 1, 'width': 3, 'z-index': 80 }
    },
    {
      selector: 'edge.highlight',
      style: { 'line-color': '#4ea8ff', 'target-arrow-color': '#4ea8ff', 'opacity': 1, 'width': 3.1 }
    },
    {
      selector: 'edge.feature-path-edge',
      style: {
        'line-color': '#34d399',
        'target-arrow-color': '#34d399',
        'opacity': 1,
        'width': 3.6,
        'z-index': 96,
      }
    },
    {
      selector: 'edge.impact-edge',
      style: {
        'line-color': '#60a5fa',
        'target-arrow-color': '#60a5fa',
        'opacity': 1,
        'width': 3.1,
        'z-index': 84,
      }
    },
    {
      selector: 'edge[collapsedEdge]',
      style: {
        'line-style': 'dashed',
        'line-color': '#8ebfe9',
        'target-arrow-color': '#8ebfe9',
        'opacity': 0.96,
        'width': 2.7,
      }
    },
    {
      selector: 'edge.edge-hover-muted',
      style: { 'opacity': 0.16 }
    },
    {
      selector: 'edge.edge-muted',
      style: { 'opacity': 0.08 }
    },
    {
      selector: 'edge.edge-inspected',
      style: {
        'line-color': '#fbbf24',
        'target-arrow-color': '#fbbf24',
        'opacity': 1,
        'width': 3.4,
        'arrow-scale': 1,
        'z-index': 120,
      }
    },
    {
      selector: 'edge.dim',
      style: { 'opacity': 0.04 }
    },
  ],
  // 'grid' placeholder: the real force layout runs ~50ms later via the
  // deferred relayoutAndFit (and again when live data replaces the demo
  // elements) — a constructor-time 4000-iteration fCoSE run was pure
  // discarded work on every page load.
  layout: { name: 'grid', fit: true },
  wheelSensitivity: 0.2,
  minZoom: VIEWER_MIN_ZOOM,
  maxZoom: 2.4,
});

let liveProjectRoot = '';

/* Shared graph utilities used by split viewer modules. */

function visibleGraphElements() {
  const visible = cy.elements().filter((ele) =>
    ele.style('display') !== 'none' && !ele.hasClass('collapse-hidden')
  );
  return visible.length > 0 ? visible : cy.elements();
}

function graphContentNodes() {
  return cy.nodes().filter((n) => !n.data('isGroup') && !n.data('collapsedProxy') && !n.data('detailBucket'));
}

function visibleGraphContentNodes() {
  return graphContentNodes().filter((n) => n.style('display') !== 'none' && !n.hasClass('collapse-hidden'));
}

function hashString(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function hashNumber(value) {
  let hash = 2166136261;
  const text = String(value);
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function setGraphState(kind, message = '') {
  const el = document.getElementById('graph-state');
  if (!el) return;
  if (!kind) {
    el.hidden = true;
    el.className = 'graph-state';
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.className = `graph-state ${kind}`;
  el.textContent = message;
}

const collapsedGroupIds = new Set();
let pendingHashCollapsedGroups = null;

function graphGroupNodes() {
  return cy.nodes().filter((n) => n.data('isGroup'));
}

function baseGroupLabel(group) {
  return String(group.data('baseLabel') || group.data('label') || group.id());
}

function groupChildCount(group) {
  return Number(group.data('childCount') || group.children().filter((n) => !n.data('isGroup')).length || 0);
}

function collapsedGroupLabel(group) {
  const visible = Number(group.data('visibleChildCount') || 0);
  const total = groupChildCount(group);
  const count = total > 0 ? `${visible}/${total}` : `${visible}`;
  return `${baseGroupLabel(group)} (${count})`;
}

function collapsedProxyIdForGroupId(groupId) {
  return `collapsed-group:${hashString(groupId)}`;
}

function collapsedProxyForGroup(group) {
  const proxy = cy.getElementById(collapsedProxyIdForGroupId(group.id()));
  return proxy.length > 0 ? proxy : null;
}

function ensureCollapsedProxyForGroup(group) {
  const id = collapsedProxyIdForGroupId(group.id());
  const existing = cy.getElementById(id);
  const label = collapsedGroupLabel(group);
  if (existing.length > 0) {
    existing.data('label', label);
    existing.data('sourceGroup', group.id());
    existing.data('childCount', groupChildCount(group));
    existing.style('display', 'element');
    return existing;
  }
  const position = group.position();
  return cy.add({
    group: 'nodes',
    data: {
      id,
      label,
      baseLabel: baseGroupLabel(group),
      childCount: groupChildCount(group),
      collapsedProxy: 1,
      sourceGroup: group.id(),
    },
    position: { x: position.x, y: position.y },
  });
}

function removeCollapsedGroupProxies() {
  cy.nodes().filter((n) => n.data('collapsedProxy')).remove();
}

function syncCollapsedGroupProxies(visibleGroupIds) {
  cy.nodes().filter((n) => n.data('collapsedProxy')).forEach((proxy) => {
    if (!visibleGroupIds.has(proxy.data('sourceGroup'))) proxy.remove();
  });
  graphGroupNodes().forEach((group) => {
    if (!collapsedGroupIds.has(group.id()) || !visibleGroupIds.has(group.id())) return;
    ensureCollapsedProxyForGroup(group);
  });
}

function collapsedGroupList() {
  return [...collapsedGroupIds].filter((id) => cy.getElementById(id).length > 0).sort();
}

function updateGroupCollapseLabel(group) {
  const collapsed = collapsedGroupIds.has(group.id());
  group.toggleClass('collapsed', collapsed);
  if (!group.data('baseLabel')) group.data('baseLabel', String(group.data('label') || group.id()));
  if (!collapsed) {
    group.data('label', baseGroupLabel(group));
    return;
  }
  group.data('label', collapsedGroupLabel(group));
}

function syncGroupCollapseClasses() {
  graphGroupNodes().forEach(updateGroupCollapseLabel);
  const hint = document.getElementById('group-collapse-hint');
  if (hint) hint.hidden = graphGroupNodes().length === 0;
}

function syncGroupControls() {
  const collapseBtn = document.getElementById('btn-collapse-groups');
  const expandBtn = document.getElementById('btn-expand-groups');
  const note = document.getElementById('group-note');
  const visibleExpanded = graphGroupNodes().filter((group) =>
    !collapsedGroupIds.has(group.id()) && group.style('display') !== 'none'
  ).length;
  const collapsedVisible = cy.nodes().filter((node) =>
    node.data('collapsedProxy') && node.style('display') !== 'none'
  ).length;
  if (collapseBtn) collapseBtn.disabled = visibleExpanded === 0;
  if (expandBtn) expandBtn.disabled = collapsedGroupIds.size === 0;
  if (note) {
    note.textContent = collapsedVisible > 0
      ? `${collapsedVisible} collapsed · click a module to expand it.`
      : 'Click a group on the canvas to toggle it.';
  }
}

function collapseVisibleGroups() {
  const ids = graphGroupNodes()
    .filter((group) => group.style('display') !== 'none')
    .map((group) => group.id());
  if (ids.length === 0) return;
  ids.forEach((id) => collapsedGroupIds.add(id));
  syncGroupCollapseClasses();
  clearEdgeInspection();
  applyFilters();
  writeHashState();
  relayoutAndFit();
}

function expandAllGroups() {
  if (collapsedGroupIds.size === 0) return;
  collapsedGroupIds.clear();
  removeCollapsedGroupProxies();
  syncGroupCollapseClasses();
  clearEdgeInspection();
  applyFilters();
  writeHashState();
  relayoutAndFit();
}

document.getElementById('btn-collapse-groups')?.addEventListener('click', collapseVisibleGroups);
document.getElementById('btn-expand-groups')?.addEventListener('click', expandAllGroups);

function pruneCollapsedGroupsForCurrentGraph() {
  const valid = new Set(graphGroupNodes().map((group) => group.id()));
  for (const id of [...collapsedGroupIds]) {
    if (!valid.has(id)) collapsedGroupIds.delete(id);
  }
}

function applyPendingCollapsedGroups() {
  if (pendingHashCollapsedGroups === null) {
    pruneCollapsedGroupsForCurrentGraph();
    syncGroupCollapseClasses();
    return;
  }
  const valid = new Set(graphGroupNodes().map((group) => group.id()));
  collapsedGroupIds.clear();
  for (const id of pendingHashCollapsedGroups) {
    if (valid.has(id)) collapsedGroupIds.add(id);
  }
  pendingHashCollapsedGroups = null;
  syncGroupCollapseClasses();
}

function setCollapsedGroupsFromHash(raw) {
  const values = hashList(raw);
  if (values === null) return;
  pendingHashCollapsedGroups = values;
  if (graphGroupNodes().length > 0) {
    applyPendingCollapsedGroups();
    applyFilters();
  }
}

function collapsedParentForNode(node) {
  if (!node || node.data('isGroup')) return null;
  const parent = node.parent();
  if (parent.length > 0 && collapsedGroupIds.has(parent.id())) return parent;
  return null;
}

function endpointForCollapsedEdge(node) {
  const detailBucket = detailBucketForNode(node);
  if (detailBucket) return detailBucket;
  const parent = collapsedParentForNode(node);
  if (!parent) return node;
  return collapsedProxyForGroup(parent) || parent;
}

function rebuildCollapsedBoundaryEdges() {
  cy.edges().filter((edge) => edge.data('collapsedEdge')).remove();
  if (collapsedGroupIds.size === 0) return;

  const byId = new Map();
  cy.edges().filter((edge) => !edge.data('collapsedEdge') && !edge.data('detailBucketEdge')).forEach((edge) => {
    const source = endpointForCollapsedEdge(edge.source());
    const target = endpointForCollapsedEdge(edge.target());
    if (!source || !target || source.id() === target.id()) return;
    if (source.id() === edge.source().id() && target.id() === edge.target().id()) return;
    const kind = edgeKind(edge);
    const id = edgeElementId(source.id(), target.id(), kind, 'collapsed');
    const existing = byId.get(id);
    if (existing) {
      existing.data.count += 1;
      return;
    }
    byId.set(id, {
      group: 'edges',
      data: {
        id,
        source: source.id(),
        target: target.id(),
        kind,
        count: 1,
        collapsedEdge: 1,
      },
    });
  });

  if (byId.size > 0) cy.add([...byId.values()]);
}

function toggleGroupCollapse(groupOrId, force = null) {
  const group = typeof groupOrId === 'string' ? cy.getElementById(groupOrId) : groupOrId;
  if (!group || group.length === 0 || !group.data('isGroup')) return;
  const collapse = force === null ? !collapsedGroupIds.has(group.id()) : Boolean(force);
  if (collapse) collapsedGroupIds.add(group.id());
  else collapsedGroupIds.delete(group.id());
  updateGroupCollapseLabel(group);
  clearEdgeInspection();
  applyFilters();
  writeHashState();
  if (collapse) {
    const proxy = collapsedProxyForGroup(group);
    if (proxy && proxy.length > 0) {
      cy.resize();
      cy.fit(proxy.closedNeighborhood().filter((ele) => ele.style('display') !== 'none'), fitPadding());
      updateLabelVisibility();
    } else {
      relayoutAndFit();
    }
  } else {
    relayoutAndFit();
  }
}
