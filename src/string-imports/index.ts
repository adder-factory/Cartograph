/**
 * String-import extraction.
 *
 * Scans indexed source files for import-statement-shaped specifiers
 * that appear INSIDE strings — template literals (backticks) or
 * regular quoted strings — and persists them to `string_imports`.
 *
 * These are NOT real imports (the static graph correctly excludes
 * them from the import edge set). They surface in three places:
 *   1. Parser-test fixtures — `__tests__/extraction/<lang>.test.ts`
 *      contain code samples as literal strings; the parser treats them
 *      as test inputs, not actual imports of those modules.
 *   2. Codegen sources — Stencil components, esbuild plugins, and
 *      build scripts emit JS as template strings.
 *   3. Doc/README examples — markdown code blocks rendered in JSDoc
 *      or string-quoted README content.
 *
 * Why surface them at all? The killer use case is sed-style refactor
 * planning. Before running `sed -i 's|./foo|./foo.js|g'` on a repo
 * (e.g. an ESM migration), an agent should query this table to see
 * which test fixtures, codegen sources, and doc strings the sed pass
 * will accidentally rewrite — that whole class of bug is what eats
 * mechanical migrations.
 *
 * V1 scope: TypeScript/JavaScript family only — that's where ESM
 * migrations and JS codegen happen. Python/Go/etc. are out of scope
 * because their import syntax doesn't tend to live in template literals.
 *
 * The matcher is intentionally narrow: it only fires on lines that
 * look like a complete import statement (`import ... from '<spec>'`,
 * `import('<spec>')`, `require('<spec>')`). Generic string literals
 * containing dotted paths don't match — we want signal, not noise.
 */

import * as fs from 'fs';
import { logDebug, errMsg, logWarn } from '../errors.js';
import { validatePathWithinRootReal } from '../utils.js';
import { computeAlgoHash } from '../algo-hash.js';

/**
 * String-imports mining algorithm version. Derived from the sha256 of
 * this file's source (comment-strip + whitespace-normalise), so edits
 * to the scanning logic automatically shift the hash. The hook stamps
 * this onto project_metadata; a stored value other than the current
 * one triggers a one-shot full re-mine on the next `afterSync`, so
 * stale rows self-heal without a manual `cartograph index`.
 *
 * Mirrors the CHURN_ALGO_VERSION pattern — see `src/churn/index.ts`.
 */
export const STRING_IMPORTS_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./index']);

/** Project-metadata key holding the algo version of the last mining run. */
export const LAST_MINED_STRING_IMPORTS_ALGO_VERSION_KEY = 'last_mined_string_imports_algo_version';

type StringImportContainer = 'template_string' | 'string_literal';

interface StringImport {
  filePath: string;
  line: number;
  /** The specifier (`./foo`, `bar`, `@scope/pkg`). */
  moduleName: string;
  /** Full matched text — kept for debugging / agent context. */
  raw: string;
  containerKind: StringImportContainer;
}

interface FileTarget {
  path: string;
  language: string;
}

const SUPPORTED_LANGUAGES = new Set<string>(['typescript', 'javascript', 'tsx', 'jsx']);

/**
 * Patterns matching import-shaped lines. Order matters: longer / more
 * specific patterns first so we attribute to the most informative
 * shape on overlap.
 *
 * Each capture group `1` is the module specifier.
 */
const IMPORT_PATTERNS: RegExp[] = [
  // `import { x, y } from 'spec';` / `import * as ns from 'spec';` /
  // `import x from 'spec';` / `import 'spec';`
  /\bimport\b[^'"`\n]*?\bfrom\s*['"]([^'"\s]+)['"]/g,
  /\bimport\s*['"]([^'"\s]+)['"]/g,
  // Dynamic import: `import('spec')` / `await import('spec')`
  /\bimport\(\s*['"]([^'"\s]+)['"]\s*\)/g,
  // CJS require: `require('spec')`
  /\brequire\(\s*['"]([^'"\s]+)['"]\s*\)/g,
];

