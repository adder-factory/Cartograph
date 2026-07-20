import { stripCommentsForRegex } from '../utils.js';
import type { Language } from '../types.js';

/**
 * Heuristic-first detector for functions / symbols that handle secrets,
 * PII, or sensitive credentials. No model required — curated regex patterns
 * + structural cues give strong signal with near-zero latency.
 *
 * Each pattern family contributes a named signal and a fixed weight to a
 * composite score ∈ [0, 1]. A single category fires at most once even if
 * multiple regexes match (to avoid double-counting).
 *
 * Intended as a biomarker data source; integration into the biomarker
 * framework is a separate ship.
 */

/** Specific signal categories that can fire during detection. */
export type SecretSignal =
  /** Identifier or param named like API_KEY, apiKey, secret, access_key, etc. */
  | 'api-key-name'
  /** JWT structure — verifyJwt / jwt.sign / literal "eyJ..." token. */
  | 'jwt-pattern'
  /** password / passwd / pwd / passphrase identifier. */
  | 'password-name'
  /** HMAC / encryption / sign / decrypt with a key or secret argument. */
  | 'crypto-secret'
  /** Literal AKIA… AWS access key or aws_secret_access_key reference. */
  | 'aws-access-key'
  /** process.env.* or ENV['*'] read for a secret-named variable. */
  | 'env-secret-read'
  /** SSN, credit card, DOB, phone, email-address PII identifiers. */
  | 'pii-name'
  /** Hardcoded long base64-ish or hex token (>=32 chars) in source. */
  | 'literal-token';

/** Full detection result for a single symbol. */
export interface SecretsDetectionResult {
  /** Confidence 0-1. >=0.7 = strong signal; >=0.4 = moderate; <0.4 = weak. */
  score: number;
  /** Human-readable explanation for each fired signal. */
  reasons: string[];
  /** Machine-readable signal list for downstream filtering. */
  signals: SecretSignal[];
}

/** Input shape — mirrors the fields available on a Cartograph symbol. */
export interface SecretsDetectionInput {
  /** Symbol name. */
  name: string;
  /** Symbol signature (params + return type). */
  signature: string | null;
  /** Symbol body (the function source). */
  body: string;
  /** Source language used to distinguish executable code from comments. */
  language?: Language | null;
  /** Optional LLM summary if available. */
  summary?: string | null;
}

// ---------------------------------------------------------------------------
// Internal pattern definitions
// ---------------------------------------------------------------------------

interface PatternEntry {
  signal: SecretSignal;
  /** One or more regexes; ANY match fires the signal. */
  patterns: RegExp[];
  /** Score contribution when the signal fires. */
  weight: number;
  /** Human-readable reason string if the signal fires. */
  reason: string;
}

