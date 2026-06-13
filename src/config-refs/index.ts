/**
 * Config-reference extraction
 *
 * Scans indexed source files for known config-read patterns
 * (`process.env.X`, `os.getenv("X")`, etc.) and records each read
 * site as a row in `config_refs`. Each row links to its enclosing
 * function via a line-range lookup against the existing nodes table,
 * so an agent asking "what reads OBSIDIAN_PORT?" gets a list of real
 * functions, not a grep wall.
 *
 * Why a separate table, not graph nodes/edges: env vars don't have a
 * single source-of-truth file (they're a global namespace), so giving
 * them a synthetic file_path would pollute the main graph. The table
 * is queried via the consolidated `cartograph_string_refs({kind: 'env'})`
 * MCP tool and via augmented `cartograph_node` output (per-function
 * "reads:" line).
 *
 * Spike validation (mcp-obsidian-extended): 71 reads, 19 distinct
 * keys; 8× OBSIDIAN_PORT, 8× TOOL_PRESET surface as central
 * config knobs. Cartograph-itself is sparse (4 reads) — this feature
 * shines on service-style codebases.
 *
 * V1 scope: env-only, regex-based per-language. YAML key reads,
 * LaunchDarkly flags, etc. are deliberately out of scope; the schema
 * already supports them via `config_kind` so adding them later is a
 * pattern addition, not a redesign.
 */

import { computeAlgoHash } from '../algo-hash.js';
import { makeRefMiner } from '../shared-miner.js';

/**
 * Config-refs extraction algorithm version. The hook stamps this onto
 * project_metadata; a stored value other than the current one triggers
 * a one-shot full re-mine on the next `afterSync` so persisted
 * `config_refs` values self-heal after a pattern-logic change — no
 * `cartograph index` needed.
 *
 * Derived from a sha256 of this file's source via `computeAlgoHash`
 * (comment-strip + whitespace-normalise, so JSDoc / reformat-only edits
 * don't invalidate). Editing the pattern catalogue or the scan logic
 * above changes the hash automatically. See `src/algo-hash.ts`.
 */
export const CONFIG_REFS_ALGO_VERSION = computeAlgoHash('src/config-refs/index.ts', ['./index']);

/** Project-metadata key holding the algo version of the last mining run. */
export const LAST_MINED_CONFIG_REFS_ALGO_VERSION_KEY = 'last_mined_config_refs_algo_version';

type ConfigKind = 'env';

interface ConfigRef {
  configKind: ConfigKind;
  configKey: string;
  /** Indexed-symbol id for the enclosing function/method. NULL = top-level. */
  sourceNodeId: string | null;
  filePath: string;
  line: number;
}

interface PatternDef {
  /** Languages this pattern applies to (matches `Language` in types.ts). */
  languages: string[];
  /** Regex with capture group 1 = config key. */
  re: RegExp;
}

/**
 * Per-language read-pattern catalogue.
 *
 * Patterns intentionally err on the side of including only
 * UPPER_CASE_KEYS — the convention every framework follows for env
 * vars. This avoids false positives like `process.env.foo` (a Node
 * variable) or `os.getenv(some_var)` (dynamic).
 */
