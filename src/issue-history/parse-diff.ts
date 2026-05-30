/**
 * Diff parsing for issue → symbol attribution
 *
 * Pure parser: no I/O, no git invocations beyond the one `git show` it
 * uses to fetch a commit's full diff. Splits into two distinct signals
 * per (commit, file):
 *
 *   modCtx  — the *enclosing* function/class of each hunk, taken from
 *             git's `@@ -... +... @@ <ctx>` header. Cross-language
 *             because git's userdiff regex covers it (TS/JS/Py/Go/
 *             Java/C/C++/Rust/Ruby out of the box).
 *
 *   added   — declarations on `+` lines (newly-introduced symbols).
 *   removed — declarations on `-` lines (deleted symbols).
 *
 * Both signals matter independently: an issue that *modifies* `foo()`
 * is different evidence from an issue that *adds* `foo()`. The MCP
 * surface renders them with explicit kind tags so an agent can tell
 * the difference.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Hard cap on git output we'll buffer (bytes). */
const MAX_GIT_BUFFER = 200 * 1024 * 1024;
/** Wall-clock cap on a single git invocation (ms). */
const GIT_TIMEOUT_MS = 60_000;

/** Identifiers that look like declarations to the loose `name(` regex
 * but are actually keywords / locals — never represent indexable
 * symbols. Filtering them keeps the resolved hit-rate high. */
const SKIP_NAMES = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
  'await',
  'new',
  'function',
  'class',
  'interface',
  'const',
  'let',
  'var',
  'export',
  'import',
  'public',
  'private',
  'protected',
  'static',
  'async',
  'abstract',
  'default',
  'super',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'void',
  'typeof',
  'instanceof',
  'describe',
  'it',
  'expect',
  'test',
  'beforeEach',
  'afterEach',
  'beforeAll',
  'afterAll', // popular test-framework names; not symbols
  'constructor', // not a top-level symbol — owned by class
]);

/** Path patterns we never extract diff symbols from. */
const SKIP_PATH_RE =
  /^(?:dist\/|node_modules\/|\.cartograph\/|coverage\/|build\/|out\/)|\.lock$|\.snap$|^package(?:-lock)?\.json$|\.md$|\.json$|\.svg$|\.png$|\.jpg$|\.gif$|\.ico$|\.txt$|\.yml$|\.yaml$|\.toml$/i;

/** Declaration patterns; capture group 1 is the symbol name.
 * Designed to be loose — better to over-collect and miss in the
 * symbol-resolver step than to under-collect (the resolver is cheap). */
