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

export const CALL_ARG_RE = new RegExp(`(?<=[(,]${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,)])`, 'g');
export const PAIR_VALUE_RE = new RegExp(
  `(?<=[{,]${WS}[a-zA-Z_$][a-zA-Z_$0-9]{0,${MAX_WS_RUN}}${WS}:${WS})([a-zA-Z_$][a-zA-Z_$0-9]*)(?=${WS}[,}])`,
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
    const name = m[1];
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
