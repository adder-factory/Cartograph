import type { Edge, NodeKind } from '../types.js';

/**
 * Node kinds that hold type-usage incoming edges rather than call edges.
 * Class / interface / type_alias / etc. are reached via instantiates /
 * type_of / returns / extends / implements.
 */
export const TYPE_LIKE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'interface',
  'class',
  'struct',
  'type_alias',
  'enum',
  'trait',
  'protocol',
  'component',
  'module',
]);

/**
 * Edge kinds that represent type-usage of a type-like node. Typed array so
 * callers can hand it straight to `getIncomingEdges`.
 */
export const TYPE_USAGE_EDGE_KINDS: Edge['kind'][] = ['instantiates', 'type_of', 'returns', 'extends', 'implements'];