/**
 * Walk a source string and find every {string-literal | template-
 * literal} that contains import-shaped content, then return one
 * StringImport per matched specifier.
 *
 * The implementation is lexer-light: it scans for triple states
 * (`"`, `'`, `` ` ``), tracks which one we're inside, ignores
 * escaped quotes, and emits the literal's contents to the import
 * matcher. We intentionally do NOT use a real JS parser — the
 * regex-and-state-machine pass is two orders of magnitude cheaper,
 * and false positives don't matter for "what would sed touch?"
 * (the answer naturally over-matches; the agent reads the rows).
 */
export function scanStringImports(filePath: string, source: string): StringImport[] {
  return new StringImportScanner(filePath, source).scan();
}

/** Mutable lexer state — grouped to reduce field count on the class. */
interface ScanState {
  out: StringImport[];
  i: number;
  line: number;
  /** Last significant non-whitespace char — drives `/` regex-vs-division disambiguation. */
  prevSig: string;
}

/**
 * Lexer state machine for {@link scanStringImports}. All mutable state
 * lives in a `ScanState` bundle; the class coordinates the logic and
 * holds the immutable source/len/filePath configuration.
 */
class StringImportScanner {
  private readonly source: string;
  private readonly len: number;
  private readonly st: ScanState = { out: [], i: 0, line: 1, prevSig: '' };

  constructor(
    private readonly filePath: string,
    source: string,
  ) {
    this.source = source;
    this.len = source.length;
  }

  scan(): StringImport[] {
    const st = this.st;
    while (st.i < this.len) {
      const c = this.source[st.i]!;
      if (c === '/' && this.source[st.i + 1] === '/') {
        this.skipLineComment();
        continue;
      }
      if (c === '/' && this.source[st.i + 1] === '*') {
        this.skipBlockComment();
        continue;
      }
      if (c === '/' && (st.prevSig === '' || EXPRESSION_PRECEDERS.has(st.prevSig))) {
        this.skipRegexLiteral();
        continue;
      }
      if (c === '"' || c === "'" || c === '`') {
        this.scanLiteral(c);
        st.prevSig = c;
        continue;
      }
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
        this.advance();
        continue;
      }
      st.prevSig = c;
      this.advance();
    }
    return dedupe(st.out);
  }

  private advance(n = 1): void {
    const st = this.st;
    for (let k = 0; k < n && st.i < this.len; k++) {
      if (this.source[st.i] === '\n') st.line++;
      st.i++;
    }
  }

  private skipLineComment(): void {
    while (this.st.i < this.len && this.source[this.st.i] !== '\n') this.advance();
    this.st.prevSig = '';
  }

  private skipBlockComment(): void {
    this.advance(2);
    while (this.st.i < this.len && !(this.source[this.st.i] === '*' && this.source[this.st.i + 1] === '/')) {
      this.advance();
    }
    this.advance(2);
    this.st.prevSig = '';
  }

  private skipRegexLiteral(): void {
    this.advance(); // opening `/`
    while (this.st.i < this.len) {
      const rc = this.source[this.st.i]!;
      if (rc === '\\') {
        this.advance(2);
        continue;
      }
      if (rc === '[') {
        this.skipRegexCharClass();
        continue;
      }
      if (rc === '/') {
        this.advance();
        break;
      }
      if (rc === '\n') break;
      this.advance();
    }
    while (this.st.i < this.len && /[a-z]/.test(this.source[this.st.i]!)) this.advance();
    this.st.prevSig = '/';
  }

  private skipRegexCharClass(): void {
    this.advance(); // opening `[`
    while (this.st.i < this.len && this.source[this.st.i] !== ']') {
      if (this.source[this.st.i] === '\\') this.advance(2);
      else this.advance();
    }
    this.advance(); // closing `]`
  }

  /**
   * Scan a single string/template literal starting at the opening
   * quote. Re-entrant so a nested template inside `${...}` can drive
   * the same logic.
   */
  private scanLiteral(quote: '"' | "'" | '`'): void {
    const st = this.st;
    this.advance(); // opening quote
    const segments: { text: string; line: number }[] = [];
    let segBuf: string[] = [];
    let segLine = st.line;

    const flushSegment = () => {
      if (segBuf.length === 0) return;
      segments.push({ text: segBuf.join(''), line: segLine });
      segBuf = [];
    };

    while (st.i < this.len) {
      const ch = this.source[st.i]!;
      if (ch === '\\') {
        segBuf.push(ch, this.source[st.i + 1] ?? '');
        this.advance(2);
        continue;
      }
      if (ch === quote) {
        this.advance();
        break;
      }
      if (quote === '`' && ch === '$' && this.source[st.i + 1] === '{') {
        flushSegment();
        this.advance(2);
        this.drainTemplateExpression();
        segLine = st.line;
        continue;
      }
      if (segBuf.length === 0) segLine = st.line;
      segBuf.push(ch);
      this.advance();
    }
    flushSegment();

    const containerKind: StringImportContainer = quote === '`' ? 'template_string' : 'string_literal';
    this.emitMatches(segments, containerKind);
  }

  private drainTemplateExpression(): void {
    const st = this.st;
    let depth = 1;
    while (st.i < this.len && depth > 0) {
      const ec = this.source[st.i]!;
      if (ec === '{') {
        depth++;
        this.advance();
        continue;
      }
      if (ec === '}') {
        depth--;
        this.advance();
        continue;
      }
      if (ec === '"' || ec === "'" || ec === '`') {
        this.scanLiteral(ec);
        continue;
      }
      this.advance();
    }
  }

  private emitMatches(segments: { text: string; line: number }[], containerKind: StringImportContainer): void {
    for (const seg of segments) {
      for (const pat of IMPORT_PATTERNS) {
        pat.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = pat.exec(seg.text)) !== null) {
          const before = seg.text.slice(0, m.index);
          const newlinesBefore = (before.match(/\n/g) ?? []).length;
          this.st.out.push({
            filePath: this.filePath,
            line: seg.line + newlinesBefore,
            moduleName: m[1]!,
            raw: m[0]!,
            containerKind,
          });
        }
      }
    }
  }
}

