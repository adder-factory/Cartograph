/**
 * Viewer `GET /api/system` overview endpoint.
 *
 * Boots the real viewer server against THIS repo's own pre-built index
 * (`.cartograph/` at the repo root) and asserts the structured payload
 * shape that the viewer's Status/Overview page is built against. The
 * repo's own index always has summarizable symbols, so the readiness
 * rollup is non-empty.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Cartograph from '../src/index.js';
import { startViewerServer, type ViewerHandle } from '../src/features/viewer/server/index.js';
import type { SystemPayload } from '../src/features/viewer/server/system-payload.js';

describe('viewer GET /api/system', () => {
  let handle: ViewerHandle;
  let testDir: string;

  beforeAll(async () => {
    // Hermetic temp project — the repo's own .cartograph/ is gitignored
    // and absent in clean checkouts/CI, so don't boot against process.cwd().
    // The fixture has real functions so the summaries-readiness denominator
    // is non-empty.
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-system-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `
export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }
export function compute(x: number, y: number): number {
  const a = add(x, y);
  const b = mul(a, 2);
  return add(b, x);
}
`,
    );
    const cg = Cartograph.initSync(testDir, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.close();
    handle = await startViewerServer(testDir, { port: 0 });
  });

  afterAll(async () => {
    await handle.close();
    fs.rmSync(testDir, { recursive: true, force: true });
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

    // LLM section: null when the fixture has no LLM configured, else tiers
    // is an array; each tier's reachable is a tri-state.
    expect(body.llm === null || Array.isArray(body.llm.tiers)).toBe(true);
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
