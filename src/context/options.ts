import type { BuildContextOptions, FindRelevantContextOptions, NodeKind } from '../types.js';

const DEFAULT_SEARCH_LIMIT = 3;
const DEFAULT_TRAVERSAL_DEPTH = 1;
const DEFAULT_MAX_NODES = 20;
const DEFAULT_MIN_SCORE = 0.3;

const MAX_SEARCH_LIMIT = 100;
const MAX_NODES = 1000;
const MAX_TRAVERSAL_DEPTH = 10;

/**
 * Node kinds with high information value in context results. Import/export
 * symbols are excluded because they mostly describe availability, not behavior.
 */
export const HIGH_VALUE_NODE_KINDS: readonly NodeKind[] = [
  'function',
  'method',
  'class',
  'interface',
  'type_alias',
  'struct',
  'trait',
  'component',
  'route',
  'variable',
  'constant',
  'enum',
  'module',
  'namespace',
];

const DEFAULT_BUILD_OPTIONS: Required<BuildContextOptions> = {
  maxNodes: DEFAULT_MAX_NODES,
  maxCodeBlocks: 5,
  maxCodeBlockSize: 1500,
  includeCode: true,
  format: 'markdown',
  searchLimit: DEFAULT_SEARCH_LIMIT,
  traversalDepth: DEFAULT_TRAVERSAL_DEPTH,
  minScore: DEFAULT_MIN_SCORE,
  extraCandidates: [],
  behaviorBias: false,
  explain: false,
};

const DEFAULT_FIND_OPTIONS: Required<FindRelevantContextOptions> = {
  searchLimit: DEFAULT_SEARCH_LIMIT,
  traversalDepth: DEFAULT_TRAVERSAL_DEPTH,
  maxNodes: DEFAULT_MAX_NODES,
  minScore: DEFAULT_MIN_SCORE,
  edgeKinds: [],
  nodeKinds: [...HIGH_VALUE_NODE_KINDS],
  extraCandidates: [],
  behaviorBias: false,
  explain: false,
};

const DEFAULT_TEXT_SEARCH_KINDS: readonly NodeKind[] = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'export',
  'route',
  'component',
];

export function normalizeBuildOptions(options: BuildContextOptions = {}): Required<BuildContextOptions> {
  const opts = { ...DEFAULT_BUILD_OPTIONS, ...options };
  return {
    ...opts,
    extraCandidates: [...opts.extraCandidates],
  };
}

export function normalizeFindOptions(options: FindRelevantContextOptions = {}): Required<FindRelevantContextOptions> {
  const opts = { ...DEFAULT_FIND_OPTIONS, ...options };
  return {
    ...opts,
    searchLimit: clamp(opts.searchLimit, 1, MAX_SEARCH_LIMIT),
    maxNodes: clamp(opts.maxNodes, 1, MAX_NODES),
    traversalDepth: clamp(opts.traversalDepth, 0, MAX_TRAVERSAL_DEPTH),
    edgeKinds: [...opts.edgeKinds],
    nodeKinds: [...opts.nodeKinds],
    extraCandidates: [...opts.extraCandidates],
  };
}

/** Pick search kinds for the multi-term text-search pass. */
export function pickSearchKinds(callerKinds: readonly NodeKind[] | undefined): NodeKind[] {
  if (callerKinds && callerKinds.length > 0) return [...callerKinds];
  return [...DEFAULT_TEXT_SEARCH_KINDS];
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, value), max);
}
