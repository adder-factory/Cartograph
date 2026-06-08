import type { UnresolvedReference } from '../../extraction/types.js';
import type { Node } from '../../types.js';

export function makeFrameworkReference(
  node: Node,
  referenceName: string,
  referenceKind: UnresolvedReference['referenceKind'] = 'references',
): UnresolvedReference {
  return {
    fromNodeId: node.id,
    referenceName,
    referenceKind,
    line: node.startLine,
    column: node.startColumn,
    filePath: node.filePath,
    language: node.language,
  };
}
