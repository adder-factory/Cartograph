function safeFilePart(value) {
  return String(value || 'graph')
    .replaceAll(/[^\w.-]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 80) || 'graph';
}

function graphExportFilename(ext) {
  const label = viewerLiveSymbolCache()?.label || viewerCurrentSymbolId() || 'graph';
  return `cartograph-${safeFilePart(label)}.${ext}`;
}

function downloadText(filename, mime, text) {
  const blob = new Blob([text], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function downloadDataUrl(filename, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
}

function visibleGraphNodes() {
  // Group nodes are excluded outright: expanded groups are container
  // chrome, and collapsed groups are display:none (their collapsedProxy
  // is the visible artifact and is not flagged isGroup).
  return cy.nodes().filter((n) =>
    !n.data('isGroup') &&
    n.style('display') !== 'none' &&
    !n.hasClass('collapse-hidden')
  );
}

function visibleGraphEdges() {
  return cy.edges().filter((e) => e.style('display') !== 'none');
}

function currentGraphFilterState() {
  return {
    density: viewerGraphMode('densityMode', graphDensityMode),
    detail: viewerGraphMode('detailGroupingMode', detailGroupingMode),
    hiddenKinds: hiddenKindKeys(),
    health: checkedHashValues('[data-filter-health]', 'filterHealth'),
    files: checkedHashValues('[data-filter-scope]', 'filterScope'),
    edges: checkedHashValues('[data-filter-edge]', 'filterEdge'),
    collapsedGroups: collapsedGroupList(),
    scope: viewerGraphMode('breadcrumbScope', breadcrumbScope),
  };
}

function graphJsonPayload() {
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    url: location.href,
    focus: viewerCurrentSymbolId(),
    filters: currentGraphFilterState(),
    nodes: visibleGraphNodes().map((n) => ({
      id: n.id(),
      label: n.data('label'),
      kind: n.data('kind'),
      health: n.data('health'),
      findingCount: n.data('findingCount') || 0,
      file: n.data('file'),
      centrality: n.data('centrality') || 0,
      position: n.position(),
      parent: n.parent?.().length ? n.parent().id() : undefined,
      group: n.data('isGroup') ? true : undefined,
      collapsed: n.hasClass('collapsed') || undefined,
      collapsedProxy: n.data('collapsedProxy') ? true : undefined,
      detailBucket: n.data('detailBucket') ? true : undefined,
      bucketKind: n.data('bucketKind') || undefined,
      sourceGroup: n.data('sourceGroup') || undefined,
      childCount: (n.data('isGroup') || n.data('collapsedProxy') || n.data('detailBucket')) ? Number(n.data('childCount') || groupChildCount(n)) : undefined,
      pinned: n.hasClass('pinned') || n.locked(),
    })),
    edges: visibleGraphEdges().map((e) => ({
      id: e.id(),
      source: e.source().id(),
      target: e.target().id(),
      kind: e.data('kind'),
      count: e.data('count') || undefined,
      collapsedEdge: e.data('collapsedEdge') ? true : undefined,
      detailBucketEdge: e.data('detailBucketEdge') ? true : undefined,
    })),
  };
}

function exportGraphJson(btn) {
  downloadText(graphExportFilename('json'), 'application/json;charset=utf-8', JSON.stringify(graphJsonPayload(), null, 2));
  flashActionButton(btn, 'Saved');
}

function exportGraphPng(btn) {
  const dataUrl = cy.png({ bg: '#0b0f17', full: false, scale: 2 });
  downloadDataUrl(graphExportFilename('png'), dataUrl);
  flashActionButton(btn, 'Saved');
}

function svgRect(attrs) {
  return `<rect ${Object.entries(attrs).map(([k, v]) => `${k}="${escapeHtml(String(v))}"`).join(' ')} />`;
}

function svgEdgePath(edge) {
  const s = edge.source().position();
  const t = edge.target().position();
  const dx = t.x - s.x;
  const dy = t.y - s.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const weight = edgeRouteWeight(edge);
  const mx = s.x + dx * weight;
  const my = s.y + dy * weight;
  const dist = signedEdgeRouteDistance(edge);
  const cx = mx + (-dy / len) * dist;
  const cy = my + (dx / len) * dist;
  return `M ${s.x.toFixed(1)} ${s.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${t.x.toFixed(1)} ${t.y.toFixed(1)}`;
}

function graphSvgText() {
  const nodes = visibleGraphNodes();
  if (nodes.length === 0) return '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480"></svg>';
  const bb = nodes.boundingBox({ includeLabels: true, includeOverlays: false });
  const pad = 96;
  const minX = Math.floor(bb.x1 - pad);
  const minY = Math.floor(bb.y1 - pad);
  const width = Math.max(320, Math.ceil(bb.w + pad * 2));
  const height = Math.max(240, Math.ceil(bb.h + pad * 2));
  const groups = cy.nodes().filter((n) =>
    n.data('isGroup') && !n.hasClass('collapsed') && n.style('display') !== 'none'
  );
  const groupSvg = groups.map((group) => {
    const children = group.children().filter((n) => n.style('display') !== 'none');
    if (children.length === 0) return '';
    const gb = children.boundingBox({ includeLabels: true, includeOverlays: false });
    return svgRect({
      x: Math.floor(gb.x1 - 28),
      y: Math.floor(gb.y1 - 42),
      width: Math.ceil(gb.w + 56),
      height: Math.ceil(gb.h + 70),
      rx: 10,
      fill: '#20242a',
      'fill-opacity': '0.16',
      stroke: '#3a414a',
      'stroke-dasharray': '7 5',
    }) + `<text x="${Math.floor(gb.x1 - 16)}" y="${Math.floor(gb.y1 - 18)}" fill="#9aa3ad" font-size="12" font-weight="600">${escapeHtml(group.data('label') || '')}</text>`;
  }).join('\n');
  const edgeSvg = visibleGraphEdges().map((e) => {
    return `<path d="${svgEdgePath(e)}" fill="none" stroke="#58627a" stroke-width="1.4" stroke-opacity="0.76" marker-end="url(#arrow)" />`;
  }).join('\n');
  const nodeSvg = nodes.map((n) => {
    const p = n.position();
    const width = Math.max(26, Number(n.width()) || 32);
    const height = Math.max(26, Number(n.height()) || width);
    const isGroup = Boolean(n.data('isGroup') || n.data('collapsedProxy'));
    const isDetailBucket = Boolean(n.data('detailBucket'));
    const fill = isGroup ? '#20242a' : fillForKind(n.data('kind'));
    const stroke = n.id() === viewerCurrentSymbolId() ? '#ffffff' : isGroup ? '#5fadff' : borderForHealth(n.data('health'));
    const label = escapeHtml(String(n.data('label') || n.id()));
    const halfW = width / 2;
    const halfH = height / 2;
    // Mirrors KIND_SHAPE's families approximately: rects for type
    // containers and files, diamonds for contracts, circles for the
    // rest (barrel/hexagon/tag render as circles in the export).
    const kind = n.data('kind');
    const isRectKind = ['class', 'struct', 'enum', 'file', 'module', 'namespace'].includes(kind);
    const isDiamondKind = ['interface', 'trait', 'type_alias', 'protocol'].includes(kind);
    let shape;
    if (isGroup || isDetailBucket || isRectKind) {
      shape = svgRect({ x: (p.x - halfW).toFixed(1), y: (p.y - halfH).toFixed(1), width: width.toFixed(1), height: height.toFixed(1), rx: 7, fill, stroke, 'stroke-width': 2 });
    } else if (isDiamondKind) {
      const points = `${p.x.toFixed(1)},${(p.y - halfH).toFixed(1)} ${(p.x + halfW).toFixed(1)},${p.y.toFixed(1)} ${p.x.toFixed(1)},${(p.y + halfH).toFixed(1)} ${(p.x - halfW).toFixed(1)},${p.y.toFixed(1)}`;
      shape = `<polygon points="${points}" fill="${fill}" stroke="${stroke}" stroke-width="2" />`;
    } else {
      shape = `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${halfW.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="2" />`;
    }
    return `${shape}<text x="${p.x.toFixed(1)}" y="${(p.y + halfH + 15).toFixed(1)}" fill="#dde3ee" font-size="11" text-anchor="middle">${label}</text>`;
  }).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${minX} ${minY} ${width} ${height}">
<rect x="${minX}" y="${minY}" width="${width}" height="${height}" fill="#0b0f17" />
<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto" markerUnits="strokeWidth"><path d="M0,0 L0,6 L7,3 z" fill="#58627a" /></marker></defs>
${groupSvg}
${edgeSvg}
${nodeSvg}
</svg>`;
}

function exportGraphSvg(btn) {
  downloadText(graphExportFilename('svg'), 'image/svg+xml;charset=utf-8', graphSvgText());
  flashActionButton(btn, 'Saved');
}

document.getElementById('btn-graph-json').addEventListener('click', (e) => exportGraphJson(e.currentTarget));
document.getElementById('btn-graph-png').addEventListener('click', (e) => exportGraphPng(e.currentTarget));
document.getElementById('btn-graph-svg').addEventListener('click', (e) => exportGraphSvg(e.currentTarget));

globalThis.addEventListener('hashchange', () => {
  const s = readHashState();
  applyHashStateControls(s);
  if (LIVE_MODE && s.focus && s.focus !== viewerLiveSymbolCache()?.id) searchAndFocus(s.focus);
  restoreMobilePanelFromHash(s.panel);
});
