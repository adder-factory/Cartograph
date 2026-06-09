import type { Language, Node, NodeKind } from '../../types.js';
import { makeLineIndex } from '../../utils.js';

export interface FrameworkNodeAtOffsetArgs {
  idPrefix: string;
  kind: NodeKind;
  name: string;
  filePath: string;
  content: string;
  offset: number;
  language: Language;
  signature: string;
}

export function makeFrameworkNodeAtOffset(args: FrameworkNodeAtOffsetArgs): Node {
  const lineOf = makeLineIndex(args.content);
  const line = lineOf(args.offset);
  const column = Math.max(0, args.offset - (args.content.lastIndexOf('\n', args.offset - 1) + 1));
  return {
    id: `${args.idPrefix}:${args.filePath}:${line}:${args.name}`,
    kind: args.kind,
    name: args.name,
    qualifiedName: `${args.filePath}#${args.name}`,
    filePath: args.filePath,
    language: args.language,
    startLine: line,
    endLine: line,
    startColumn: column,
    endColumn: column + args.name.length,
    signature: args.signature,
    updatedAt: Date.now(),
  };
}
