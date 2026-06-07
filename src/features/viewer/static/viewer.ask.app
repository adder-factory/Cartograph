/* List of biomarker names used by the intent detector. Mirrors
   src/biomarkers/types.ts; rename / extend there to keep this in
   sync. Lowercase + underscore form is what the API expects. */
const KNOWN_BIOMARKERS = new Set([
  'large_method', 'complex_method', 'nested_complexity',
  'complex_conditional', 'brain_method', 'long_parameter_list',
  'magic_number', 'hardcoded_url', 'recently_grew', 'stale_doc',
  'unused_export', 'god_class', 'feature_envy',
]);
const BIOMARKER_ALIASES = {
  'god classes': 'god_class', 'god class': 'god_class',
  'large methods': 'large_method', 'large method': 'large_method',
  'complex methods': 'complex_method', 'complex method': 'complex_method',
  'unused exports': 'unused_export', 'unused export': 'unused_export',
  'brain methods': 'brain_method', 'feature envies': 'feature_envy',
  'errors': 'error', 'warnings': 'warning',
};

/* Try to interpret the question as a navigation command. Returns
   one of: { kind: 'biomarker', name } | { kind: 'symbol', name }
   | null (fall through to LLM). The detector is intentionally
   conservative — only obvious "show me X" / bare-biomarker-name
   inputs match, so general questions still hit the LLM. */
function detectIntent(raw) {
  const q = raw.trim().toLowerCase();
  // Bare biomarker name → biomarker filter.
  if (KNOWN_BIOMARKERS.has(q)) return { kind: 'biomarker', name: q };
  if (BIOMARKER_ALIASES[q]) return { kind: 'biomarker', name: BIOMARKER_ALIASES[q] };
  // "show me god_class", "find god classes", "where are the god classes"
  const commandPrefixes = ['show me ', 'show ', 'find ', 'locate ', 'where is ', 'where are ', 'where the ', 'list '];
  const prefix = commandPrefixes.find((candidate) => q.startsWith(candidate));
  if (prefix) {
    let target = q.slice(prefix.length).trim();
    if (target.endsWith('?')) target = target.slice(0, -1).trim();
    if (target.startsWith('all ')) target = target.slice(4).trim();
    if (target.startsWith('the ')) target = target.slice(4).trim();
    if (KNOWN_BIOMARKERS.has(target)) return { kind: 'biomarker', name: target };
    if (BIOMARKER_ALIASES[target]) return { kind: 'biomarker', name: BIOMARKER_ALIASES[target] };
    // Otherwise treat as a symbol name (preserve original case).
    const symbolName = raw.trim().slice(prefix.length).replace(/\?$/, '').trim().replace(/^(?:all|the)\s+/i, '');
    return { kind: 'symbol', name: symbolName };
  }
  return null;
}

/* Apply a biomarker filter — dim every cy node that doesn't carry
   a finding of that biomarker, focus the highest-centrality one,
   and post a clickable summary into the chat. */
let activeBiomarkerFilter = null;

function syncBiomarkerFilterClasses() {
  if (!activeBiomarkerFilter) return;
  cy.nodes().forEach((n) => {
    if (n.data('isGroup') || n.data('collapsedProxy') || n.data('detailBucket')) return;
    n.toggleClass('dim', !activeBiomarkerFilter.has(n.id()));
  });
}

