import type { Node } from '../types.js';
import type { ResolutionContext, UnresolvedRef } from './types.js';

/**
 * C++ out-of-class method definitions are extracted as functions named
 * `Class::method`. Treat those as method targets when a class receiver
 * has already been established by the name matcher.
 */
export function findCppOutOfClassMethod(args: {
  classNode: Node;
  methodName: string;
  ref: UnresolvedRef;
  context: ResolutionContext;
}): Node | undefined {
  const { classNode, methodName, ref, context } = args;
  if (ref.language !== 'cpp') return undefined;
  const qualifiedName = `${classNode.name}::${methodName}`;
  return [...context.getNodesByName(qualifiedName), ...context.getNodesByQualifiedName(qualifiedName)].find(
    (n) => n.kind === 'function' && n.language === 'cpp',
  );
}
