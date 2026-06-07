/* Breadcrumb — split the file path into clickable segments and
   render `dir › dir › file › symbol`. Directory segments scope the
   search (filter file:// scope), file segment is currently inert
   (could open the file in an editor in a future revision). */
function renderBreadcrumb(file, label) {
  const el = document.getElementById('d-breadcrumb');
  if (!file) { el.innerHTML = ''; return; }
  const parts = String(file).split('/').filter(Boolean);
  const html = parts.map((seg, i) => {
    const isLast = i === parts.length - 1 && !label;
    return `<span class="seg${isLast ? ' last' : ''}" data-bc-prefix="${escapeHtml(parts.slice(0, i + 1).join('/'))}">${escapeHtml(seg)}</span>`;
  }).join('<span class="sep">›</span>');
  const tail = label ? `<span class="sep">›</span><span class="seg last">${escapeHtml(label)}</span>` : '';
  el.innerHTML = html + tail;
  markBreadcrumbScope();
}

/* Breadcrumb scope — when set, applyFilters hides any cy node
   whose file path doesn't start with this prefix. Click a segment
   to scope, click the same segment (or the root scope) again to
   clear. */
let breadcrumbScope = null;
syncViewerGraphState({ breadcrumbScope });

function markBreadcrumbScope() {
  document.querySelectorAll('#d-breadcrumb .seg.scoped').forEach((el) => el.classList.remove('scoped'));
  if (!breadcrumbScope) return;
  document.querySelectorAll('#d-breadcrumb .seg[data-bc-prefix]').forEach((seg) => {
    if (`${seg.dataset.bcPrefix}/` === breadcrumbScope) seg.classList.add('scoped');
  });
}

document.getElementById('d-breadcrumb').addEventListener('click', (e) => {
  const seg = e.target.closest('.seg[data-bc-prefix]');
  if (!seg || seg.classList.contains('last')) return;
  const prefix = seg.dataset.bcPrefix + '/';
  // Toggle: same prefix clicked twice clears scope.
  breadcrumbScope = (breadcrumbScope === prefix) ? null : prefix;
  syncViewerGraphState({ breadcrumbScope });
  // Reflect in the search input as a visible cue.
  const input = document.getElementById('search-input');
  input.value = breadcrumbScope ? `path:${breadcrumbScope}` : '';
  applyFilters();
  // Mark the active segment so the user sees what's scoping.
  markBreadcrumbScope();
  writeHashState();
});

/* Map our `language` field to Prism's grammar key (mostly identity,
   a few diverge). Unmapped languages stay as `language-none`,
   which is fine — Prism just leaves them as plain text. */
const PRISM_LANG = {
  typescript: 'typescript', tsx: 'tsx', javascript: 'javascript', jsx: 'jsx',
  python: 'python', go: 'go', rust: 'rust', java: 'java', c: 'c', cpp: 'cpp',
  csharp: 'csharp', php: 'php', ruby: 'ruby', swift: 'swift', kotlin: 'kotlin',
  scala: 'scala', dart: 'dart', sql: 'sql', graphql: 'graphql', svelte: 'svelte',
  lua: 'lua', r: 'r', bash: 'bash',
};
function prismLangFor(lang) { return PRISM_LANG[lang] || 'none'; }

/* Source loader — lazy on first selection, eager-load thereafter.
   Renders raw source (with line-number gutter), then asks Prism to
   syntax-highlight in-place. Search-in-code wraps the SAME DOM in
   <mark class="m"> spans without re-running Prism, so highlighting
   and search highlights coexist. */
let codeOriginalHtml = '';   // post-Prism HTML, no search marks
let codeMatches = [];        // <mark> elements in DOM order
let codeMatchIndex = -1;
let codeStartLine = 1;
let sourceRequestSeq = 0;
let sourcePanelDismissed = false;

function resetCodePanel(symbolId) {
  sourceRequestSeq++;
  document.getElementById('d-code').innerHTML = '';
  document.getElementById('d-code-summary').textContent = 'Source';
  document.getElementById('d-code-search').value = '';
  document.getElementById('d-code-find-count').textContent = '';
  // Reset Line input — leftover "143-200" from a previous symbol
  // is meaningless on the next file. Same for the captured
  // selection chip in the chat header.
  const gotoEl = document.getElementById('d-code-goto');
  if (gotoEl) { gotoEl.value = ''; gotoEl.style.borderColor = ''; }
  capturedSelection = '';
  capturedSelectionLines = 0;
  updateAskSelectionChip();
  globalThis.getSelection()?.removeAllRanges();
  codeOriginalHtml = '';
  codeMatches = [];
  codeMatchIndex = -1;
  if (LIVE_MODE && symbolId) {
    const colEl = document.getElementById('canvas-col');
    const wasOpen = colEl.classList.contains('with-codepane');
    const shouldOpen = wasOpen || (!isMobileViewport() && !sourcePanelDismissed);
    if (shouldOpen) {
      colEl.classList.add('with-codepane');
      // Re-fit cy whenever the canvas height actually changed.
      if (!wasOpen) resizeGraphSoon();
      loadSourceLive(symbolId);
    } else {
      colEl.classList.remove('with-codepane');
      syncMobilePanelButtons();
    }
  }
}

