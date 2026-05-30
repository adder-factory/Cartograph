/**
 * Shared framework-resolver helper.
 *
 * Resolve a symbol by name + kind using indexed queries, preferring
 * candidates in framework-conventional directories. Extracted from the
 * per-language framework resolvers (python / swift / java / csharp /
 * rust), which each carried an identical copy.
 */

import type { ResolutionContext } from '../types.js';

interface ResolveByNameArgs {
  name: string;
  kinds: Set<string>;
  preferredDirPatterns: string[];
  context: ResolutionContext;
}

/**
 * Resolve a symbol by name using indexed queries instead of scanning all
 * files. Filters candidates to `kinds`, then prefers any whose file path
 * contains one of `preferredDirPatterns`, falling back to the first match.
 */
export function resolveByNameAndKind(args: ResolveByNameArgs): string | null {
  const { name, kinds, preferredDirPatterns, context } = args;
  const candidates = context.getNodesByName(name);
  if (candidates.length === 0) return null;

  const kindFiltered = candidates.filter((n) => kinds.has(n.kind));
  if (kindFiltered.length === 0) return null;

  // Prefer candidates in framework-conventional directories
  const preferred = kindFiltered.filter((n) => preferredDirPatterns.some((d) => n.filePath.includes(d)));
  if (preferred.length > 0) return preferred[0]!.id;

  // Fall back to any match
  return kindFiltered[0]!.id;
}
