/**
 * Tests for the heuristic-first secrets / PII detector.
 *
 * Covers: input validation, individual signal firing, composite scoring,
 * score cap, deduplication within categories, false-positive guards, and
 * human-readable reason strings.
 */
import { describe, it, expect } from 'vitest';
import { detectSecretsHandling, type SecretsDetectionInput } from '../src/llm/secrets-detector.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function input(overrides: Partial<SecretsDetectionInput> & { body?: string }): SecretsDetectionInput {
  return {
    name: overrides.name ?? 'myFunction',
    signature: overrides.signature ?? null,
    body: overrides.body ?? '',
    summary: overrides.summary,
  };
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

describe('detectSecretsHandling — input validation', () => {
  it('empty body returns score=0, signals=[]', () => {
    const result = detectSecretsHandling(input({ body: '' }));
    expect(result.score).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it('body with no secret patterns returns score=0', () => {
    const result = detectSecretsHandling(input({ body: 'function add(a: number, b: number) { return a + b; }' }));
    expect(result.score).toBe(0);
    expect(result.signals).toEqual([]);
  });

  it('all-fields-empty (except name) returns score=0', () => {
    const result = detectSecretsHandling({
      name: '',
      signature: null,
      body: '',
      summary: null,
    });
    expect(result.score).toBe(0);
    expect(result.signals).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Single signals
// ---------------------------------------------------------------------------

describe('detectSecretsHandling — single signals', () => {
  it('api-key-name fires for function named getApiKey', () => {
    const result = detectSecretsHandling(input({ name: 'getApiKey', body: 'return config.apiKey;' }));
    expect(result.signals).toContain('api-key-name');
    // weight is 0.3; score should include it
    expect(result.score).toBeGreaterThanOrEqual(0.3);
  });

  it('api-key-name fires for body referencing "secret"', () => {
    const result = detectSecretsHandling(input({ body: 'const value = config.secret;' }));
    expect(result.signals).toContain('api-key-name');
    expect(result.score).toBeGreaterThanOrEqual(0.3);
  });

  it('jwt-pattern fires for verifyJwt call in body', () => {
    const result = detectSecretsHandling(input({ body: 'const payload = verifyJwt(token, secretKey);' }));
    expect(result.signals).toContain('jwt-pattern');
    expect(result.score).toBeGreaterThanOrEqual(0.3);
  });

  it('jwt-pattern fires for jwt.verify in body', () => {
    const result = detectSecretsHandling(input({ body: 'jwt.verify(token, process.env.JWT_SECRET);' }));
    expect(result.signals).toContain('jwt-pattern');
  });

  it('literal AWS access key fires AKIA pattern with weight >=0.6', () => {
    const result = detectSecretsHandling(input({ body: 'const key = "AKIAIOSFODNN7EXAMPLE"; // DO NOT COMMIT' }));
    expect(result.signals).toContain('aws-access-key');
    expect(result.score).toBeGreaterThanOrEqual(0.6);
  });

  it('hardcoded JWT literal (eyJ...) fires jwt-pattern with weight >=0.5', () => {
    const result = detectSecretsHandling(
      input({
        body: 'const tok = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ.abc";',
      }),
    );
    expect(result.signals).toContain('jwt-pattern');
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('env-secret-read fires for process.env.SECRET_KEY', () => {
    const result = detectSecretsHandling(input({ body: 'const key = process.env.SECRET_KEY;' }));
    expect(result.signals).toContain('env-secret-read');
    expect(result.score).toBeGreaterThanOrEqual(0.3);
  });

  it('env-secret-read fires for process.env.PASSWORD', () => {
    const result = detectSecretsHandling(input({ body: 'const pass = process.env.PASSWORD_HASH;' }));
    expect(result.signals).toContain('env-secret-read');
  });

  it('password-name fires for function with password param', () => {
    const result = detectSecretsHandling(
      input({
        body: 'function login(username: string, password: string) {}',
      }),
    );
    expect(result.signals).toContain('password-name');
    expect(result.score).toBeGreaterThanOrEqual(0.3);
  });

  it('password-name fires for "passwd" variant', () => {
    const result = detectSecretsHandling(input({ body: 'const passwd = getHash();' }));
    expect(result.signals).toContain('password-name');
  });

  it('pii-name fires for ssn reference', () => {
    const result = detectSecretsHandling(input({ body: 'const ssn = user.socialSecurity;' }));
    expect(result.signals).toContain('pii-name');
    expect(result.score).toBeGreaterThanOrEqual(0.2);
  });

  it('pii-name fires for credit_card reference', () => {
    const result = detectSecretsHandling(input({ body: 'const creditCard = payment.credit_card;' }));
    expect(result.signals).toContain('pii-name');
  });

  it('literal-token fires for long base64-ish string', () => {
    const result = detectSecretsHandling(
      input({
        body: 'const secret = "abcdefghijklmnopqrstuvwxyz012345";',
      }),
    );
    expect(result.signals).toContain('literal-token');
    expect(result.score).toBeGreaterThanOrEqual(0.2);
  });

  it('crypto-secret fires for hmac with key argument', () => {
    const result = detectSecretsHandling(input({ body: 'const mac = hmac(data, secretKey);' }));
    expect(result.signals).toContain('crypto-secret');
  });
});

// ---------------------------------------------------------------------------
// Composite scoring
// ---------------------------------------------------------------------------

describe('detectSecretsHandling — composite scoring', () => {
  it('api-key-name + crypto-secret accumulate to ~0.5', () => {
    const result = detectSecretsHandling(
      input({
        body: 'function signRequest(apiKey: string) { return hmac(payload, apiKey); }',
      }),
    );
    expect(result.signals).toContain('api-key-name');
    expect(result.signals).toContain('crypto-secret');
    // 0.3 (api-key-name) + 0.2 (crypto-secret) = 0.5
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('score caps at 1.0 even with many signals', () => {
    // Trigger as many signals as possible in one body
    const body = [
      'const apiKey = process.env.SECRET_KEY;', // api-key-name + env-secret-read
      'const password = "AKIAIOSFODNN7EXAMPLE";', // password-name + aws-access-key (literal)
      'const ssn = user.ssn;', // pii-name
      'const tok = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";', // jwt-literal
    ].join('\n');
    const result = detectSecretsHandling(input({ body }));
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.signals.length).toBeGreaterThan(3);
  });

  it('same category fires only once for multiple API_KEY mentions', () => {
    const result = detectSecretsHandling(
      input({
        body: 'const apiKey = config.api_key; return { apiKey, secret: cfg.apiKey };',
      }),
    );
    // Only one api-key-name signal regardless of how many matches
    const apiKeySignals = result.signals.filter((s) => s === 'api-key-name');
    expect(apiKeySignals).toHaveLength(1);
  });

  it('multiple distinct signals all appear in result', () => {
    const result = detectSecretsHandling(
      input({
        body: 'function authenticate(password: string) { return jwt.sign(payload, secret); }',
      }),
    );
    // password-name + jwt-pattern + api-key-name (from "secret")
    expect(result.signals.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.length).toBe(result.signals.length);
  });
});

// ---------------------------------------------------------------------------
// False-positive guards
// ---------------------------------------------------------------------------

describe('detectSecretsHandling — false-positive guards', () => {
  it('test-named symbol (testApiKeyAuth) down-weights score by 0.5', () => {
    // Without down-weight: api-key-name fires on "apiKey" token → 0.3
    // With down-weight: 0.3 * 0.5 = 0.15
    // Use a body with a standalone "apiKey" token so the signal can fire,
    // then verify the score is halved (test-name guard is multiplicative).
    const result = detectSecretsHandling(
      input({
        name: 'testApiKeyAuth',
        body: 'const apiKey = getApiKey(); expect(apiKey).toBeDefined();',
      }),
    );
    expect(result.score).toBeLessThan(0.3);
    // Signal still fires; only score is reduced
    expect(result.signals).toContain('api-key-name');
  });

  it('test_-prefixed symbol is also down-weighted', () => {
    const result = detectSecretsHandling(input({ name: 'test_password_reset', body: 'const password = "hunter2";' }));
    expect(result.score).toBeLessThan(0.3);
  });

  it('should-prefixed symbol is down-weighted', () => {
    const result = detectSecretsHandling(
      input({ name: 'should validate apiKey header', body: 'expect(req.apiKey).toBeDefined();' }),
    );
    expect(result.score).toBeLessThan(0.3);
  });

  it('plain "token" mention without other context produces low score (api-key-name still fires)', () => {
    // "token" matches api-key-name → 0.3, but no other signals
    const result = detectSecretsHandling(
      input({ body: 'function processToken(token: string) { return parse(token); }' }),
    );
    expect(result.signals).toContain('api-key-name');
    // Score should be exactly the api-key-name weight (0.3) — below "moderate" threshold
    expect(result.score).toBeLessThanOrEqual(0.3);
  });

  it('long strings in test fixtures still caught by literal-token signal', () => {
    const result = detectSecretsHandling(
      input({
        name: 'getFixture',
        body: 'return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 34 chars of dummy data',
      }),
    );
    // literal-token fires even for test-fixture-looking code (integration layer may pre-filter)
    expect(result.signals).toContain('literal-token');
  });
});

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

describe('detectSecretsHandling — reasons', () => {
  it('reasons array has one entry per fired signal', () => {
    const result = detectSecretsHandling(
      input({
        body: 'const apiKey = process.env.SECRET_KEY; const password = cfg.pwd;',
      }),
    );
    expect(result.reasons.length).toBe(result.signals.length);
  });

  it('each reason is a non-empty human-readable string', () => {
    const result = detectSecretsHandling(input({ body: 'const apiKey = config.api_key;' }));
    for (const reason of result.reasons) {
      expect(typeof reason).toBe('string');
      expect(reason.length).toBeGreaterThan(5);
    }
  });

  it('reasons are deterministic for the same input', () => {
    const i = input({ body: 'const apiKey = process.env.API_KEY; const password = pass;' });
    const r1 = detectSecretsHandling(i);
    const r2 = detectSecretsHandling(i);
    expect(r1.reasons).toEqual(r2.reasons);
    expect(r1.signals).toEqual(r2.signals);
    expect(r1.score).toBe(r2.score);
  });

  it('no signals → empty reasons array', () => {
    const result = detectSecretsHandling(input({ body: 'return 42;' }));
    expect(result.reasons).toEqual([]);
  });

  it('summary field contributes to detection when body is clean', () => {
    const result = detectSecretsHandling(
      input({
        body: 'return user;',
        summary: 'Retrieves the user and their api_key for downstream auth.',
      }),
    );
    expect(result.signals).toContain('api-key-name');
  });

  it('signature field contributes to detection', () => {
    const result = detectSecretsHandling(
      input({
        body: 'return computed;',
        signature: '(password: string, salt: Buffer): string',
      }),
    );
    expect(result.signals).toContain('password-name');
  });
});
