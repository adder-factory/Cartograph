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
      // Long base64-ish or hex token (>=32 printable chars) in a string literal
      /["'][A-Za-z0-9_/+=-]{32,}["']/,
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
  let rawScore = 0;

  for (const entry of PATTERN_TABLE) {
    // Each category fires at most once (no double-counting within category).
    const entryWeight = matchedSecretSignalWeight(entry, corpus);
    if (entryWeight !== null) {
      firedSignals.push(entry.signal);
      reasons.push(entry.reason);
      rawScore += entryWeight;
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