/**
 * Single-character precedes-an-expression set. When `/` follows one
 * of these (or appears at start-of-input), it's a regex literal, not
 * a division operator. Approximation taken from acorn's tokenizer
 * — covers the common 99% without paying the cost of full grammar
 * lookback.
 */
const EXPRESSION_PRECEDERS = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '?',
  '=',
  '+',
  '-',
  '*',
  '%',
  '&',
  '|',
  '^',
  '~',
  '!',
  '<',
  '>',
]);

function dedupe(refs: StringImport[]): StringImport[] {
  const seen = new Set<string>();
  const out: StringImport[] = [];
  for (const r of refs) {
    const key = `${r.filePath}\t${r.line}\t${r.moduleName}\t${r.containerKind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/**
 * Scan a list of (path, language) targets and return all string-
 * import sites. Pure I/O + regex; the caller owns DB writes via
 * `applyStringImports`.
 */
export function extractStringImports(rootDir: string, targets: Iterable<FileTarget>): StringImport[] {
  const refs: StringImport[] = [];
  for (const t of targets) {
    if (!SUPPORTED_LANGUAGES.has(t.language)) continue;
    const abs = validatePathWithinRootReal(rootDir, t.path);
    if (!abs) {
      logWarn('Path traversal blocked in extractStringImports', { filePath: t.path });
      continue;
    }
    let src: string;
    try {
      src = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      logDebug(`extractStringImports: read failed for ${t.path}: ${errMsg(err)}`);
      continue;
    }
    // Cheap pre-filter — if the file has no `import` and no `require`
    // anywhere, skip the lexer pass entirely.
    if (!src.includes('import') && !src.includes('require')) continue;
    refs.push(...scanStringImports(t.path, src));
  }
  return refs;
}
