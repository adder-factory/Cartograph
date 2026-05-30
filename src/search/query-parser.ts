/**
 * Field-qualified search query parser.
 *
 * Splits a raw query like
 *
 *     kind:function name:auth path:src/api centrality:>0.01 sort:centrality authenticate
 *
 * into structured filters (kind=function, name="auth", path prefix
 * "src/api", centrality > 0.01, sorted by centrality) plus the
 * free-text portion ("authenticate") that goes to FTS. Free-text and
 * filters compose: filters narrow the result set, FTS scores within
 * the narrowed set.
 *
 * Recognised fields (case-insensitive, value is the rest until
 * whitespace):
 *
 *   kind:        one of function|method|class|interface|struct|...
 *   lang:        one of typescript|python|go|...   (alias: language:)
 *   path:        glob/prefix matched against file_path
 *   name:        exact substring of the symbol's name (case-insensitive)
 *   sig:         substring of the signature (alias: signature:)
 *   centrality:  numeric comparison: `>0.01`, `>=0.001`, `<0.5`, `<=0.001`,
 *                or bare number = `>= n`
 *   sort:        `centrality` (sort by centrality DESC) | `relevance`
 *                (default — original score-based ordering)
 *
 * Unknown field prefixes (e.g. `foo:bar`) are passed through to FTS
 * as plain text — that's how someone searching for `TODO:` gets a
 * result instead of a parse error.
 *
 * Quoting:
 *   kind:function path:"src/some path/with spaces" → handled by stripping
 *   the surrounding double quotes from the value (single token only,
 *   no nested escapes).
 */

import type { NodeKind, Language } from '../types.js';
import { VALID_LANGUAGES } from '../config.js';

type CentralityComparator = '>' | '>=' | '<' | '<=';
export interface CentralityFilter {
  op: CentralityComparator;
  value: number;
}
export type SortMode = 'relevance' | 'centrality';

interface ParsedQuery {
  /** Free-text portion to feed to FTS / LIKE. May be empty. */
  text: string;
  /** kind: filters (OR'd). Empty when none specified. */
  kinds: NodeKind[];
  /** lang:/language: filters (OR'd). Empty when none specified. */
  languages: Language[];
  /** path: filters (OR'd, prefix match against file_path). Empty when none. */
  pathFilters: string[];
  /** name: filters (OR'd, case-insensitive substring of node.name). */
  nameFilters: string[];
  /**
   * sig:/signature: filters — case-insensitive substring of
   * node.signature. Lets users find functions by what they return /
   * accept (e.g. `sig:Promise<User>`, `sig:io.Reader`).
   */
  signatureFilters: string[];
  /**
   * callers-of: NAME — restricts results to nodes that have an
   * outgoing `calls` edge to any node named NAME. Combine with text
   * to express "callers of authenticate matching *Handler".
   */
  callersOf: string[];
  /**
   * callees-of: NAME — restricts results to nodes that are called
   * BY any node named NAME — i.e. things on NAME's outbound call list.
   */
  calleesOf: string[];
  /**
   * depends-on: NAME — restricts results to nodes that have an
   * outgoing dependency edge to any node named NAME. Broader than
   * `callers-of:` — covers `calls` PLUS structural dependency kinds
   * (imports / extends / implements / type_of / returns /
   * instantiates / overrides). Answers "what would break if NAME
   * changed" in a way calls-only `callers-of:` misses (e.g. a class
   * that `extends NAME` but never calls it).
   */
  dependsOn: string[];
  /**
   * centrality: filter — single op/value because the comparison is
   * meant to narrow, not OR. The latest valid token wins on conflict
   * (`centrality:>0.01 centrality:>0.5` ⇒ `>0.5`).
   */
  centralityFilter?: CentralityFilter;
  /**
   * sort:centrality / sort:relevance. Defaults to 'relevance' when
   * unset (the existing score-based ordering). Surfaced as a field
   * rather than just a flag because future sort keys (recent,
   * complexity, churn) plug in as additional enum values.
   */
  sortBy?: SortMode;
}

const KIND_VALUES: ReadonlySet<string> = new Set<NodeKind>([
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
]);

/**
 * Single source of truth for the `lang:`/`language:` filter values
 * is `VALID_LANGUAGES` in config.ts (which has a compile-time
 * exhaustiveness check against the Language union). Importing the
 * array — instead of duplicating it here — closes a real drift bug
 * caught 2026-05-03: this set used to manually list ~20 of the 24
 * registered languages, so `lang:bash` / `lang:rescript` etc.
 * silently fell through to FTS text instead of filtering.
 *
 * The `unknown` sentinel is filtered out: it's a valid Language
 * literal (used internally when extension detection fails) but
 * `lang:unknown` doesn't make sense as a user-facing filter.
 */
