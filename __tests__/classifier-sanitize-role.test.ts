/**
 * Unit tests for `sanitizeApiEndpointRole` — the structural sanity
 * guard on the `api_endpoint` role (friction F16).
 *
 * `api_endpoint` is a structural claim: the symbol services an inbound
 * HTTP request. A non-structural classifier (a small chat NLI model)
 * can emit it from docstring prose alone — e.g. a function whose doc
 * says "public entry point" gets read as an API
 * endpoint. The guard demotes such unsupported labels to
 * `business_logic` while leaving structurally-backed labels intact.
 */
import { describe, it, expect } from 'vitest';
import { sanitizeApiEndpointRole, classifyByStructure } from '../src/llm/classifier.js';

describe('sanitizeApiEndpointRole (F16)', () => {
  it('demotes api_endpoint with no structural HTTP evidence to business_logic', () => {
    // The friction case: `findDuplicateCode` — a plain detector pass,
    // classified api_endpoint off a docstring saying "public entry point".
    expect(
      sanitizeApiEndpointRole('api_endpoint', {
        kind: 'function',
        signature: '(items: readonly string[]): Finding[]',
      }),
    ).toBe('business_logic');
  });

  it('keeps api_endpoint when the route extractor tagged kind=route', () => {
    expect(sanitizeApiEndpointRole('api_endpoint', { kind: 'route', signature: null })).toBe('api_endpoint');
  });

  it('keeps api_endpoint when the signature carries an API param decorator', () => {
    expect(
      sanitizeApiEndpointRole('api_endpoint', {
        kind: 'method',
        signature: 'create(@Body() dto: CreateUserDto): Promise<User>',
      }),
    ).toBe('api_endpoint');
  });

  it('keeps api_endpoint for a (req, res) handler signature', () => {
    expect(
      sanitizeApiEndpointRole('api_endpoint', {
        kind: 'function',
        signature: '(req: Request, res: Response): void',
      }),
    ).toBe('api_endpoint');
  });

  it('keeps api_endpoint for a known handler type in the signature', () => {
    expect(
      sanitizeApiEndpointRole('api_endpoint', {
        kind: 'variable',
        signature: 'const handler: APIGatewayProxyHandler',
      }),
    ).toBe('api_endpoint');
  });

  // Go framework handler shapes (Gin / Echo / Fiber / net/http / cobra) —
  // surfaced by the ollama bug-hunt: every Go HTTP handler was being
  // demoted to business_logic because the structural pre-filter only
  // knew Express's `(req, res)` shape.
  it('keeps api_endpoint for Go framework handler signatures', () => {
    const goSigs: ReadonlyArray<{ kind: string; signature: string }> = [
      { kind: 'method', signature: '(c *gin.Context)' },
      { kind: 'function', signature: '(c echo.Context) error' },
      { kind: 'function', signature: '(c *fiber.Ctx) error' },
      { kind: 'function', signature: '(w http.ResponseWriter, r *http.Request)' },
      { kind: 'function', signature: '(cmd *cobra.Command, args []string) error' },
    ];
    for (const c of goSigs) {
      expect(sanitizeApiEndpointRole('api_endpoint', c)).toBe('api_endpoint');
    }
  });
});

describe('classifyByStructure — Go framework handlers', () => {
  // Parallel coverage for the upstream rule that ASSIGNS api_endpoint
  // (the sanitizer tests above only verify the role survives once
  // assigned). Without this, a refactor that removes GO_HANDLER_RE from
  // classifyByStructure would silently drop on-demand role inference
  // back to `unknown` for every Go handler.
  const cases: ReadonlyArray<{ name: string; signature: string }> = [
    { name: 'GinHandler', signature: '(c *gin.Context)' },
    { name: 'EchoHandler', signature: '(c echo.Context) error' },
    { name: 'FiberHandler', signature: '(c *fiber.Ctx) error' },
    { name: 'NetHttpHandler', signature: '(w http.ResponseWriter, r *http.Request)' },
    { name: 'CobraCommandRun', signature: '(cmd *cobra.Command, args []string) error' },
  ];
  for (const c of cases) {
    it(`labels ${c.name} as api_endpoint`, () => {
      expect(
        classifyByStructure({ kind: 'function', name: c.name, filePath: 'server/handler.go', signature: c.signature }),
      ).toBe('api_endpoint');
    });
  }

  // Negative cases — bare identifiers that LOOK similar but aren't handler signatures.
  it('does not over-match plain functions whose params reference Go types', () => {
    expect(
      classifyByStructure({
        kind: 'function',
        name: 'inspectContext',
        filePath: 'pkg/ctx.go',
        signature: '(ctx context.Context, name string) (string, error)',
      }),
    ).toBeNull();
  });

  it('passes every non-api_endpoint role through unchanged', () => {
    for (const role of ['business_logic', 'util', 'data_model', 'framework_glue', 'test_helper', 'unknown']) {
      expect(sanitizeApiEndpointRole(role, { kind: 'function', signature: null })).toBe(role);
    }
  });

  // Audit group-4 #6: the LLM classifier over-assigned api_endpoint to
  // these plain functions / methods off docstring prose. The guard must
  // fold every one to business_logic — none has HTTP-handler evidence.
  it('demotes the audit-flagged non-endpoints (getConfigPath / getCategorizedHotspots / getSymbolCoChanges / delete)', () => {
    const cases: ReadonlyArray<{ kind: string; signature: string | null }> = [
      // getConfigPath — config path getter
      { kind: 'function', signature: '(projectRoot: string): string' },
      // getCategorizedHotspots — DB query helper
      { kind: 'function', signature: '(qb: QueryBuilder, opts: { minCommits?: number } = {}): HotspotRow[]' },
      // getSymbolCoChanges — DB query helper
      { kind: 'function', signature: '(qb: QueryBuilder, nodeId: string): Array<{ nodeId: string }>' },
      // a `delete` method whose only input was the docstring "Accesses map"
      { kind: 'method', signature: '(id: string): void' },
    ];
    for (const c of cases) {
      expect(sanitizeApiEndpointRole('api_endpoint', c)).toBe('business_logic');
    }
  });
});
