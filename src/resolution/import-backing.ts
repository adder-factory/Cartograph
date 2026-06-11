/**
 * Import-backing checks for pure-name resolution.
 *
 * "Backing" means the ref's file explicitly imports the bare name under
 * that local binding. Name-match strategies consult these helpers to
 * decide when a pure-name hit must yield to the import resolver.
 */

import type { ImportMapping, ResolutionContext, UnresolvedRef } from './types.js';
import { isCompatibleLanguage } from './name-matcher-receivers.js';

/**
 * F2 — true when `localName` is imported into `ref`'s file under that
 * local binding (`import { map } from './util.js'`). A genuine same-
 * name import is concrete EXTRACTED-confidence backing, so the builtin-
 * method suppression must NOT fire — `map(...)` then really does call
 * the imported `map`, and `someMap.set(...)` where `someMap` is an
 * imported value is a real cross-module receiver. Namespace imports
 * (`import * as x`) DO count for the receiver case: `x.set()` legitimately
 * targets the namespace's `set` export.
 *
 * Pass the bare callee name for unqualified calls, or the receiver
 * identifier for `receiver.method` calls.
 */
export function hasConcreteImportBacking(ref: UnresolvedRef, context: ResolutionContext, localName: string): boolean {
  let imports: ImportMapping[];
  try {
    imports = context.getImportMappings(ref.filePath, ref.language);
  } catch {
    // Conservative: an import-lookup failure must not cause suppression
    // of a possibly-real edge. Treat as "backing unknown → assume backed".
    return true;
  }
  return imports.some((imp) => imp.localName === localName);
}

/**
 * A bare name that the ref's file explicitly imports must not pure-name
 * match a node in an INCOMPATIBLE language — the import resolver owns
 * that binding (direct resolution at 0.9, or the external-import
 * fallback at 0.4). Without this gate, `import { describe } from
 * 'bun:test'` plus a single ObjC `-describe` method in the project
 * produced hundreds of phantom cross-language calls/references edges —
 * enough to make a doc-fixture method the top-centrality node in the
 * repo. JVM languages stay exempt: Kotlin↔Java same-name resolution is
 * real and `isCompatibleLanguage` already models it.
 */
export function isImportShadowedCrossLanguageMatch(
  ref: UnresolvedRef,
  context: ResolutionContext,
  candidate: { language: string },
): boolean {
  if (isCompatibleLanguage(ref.language, candidate.language)) return false;
  const name = ref.referenceName;
  if (name.includes('.') || name.includes('::') || name.includes('/')) return false;
  return hasConcreteImportBacking(ref, context, name);
}
