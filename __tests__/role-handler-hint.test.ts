/**
 * cartograph_role: unknown-diagnostic should detect handler-shaped
 * signatures and surface the supported-shape hint (Agent C B-2).
 *
 * Locks in the small token-set used by `signatureLooksLikeHandler` so
 * a future refactor doesn't silently drop coverage for one of the
 * frameworks the structural classifier already supports.
 */
import { describe, it, expect } from 'vitest';
import { signatureLooksLikeHandler } from '../src/mcp/tools/role.js';

describe('signatureLooksLikeHandler — handler-token detector', () => {
  it('returns false on empty / nullish signatures', () => {
    expect(signatureLooksLikeHandler(undefined)).toBe(false);
    expect(signatureLooksLikeHandler(null)).toBe(false);
    expect(signatureLooksLikeHandler('')).toBe(false);
  });

  it('detects Go framework handler tokens', () => {
    expect(signatureLooksLikeHandler('(c *gin.Context)')).toBe(true);
    expect(signatureLooksLikeHandler('(c echo.Context) error')).toBe(true);
    expect(signatureLooksLikeHandler('(c *fiber.Ctx) error')).toBe(true);
    expect(signatureLooksLikeHandler('(w http.ResponseWriter, r *http.Request)')).toBe(true);
    expect(signatureLooksLikeHandler('(cmd *cobra.Command, args []string) error')).toBe(true);
  });

  it('detects Lambda / Express handler type names', () => {
    expect(signatureLooksLikeHandler('const handler: APIGatewayProxyHandler')).toBe(true);
    expect(signatureLooksLikeHandler('const h: RequestHandler')).toBe(true);
    expect(signatureLooksLikeHandler('const h: RouteHandler')).toBe(true);
    expect(signatureLooksLikeHandler('const h: HttpHandler')).toBe(true);
  });

  it('returns false on plain non-handler signatures', () => {
    expect(signatureLooksLikeHandler('(items: readonly string[]): Finding[]')).toBe(false);
    expect(signatureLooksLikeHandler('(name: string, age: number)')).toBe(false);
    expect(signatureLooksLikeHandler('(ctx context.Context) error')).toBe(false);
  });
});