const LANGUAGE_VALUES: ReadonlySet<string> = new Set<Language>(
  (VALID_LANGUAGES as readonly Language[]).filter((l) => l !== 'unknown'),
);

/**
 * Strip a surrounding pair of double quotes from `s`. Allows users to
 * keep whitespace in path filters: `path:"my dir/file"`.
 */
function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1);
  return s;
}

/**
 * Tokenise on whitespace, preserving quoted spans as part of the
 * current token. Quotes can appear at the start (`"…"`) OR mid-token
 * (`path:"…"`); in both cases everything from the opening `"` to the
 * matching `"` is included in the token, whitespace and all. An
 * unterminated quote swallows the rest of the input as one token —
 * forgiving rather than throwing.
 */
function tokeniseQuoteAware(raw: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i]!)) i++;
    if (i >= raw.length) break;
    const start = i;
    while (i < raw.length && !/\s/.test(raw[i]!)) {
      if (raw[i] === '"') i = skipPastClosingQuote(raw, i);
      else i++;
    }
    tokens.push(raw.slice(start, i));
  }
  return tokens;
}

/** Advance past a `"…"` literal starting at `openIdx` — returns the
 *  index just after the matching close-quote, or `raw.length` when
 *  the quote is unterminated (caller-friendly: same value the outer
 *  loop checks against, so unterminated quotes terminate naturally). */
function skipPastClosingQuote(raw: string, openIdx: number): number {
  const closeIdx = raw.indexOf('"', openIdx + 1);
  if (closeIdx === -1) return raw.length;
  return closeIdx + 1;
}

interface TokenHandlerArgs {
  valueRaw: string;
  out: ParsedQuery;
  textParts: string[];
  tok: string;
}

/** Per-key handler in {@link TOKEN_HANDLERS}. Mutates `out` for
 *  recognised values; falls back to pushing the original token onto
 *  `textParts` so user typos still influence FTS instead of vanishing. */
type TokenHandler = (args: TokenHandlerArgs) => void;

const handleKindToken: TokenHandler = ({ valueRaw: v, out, textParts, tok }) => {
  if (KIND_VALUES.has(v)) out.kinds.push(v as NodeKind);
  else textParts.push(tok);
};
const handleLanguageToken: TokenHandler = ({ valueRaw: v, out, textParts, tok }) => {
  const lower = v.toLowerCase();
  if (LANGUAGE_VALUES.has(lower)) out.languages.push(lower as Language);
  else textParts.push(tok);
};
const handlePathToken: TokenHandler = ({ valueRaw: v, out }) => {
  out.pathFilters.push(v);
};
const handleNameToken: TokenHandler = ({ valueRaw: v, out }) => {
  out.nameFilters.push(v);
};
const handleSignatureToken: TokenHandler = ({ valueRaw: v, out }) => {
  out.signatureFilters.push(v);
};
const handleCallersOfToken: TokenHandler = ({ valueRaw: v, out }) => {
  out.callersOf.push(v);
};
const handleCalleesOfToken: TokenHandler = ({ valueRaw: v, out }) => {
  out.calleesOf.push(v);
};
const handleDependsOnToken: TokenHandler = ({ valueRaw: v, out }) => {
  out.dependsOn.push(v);
};
const handleCentralityToken: TokenHandler = ({ valueRaw: v, out, textParts, tok }) => {
  const cf = parseCentralityValue(v);
  if (cf) out.centralityFilter = cf;
  else textParts.push(tok);
};
const handleSortToken: TokenHandler = ({ valueRaw: v, out, textParts, tok }) => {
  const lower = v.toLowerCase();
  if (lower === 'centrality' || lower === 'relevance') out.sortBy = lower;
  else textParts.push(tok);
};

/** `key → handler` dispatch table. Aliases (`lang`/`language`,
 *  `sig`/`signature`) point at the same handler. Any key not present
 *  falls through to `textParts.push(tok)` in the orchestrator. */
const TOKEN_HANDLERS: ReadonlyMap<string, TokenHandler> = new Map<string, TokenHandler>([
  ['kind', handleKindToken],
  ['lang', handleLanguageToken],
  ['language', handleLanguageToken],
  ['path', handlePathToken],
  ['name', handleNameToken],
  ['sig', handleSignatureToken],
  ['signature', handleSignatureToken],
  ['callers-of', handleCallersOfToken],
  ['callees-of', handleCalleesOfToken],
  ['depends-on', handleDependsOnToken],
  ['centrality', handleCentralityToken],
  ['sort', handleSortToken],
]);

