/**
 * Build-context reference extraction.
 *
 * Scans indexed source files for module-format-sensitive identifiers:
 * `__dirname`, `__filename`, `import.meta.dirname`, `import.meta.filename`,
 * `import.meta.url`. These are surface-area for any module-format
 * migration — the agent needs to find every site to plan a CJS↔ESM
 * conversion.
 *
 * Mirrors the shape of `src/config-refs/`: pure I/O + regex; the
 * caller persists rows via `applyBuildContextRefs`. Each row links to
 * its enclosing function via a line-range lookup against the existing
 * nodes table, so an agent asking "what reads __dirname?" gets a list
 * of real functions, not a grep wall.
 *
 * V1 scope: TS/JS family (typescript, javascript, tsx, jsx). Other
 * languages don't share the `import.meta` / `__dirname` semantics.
 */

import { computeAlgoHash } from '../algo-hash.js';
import { makeRefMiner } from '../shared-miner.js';

/**
 * Build-context-refs mining algorithm version. The hook stamps this onto
 * project_metadata; a stored value other than the current one triggers a
 * one-shot full re-mine on the next `afterSync` so persisted rows
 * self-heal after a mining-logic change — no `cartograph index` needed.
 *
 * Derived from a sha256 of this file's source via `computeAlgoHash`
 * (comment-strip + whitespace-normalise). Mirrors the CHURN_ALGO_VERSION
 * pattern from `src/churn/index.ts`.
 */
export const BUILD_CONTEXT_REFS_ALGO_VERSION = computeAlgoHash('src/build-context-refs/index.ts', ['./index']);

/** Project-metadata key holding the algo version of the last mining run. */
export const LAST_MINED_BUILD_CONTEXT_REFS_ALGO_VERSION_KEY = 'last_mined_build_context_refs_algo_version';

type BuildContextRefKind =
  | '__dirname'
  | '__filename'
  | 'import.meta.dirname'
  | 'import.meta.filename'
  | 'import.meta.url';

interface BuildContextRef {
  refKind: BuildContextRefKind;
  /** Indexed-symbol id for the enclosing function/method. NULL = top-level. */
  sourceNodeId: string | null;
  filePath: string;
  line: number;
}

interface PatternDef {
  languages: string[];
  re: RegExp;
  /** Prefix prepended to the regex capture to form the final refKind. */
  prefix?: string;
}

const PATTERNS: PatternDef[] = [
  // __dirname / __filename — the capture IS the ref kind.
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /\b(__dirname|__filename)\b/g,
  },
  // import.meta.dirname / .filename / .url — capture the property,
  // prepend `import.meta.` so the stored value is the full identifier.
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /\bimport\.meta\.(dirname|filename|url)\b/g,
    prefix: 'import.meta.',
  },
];

const SUPPORTED_LANGUAGES = new Set<string>(PATTERNS.flatMap((p) => p.languages));

/**
 * Resolver supplied by caller: (filePath, line) → enclosing nodeId.
 * Returns null when the read is at the file's top level.
 */
type EnclosingNodeResolver = (filePath: string, line: number) => string | null;

interface FileTarget {
  path: string;
  language: string;
}

/**
 * Scan a list of (path, language) targets for build-context refs.
 * Pure I/O + regex; the caller owns DB writes. The shared scan loop
 * lives in `makeRefMiner`.
 */
export const extractBuildContextRefs = makeRefMiner<BuildContextRef>({
  extractorName: 'extractBuildContextRefs',
  isLanguageSupported: (lang) => SUPPORTED_LANGUAGES.has(lang),
  lineMatches: lineHasBuildContextHint,
  collectRefsForLine: collectBuildContextRefsForLine,
});

/** Cheap pre-filter for lines that could possibly carry a
 *  build-context literal (`__dirname`, `__filename`, `import.meta`).
 *  Avoids running the per-pattern regex on lines that obviously
 *  can't match. */
function lineHasBuildContextHint(line: string): boolean {
  return line.includes('__dirname') || line.includes('__filename') || line.includes('import.meta');
}

interface CollectBuildContextLineArgs {
  refs: BuildContextRef[];
  line: string;
  lineNo: number;
  target: FileTarget;
  resolveEnclosing: EnclosingNodeResolver;
}

/** Per-line build-context ref scan: walk every pattern compatible
 *  with the target language and append one ref per match. Pulled
 *  out of {@link extractBuildContextRefs} so the outer file/line
 *  loops don't nest the per-pattern + while-exec at depth 4. */
function collectBuildContextRefsForLine(args: CollectBuildContextLineArgs): void {
  const { refs, line, lineNo, target, resolveEnclosing } = args;
  for (const pat of PATTERNS) {
    if (!pat.languages.includes(target.language)) continue;
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(line)) !== null) {
      const refKind = ((pat.prefix ?? '') + m[1]!) as BuildContextRefKind;
      refs.push({
        refKind,
        sourceNodeId: resolveEnclosing(target.path, lineNo),
        filePath: target.path,
        line: lineNo,
      });
    }
  }
}