document.getElementById('btn-code-close').addEventListener('click', () => {
  sourcePanelDismissed = true;
  document.getElementById('canvas-col').classList.remove('with-codepane');
  if (isMobileViewport()) document.getElementById('stage').classList.add('mobile-detail-open');
  syncMobilePanelButtons();
  resizeGraphSoon();
});

/* Copy / Export — pull the source out of #d-code without the
   line-number gutter, then either clipboard-write or trigger a
   download with the symbol's name + language extension. */
function getCurrentSourceText() {
  const codeEl = document.getElementById('d-code');
  // textContent grabs all text including the lineno spans; clone the
  // node, strip linenos first so the export is clean.
  const clone = codeEl.cloneNode(true);
  clone.querySelectorAll('.lineno').forEach((el) => el.remove());
  return clone.textContent || '';
}
const EXT_BY_LANG = {
  typescript: 'ts', tsx: 'tsx', javascript: 'js', jsx: 'jsx',
  python: 'py', go: 'go', rust: 'rs', java: 'java', c: 'c', cpp: 'cpp',
  csharp: 'cs', php: 'php', ruby: 'rb', swift: 'swift', kotlin: 'kt',
  scala: 'scala', dart: 'dart', sql: 'sql', graphql: 'graphql',
  svelte: 'svelte', lua: 'lua', r: 'r', bash: 'sh',
};

document.getElementById('btn-code-copy').addEventListener('click', async (e) => {
  const src = getCurrentSourceText();
  if (!src) return;
  await copyToClipboard(src, e.currentTarget);
});

