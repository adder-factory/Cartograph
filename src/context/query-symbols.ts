/**
 * Extract likely symbol names from a natural language query.
 *
 * Identifies potential code symbols using patterns:
 * - CamelCase: UserService, signInWithGoogle
 * - snake_case: user_service, sign_in
 * - SCREAMING_SNAKE: MAX_RETRIES
 * - dot.notation: app.isPackaged (extracts both sides)
 * - Single words that look like identifiers
 */

interface RegexSpec {
  pattern: RegExp;
  minLength: number;
}

const MIN_NON_ASCII_QUERY_TOKEN_LENGTH = 2;

const QUERY_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'this',
  'that',
  'have',
  'been',
  'will',
  'would',
  'could',
  'should',
  'does',
  'done',
  'make',
  'made',
  'use',
  'used',
  'using',
  'work',
  'works',
  'find',
  'found',
  'show',
  'call',
  'called',
  'calling',
  'get',
  'set',
  'add',
  'all',
  'any',
  'how',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'not',
  'but',
  'are',
  'was',
  'were',
  'has',
  'had',
  'its',
  'can',
  'did',
  'may',
  'also',
  'into',
  'than',
  'then',
  'them',
  'each',
  'other',
  'some',
  'such',
  'only',
  'same',
  'about',
  'after',
  'before',
  'between',
  'through',
  'during',
  'without',
  'again',
  'further',
  'once',
  'here',
  'there',
  'both',
  'just',
  'more',
  'most',
  'very',
  'being',
  'having',
  'doing',
  'system',
  'need',
  'needs',
  'want',
  'wants',
  'like',
  'look',
  'change',
  'changes',
  'changed',
  'changing',
  'layer',
  'handle',
  'handles',
  'handling',
  'incoming',
  'outgoing',
  'data',
  'flow',
  'flows',
  'level',
  'levels',
  'request',
  'requests',
  'response',
  'responses',
  'implement',
  'implements',
  'implementation',
  'interface',
  'interfaces',
  'class',
  'classes',
  'method',
  'methods',
  'trigger',
  'triggers',
  'affected',
  'affect',
  'affects',
  'else',
  'code',
  'failing',
  'failed',
  'silently',
  'decide',
  'decides',
  'return',
  'returns',
  'returned',
  'take',
  'takes',
  'taken',
  'check',
  'checks',
  'checked',
  'create',
  'creates',
  'created',
  'read',
  'reads',
  'write',
  'writes',
  'written',
  'start',
  'starts',
  'stop',
  'stops',
  'run',
  'runs',
  'running',
]);

export function extractSymbolsFromQuery(query: string): string[] {
  const symbols = new Set<string>();

  collectRegexMatches(query, { pattern: /\b([A-Z][a-z]+(?:[A-Z][a-z]*)*)\b/g, minLength: 2 }, symbols);
  collectRegexMatches(query, { pattern: /\b([a-z]+(?:[A-Z][a-z]*)+)\b/g, minLength: 2 }, symbols);
  collectRegexMatches(query, { pattern: /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\b/gi, minLength: 3 }, symbols);
  collectRegexMatches(query, { pattern: /\b([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)\b/g, minLength: 1 }, symbols);
  collectRegexMatches(query, { pattern: /\b([A-Z]{2,})\b/g, minLength: 1 }, symbols);
  collectRegexMatches(query, { pattern: /\b([a-z][a-z0-9]{2,})\b/g, minLength: 1 }, symbols);
  collectNonAsciiIdentifierTokens(query, symbols);

  collectDottedIdentifierCandidates(query, symbols);

  return Array.from(symbols).filter((s) => !QUERY_STOPWORDS.has(s.toLowerCase()));
}

function collectNonAsciiIdentifierTokens(text: string, symbols: Set<string>): void {
  let match: RegExpExecArray | null;
  const pattern = /[\p{L}\p{N}_]+/gu;
  while ((match = pattern.exec(text)) !== null) {
    const token = match[0];
    if (!containsNonAscii(token)) continue;
    if (codePointLength(token) < MIN_NON_ASCII_QUERY_TOKEN_LENGTH) continue;
    symbols.add(token);
  }
}

function containsNonAscii(value: string): boolean {
  return Array.from(value).some((char) => (char.codePointAt(0) ?? 0) > 0x7f);
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function addDotPathAndParts(symbols: Set<string>, path: string): void {
  symbols.add(path);
  for (const part of path.split('.')) {
    if (part.length >= 2) symbols.add(part);
  }
}

function collectDottedIdentifierCandidates(text: string, symbols: Set<string>): void {
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    if (!isAsciiLetter(char) || (index > 0 && isIdentifierPathChar(text[index - 1]!))) {
      index++;
      continue;
    }

    const start = index;
    index++;
    while (index < text.length && isIdentifierPathChar(text[index]!)) index++;

    const candidate = text.slice(start, index);
    if (candidate.includes('.') && isDottedIdentifierPath(candidate)) addDotPathAndParts(symbols, candidate);
  }
}

function isDottedIdentifierPath(value: string): boolean {
  const parts = value.split('.');
  return parts.length > 1 && parts.every(isIdentifierPathPart);
}

function isIdentifierPathPart(value: string): boolean {
  if (!value) return false;
  if (!isAsciiLetter(value[0]!)) return false;
  for (const char of value.slice(1)) {
    if (!isAsciiLetter(char) && !isAsciiDigit(char)) return false;
  }
  return true;
}

function isIdentifierPathChar(char: string): boolean {
  return char === '.' || isAsciiLetter(char) || isAsciiDigit(char);
}

function isAsciiLetter(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 48 && code <= 57;
}

function collectRegexMatches(text: string, spec: RegexSpec, out: Set<string>): void {
  let match: RegExpExecArray | null;
  while ((match = spec.pattern.exec(text)) !== null) {
    if (match[1] && match[1].length >= spec.minLength) out.add(match[1]);
  }
}
