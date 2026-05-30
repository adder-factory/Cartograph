/**
 * Shared skeleton for string-literal miners.
 *
 * Both `src/sql-refs/index.ts` and `src/build-context-refs/index.ts`
 * follow the same outer loop pattern:
 *   1. Skip unsupported languages.
 *   2. Validate the path is within the project root.
 *   3. Read the file.
 *   4. Strip comments (length/newline-preserving) so doc-comment
 *      examples aren't mined as real usage sites.
 *   5. Iterate lines with a cheap pre-filter.
 *   6. Delegate to a caller-supplied per-line collector.
 *
 * This module owns that skeleton so neither miner duplicates it.
 * The two modules remain fully independent — they import only from
 * this neutral location, not from each other.
 */

import * as fs from 'node:fs';
import { logDebug, errMsg, logWarn } from './errors.js';
import { validatePathWithinRootReal, stripCommentsForRegex } from './utils.js';

interface MinerFileTarget {
  path: string;
  language: string;
}

/**
 * Resolver supplied by each miner's caller: (filePath, line) →
 * enclosing nodeId. Returns null when the site is at file top-level.
 */
type MinerEnclosingNodeResolver = (filePath: string, line: number) => string | null;

interface ExtractRefsFromTargetsArgs<TRef> {
  /** Project root directory (absolute). Used for path validation. */
  rootDir: string;
  /** Iterable of (path, language) targets to scan. */
  targets: Iterable<MinerFileTarget>;
  /** Resolver for the enclosing function/method. */
  resolveEnclosing: MinerEnclosingNodeResolver;
  /** Name of the calling extractor, used in warning messages. */
  extractorName: string;
  /** Return true iff this language should be scanned. */
  isLanguageSupported: (language: string) => boolean;
  /**
   * Cheap per-line pre-filter. Return false to skip the line without
   * running the per-pattern collect logic.
   */
  lineMatches: (line: string) => boolean;
  /**
   * Collect refs from a single line that passed `lineMatches`.
   * Implementations append to `refs` in-place.
   */
  collectRefsForLine: (args: {
    refs: TRef[];
    line: string;
    lineNo: number;
    target: MinerFileTarget;
    resolveEnclosing: MinerEnclosingNodeResolver;
  }) => void;
}

/**
 * Run the standard miner loop over `targets`, returning all collected
 * refs. Pure I/O + regex; the caller owns DB writes.
 */
function extractRefsFromTargets<TRef>(args: ExtractRefsFromTargetsArgs<TRef>): TRef[] {
  const { rootDir, targets, resolveEnclosing, extractorName, isLanguageSupported, lineMatches, collectRefsForLine } =
    args;
  const refs: TRef[] = [];
  for (const t of targets) {
    if (!isLanguageSupported(t.language)) continue;
    const abs = validatePathWithinRootReal(rootDir, t.path);
    if (!abs) {
      logWarn(`Path traversal blocked in ${extractorName}`, { filePath: t.path });
      continue;
    }
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      logDebug(`${extractorName}: read failed for ${t.path}: ${errMsg(err)}`);
      continue;
    }
    const lines = stripCommentsForRegex(src, t.language).split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (!lineMatches(line)) continue;
      collectRefsForLine({ refs, line, lineNo: i + 1, target: t, resolveEnclosing });
    }
  }
  return refs;
}

/** A configured string-literal miner: closes over its spec and scans
 *  whatever (path, language) targets it is handed. */
export type RefMiner<TRef> = (
  rootDir: string,
  targets: Iterable<MinerFileTarget>,
  resolveEnclosing: MinerEnclosingNodeResolver,
) => TRef[];

/** Per-miner specifics — everything in {@link ExtractRefsFromTargetsArgs}
 *  except the three per-call inputs. */
type RefMinerSpec<TRef> = Omit<ExtractRefsFromTargetsArgs<TRef>, 'rootDir' | 'targets' | 'resolveEnclosing'>;

/**
 * Build a string-literal miner from its spec. `sql-refs` and
 * `build-context-refs` are each one `makeRefMiner` call — the
 * entry-point wrapper (bind the spec, forward the three per-call
 * inputs to the shared scan loop) is defined once here instead of
 * being duplicated per miner module.
 */
export function makeRefMiner<TRef>(spec: RefMinerSpec<TRef>): RefMiner<TRef> {
  return (rootDir, targets, resolveEnclosing) =>
    extractRefsFromTargets<TRef>({ rootDir, targets, resolveEnclosing, ...spec });
}