const DECL_PATTERNS: RegExp[] = [
  // function foo / function* foo / async function foo
  /^[+\-]\s*(?:export\s+)?(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/,
  // class Foo / abstract class Foo / export class Foo
  /^[+\-]\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  // interface Foo
  /^[+\-]\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/,
  // type Foo = ... / type alias
  /^[+\-]\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*=/,
  // enum Foo
  /^[+\-]\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/,
  // const Foo = (..) =>  /  const Foo = function
  /^[+\-]\s*(?:export\s+)?const\s+([A-Z][\w$]*)\s*=\s*(?:\([^)]*\)\s*=>|function|async\s)/,
  // method-like:  visibility?  name(    (loose; SKIP_NAMES filters keywords)
  /^[+\-]\s*(?:public|private|protected|static|async)\s+(?:[a-z]+\s+)*([A-Za-z_$][\w$]*)\s*\(/,
  // Python: def name(  /  async def name(
  /^[+\-]\s*(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/,
  // Go: func name(  /  func (recv) name(
  /^[+\-]\s*func\s+(?:\([^)]*\)\s+)?([A-Za-z_][\w]*)\s*\(/,
  // Rust: fn name(  /  pub fn name<...>(
  /^[+\-]\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][\w]*)\s*[<(]/,
];

interface FileDiffSets {
  modCtx: Set<string>;
  added: Set<string>;
  removed: Set<string>;
}

/**
 * Pull the symbol name out of a git `@@ ... @@ <ctx>` context line.
 * Git's userdiff regexes already give us a single line that includes
 * the enclosing definition (e.g. `function processOrder(order: Order)
 * {`). We take the first identifier following a recognised keyword,
 * falling back to "first identifier-followed-by-paren" for languages
 * git doesn't have explicit userdiff for.
 */
export function extractSymbolFromContext(ctx: string): string | null {
  const trimmed = ctx.trim();
  if (!trimmed) return null;
  // Order of patterns matters: anchor on keyword first, then on
  // identifier-followed-by-paren.
  const m1 = trimmed.match(/(?:function|class|interface|type|enum|def|func|fn)\s+([A-Za-z_$][\w$]*)/);
  if (m1 && !SKIP_NAMES.has(m1[1]!)) return m1[1]!;
  const m2 = trimmed.match(/^([A-Za-z_$][\w$]*)\s*\(/);
  if (m2 && !SKIP_NAMES.has(m2[1]!)) return m2[1]!;
  // Methods: `  async foo(` after some indentation, with possibly a
  // visibility modifier we already skipped above.
  const m3 = trimmed.match(/(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/);
  if (m3 && !SKIP_NAMES.has(m3[1]!)) return m3[1]!;
  return null;
}

/**
 * Pull a declared symbol name out of a single `+` or `-` diff line.
 */
export function extractDeclaration(diffLine: string): { name: string; sign: '+' | '-' } | null {
  if (!diffLine || (diffLine[0] !== '+' && diffLine[0] !== '-')) return null;
  // Skip the file-marker lines emitted by git.
  if (diffLine.startsWith('+++') || diffLine.startsWith('---')) return null;
  for (const re of DECL_PATTERNS) {
    const m = re.exec(diffLine);
    if (m && m[1] && !SKIP_NAMES.has(m[1])) {
      return { name: m[1], sign: diffLine[0] as '+' | '-' };
    }
  }
  return null;
}

/**
 * Pull a declaration name out of an unchanged (` `-prefixed) diff
 * line. Used to detect the enclosing function when git's `@@ ... @@
 * <ctx>` header is empty (which happens when the changed hunk lives
 * inside a function that starts at line 1, so there's no enclosing
 * scope *above* the hunk for git's userdiff to reference).
 *
 * Matches the same patterns as `extractDeclaration` but allows a
 * leading space (the diff context-line prefix).
 */
function extractContextDeclaration(diffLine: string): string | null {
  if (!diffLine || diffLine[0] !== ' ') return null;
  for (const re of DECL_PATTERNS) {
    // DECL_PATTERNS anchor on `[+\-]` — accept space too by trying
    // again with that prefix swapped.
    const swapped = '+' + diffLine.slice(1);
    const m = re.exec(swapped);
    if (m && m[1] && !SKIP_NAMES.has(m[1])) return m[1];
  }
  return null;
}

/**
 * Run `git show <sha>` and parse the diff into per-file
 * (modCtx, added, removed) sets.
 *
 * Throws if git fails (caller should catch + log + skip the commit).
 */
/** Parse the optional symbol context off a `@@ -a,b +c,d @@ <ctx>`
 *  hunk header and add it to the file's modCtx set. Pulled out of
 *  the diff line loop so the `if-startsWith / if-match / if-sym`
 *  chain doesn't sit 4-deep under the for-of. */
function recordHunkContextSymbol(line: string, sets: FileDiffSets): void {
  const m = line.match(/^@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@\s*(.*)$/);
  if (!m || !m[1]) return;
  const sym = extractSymbolFromContext(m[1]);
  if (sym) sets.modCtx.add(sym);
}

/** Parse a `diff --git a/<old> b/<new>` header line. Returns the new
 *  path (or `null` when the path is in the SKIP_PATH_RE blocklist or
 *  the line doesn't match the expected shape). Idempotent on the
 *  perFile map — registers a fresh entry only when none exists. */
function startNewDiffFile(line: string, perFile: Map<string, FileDiffSets>): string | null {
  const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
  if (!m) return null;
  const newPath = m[2]!;
  if (SKIP_PATH_RE.test(newPath)) return null;
  if (!perFile.has(newPath)) {
    perFile.set(newPath, { modCtx: new Set(), added: new Set(), removed: new Set() });
  }
  return newPath;
}

export async function parseCommitDiff(rootDir: string, commitSha: string): Promise<Map<string, FileDiffSets>> {
  const { stdout } = await execFileAsync('git', ['show', commitSha, '--unified=3', '--no-color', '--no-renames'], {
    cwd: rootDir,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_BUFFER,
  });
  const lines = stdout.split('\n');
  const perFile = new Map<string, FileDiffSets>();
  let curFile: string | null = null;

  for (const L of lines) {
    if (L.startsWith('diff --git ')) {
      curFile = startNewDiffFile(L, perFile);
      continue;
    }
    if (curFile === null) continue;
    if (L.startsWith('@@')) {
      recordHunkContextSymbol(L, perFile.get(curFile)!);
      continue;
    }
    const decl = extractDeclaration(L);
    if (decl) {
      const sets = perFile.get(curFile)!;
      if (decl.sign === '+') sets.added.add(decl.name);
      else sets.removed.add(decl.name);
      continue;
    }
    // Fallback: an unchanged context line within a hunk that contains
    // a declaration is the enclosing scope for that hunk. This catches
    // the case where the function's signature is at line 1 (so git's
    // userdiff has no scope *above* the hunk to use as @@ <ctx>).
    const ctxName = extractContextDeclaration(L);
    if (ctxName) perFile.get(curFile)!.modCtx.add(ctxName);
  }

  return perFile;
}