const AWS_LITERAL_AKIA_RE = /\bAKIA[0-9A-Z]{16}\b/;
const JWT_LITERAL_RE = /["']eyJ[A-Za-z0-9_.+/=-]{20,}["']/;
const PII_NAME_PATTERNS: readonly RegExp[] = [
  /\bssn\b/i,
  /\bsocial[_-]?security\b/i,
  /\bcredit[_-]?card\b/i,
  /\bcc[_-]?num\b/i,
  /\bdate[_-]?of[_-]?birth\b/i,
  /\bdob\b/i,
  /\bphone[_-]?number\b/i,
  /\bemail[_-]?address\b/i,
];

const PATTERN_TABLE: PatternEntry[] = [
  {
    signal: 'api-key-name',
    patterns: [/\b(api[_-]?key|secret|token|access[_-]?key|client[_-]?secret)\b/i],
    weight: 0.3,
    reason: 'identifier looks like an API key or secret token',
  },
  {
    signal: 'jwt-pattern',
    patterns: [
      // Function-call patterns for JWT operations
      /\b(verify|decode|sign)Jwt\b|\bjwt\.(sign|verify|decode)\b/,
      // Literal JWT value starting with eyJ (allows base64url chars + dots between segments)
      JWT_LITERAL_RE,
    ],
    weight: 0.3,
    reason: 'handles or contains a JWT token',
  },
  {
    signal: 'password-name',
    patterns: [/\b(password|passwd|pwd|passphrase)\b/i],
    weight: 0.3,
    reason: 'identifier looks like a password or passphrase',
  },
  {
    signal: 'crypto-secret',
    patterns: [/\b(hmac|encrypt|decrypt|sign|verify).*?(secret|key)\b/i],
    weight: 0.2,
    reason: 'performs cryptographic operation with a secret or key',
  },
  {
    signal: 'aws-access-key',
    patterns: [
      // Literal hardcoded AWS access key ID
      AWS_LITERAL_AKIA_RE,
      // Reference to AWS secret_access_key or access_key_id
      /aws[_-]?(secret[_-]?access[_-]?key|access[_-]?key[_-]?id)/i,
    ],
    weight: 0.4,
    reason: 'references an AWS access key or secret access key',
  },
  {
    signal: 'env-secret-read',
    patterns: [/process\.env\.(SECRET|TOKEN|KEY|PASSWORD)\w*/i, /ENV\[['"](SECRET|TOKEN|KEY|PASSWORD)\w*['"]\]/i],
    weight: 0.3,
    reason: 'reads a secret or credential from environment variables',
  },
  {
    signal: 'pii-name',
    patterns: [...PII_NAME_PATTERNS],
    weight: 0.2,
    reason: 'references personally identifiable information (PII)',
  },
  {
    signal: 'literal-token',
    patterns: [
      // Long base64-ish or hex token (>=32 printable chars) in a
      // string literal. Two guards against prose-shaped literals
      // (field report #2 item 4 — "application/x-www-form-urlencoded"
      // is 34 chars of the token alphabet):
      //   1. a known MIME-type prefix never counts, and
      //   2. the literal must contain at least one DIGIT — real keys
      //      and tokens essentially always do; English words and
      //      kebab/slash identifiers essentially never do.
      /["'](?!(?:application|audio|font|image|message|model|multipart|text|video)\/)(?=[A-Za-z_/+=-]*\d)[A-Za-z0-9_/+=-]{32,}["']/,
    ],
    weight: 0.2,
    reason: 'contains a hardcoded long token or credential string',
  },
];

// AWS literal key gets a higher one-time boost when it fires.
const AWS_LITERAL_AKIA_WEIGHT = 0.6;
const JWT_LITERAL_WEIGHT = 0.5;

// ---------------------------------------------------------------------------
// Test-name down-weight
// ---------------------------------------------------------------------------

/**
 * Regex to identify test-scoped symbol names (camelCase and snake_case variants).
 * Matches: testFoo, test_foo, test-foo, itFoo, it_foo, specFoo, shouldFoo,
 *          fooTest, foo_test, foo_spec.
 */
const TEST_NAME_RE = /^(test[_A-Z-]|it[_A-Z-]|spec[_A-Z-]|should[_ A-Z]|describe[_A-Z-]|.*[_-]test$|.*[_-]spec$)/i;

const TEST_NAME_DOWN_WEIGHT = 0.5;

/**
 * Defensive handlers necessarily mention the sensitive values they remove.
 * Keep those lexical signals visible, but prevent redactor/sanitizer vocabulary
 * alone from reaching the biomarker warning floor.
 */
const DEFENSIVE_HANDLER_NAME_RE = /^(?:redact|sanitiz|sanitis|mask|scrub)/i;
const DEFENSIVE_LEXICAL_DOWN_WEIGHT = 0.5;
const DEFENSIVE_LEXICAL_SIGNALS: ReadonlySet<SecretSignal> = new Set(['api-key-name', 'password-name', 'pii-name']);
const DEFENSIVE_REPLACEMENT_CALL_RE = /\.(?:replace|replaceAll)\s*\(/g;
const RETURN_STATEMENT_RE = /\breturn\b/g;
const DEFENSIVE_BRACKETED_MASK_RE = /["'`]\[(?:masked|redacted)\]["'`]/i;
const DEFENSIVE_ANGLE_MASK_RE = /["'`]<(?:masked|redacted)>["'`]/i;
const DEFENSIVE_STAR_MASK_RE = /["'`]\*{3,}["'`]/;
const DEFENSIVE_MASK_LITERAL_PATTERNS: readonly RegExp[] = [
  DEFENSIVE_BRACKETED_MASK_RE,
  DEFENSIVE_ANGLE_MASK_RE,
  DEFENSIVE_STAR_MASK_RE,
];
const IDENTIFIER_RE = /\b[A-Za-z_$][\w$]*\b/g;
const SIMPLE_IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const MASK_IDENTIFIER_WORDS: ReadonlySet<string> = new Set([
  'mask',
  'masked',
  'masking',
  'redact',
  'redacted',
  'redaction',
]);
const NEGATED_MASK_IDENTIFIER_WORDS: ReadonlySet<string> = new Set([
  'not',
  'raw',
  'unmask',
  'unmasked',
  'unredacted',
  'without',
]);

interface SourceRange {
  readonly start: number;
  readonly end: number;
}

function skipQuoted(source: string, start: number): number {
  const quote = source[start];
  if (quote !== '"' && quote !== "'" && quote !== '`') return start;
  let index = start + 1;
  while (index < source.length) {
    if (source[index] === '\\') {
      index += 2;
      continue;
    }
    if (source[index] === quote) return index + 1;
    index++;
  }
  return source.length;
}

function findQuotedRanges(source: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  let index = 0;
  while (index < source.length) {
    const quotedEnd = skipQuoted(source, index);
    if (quotedEnd === index) {
      index++;
      continue;
    }
    ranges.push({ start: index, end: quotedEnd });
    index = quotedEnd;
  }
  return ranges;
}

function isInsideRange(index: number, ranges: readonly SourceRange[]): boolean {
  return ranges.some((range) => index >= range.start && index < range.end);
}

function findClosingParen(source: string, openIndex: number): number | null {
  let depth = 0;
  let index = openIndex;
  while (index < source.length) {
    const quotedEnd = skipQuoted(source, index);
    if (quotedEnd !== index) {
      index = quotedEnd;
      continue;
    }
    const char = source[index];
    if (char === '(') depth++;
    if (char === ')') {
      depth--;
      if (depth === 0) return index;
    }
    index++;
  }
  return null;
}

function findFirstArgumentSeparator(source: string, openIndex: number, closeIndex: number): number | null {
  let nestedDepth = 0;
  let index = openIndex + 1;
  while (index < closeIndex) {
    const quotedEnd = skipQuoted(source, index);
    if (quotedEnd !== index) {
      index = quotedEnd;
      continue;
    }
    const char = source[index];
    if (char === '(' || char === '[' || char === '{') nestedDepth++;
    if (char === ')' || char === ']' || char === '}') nestedDepth = Math.max(0, nestedDepth - 1);
    if (char === ',' && nestedDepth === 0) return index;
    index++;
  }
  return null;
}

function replacementReceiverStart(source: string, dotIndex: number): number {
  let index = dotIndex;
  for (;;) {
    while (index > 0 && /\s/.test(source[index - 1]!)) index--;
    while (index > 0 && /[\w$]/.test(source[index - 1]!)) index--;
    if (index === 0 || source[index - 1] !== '.') return index;
    index--;
  }
}

function identifierWords(identifier: string): string[] {
  return identifier
    .replaceAll(/([a-z\d])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[_$]+/)
    .filter(Boolean);
}

function isMaskIdentifier(identifier: string): boolean {
  const words = identifierWords(identifier);
  if (words.some((word) => NEGATED_MASK_IDENTIFIER_WORDS.has(word))) return false;
  return words.some((word) => MASK_IDENTIFIER_WORDS.has(word));
}

function hasMaskLiteral(expression: string): boolean {
  return findQuotedRanges(expression).some((range) => {
    const literal = expression.slice(range.start, range.end);
    return DEFENSIVE_MASK_LITERAL_PATTERNS.some((pattern) => pattern.test(literal));
  });
}

function hasNegatedMaskIdentifier(expression: string): boolean {
  const codeOnly = blankRanges(expression, findQuotedRanges(expression));
  return [...codeOnly.matchAll(IDENTIFIER_RE)].some((match) =>
    identifierWords(match[0]).some((word) => NEGATED_MASK_IDENTIFIER_WORDS.has(word)),
  );
}

function hasMaskIdentifier(expression: string, requireSimpleIdentifier: boolean): boolean {
  const codeOnly = blankRanges(expression, findQuotedRanges(expression)).trim();
  if (requireSimpleIdentifier) return SIMPLE_IDENTIFIER_RE.test(codeOnly) && isMaskIdentifier(codeOnly);
  const identifiers = [...codeOnly.matchAll(IDENTIFIER_RE)].map((match) => match[0]);
  if (hasNegatedMaskIdentifier(expression)) return false;
  return identifiers.some(isMaskIdentifier);
}

function hasRawSensitiveIdentifier(expression: string): boolean {
  const codeOnly = blankRanges(expression, findQuotedRanges(expression));
  return [...codeOnly.matchAll(IDENTIFIER_RE)].some((match) => {
    const identifier = match[0];
    return !isMaskIdentifier(identifier) && hasSensitiveLexicalTerm(identifier);
  });
}

type ReplacementShape =
  | { readonly kind: 'direct' }
  | {
      readonly kind: 'callback';
      readonly arrowIndex: number | null;
      readonly fullMatchParameter: string | null;
      readonly sensitiveParameters: ReadonlySet<string>;
    };

interface CallbackOutput {
  readonly expression: string;
  readonly guardPrefix: string;
}

function findOutsideQuoted(source: string, token: string, quotedRanges: readonly SourceRange[]): number {
  let index = source.indexOf(token);
  while (index >= 0) {
    if (!isInsideRange(index, quotedRanges)) return index;
    index = source.indexOf(token, index + token.length);
  }
  return -1;
}

function callbackParameterSource(replacementArgument: string, arrowIndex: number | null): string {
  if (arrowIndex !== null) {
    const prefix = replacementArgument
      .slice(0, arrowIndex)
      .trim()
      .replace(/^async\s+/, '');
    if (prefix.startsWith('(') && prefix.endsWith(')')) return prefix.slice(1, -1);
    return prefix;
  }

  const openIndex = replacementArgument.indexOf('(');
  if (openIndex < 0) return '';
  const closeIndex = findClosingParen(replacementArgument, openIndex);
  return closeIndex === null ? '' : replacementArgument.slice(openIndex + 1, closeIndex);
}

function sensitiveParameterNames(parameterSource: string): ReadonlySet<string> {
  const names = new Set<string>();
  for (const match of parameterSource.matchAll(IDENTIFIER_RE)) {
    if (hasSensitiveLexicalTerm(match[0])) names.add(match[0].toLowerCase());
  }
  return names;
}

function firstCallbackParameterName(parameterSource: string): string | null {
  const firstParameter = parameterSource.split(',', 1)[0]?.trim() ?? '';
  const match = /^(?:\.\.\.)?([A-Za-z_$][\w$]*)/.exec(firstParameter);
  return match?.[1]?.toLowerCase() ?? null;
}

function describeReplacement(replacementArgument: string): ReplacementShape {
  const quotedRanges = findQuotedRanges(replacementArgument);
  const arrowIndex = findOutsideQuoted(replacementArgument, '=>', quotedRanges);
  const codeOnly = blankRanges(replacementArgument, quotedRanges).trim();
  const isFunctionCallback = /^(?:async\s+)?function\b/.test(codeOnly);
  if (arrowIndex < 0 && !isFunctionCallback) return { kind: 'direct' };
  const normalizedArrowIndex = arrowIndex < 0 ? null : arrowIndex;
  const parameterSource = callbackParameterSource(replacementArgument, normalizedArrowIndex);
  return {
    kind: 'callback',
    arrowIndex: normalizedArrowIndex,
    fullMatchParameter: firstCallbackParameterName(parameterSource),
    sensitiveParameters: sensitiveParameterNames(parameterSource),
  };
}

function callbackOutputExpressions(
  replacementArgument: string,
  shape: Extract<ReplacementShape, { kind: 'callback' }>,
): CallbackOutput[] {
  const outputs: CallbackOutput[] = [];
  const quotedRanges = findQuotedRanges(replacementArgument);
  for (const match of replacementArgument.matchAll(RETURN_STATEMENT_RE)) {
    if (isInsideRange(match.index, quotedRanges)) continue;
    const semicolon = replacementArgument.indexOf(';', match.index);
    const newline = replacementArgument.indexOf('\n', match.index);
    const candidates = [semicolon, newline].filter((index) => index >= 0);
    const end = candidates.length === 0 ? replacementArgument.length : Math.min(...candidates);
    const guardStart = Math.max(
      replacementArgument.lastIndexOf('\n', match.index - 1),
      replacementArgument.lastIndexOf(';', match.index - 1),
      replacementArgument.lastIndexOf('{', match.index - 1),
      replacementArgument.lastIndexOf('}', match.index - 1),
    );
    outputs.push({
      expression: replacementArgument.slice(match.index + match[0].length, end),
      guardPrefix: replacementArgument.slice(guardStart + 1, match.index).trim(),
    });
  }

  if (shape.arrowIndex !== null) {
    const conciseOutput = replacementArgument.slice(shape.arrowIndex + 2).trim();
    if (!conciseOutput.startsWith('{')) outputs.push({ expression: conciseOutput, guardPrefix: '' });
  }
  return outputs;
}

function expressionReferencesIdentifier(expression: string, identifier: string | null): boolean {
  if (identifier === null) return false;
  const codeOnly = blankRanges(expression, findQuotedRanges(expression));
  return [...codeOnly.matchAll(IDENTIFIER_RE)].some((match) => match[0].toLowerCase() === identifier);
}

function isMaskingCallbackOutput(
  output: CallbackOutput,
  shape: Extract<ReplacementShape, { kind: 'callback' }>,
): boolean {
  return (
    !expressionReferencesIdentifier(output.expression, shape.fullMatchParameter) &&
    !hasNegatedMaskIdentifier(output.expression) &&
    !hasRawSensitiveIdentifier(output.expression) &&
    (hasMaskLiteral(output.expression) || hasMaskIdentifier(output.expression, false))
  );
}

function isProvenEmptySensitivePassthrough(
  output: CallbackOutput,
  shape: Extract<ReplacementShape, { kind: 'callback' }>,
): boolean {
  const expression = blankRanges(output.expression, findQuotedRanges(output.expression)).trim().toLowerCase();
  if (shape.fullMatchParameter === null || expression !== shape.fullMatchParameter) return false;
  const guardMatch = /^if\s*\(\s*([A-Za-z_$][\w$]*)\.length\s*===\s*0\s*\)\s*$/.exec(output.guardPrefix);
  const guardedParameter = guardMatch?.[1];
  return guardedParameter !== undefined && shape.sensitiveParameters.has(guardedParameter.toLowerCase());
}

function hasExecutableMaskOutput(replacementArgument: string, shape: ReplacementShape): boolean {
  if (shape.kind === 'direct') {
    return (
      !hasNegatedMaskIdentifier(replacementArgument) &&
      !hasRawSensitiveIdentifier(replacementArgument) &&
      (hasMaskLiteral(replacementArgument) || hasMaskIdentifier(replacementArgument, true))
    );
  }
  const callbackOutputs = callbackOutputExpressions(replacementArgument, shape);
  const isMaskingOutput = (output: CallbackOutput): boolean => isMaskingCallbackOutput(output, shape);
  if (!callbackOutputs.some(isMaskingOutput)) return false;
  return callbackOutputs.every((output) => isMaskingOutput(output) || isProvenEmptySensitivePassthrough(output, shape));
}

function blankSensitiveParameterUses(source: string, parameters: ReadonlySet<string>): string {
  const chars = source.split('');
  for (const match of source.matchAll(IDENTIFIER_RE)) {
    if (parameters.has(match[0].toLowerCase())) chars.fill(' ', match.index, match.index + match[0].length);
  }
  return chars.join('');
}

function hasUnboundSensitiveCallbackUse(
  replacementArgument: string,
  shape: Extract<ReplacementShape, { kind: 'callback' }>,
): boolean {
  return hasSensitiveLexicalTerm(blankSensitiveParameterUses(replacementArgument, shape.sensitiveParameters));
}

function findMaskingReplacementRanges(body: string): SourceRange[] {
  const ranges: SourceRange[] = [];
  const quotedRanges = findQuotedRanges(body);
  for (const match of body.matchAll(DEFENSIVE_REPLACEMENT_CALL_RE)) {
    const callStart = match.index;
    if (isInsideRange(callStart, quotedRanges)) continue;
    const openIndex = callStart + match[0].lastIndexOf('(');
    const closeIndex = findClosingParen(body, openIndex);
    if (closeIndex === null) continue;
    const separator = findFirstArgumentSeparator(body, openIndex, closeIndex);
    if (separator === null) continue;
    const replacementArgument = body.slice(separator + 1, closeIndex);
    const shape = describeReplacement(replacementArgument);
    if (!hasExecutableMaskOutput(replacementArgument, shape)) continue;
    if (shape.kind === 'callback' && hasUnboundSensitiveCallbackUse(replacementArgument, shape)) continue;
    ranges.push({ start: replacementReceiverStart(body, callStart), end: closeIndex + 1 });
  }
  return ranges;
}

function blankRanges(source: string, ranges: readonly SourceRange[]): string {
  const chars = source.split('');
  for (const range of ranges) chars.fill(' ', range.start, range.end);
  return chars.join('');
}

function hasSensitiveLexicalTerm(source: string): boolean {
  return PATTERN_TABLE.some(
    (entry) => DEFENSIVE_LEXICAL_SIGNALS.has(entry.signal) && entry.patterns.some((pattern) => pattern.test(source)),
  );
}

/** A defensive-sounding name is not evidence by itself: require executable
 * replacement syntax whose replacement argument contains a masking output.
 * Blank only those masking calls, then reject the defensive discount when any
 * sensitive executable term remains elsewhere in the body. */
function hasDemonstratedDefensiveSemantics(body: string, language: Language | null | undefined): boolean {
  const executableBody = stripCommentsForRegex(body, language ?? 'typescript');
  const maskingRanges = findMaskingReplacementRanges(executableBody);
  if (maskingRanges.length === 0) return false;
  const outsideMaskingCalls = blankRanges(executableBody, maskingRanges);
  return !hasSensitiveLexicalTerm(outsideMaskingCalls);
}

// ---------------------------------------------------------------------------
// Core implementation
// ---------------------------------------------------------------------------

/**
 * Build the concatenated text corpus for a symbol — all available fields
 * joined with newlines so every pattern has a single target string to search.
 */
function buildCorpus(input: SecretsDetectionInput): string {
  return [input.name, input.signature ?? '', input.body, input.summary ?? ''].filter(Boolean).join('\n');
}

/**
 * Detect secrets-handling patterns in a symbol's name, signature, body, and
 * optional summary. Returns a scored result with human-readable reasons and
 * machine-readable signal identifiers.
 *
 * Score semantics:
 * - >= 0.7: strong signal — likely handles secrets
 * - >= 0.4: moderate signal — worth reviewing
 * - <  0.4: weak or no signal
 */
export function detectSecretsHandling(input: SecretsDetectionInput): SecretsDetectionResult {
  const corpus = buildCorpus(input);

  if (!corpus.trim()) {
    return { score: 0, reasons: [], signals: [] };
  }

  const firedSignals: SecretSignal[] = [];
  const reasons: string[] = [];
  const defensiveHandler =
    DEFENSIVE_HANDLER_NAME_RE.test(input.name) && hasDemonstratedDefensiveSemantics(input.body, input.language);
  let rawScore = 0;

  for (const entry of PATTERN_TABLE) {
    // Each category fires at most once (no double-counting within category).
    const entryWeight = matchedSecretSignalWeight(entry, corpus);
    if (entryWeight !== null) {
      firedSignals.push(entry.signal);
      reasons.push(entry.reason);
      rawScore +=
        defensiveHandler && DEFENSIVE_LEXICAL_SIGNALS.has(entry.signal)
          ? entryWeight * DEFENSIVE_LEXICAL_DOWN_WEIGHT
          : entryWeight;
    }
  }

  // Apply test-name down-weight (multiplicative).
  let score = Math.min(1, rawScore);
  if (score > 0 && TEST_NAME_RE.test(input.name)) {
    score = score * TEST_NAME_DOWN_WEIGHT;
  }

  return {
    score: Math.round(score * 1000) / 1000, // 3 dp, no float drift
    reasons,
    signals: firedSignals,
  };
}

function matchedSecretSignalWeight(entry: (typeof PATTERN_TABLE)[number], corpus: string): number | null {
  if (!entry.patterns.some((pattern) => pattern.test(corpus))) return null;

  // Special-case weight overrides for high-confidence literal patterns.
  if (entry.signal === 'aws-access-key' && AWS_LITERAL_AKIA_RE.test(corpus)) {
    return AWS_LITERAL_AKIA_WEIGHT;
  }
  if (entry.signal === 'jwt-pattern' && JWT_LITERAL_RE.test(corpus)) {
    return JWT_LITERAL_WEIGHT;
  }
  return entry.weight;
}