async function applyBiomarkerFilter(name, history) {
  try {
    const r = await fetch(`/api/findings/${encodeURIComponent(name)}?limit=80`);
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      const msg = document.createElement('div');
      msg.className = 'askpanel-msg err';
      msg.textContent = err.error || `HTTP ${r.status}`;
      history.appendChild(msg);
      return;
    }
    const data = await r.json();
    const findings = data.findings || [];
    activeBiomarkerFilter = new Set(findings.map((f) => f.id));
    // Dim non-matching nodes; highlight matches.
    cy.nodes().removeClass('focus');
    syncBiomarkerFilterClasses();
    // Auto-focus the top hit if any of them are in cy already.
    const inGraph = findings.find((f) => cy.getElementById(f.id).length > 0);
    if (inGraph) {
      cy.getElementById(inGraph.id).addClass('focus');
      await selectSymbolLive(inGraph.id);
    } else if (findings[0]) {
      // No match in current cy — re-anchor the graph on the top hit.
      await searchAndFocus(findings[0].id);
    }
    // Render an answer-shaped summary with clickable hits.
    const ans = document.createElement('div');
    ans.className = 'askpanel-msg a';
    ans.innerHTML = `Filtered to <b>${escapeHtml(name)}</b> · ${findings.length} matching symbol${findings.length === 1 ? '' : 's'}<br>` +
      findings.slice(0, 12).map((f) =>
        `<a class="ask-link" data-symbol="${escapeHtml(f.id)}">${escapeHtml(f.name)}</a> <span class="ask-loc">${escapeHtml(f.file)} · ${f.severity}/${f.metric}</span>`
      ).join('<br>') +
      (findings.length > 12 ? `<br><span class="ask-loc">+${findings.length - 12} more</span>` : '') +
      `<br><br><a class="ask-link clear-filter" data-action="clear-biomarker">⊘ Clear filter</a>`;
    history.appendChild(ans);
  } catch (err) {
    const msg = document.createElement('div');
    msg.className = 'askpanel-msg err';
    msg.textContent = `Failed to apply filter: ${String(err)}`;
    history.appendChild(msg);
  }
}

function clearBiomarkerFilter() {
  activeBiomarkerFilter = null;
  cy.nodes().removeClass('dim');
}

/* Turn backtick-quoted identifiers in an answer into <a> links.
   `foo` → <a class="ask-link" data-symbol="foo">foo</a>.
   Escapes the surrounding text so the answer can't inject HTML. */
function renderAnswerWithCitations(text) {
  // Split on backticks so we can wrap odd-indexed (inside ``) parts.
  const parts = String(text ?? '').split('`');
  return parts.map((part, i) => {
    const safe = escapeHtml(part);
    if (i % 2 === 1 && /^[A-Za-z_][\w$]*$/.test(part)) {
      // Plain identifier in backticks — render as link.
      return `<a class="ask-link" data-symbol="${safe}">${safe}</a>`;
    }
    if (i % 2 === 1) {
      // Some other backticked content (e.g., a path or expression) —
      // keep monospace styling but not clickable.
      return `<code>${safe}</code>`;
    }
    return safe;
  }).join('');
}

/* Click delegate inside the chat history for inline links —
   clickable symbols and the Clear-filter action. */
document.getElementById('ask-history').addEventListener('click', (e) => {
  const link = e.target.closest('a.ask-link');
  if (!link) return;
  if (link.dataset.action === 'clear-biomarker') {
    clearBiomarkerFilter();
    const ack = document.createElement('div');
    ack.className = 'askpanel-msg a';
    ack.textContent = 'Filter cleared.';
    document.getElementById('ask-history').appendChild(ack);
    return;
  }
  const sym = link.dataset.symbol;
  if (sym && LIVE_MODE) searchAndFocus(sym);
});

/* Captured source selection — refreshed on selectionchange whenever
   the active selection lives inside the code panel. Kept around so
   the user can highlight code, then click into the chat to ask
   "refactor this" without losing the selection. */
let capturedSelection = '';
let capturedSelectionLines = 0;

function updateAskSelectionChip() {
  const chip = document.getElementById('ask-selection-chip');
  const count = document.getElementById('ask-selection-count');
  if (!capturedSelection) { chip.hidden = true; return; }
  chip.hidden = false;
  count.textContent = `${capturedSelectionLines} line${capturedSelectionLines === 1 ? '' : 's'} selected`;
}

document.addEventListener('selectionchange', () => {
  const sel = globalThis.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    // Don't clear immediately — user might be moving focus to the
    // chat input. Only clear when an entirely-different focus
    // grabs the selection.
    return;
  }
  const range = sel.getRangeAt(0);
  const codeEl = document.getElementById('d-code');
  if (!codeEl.contains(range.commonAncestorContainer)) return;
  // Build a clean string from the selection, stripping line-number
  // gutter spans (marked with .lineno).
  const fragment = range.cloneContents();
  fragment.querySelectorAll('.lineno').forEach((el) => el.remove());
  const text = fragment.textContent ?? '';
  if (!text.trim()) return;
  capturedSelection = text;
  capturedSelectionLines = text.split('\n').filter((l) => l.length > 0 || true).length;
  // Recompute lines as the count of newlines + 1.
  capturedSelectionLines = (text.match(/\n/g)?.length ?? 0) + 1;
  updateAskSelectionChip();
});

