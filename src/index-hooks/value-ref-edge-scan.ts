export interface ValueRefEdgeRecord {
  source: string;
  target: string;
  kind: 'references';
}

export const SUPPORTED_VALUE_REF_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);

const JS_RESERVED_HEAD: ReadonlySet<string> = new Set([
  'if',
  'while',
  'for',
  'switch',
  'catch',
  'return',
  'typeof',
  'await',
  'new',
  'delete',
  'void',
  'in',
  'of',
  'instanceof',
  'yield',
  'throw',
  'function',
  'class',
  'extends',
  'implements',
  'static',
  'async',
  'super',
  'this',
  'true',
  'false',
  'null',
  'undefined',
  'import',
  'export',
  'from',
  'as',
  'default',
  'const',
  'let',
  'var',
  'do',
  'else',
  'finally',
  'try',
  'with',
  'break',
  'continue',
  'case',
]);

/** Bound on `\s` runs inside the regex lookbehinds + lookaheads.
 *  V8's variable-length lookbehind walks BACKWARDS across the entire
 *  possible `\s*` span at every candidate position. On pathological
 *  generated or fixture-scale inputs, the unbounded form can hang a
 *  worker. The 200-char bound preserves realistic multiline call/object
 *  expressions while keeping every regex probe finite. */
const MAX_WS_RUN = 200;
const WS = String.raw`\s{0,${MAX_WS_RUN}}`;

/** Bare identifier in call-argument OR array-element position. The
 *  square brackets cover dispatch tables built as array literals —
 *  `new Map([['save', doSave]])`, `const STEPS = [stepOne, stepTwo]`
 *  — which the call/pair passes can't see. */
export const CALL_ARG_RE = new RegExp(String.raw`(?<=[(,\[]${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,)\]])`, 'g');
export const PAIR_VALUE_RE = new RegExp(
  `(?<=[{,]${WS}[a-zA-Z_$][a-zA-Z_$0-9]{0,${MAX_WS_RUN}}${WS}:${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,}])`,
  'g',
);

/** Braced bare-identifier values after `=`: JSX attribute callbacks
 *  (`onSubmit={submit}`, `render={Row}`). Member expressions
 *  (`={this.save}`, `={handlers.save}`) are out of scope — their head
 *  segment resolves through other edge kinds. The `=` anchor keeps
 *  this off object literals and block statements. */
export const JSX_ATTR_VALUE_RE = new RegExp(String.raw`(?<==${WS}\{${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}\})`, 'g');

/** Parenthesised ternary used as a callee: `(pretty ? a : b)(args)`.
 *  Both arms are function references the structural extraction can't
 *  see (the callee is a conditional_expression, not a name). The
 *  condition part excludes `( ) ? :` so nested ternaries and optional
 *  chaining never confuse the match. */
export const INVOKED_TERNARY_RE = new RegExp(
  String.raw`\([^()?:]{0,${MAX_WS_RUN}}\?${WS}([a-zA-Z_$][a-zA-Z_$0-9]*)${WS}:${WS}([a-zA-Z_$][a-zA-Z_$0-9]*)${WS}\)${WS}\(`,
  'g',
);

export interface CollectValueRefMatchesArgs {
  cleaned: string;
  re: RegExp;
  fileNodeId: string;
  seenNames: Set<string>;
  seen: Set<string>;
  edges: ValueRefEdgeRecord[];
  nameIndex: ReadonlyMap<string, string>;
}

export function collectValueRefMatches(args: CollectValueRefMatchesArgs): void {
  const { cleaned, re, fileNodeId, seenNames, seen, edges, nameIndex } = args;
  re.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned)) !== null) {
    // Multi-group patterns (INVOKED_TERNARY_RE) capture one identifier
    // per group; single-group patterns just iterate once.
    for (const name of m.slice(1)) {
      if (!name || JS_RESERVED_HEAD.has(name)) continue;
      if (seenNames.has(name)) continue;
      seenNames.add(name);
      const targetId = nameIndex.get(name);
      if (!targetId) continue;
      const key = `${fileNodeId}->${targetId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: fileNodeId, target: targetId, kind: 'references' });
    }
  }
}