document.getElementById('btn-code-selectall').addEventListener('click', () => {
  const codeEl = document.getElementById('d-code');
  const linenos = Array.from(codeEl.querySelectorAll('span.lineno'));
  if (linenos.length === 0) return;
  // Select from just after the first lineno through the last child.
  const range = document.createRange();
  range.setStartAfter(linenos[0]);
  range.setEndAfter(codeEl.lastChild ?? linenos[linenos.length - 1]);
  const sel = globalThis.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
});
document.getElementById('btn-code-export').addEventListener('click', () => {
  const src = getCurrentSourceText();
  if (!src) return;
  const lang = liveSymbolCache?.language || 'typescript';
  const ext = EXT_BY_LANG[lang] || 'txt';
  const safeName = (liveSymbolCache?.label || 'source').replaceAll(/[^A-Za-z0-9_-]/g, '_');
  const blob = new Blob([src], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${safeName}.${ext}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

/* "Show source" button — re-opens the panel after the user closed
   it. Re-fetches the source for the current selection; falls back
   to the cached symbol id when nothing is selected. */
/* Splitter drag — vertical between graph & codepane (resizes the
   codepane height), horizontal between code & chat (resizes the
   60/40 split). Sizes persist via localStorage so the user's
   preferred layout sticks across reloads. cy.resize() runs on
   pointer-up so the graph re-fits cleanly. */
const SPLIT_KEY = 'cartograph-viewer-splitters-v1';
const splitState = (() => {
  return readViewerJsonStorage(SPLIT_KEY, {}, {
    validate: (value) => value && typeof value === 'object' && !Array.isArray(value),
  });
})();
function applySplitState() {
  if (splitState.codepaneH) document.getElementById('codepane').style.height = splitState.codepaneH + 'px';
  if (splitState.codeFlex)  document.documentElement.style.setProperty('--code-flex', splitState.codeFlex);
  if (splitState.chatFlex)  document.documentElement.style.setProperty('--chat-flex', splitState.chatFlex);
}
applySplitState();

function bindSplitter(el, axis, onMove, onEnd) {
  el.addEventListener('mousedown', (e) => {
    e.preventDefault();
    el.classList.add('dragging');
    document.body.style.cursor = (axis === 'v') ? 'row-resize' : 'col-resize';
    document.body.style.userSelect = 'none';
    const move = (ev) => onMove(ev);
    const up = () => {
      el.classList.remove('dragging');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      onEnd?.();
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
}

bindSplitter(
  document.getElementById('splitter-v'), 'v',
  (e) => {
    const col = document.getElementById('canvas-col');
    const colRect = col.getBoundingClientRect();
    // Codepane height = distance from cursor to bottom of canvas-col.
    const newH = Math.max(140, Math.min(colRect.height - 200, colRect.bottom - e.clientY));
    document.getElementById('codepane').style.height = newH + 'px';
    splitState.codepaneH = Math.round(newH);
  },
  () => {
    writeViewerJsonStorage(SPLIT_KEY, splitState);
    resizeGraphSoon();
  },
);
bindSplitter(
  document.getElementById('splitter-h'), 'h',
  (e) => {
    const pane = document.getElementById('codepane');
    const r = pane.getBoundingClientRect();
    const cursorX = e.clientX - r.left;
    // Translate cursor x into a flex ratio. Clamp 25%..85% so neither pane vanishes.
    const ratio = Math.max(0.25, Math.min(0.85, cursorX / r.width));
    const codeFlex = Math.round(ratio * 100);
    const chatFlex = 100 - codeFlex;
    document.documentElement.style.setProperty('--code-flex', codeFlex);
    document.documentElement.style.setProperty('--chat-flex', chatFlex);
    splitState.codeFlex = codeFlex;
    splitState.chatFlex = chatFlex;
  },
  () => writeViewerJsonStorage(SPLIT_KEY, splitState),
);

document.getElementById('btn-show-code').addEventListener('click', () => {
  const symbolId = liveSymbolCache?.id;
  if (!LIVE_MODE || !symbolId) return;
  sourcePanelDismissed = false;
  document.getElementById('canvas-col').classList.add('with-codepane');
  syncMobilePanelButtons();
  resizeGraphSoon();
  // Reload only if the panel was emptied; otherwise just keep what's there.
  if (!codeOriginalHtml) loadSourceLive(symbolId);
});

/* Go-to-line / select-range. Accepts either:
   - "123" → scroll line 123 into view and flash it
   - "10-50" → make a real DOM Selection covering lines 10–50
     (without the line-number gutter), so Cmd+C copies just the
     code. The range is scrolled into view too. */
function findLinenoSpan(codeEl, n) {
  const padded = String(n);
  return Array.from(codeEl.querySelectorAll('span.lineno'))
    .find((el) => el.textContent.trim() === padded) ?? null;
}

function gotoLine(target) {
  if (!Number.isFinite(target) || target < 1) return false;
  const codeEl = document.getElementById('d-code');
  const hit = findLinenoSpan(codeEl, target);
  if (!hit) return false;
  hit.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const prev = hit.style.background;
  hit.style.background = 'var(--accent-soft)';
  setTimeout(() => { hit.style.background = prev; }, 900);
  return true;
}

function selectLineRange(startN, endN) {
  if (!Number.isFinite(startN) || !Number.isFinite(endN)) return false;
  if (startN > endN) [startN, endN] = [endN, startN];
  const codeEl = document.getElementById('d-code');
  const startSpan = findLinenoSpan(codeEl, startN);
  const endSpan   = findLinenoSpan(codeEl, endN);
  if (!startSpan || !endSpan) return false;
  // Selection starts AFTER the start lineno (skip the gutter
  // text), ends BEFORE the next-line lineno (or end of code).
  const range = document.createRange();
  range.setStartAfter(startSpan);
  const tail = findLinenoSpan(codeEl, endN + 1);
  if (tail) range.setEndBefore(tail);
  else range.setEndAfter(codeEl.lastChild ?? endSpan);
  const sel = globalThis.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  startSpan.scrollIntoView({ block: 'start', behavior: 'smooth' });
  return true;
}

function flashGotoError() {
  const input = document.getElementById('d-code-goto');
  input.style.borderColor = 'var(--err)';
  setTimeout(() => { input.style.borderColor = ''; }, 600);
}

function applyGotoExpression(raw) {
  const v = String(raw).trim();
  if (!v) return;
  // Range: "10-50" or "10 - 50" → select lines.
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(v);
  if (m) {
    if (!selectLineRange(Number.parseInt(m[1], 10), Number.parseInt(m[2], 10))) flashGotoError();
    return;
  }
  // Single line: "123" → scroll + flash.
  if (/^\d+$/.test(v)) {
    if (!gotoLine(Number.parseInt(v, 10))) flashGotoError();
    return;
  }
  flashGotoError();
}

document.getElementById('d-code-goto').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    applyGotoExpression(e.target.value);
  } else if (e.key === 'Escape') {
    e.target.value = '';
    e.target.blur();
    globalThis.getSelection()?.removeAllRanges();
  }
});
document.getElementById('d-code-goto').addEventListener('input', (e) => {
  // Live single-line scroll only; ranges wait for Enter so the
  // selection doesn't thrash while the user is still typing.
  const v = e.target.value.trim();
  if (/^\d+$/.test(v)) gotoLine(Number.parseInt(v, 10));
});

async function loadSourceLive(symbolId) {
  const requestSeq = ++sourceRequestSeq;
  const isCurrentSourceRequest = () =>
    requestSeq === sourceRequestSeq && (!LIVE_MODE || liveSymbolCache?.id === symbolId);
  const codeEl = document.getElementById('d-code');
  document.getElementById('d-code-summary').textContent = 'Loading source...';
  codeEl.textContent = 'Loading source...';
  try {
    const r = await fetch(`/api/source/${encodeURIComponent(symbolId)}`);
    if (!isCurrentSourceRequest()) return;
    if (!r.ok) {
      document.getElementById('d-code-summary').textContent = 'Source unavailable';
      codeEl.textContent = `(failed: HTTP ${r.status})`;
      return;
    }
    const p = await r.json();
    if (!isCurrentSourceRequest()) return;
    if (p.error) {
      document.getElementById('d-code-summary').textContent = 'Source unavailable';
      codeEl.textContent = `(${p.error})`;
      return;
    }
    const lang = prismLangFor(p.language);
    codeStartLine = p.startLine || 1;
    codeEl.className = `language-${lang}`;
    codeEl.textContent = String(p.source ?? '');
    document.getElementById('d-code-summary').textContent =
      `Source · ${p.endLine - p.startLine + 1} lines · ${escapeHtml(p.file || '')}`;
    // Reflect the file's actual line range in the goto placeholder
    // so the user sees, e.g., "143 or 143-232" instead of an
    // arbitrary "10-50". Helps when scanning long methods.
    const gotoInput = document.getElementById('d-code-goto');
    if (gotoInput) gotoInput.placeholder = `${p.startLine} or ${p.startLine}-${p.endLine}`;

    /* All grammars are bundled up-front, so highlightElement is
       fully synchronous — decorate line numbers immediately
       afterwards, no callback or race window. */
    if (globalThis.Prism) {
      try { Prism.highlightElement(codeEl); } catch (err) { console.debug('syntax highlighting unavailable', err); }
    }
    decorateLineNumbers(codeEl, codeStartLine);
    codeOriginalHtml = codeEl.innerHTML;
    runCodeSearch(document.getElementById('d-code-search').value);
  } catch (err) {
    if (!isCurrentSourceRequest()) return;
    document.getElementById('d-code-summary').textContent = 'Source unavailable';
    codeEl.textContent = `(error: ${String(err)})`;
  }
}

/* Walk the Prism-rendered HTML and add a `<span class="lineno">`
   prefix to each line. We insert at the start of every line by
   splitting on newlines AT THE TEXT LEVEL — Prism wraps tokens
   but doesn't wrap lines. Approach: replace the code element's
   innerHTML with one wrapped per line. */
function decorateLineNumbers(codeEl, startLine) {
  const html = codeEl.innerHTML;
  const lines = html.split('\n');
  const padW = String(startLine + lines.length - 1).length;
  codeEl.innerHTML = lines.map((line, i) => {
    const ln = String(startLine + i).padStart(padW, ' ');
    return `<span class="lineno">${ln}</span>${line}`;
  }).join('\n');
}

/* In-code search. Walks the rendered code's text nodes and wraps
   matches in <mark class="m">. Avoids touching <span class="lineno">
   gutter entries so a query for "10" doesn't match the line
   number. Skipped entirely on empty query. */
function runCodeSearch(rawQuery) {
  const codeEl = document.getElementById('d-code');
  const countEl = document.getElementById('d-code-find-count');
  if (!codeOriginalHtml) { countEl.textContent = ''; return; }
  // Restore unmarked DOM first.
  codeEl.innerHTML = codeOriginalHtml;
  codeMatches = [];
  codeMatchIndex = -1;
  const query = rawQuery.trim();
  if (!query) { countEl.textContent = ''; return; }
  const queryLower = query.toLowerCase();
  // Walk text nodes, skip linenos, replace matches with <mark>.
  const walker = document.createTreeWalker(codeEl, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      if (n.parentElement?.classList.contains('lineno')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.toLowerCase().includes(queryLower)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  const targets = [];
  let cur; while ((cur = walker.nextNode())) targets.push(cur);
  for (const t of targets) wrapMatches(t, queryLower);
  codeMatches = Array.from(codeEl.querySelectorAll('mark.m'));
  if (codeMatches.length > 0) {
    codeMatchIndex = 0;
    codeMatches[0].classList.add('active');
    codeMatches[0].scrollIntoView({ block: 'center' });
  }
  countEl.textContent = codeMatches.length === 0 ? 'no matches' : `${codeMatchIndex + 1}/${codeMatches.length}`;
}

/* Replace one text node's matching substrings with <mark> nodes. */
function wrapMatches(textNode, queryLower) {
  const text = textNode.nodeValue;
  if (!text) return;
  const lower = text.toLowerCase();
  const qlen = queryLower.length;
  const frag = document.createDocumentFragment();
  let i = 0;
  while (i < text.length) {
    const j = lower.indexOf(queryLower, i);
    if (j < 0) {
      frag.appendChild(document.createTextNode(text.slice(i)));
      break;
    }
    if (j > i) frag.appendChild(document.createTextNode(text.slice(i, j)));
    const mark = document.createElement('mark');
    mark.className = 'm';
    mark.textContent = text.slice(j, j + qlen);
    frag.appendChild(mark);
    i = j + qlen;
  }
  textNode.parentNode.replaceChild(frag, textNode);
}

function stepCodeMatch(delta) {
  if (codeMatches.length === 0) return;
  codeMatches[codeMatchIndex]?.classList.remove('active');
  codeMatchIndex = (codeMatchIndex + delta + codeMatches.length) % codeMatches.length;
  const next = codeMatches[codeMatchIndex];
  next.classList.add('active');
  next.scrollIntoView({ block: 'center' });
  document.getElementById('d-code-find-count').textContent = `${codeMatchIndex + 1}/${codeMatches.length}`;
}

document.getElementById('d-code-search').addEventListener('input', (e) => runCodeSearch(e.target.value));
document.getElementById('d-code-search').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (codeMatches.length === 0) runCodeSearch(e.target.value);
    else stepCodeMatch(e.shiftKey ? -1 : +1);
  } else if (e.key === 'Escape') {
    e.preventDefault();
    e.target.value = '';
    runCodeSearch('');
    e.target.blur();
  }
});
document.getElementById('d-code-find-prev').addEventListener('click', () => stepCodeMatch(-1));
document.getElementById('d-code-find-next').addEventListener('click', () => stepCodeMatch(+1));

/* Render the symbol's JSDoc / preceding-comment block into the
   detail pane. Strips `/**` and leading `*` markers so the prose
   reads cleanly. The block is collapsed by default to a 3-line
   teaser; clicking the toggle expands it inline. Per-symbol open
   state is persisted in `docExpandedFor` so navigating back to a
   previously-expanded symbol keeps it open. */
const docExpandedFor = new Set();

function renderDocstringPreview(raw, symbolId) {
  const el = document.getElementById('d-doc');
  if (!raw) { el.style.display = 'none'; el.innerHTML = ''; return; }
  const cleaned = String(raw)
    .replace(/^\s*\/\*+/, '')
    .replace(/\*+\/\s*$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim();
  if (!cleaned) { el.style.display = 'none'; el.innerHTML = ''; return; }
  // Decide whether to show the toggle: if the rendered docstring
  // would actually exceed 3 lines (rough heuristic: any newline
  // past line 3, or total chars > 220), surface the toggle.
  const lineCount = cleaned.split('\n').length;
  const longish = lineCount > 3 || cleaned.length > 220;
  const expanded = symbolId && docExpandedFor.has(symbolId);
  el.style.display = 'block';
  el.classList.toggle('expanded', expanded);
  let toggleHtml = '';
  if (longish) {
    const toggleText = expanded ? '⌃ Collapse' : '⌄ Expand';
    toggleHtml = `<div class="docstring-toggle">${toggleText}</div>`;
  }
  el.innerHTML = `<div class="docstring-body"></div>${toggleHtml}`;
  // textContent (not innerHTML) for the body so docstring text
  // can't inject HTML.
  el.querySelector('.docstring-body').textContent = cleaned;
}

document.getElementById('d-doc').addEventListener('click', (e) => {
  const toggle = e.target.closest('.docstring-toggle');
  if (!toggle) return;
  const el = document.getElementById('d-doc');
  const symbolId = liveSymbolCache?.id || null;
  el.classList.toggle('expanded');
  toggle.textContent = el.classList.contains('expanded') ? '⌃ Collapse' : '⌄ Expand';
  if (symbolId) {
    if (el.classList.contains('expanded')) docExpandedFor.add(symbolId);
    else docExpandedFor.delete(symbolId);
  }
});