document.getElementById('ask-selection-clear').addEventListener('click', () => {
  capturedSelection = '';
  capturedSelectionLines = 0;
  updateAskSelectionChip();
  globalThis.getSelection()?.removeAllRanges();
});

/* Ask-AI panel wiring.
   Submitting first runs intent detection — bare biomarker names,
   "show me <X>" / "find <X>" patterns trigger viewer navigation
   directly without burning an LLM call. Anything else POSTs to
   /api/ask (which delegates to cg.llm.ask), with any active code
   selection folded in as context. */
async function submitAsk(question) {
  const target = liveSymbolCache?.label || (LIVE_MODE ? null : 'extractFromSource');
  const history = document.getElementById('ask-history');
  const submitBtn = document.getElementById('ask-submit');
  // Render the user message.
  const qNode = document.createElement('div');
  qNode.className = 'askpanel-msg q';
  qNode.textContent = question;
  history.appendChild(qNode);

  // Intent detection — does this match a navigation pattern?
  // If yes, handle in-app and skip the LLM round-trip.
  const intent = detectIntent(question);
  if (intent && LIVE_MODE) {
    submitBtn.disabled = true;
    try {
      if (intent.kind === 'biomarker') {
        await applyBiomarkerFilter(intent.name, history);
      } else if (intent.kind === 'symbol') {
        await searchAndFocus(intent.name);
        const ack = document.createElement('div');
        ack.className = 'askpanel-msg a';
        ack.innerHTML = `Focused on <a class="ask-link" data-symbol="${escapeHtml(intent.name)}">${escapeHtml(intent.name)}</a>.`;
        history.appendChild(ack);
      }
    } finally {
      submitBtn.disabled = false;
      history.scrollTop = history.scrollHeight;
    }
    return;
  }

  // Render a loading placeholder.
  const loading = document.createElement('div');
  loading.className = 'askpanel-msg loading';
  loading.textContent = 'Thinking…';
  history.appendChild(loading);
  history.scrollTop = history.scrollHeight;
  submitBtn.disabled = true;

  try {
    if (!LIVE_MODE) {
      loading.classList.replace('loading', 'err');
      loading.textContent = 'Ask is only available in live mode (cartograph viewer CLI), not in the standalone mockup.';
      return;
    }
    const r = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, symbol: target, selection: capturedSelection }),
    });
    const data = await r.json();
    if (!r.ok || data.error) {
      loading.classList.replace('loading', 'err');
      const errBody = document.createElement('div');
      errBody.textContent = data.error || `HTTP ${r.status}`;
      loading.textContent = '';
      loading.appendChild(errBody);
      if (data.hint) {
        const hint = document.createElement('div');
        hint.className = 'hint';
        hint.textContent = data.hint;
        loading.appendChild(hint);
      }
      return;
    }
    loading.classList.replace('loading', 'a');
    // Render the answer with backtick-quoted identifiers turned
    // into clickable links — same convention cartograph_ask uses
    // for citation grounding. The click delegate above routes
    // them through searchAndFocus.
    loading.innerHTML = renderAnswerWithCitations(data.answer || '(empty answer)');
  } catch (err) {
    loading.classList.replace('loading', 'err');
    loading.textContent = `Network error: ${String(err)}`;
  } finally {
    submitBtn.disabled = false;
    history.scrollTop = history.scrollHeight;
  }
}

document.getElementById('ask-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('ask-input');
  const q = input.value.trim();
  if (!q) return;
  submitAsk(q);
  input.value = '';
});

document.getElementById('ask-input').addEventListener('keydown', (e) => {
  // Cmd/Ctrl+Enter submits — natural for multi-line textareas.
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('ask-form').requestSubmit();
  }
});

function updateAskTarget(label) {
  const el = document.getElementById('ask-target');
  if (el) el.textContent = label || 'this symbol';
}