const PATTERNS: PatternDef[] = [
  // process.env.FOO  /  process.env["FOO"]  (TS, JS, TSX, JSX)
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /process\.env\.([A-Z_][A-Z0-9_]*)/g,
  },
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  // Cloudflare Workers / Hono bindings: c.env.FOO / ctx.env.FOO /
  // context.env.FOO (member) and the bracket form c.env["FOO"]. The
  // `c.env.*` accessor is the standard way Hono handlers read Workers
  // secrets/bindings, and Workers is a documented Cartograph target —
  // without this every worker secret was invisible to `find --by env`
  // (issue #10). The leading `\b` stops `abc.env.X` from matching.
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /\b(?:c|ctx|context)\.env\.([A-Z_][A-Z0-9_]*)/g,
  },
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /\b(?:c|ctx|context)\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  // Deno.env.get("FOO")
  {
    languages: ['typescript', 'javascript', 'tsx', 'jsx'],
    re: /\bDeno\.env\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  // os.getenv("FOO")  /  os.environ.get("FOO")  /  os.environ["FOO"]
  {
    languages: ['python'],
    re: /\bos\.getenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  {
    languages: ['python'],
    re: /\bos\.environ\.get\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  {
    languages: ['python'],
    re: /\bos\.environ\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  // Bare getenv("FOO") (Python convention with `from os import getenv`).
  // The `(?<!\.)` guard stops this from ALSO matching the `getenv(` inside
  // `os.getenv(` — without it every `os.getenv("FOO")` read was counted
  // twice (once here, once by the `os.getenv` pattern above).
  {
    languages: ['python'],
    re: /(?<!\.)\bgetenv\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  // os.Getenv("FOO")  /  os.LookupEnv("FOO")  (Go)
  {
    languages: ['go'],
    re: /\bos\.(?:Getenv|LookupEnv)\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
  // System.getenv("FOO") (Java/Kotlin)
  {
    languages: ['java', 'kotlin'],
    re: /\bSystem\.getenv\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
  // ENV["FOO"] / ENV.fetch("FOO") (Ruby)
  {
    languages: ['ruby'],
    re: /\bENV\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g,
  },
  {
    languages: ['ruby'],
    re: /\bENV\.fetch\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g,
  },
  // Rust: env!("FOO") / std::env::var("FOO")
  {
    languages: ['rust'],
    re: /\benv!\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
  {
    languages: ['rust'],
    re: /\bstd::env::var\(\s*"([A-Z_][A-Z0-9_]*)"/g,
  },
];

/** A file's languages-of-interest. Skip everything not in PATTERNS. */
const SUPPORTED_LANGUAGES = new Set<string>(PATTERNS.flatMap((p) => p.languages));

/**
 * Resolver supplied by caller: (filePath, line) → enclosing nodeId
 * (function/method/class). Returns null when the read is at the file's
 * top level — the row still gets persisted with NULL source_node_id.
 */
type EnclosingNodeResolver = (filePath: string, line: number) => string | null;

interface FileTarget {
  path: string;
  language: string;
}

/**
 * Cheap pre-filter to skip the 99% of lines that obviously contain no
 * env reference. Three explicit `String.includes` calls (not a single
 * case-insensitive regex) — measured faster on hot paths and keeps the
 * intent visible at the call site.
 */
function lineMightContainEnvRef(line: string): boolean {
  return line.includes('env') || line.includes('Env') || line.includes('ENV');
}

/**
 * Scan a list of (path, language) targets and return all env read
 * sites. Pure I/O + regex; the caller owns DB writes via
 * `applyConfigRefs`. The shared scan loop (language filter, path
 * validation, comment strip, line iteration) lives in `makeRefMiner`.
 */
export const extractConfigRefs = makeRefMiner<ConfigRef>({
  extractorName: 'extractConfigRefs',
  isLanguageSupported: (lang) => SUPPORTED_LANGUAGES.has(lang),
  lineMatches: lineMightContainEnvRef,
  collectRefsForLine: collectEnvRefsForLine,
});

/** Per-line ENV-ref scan: walk every pattern compatible with the
 *  target's language and append one ref per match. Pulled out of
 *  {@link extractConfigRefs} so the inner per-pattern + while + match
 *  doesn't sit 4-deep under the outer file/line loops. */
interface CollectEnvRefsLineArgs {
  refs: ConfigRef[];
  line: string;
  lineNo: number;
  target: FileTarget;
  resolveEnclosing: EnclosingNodeResolver;
}

function collectEnvRefsForLine(args: CollectEnvRefsLineArgs): void {
  const { refs, line, lineNo, target, resolveEnclosing } = args;
  for (const pat of PATTERNS) {
    if (!pat.languages.includes(target.language)) continue;
    pat.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pat.re.exec(line)) !== null) {
      refs.push({
        configKind: 'env',
        configKey: m[1]!,
        sourceNodeId: resolveEnclosing(target.path, lineNo),
        filePath: target.path,
        line: lineNo,
      });
    }
  }
}
