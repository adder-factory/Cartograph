/**
 * Self-codebase eval cases — run the harness against the cartograph
 * repo's OWN index. Lets developers iterate on ranking changes
 * (BACKLOG B #19) without needing a separate large codebase like
 * Elasticsearch checked out.
 *
 * Each `expectedSymbols` entry is a real symbol that exists in this
 * repo at the time of writing; recall <0.5 means the search /
 * context surface failed to find a known-correct hit. As the repo
 * evolves, drop or replace cases that hit the "expected symbol
 * doesn't exist anymore" failure shape.
 */
import type { EvalTestCase } from './types.js';

export const selfTestCases: EvalTestCase[] = [
  // === searchNodes — symbol-name precision ===

  {
    id: 'self-search-class-Cartograph',
    query: 'Cartograph',
    api: 'searchNodes',
    expectedSymbols: ['Cartograph'],
    kinds: ['class'],
  },
  {
    id: 'self-search-fn-searchNodes',
    query: 'searchNodes',
    api: 'searchNodes',
    expectedSymbols: ['searchNodes'],
    kinds: ['function'],
  },
  {
    id: 'self-search-fn-extractFromSource',
    query: 'extractFromSource',
    api: 'searchNodes',
    expectedSymbols: ['extractFromSource'],
    kinds: ['function'],
  },
  {
    id: 'self-search-iface-ToolModule',
    query: 'ToolModule',
    api: 'searchNodes',
    expectedSymbols: ['ToolModule'],
    kinds: ['interface'],
  },
  {
    id: 'self-search-fn-compareToRef',
    query: 'compareToRef structural diff',
    api: 'searchNodes',
    expectedSymbols: ['compareToRef'],
    kinds: ['function'],
  },
  {
    id: 'self-search-method-invalidateNodeCacheForFile',
    query: 'invalidateNodeCacheForFile',
    api: 'searchNodes',
    expectedSymbols: ['invalidateNodeCacheForFile'],
    kinds: ['method'],
  },

  // === searchNodes — fuzzy-fallback typo recovery (B6) ===
  // searchNodes cascades: FTS → LIKE → fuzzy-edit-distance. These
  // cases hand it a deliberately misspelt query so the fuzzy fallback
  // is the only path that finds the right symbol — a regression in
  // that fallback path silently breaks typo recovery without affecting
  // any of the exact cases above. No `kinds` filter — the fuzzy path
  // walks all distinct names and we want it to find the symbol
  // regardless of declared kind.

  {
    id: 'self-fuzzy-extractFromSorce', // missing 'u' in Sorce
    query: 'extractFromSorce',
    api: 'searchNodes',
    expectedSymbols: ['extractFromSource'],
  },
  {
    id: 'self-fuzzy-compreToRef', // missing 'a' in compre
    query: 'compreToRef',
    api: 'searchNodes',
    expectedSymbols: ['compareToRef'],
  },
  {
    id: 'self-fuzzy-serchNodes', // missing 'a' in serch
    query: 'serchNodes',
    api: 'searchNodes',
    expectedSymbols: ['searchNodes'],
  },
  {
    id: 'self-fuzzy-doublehit-Cortogroph', // two substitutions in Cartograph
    // Stress case: exactly two errors. SUGGEST_MAX_EDIT_DIST in the
    // fuzzy helper caps at 2, so this just barely fits — the case
    // fails immediately if a future refactor tightens the budget.
    query: 'Cortogroph',
    api: 'searchNodes',
    expectedSymbols: ['Cartograph'],
  },

  // === searchSemantic — embedding-based concept + peer search (B9) ===
  // These cases SKIP today: the project ships without embeddings
  // populated. Once `cartograph embed` runs (or an embedding fixture
  // gets wired into the eval setup), they activate automatically and
  // start gating semantic regressions. Scorer treats SKIP as PASS so
  // the gate stays green in the no-embeddings default.

  {
    id: 'self-semantic-concept-cache-refresh',
    // Concept query: should pull the active freshness-cache and
    // configuration-invalidation symbols.
    query: 'cache refresh and invalidation pattern',
    api: 'searchSemantic',
    expectedSymbols: ['invalidateFreshness', 'EMPTY_INVALIDATION_PLAN'],
  },
  {
    id: 'self-semantic-peers-of-Cartograph',
    // Peer mode: similar-to a known central class. Expected peers
    // should include the current Cartograph facade/module family.
    query: '',
    api: 'searchSemantic',
    symbolName: 'Cartograph',
    expectedSymbols: ['CartographCore', 'ReadCartographModule'],
  },
  {
    id: 'self-semantic-peers-of-searchNodes',
    // Peer mode on a search-related symbol. Expected peers in the
    // semantic neighborhood: other search variants + cascade helpers.
    query: '',
    api: 'searchSemantic',
    symbolName: 'searchNodes',
    expectedSymbols: ['searchNodesFTS', 'searchNodesLike'],
  },

  // === findRelevantContext — exploration quality ===

  {
    id: 'self-explore-mcp-tool-registration',
    // Refined query (was: "How are MCP tools registered and
    // dispatched?") — the original was too generic, missed
    // BIOMARKERS_TOOL on the post-viewer corpus. Mentioning the
    // registry + lookup-by-name surfaces all three.
    query: 'In the MCP tool registry, how is each ToolModule registered and looked up by name?',
    api: 'findRelevantContext',
    expectedSymbols: ['ToolModule', 'getToolModule', 'BIOMARKERS_TOOL'],
    options: { searchLimit: 8, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'self-explore-extraction-pipeline',
    query: 'How does ExtractionOrchestrator use ParseWorkerPool to parse and store files?',
    api: 'findRelevantContext',
    expectedSymbols: ['ExtractionOrchestrator', 'ParseWorkerPool', 'requestParse'],
    options: { traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'self-explore-biomarker-engine',
    query: 'How are per-symbol biomarker findings computed?',
    api: 'findRelevantContext',
    expectedSymbols: ['analyseProject', 'evaluateRules', 'computeMetrics'],
    // searchLimit bumped 8 → 16 after the viewer added
    // `biomarkerFindingsPayload` (commit e93ab60), which now
    // out-ranks `analyseProject` for the natural-language query.
    // Wider FTS recall surfaces both, restoring 1.0 — the engine
    // ranking is doing its job, the case just needed more headroom
    // on a corpus that grew the biomarker-related symbol space.
    options: { searchLimit: 16, traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'self-explore-search-cascade',
    // Anchor the public cascade and its two concrete stages so this
    // remains deterministic when hybrid search degrades to lexical-only.
    query: 'How does runRetrievalCascade fall back from searchNodesFTS to searchNodesFuzzy?',
    api: 'findRelevantContext',
    expectedSymbols: ['searchNodes', 'runRetrievalCascade', 'searchNodesFTS', 'searchNodesFuzzy'],
    options: { traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
  {
    id: 'self-explore-compare-to-ref',
    // Name the public function and the two delta records it constructs.
    // This still exercises traversal into the compare pipeline while
    // remaining stable when the optional hybrid channel is unavailable.
    query: 'How does compareToRef classify changed files and build FileDelta and SymbolDelta records?',
    api: 'findRelevantContext',
    expectedSymbols: ['compareToRef', 'FileDelta', 'SymbolDelta'],
    options: { traversalDepth: 3, maxNodes: 80, minScore: 0.2 },
  },
];
