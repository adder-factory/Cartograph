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
    language: overrides.language,
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

  it('literal-token does NOT fire on MIME types or digit-free prose literals (field report #2 item 4)', () => {
    // 34 chars of the token alphabet, zero digits — a content type,
    // not a credential. Used to push a real Turnstile verifier to
    // warning.
    const mime = detectSecretsHandling(
      input({ body: 'headers.set("content-type", "application/x-www-form-urlencoded");' }),
    );
    expect(mime.signals).not.toContain('literal-token');
    // Digit-free kebab/slash identifier prose — same shape, same verdict.
    const prose = detectSecretsHandling(input({ body: 'const slug = "this-is-a-long-kebab-identifier-string";' }));
    expect(prose.signals).not.toContain('literal-token');
    // A long token WITH digits still fires even when slash-y.
    const real = detectSecretsHandling(input({ body: 'const k = "c2VjcmV0LXRva2Vu/with9digits8inside7thing";' }));
    expect(real.signals).toContain('literal-token');
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
    expect(result.score).toBeLessThanOrEqual(1);
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
  it('down-weights lexical secret terms in a defensive redactor name and body', () => {
    // Real SynergySSH shape: `password` is the value being masked and `token`
    // appears only in an explanatory comment. Together they used to score 0.6
    // and emit a secrets_handling warning for the defensive helper itself.
    const result = detectSecretsHandling(
      input({
        name: 'redactUserColonPassword',
        signature: '(line: string): string',
        body: `
          const redactUserColonPassword = (line: string): string =>
            line.replace(USER_COLON_PASSWORD, (full, user: string, password: string) => {
              if (password.length === 0) return full;
              // Only part of the token is masked so its surrounding syntax stays intact.
              return user + SECRET_MASK;
            });
        `,
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBe(0.3);

    for (const replacement of ['"[masked]"', '"<redacted>"', '"***"']) {
      const sanitizer = detectSecretsHandling(
        input({
          name: 'sanitizePasswordToken',
          body: `return token.replace(password, ${replacement});`,
        }),
      );
      expect(sanitizer.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
      expect(sanitizer.score).toBe(0.3);
    }
  });

  it('does not trust a sanitizer name when the function returns credentials unchanged', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: 'return { password, token };',
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it.each([
    ['a direct replacement', 'return token.replace(pattern, password + "***");'],
    ['a replacement callback', 'return token.replace(pattern, (password) => password + "***");'],
    ['a callback full match', 'return token.replace(pattern, (full, password) => full + "***");'],
    ['an explicitly raw value', 'return token.replace(pattern, (password) => raw + "***");'],
  ])('does not down-weight %s that appends a mask to a raw credential', (_description, body) => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body,
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not down-weight a callback with masked and unguarded passthrough branches', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: [
          'return token.replace(pattern, (full, password) => {',
          '  if (leak) return full;',
          '  return "***";',
          '});',
        ].join('\n'),
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not trust a redactor name when the function logs credentials', () => {
    const result = detectSecretsHandling(
      input({
        name: 'redactCredentials',
        body: 'console.log(password, token);',
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not down-weight a partial mask that leaks a different raw credential', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: ['const maskedPassword = password.replace(/./g, "***");', 'console.log(token);', 'return token;'].join(
          '\n',
        ),
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not treat an unrelated replacement followed by a masked flag as redaction', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: [
          'const normalized = username.replace("a", "b");',
          'const masked = false;',
          'console.log(password, token);',
          'return { password, token };',
        ].join('\n'),
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not let an unrelated username mask excuse a raw password and token sink', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: ['const maskedUsername = username.replace(/./g, "***");', 'send(password, token);'].join('\n'),
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not treat an arbitrary unmaskedValue replacement as a mask', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: 'return token.replace(password, unmaskedValue);',
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not treat mask-like replacement text inside a string literal as executable', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: 'const example = "token.replace(password, \'[masked]\')";',
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('uses Python comment syntax before accepting masking evidence', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        language: 'python',
        body: '# token.replace(password, "***")',
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('does not down-weight when one secret is masked and another is forwarded', () => {
    const result = detectSecretsHandling(
      input({
        name: 'sanitizePasswordToken',
        body: ['return password.replace(/./g, () => {', '  forwardToService(token);', '  return "***";', '});'].join(
          '\n',
        ),
      }),
    );

    expect(result.signals).toEqual(expect.arrayContaining(['api-key-name', 'password-name']));
    expect(result.score).toBeGreaterThanOrEqual(0.5);
  });

  it('keeps substantive env, crypto, and literal signals strong in defensive helpers', () => {
    const envAndCrypto = detectSecretsHandling(
      input({
        name: 'sanitizeEnvironmentSecret',
        body: 'const secretKey = process.env.SECRET_KEY; return hmac(payload, secretKey);',
      }),
    );
    expect(envAndCrypto.signals).toEqual(expect.arrayContaining(['crypto-secret', 'env-secret-read']));
    expect(envAndCrypto.score).toBe(0.5);

    const literalCases = [
      {
        name: 'redactAwsFixture',
        body: 'return "AKIAIOSFODNN7EXAMPLE";',
        signal: 'aws-access-key',
        score: 0.6,
      },
      {
        name: 'sanitizeEncodedClaim',
        body: 'return "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc";',
        signal: 'jwt-pattern',
        score: 0.5,
      },
      {
        name: 'scrubOpaqueFixture',
        body: 'return "c2VjcmV0LXRva2VuLXBheWxvYWQ9MTIzNDU2";',
        signal: 'literal-token',
        score: 0.2,
      },
    ];
    for (const literalCase of literalCases) {
      const result = detectSecretsHandling(input({ name: literalCase.name, body: literalCase.body }));
      expect(result.signals).toContain(literalCase.signal);
      expect(result.score).toBe(literalCase.score);
    }
  });

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

  it('digit-free fixture strings are no longer flagged as literal tokens', () => {
    const result = detectSecretsHandling(
      input({
        name: 'getFixture',
        body: 'return "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"; // 34 chars of dummy data',
      }),
    );
    // Since the digit requirement (field report #2 item 4), a
    // digit-free letter run no longer counts as a token — that shape
    // is prose/dummy data, the exact FP class the report hit. A
    // digit-bearing fixture still fires (covered above).
    expect(result.signals).not.toContain('literal-token');
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
