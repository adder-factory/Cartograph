/* Graph minimap rendering, navigation, and throttled Cytoscape event loop. */

let minimapFrame = 0;
let minimapTransform = null;

function minimapVisibleNodes() {
  return visibleGraphContentNodes().filter((node) => node.style('display') !== 'none' && !node.hasClass('collapse-hidden'));
}

function minimapVisibleEdges() {
  return cy.edges().filter((edge) => edge.style('display') !== 'none');
}

function minimapNodeColor(node) {
  if (node.hasClass('feature-path-node')) return '#34d399';
  if (node.hasClass('impact-node')) return '#60a5fa';
  if (node.hasClass('compare-node')) return '#f59e0b';
  if (node.hasClass('focus') || node.selected()) return '#ffffff';
  return fillForKind(node.data('kind'));
}

function minimapEdgeColor(edge) {
  if (edge.hasClass('feature-path-edge')) return '#34d399';
  if (edge.hasClass('impact-edge')) return '#60a5fa';
  return edgeColorForKind(edge.data('kind'));
}

function graphMinimapBounds(nodes) {
  const positions = nodes.map((node) => node.position());
  if (positions.length === 0) return null;
  const xs = positions.map((pos) => pos.x);
  const ys = positions.map((pos) => pos.y);
  let x1 = Math.min(...xs);
  let x2 = Math.max(...xs);
  let y1 = Math.min(...ys);
  let y2 = Math.max(...ys);
  if (Math.abs(x2 - x1) < 1) { x1 -= 80; x2 += 80; }
  if (Math.abs(y2 - y1) < 1) { y1 -= 80; y2 += 80; }
  const pad = Math.max(80, Math.max(x2 - x1, y2 - y1) * 0.08);
  return { x1: x1 - pad, y1: y1 - pad, x2: x2 + pad, y2: y2 + pad };
}

function drawGraphMinimap() {
  minimapFrame = 0;
  const canvas = document.getElementById('graph-minimap-canvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = 'rgba(11, 15, 23, 0.86)';
  ctx.fillRect(0, 0, width, height);

  const nodes = minimapVisibleNodes();
  const bounds = graphMinimapBounds(nodes);
  if (!bounds) {
    minimapTransform = null;
    return;
  }
  const pad = 9;
  const graphWidth = bounds.x2 - bounds.x1;
  const graphHeight = bounds.y2 - bounds.y1;
  const scale = Math.min((width - pad * 2) / graphWidth, (height - pad * 2) / graphHeight);
  const offsetX = (width - graphWidth * scale) / 2;
  const offsetY = (height - graphHeight * scale) / 2;
  const toCanvas = (pos) => ({
    x: offsetX + (pos.x - bounds.x1) * scale,
    y: offsetY + (pos.y - bounds.y1) * scale,
  });
  minimapTransform = { ...bounds, scale, offsetX, offsetY };

  ctx.lineWidth = 1;
  minimapVisibleEdges().forEach((edge) => {
    if (edge.source().style('display') === 'none' || edge.target().style('display') === 'none') return;
    const source = toCanvas(edge.source().position());
    const target = toCanvas(edge.target().position());
    ctx.strokeStyle = minimapEdgeColor(edge);
    ctx.globalAlpha = edge.hasClass('feature-path-edge') || edge.hasClass('impact-edge') ? 0.95 : 0.36;
    ctx.beginPath();
    ctx.moveTo(source.x, source.y);
    ctx.lineTo(target.x, target.y);
    ctx.stroke();
  });

  ctx.globalAlpha = 1;
  nodes.forEach((node) => {
    const pos = toCanvas(node.position());
    const radius = node.hasClass('focus') || node.hasClass('feature-path-node') ? 3.4 : 2.4;
    ctx.fillStyle = minimapNodeColor(node);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, radius, 0, Math.PI * 2);
    ctx.fill();
  });

  const z = cy.zoom();
  const pan = cy.pan();
  const viewport = {
    x1: (0 - pan.x) / z,
    y1: (0 - pan.y) / z,
    x2: (cy.width() - pan.x) / z,
    y2: (cy.height() - pan.y) / z,
  };
  const v1 = toCanvas({ x: viewport.x1, y: viewport.y1 });
  const v2 = toCanvas({ x: viewport.x2, y: viewport.y2 });
  ctx.strokeStyle = 'rgba(236, 239, 243, 0.82)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 3]);
  ctx.strokeRect(v1.x, v1.y, v2.x - v1.x, v2.y - v1.y);
  ctx.setLineDash([]);
}

function requestGraphMinimapDraw() {
  if (minimapFrame) return;
  minimapFrame = requestAnimationFrame(drawGraphMinimap);
}

function panGraphFromMinimap(event) {
  const canvas = document.getElementById('graph-minimap-canvas');
  if (!canvas || !minimapTransform) return;
  const rect = canvas.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const graphX = minimapTransform.x1 + (x - minimapTransform.offsetX) / minimapTransform.scale;
  const graphY = minimapTransform.y1 + (y - minimapTransform.offsetY) / minimapTransform.scale;
  const zoom = cy.zoom();
  cy.pan({
    x: cy.width() / 2 - graphX * zoom,
    y: cy.height() / 2 - graphY * zoom,
  });
  updateLabelVisibility();
  requestGraphMinimapDraw();
}

/* Structural changes redraw immediately (rAF-coalesced); continuous
   pan/zoom/render/position streams are throttled to ~10 Hz with a
   trailing draw — a full minimap repaint per frame (with per-element
   computed-style reads) is measurable jank at all-density. */
const MINIMAP_CONTINUOUS_DRAW_INTERVAL_MS = 100;
let minimapLastContinuousDraw = 0;
let minimapTrailingTimer = 0;

function requestGraphMinimapDrawThrottled() {
  const now = performance.now();
  const elapsed = now - minimapLastContinuousDraw;
  if (elapsed >= MINIMAP_CONTINUOUS_DRAW_INTERVAL_MS) {
    minimapLastContinuousDraw = now;
    requestGraphMinimapDraw();
    return;
  }
  if (minimapTrailingTimer) return;
  minimapTrailingTimer = setTimeout(() => {
    minimapTrailingTimer = 0;
    minimapLastContinuousDraw = performance.now();
    requestGraphMinimapDraw();
  }, MINIMAP_CONTINUOUS_DRAW_INTERVAL_MS - elapsed);
}

document.getElementById('graph-minimap')?.addEventListener('click', panGraphFromMinimap);
cy.on('layoutstop add remove data style resize', requestGraphMinimapDraw);
cy.on('render pan zoom position', requestGraphMinimapDrawThrottled);
setTimeout(requestGraphMinimapDraw, 80);
