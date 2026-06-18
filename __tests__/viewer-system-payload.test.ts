/**
 * Viewer `GET /api/system` overview endpoint.
 *
 * Boots the real viewer server against THIS repo's own pre-built index
 * (`.cartograph/` at the repo root) and asserts the structured payload
 * shape that the viewer's Status/Overview page is built against. The
 * repo's own index always has summarizable symbols, so the readiness
 * rollup is non-empty.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startViewerServer, type ViewerHandle } from '../src/features/viewer/server/index.js';
import type { SystemPayload } from '../src/features/viewer/server/system-payload.js';

describe('viewer GET /api/system', () => {
  let handle: ViewerHandle;

  beforeAll(async () => {
    // process.cwd() is the repo root, which is itself a Cartograph
    // project (.cartograph/ exists) — boot against its real index.
    handle = await startViewerServer(process.cwd(), { port: 0 });
  });

  afterAll(async () => {
    await handle.close();
  });

  it('returns a fully-shaped system overview payload with real data', async () => {
    const res = await apiFetch(handle, 'api/system');
    expect(res.status).toBe(200);
    const body = (await res.json()) as SystemPayload;

    // Version is the package version, read fresh from disk.
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);

    // Header metadata present (sqlite path on this repo → a real size).
    expect(typeof body.dbSizeBytes).toBe('number');
    expect(body.backend).toMatch(/sqlite/);
    expect(body.moduleFormat).toBe('ESM (NodeNext, ES2022)');

    // Every readiness key is present.
    expect(body.readiness).toHaveProperty('summaries');
    expect(body.readiness).toHaveProperty('embeddings');
    expect(body.readiness).toHaveProperty('coverage');
    expect(body.readiness).toHaveProperty('roles');
    expect(body.readiness).toHaveProperty('directorySummaries');
    expect(body.readiness).toHaveProperty('unresolvedRefs');

    // The repo's own index has summarizable symbols → a real total.
    expect(body.readiness.summaries).not.toBeNull();
    expect(body.readiness.summaries?.total).toBeGreaterThan(0);
    expect(body.readiness.summaries?.pct).toBeGreaterThanOrEqual(0);
    expect(body.readiness.summaries?.pct).toBeLessThanOrEqual(100);
    expect(body.readiness.summaries?.breakdown).toMatchObject({
      structural: expect.any(Number),
      neighborProp: expect.any(Number),
      llm: expect.any(Number),
      skippedByFloor: expect.any(Number),
    });

    // LLM section: configured or not, tiers is always an array.
    expect(body.llm).not.toBeNull();
    expect(Array.isArray(body.llm?.tiers)).toBe(true);
    for (const tier of body.llm?.tiers ?? []) {
      expect(typeof tier.tier).toBe('string');
      // reachable is a tri-state: true/false (probed) or null (unprobeable).
      expect([true, false, null]).toContain(tier.reachable);
    }
  }, 30_000);
});

function apiFetch(handle: ViewerHandle, pathOrUrl: string): Promise<Response> {
  return fetch(new URL(pathOrUrl, handle.url), {
    headers: { 'x-cartograph-viewer-token': handle.apiToken },
    signal: AbortSignal.timeout(20_000),
  });
}
