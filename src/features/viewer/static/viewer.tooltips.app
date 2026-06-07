/* Compact UI tooltips for controls, generated rows, and icon buttons. */

const TOOLTIP_SELECTOR = [
  '[data-tooltip]',
  '[title]',
  'button[aria-label]',
  '[role="button"][aria-label]',
  'select[aria-label]',
  'input[aria-label]',
  'textarea[aria-label]',
].join(',');
const TOOLTIP_DELAY_MS = 220;
const TOOLTIP_MARGIN = 10;
let tooltipEl = null;
let tooltipTarget = null;
let tooltipTimer = 0;

function ensureTooltipEl() {
  if (tooltipEl) return tooltipEl;
  tooltipEl = document.createElement('div');
  tooltipEl.className = 'ui-tooltip';
  tooltipEl.hidden = true;
  tooltipEl.setAttribute('role', 'tooltip');
  document.body.appendChild(tooltipEl);
  return tooltipEl;
}

function tooltipTextFor(el) {
  if (!el) return '';
  if (el.dataset.tooltip) return el.dataset.tooltip.trim();
  const title = el.getAttribute('title');
  if (title) {
    el.dataset.tooltip = title;
    el.removeAttribute('title');
    return title.trim();
  }
  if (el.matches('button,[role="button"],select,input,textarea')) {
    return (el.getAttribute('aria-label') || '').trim();
  }
  return '';
}

function clampTooltipX(left, width) {
  const min = TOOLTIP_MARGIN;
  const max = window.innerWidth - width - TOOLTIP_MARGIN;
  return Math.max(min, Math.min(max, left));
}

function positionTooltip(target) {
  const el = ensureTooltipEl();
  const rect = target.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  const topPreferred = rect.top - box.height - 8;
  const top = topPreferred >= TOOLTIP_MARGIN ? topPreferred : rect.bottom + 8;
  const left = clampTooltipX(rect.left + rect.width / 2 - box.width / 2, box.width);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(Math.min(top, window.innerHeight - box.height - TOOLTIP_MARGIN))}px`;
}

function showTooltipNow(target) {
  if (target !== tooltipTarget) return;
  const text = tooltipTextFor(target);
  if (!text) return;
  const el = ensureTooltipEl();
  el.textContent = text;
  el.hidden = false;
  positionTooltip(target);
  requestAnimationFrame(() => el.classList.add('show'));
}

function scheduleTooltip(target) {
  window.clearTimeout(tooltipTimer);
  const text = tooltipTextFor(target);
  if (!text) return;
  tooltipTarget = target;
  tooltipTimer = window.setTimeout(() => showTooltipNow(target), TOOLTIP_DELAY_MS);
}

function hideTooltip() {
  window.clearTimeout(tooltipTimer);
  tooltipTimer = 0;
  tooltipTarget = null;
  if (!tooltipEl) return;
  tooltipEl.classList.remove('show');
  tooltipEl.hidden = true;
}

function tooltipTargetFromEvent(event) {
  const target = event.target instanceof Element ? event.target.closest(TOOLTIP_SELECTOR) : null;
  if (!target) return null;
  if (target.closest('.ui-tooltip')) return null;
  return target;
}

document.addEventListener('pointerover', (event) => {
  const target = tooltipTargetFromEvent(event);
  if (target) scheduleTooltip(target);
});
document.addEventListener('pointerout', (event) => {
  if (!tooltipTarget) return;
  const related = event.relatedTarget instanceof Node ? event.relatedTarget : null;
  if (related && tooltipTarget.contains(related)) return;
  hideTooltip();
});
document.addEventListener('focusin', (event) => {
  const target = tooltipTargetFromEvent(event);
  if (target) scheduleTooltip(target);
});
document.addEventListener('focusout', hideTooltip);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') hideTooltip();
});
window.addEventListener('scroll', hideTooltip, true);
window.addEventListener('resize', hideTooltip);

globalThis.__cartographViewerTooltips = {
  hideTooltip,
  showFor(selector) {
    const target = document.querySelector(selector);
    if (!target) return false;
    scheduleTooltip(target);
    return true;
  },
  textFor(selector) {
    const target = document.querySelector(selector);
    return target ? tooltipTextFor(target) : '';
  },
};