/**
 * Classify one already-tokenised query fragment as either a structural
 * filter (mutated into `out`) or a free-text bit (pushed onto
 * `textParts`). Unknown keys, empty values, and invalid enum values
 * fall through to text so the user's typo doesn't disappear silently.
 */
function classifyQueryToken(tok: string, out: ParsedQuery, textParts: string[]): void {
  const colon = tok.indexOf(':');
  if (colon <= 0 || colon === tok.length - 1) {
    textParts.push(tok);
    return;
  }
  const key = tok.slice(0, colon).toLowerCase();
  const valueRaw = unquote(tok.slice(colon + 1));
  if (!valueRaw) {
    textParts.push(tok);
    return;
  }
  const handler = TOKEN_HANDLERS.get(key);
  if (!handler) {
    textParts.push(tok);
    return;
  }
  handler({ valueRaw, out, textParts, tok });
}

/**
 * Parse the value half of `centrality:<value>` into an op + numeric
 * threshold. Accepts `>`, `>=`, `<`, `<=` prefixes; a bare number
 * becomes `>=n` (the common "show me anything at least this central"
 * intent). Returns null on malformed input so the caller can fall
 * through to FTS.
 */
function parseCentralityValue(raw: string): CentralityFilter | null {
  const m = /^(>=|<=|>|<)?([0-9]+(?:\.[0-9]+)?)$/.exec(raw);
  if (!m) return null;
  const op = (m[1] ?? '>=') as CentralityComparator;
  const value = Number(m[2]);
  if (!Number.isFinite(value)) return null;
  return { op, value };
}

/**
 * Parse a raw query into structured filters + remaining text.
 * Always returns a value; never throws.
 */
export function parseQuery(raw: string): ParsedQuery {
  const out: ParsedQuery = {
    text: '',
    kinds: [],
    languages: [],
    pathFilters: [],
    nameFilters: [],
    signatureFilters: [],
    callersOf: [],
    calleesOf: [],
    dependsOn: [],
  };
  const textParts: string[] = [];
  for (const tok of tokeniseQuoteAware(raw)) {
    classifyQueryToken(tok, out, textParts);
  }
  out.text = textParts.join(' ').trim();
  return out;
}

/**
 * True if every character of `q` appears in `s` in order (gaps allowed).
 * Used as a relaxed fallback for did-you-mean suggestions when straight
 * edit distance is too tight — e.g. `GnrtHndlr` is a subsequence of
 * `GenerateHandler` (skip-vowels abbreviation). Both inputs should be
 * lowercased by the caller for case-insensitive matching.
 */
export function isSubsequence(q: string, s: string): boolean {
  if (q.length === 0) return true;
  if (q.length > s.length) return false;
  const qCodes = [...q];
  const sCodes = [...s];
  let qi = 0;
  for (let si = 0; si < sCodes.length && qi < qCodes.length; si++) {
    if (qCodes[qi] === sCodes[si]) qi++;
  }
  return qi === qCodes.length;
}

/**
 * Length of the longest contiguous substring shared by `a` and `b`.
 * Used as a third-tier suggestion fallback when edit distance and
 * subsequence both miss — catches prefix/suffix swaps like
 * `addEdge` ↔ `insertEdge` (share "Edge") that look far in edit
 * distance but share a load-bearing domain noun. Both inputs should be
 * lowercased by the caller for case-insensitive matching.
 *
 * O(|a|·|b|) DP with rolling rows; cheap enough for the suggest path's
 * 10k-name sweep on real codebases.
 */
export function longestCommonSubstring(a: string, b: string): number {
  const aCodes = [...a];
  const bCodes = [...b];
  const al = aCodes.length;
  const bl = bCodes.length;
  if (al === 0 || bl === 0) return 0;

  let prev = new Array<number>(bl + 1).fill(0);
  let cur = new Array<number>(bl + 1).fill(0);
  let max = 0;
  for (let i = 1; i <= al; i++) {
    for (let j = 1; j <= bl; j++) {
      // Invert the match check + use Math.max instead of a nested if-update
      // so the inner loop stays at depth 3 instead of 4.
      if (aCodes[i - 1] !== bCodes[j - 1]) {
        cur[j] = 0;
        continue;
      }
      cur[j] = prev[j - 1]! + 1;
      max = Math.max(max, cur[j]!);
    }
    [prev, cur] = [cur, prev];
  }
  return max;
}
