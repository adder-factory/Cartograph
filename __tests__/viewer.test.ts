/**
 * Viewer HTTP server tests
 *
 * Spins the server on a random port (port 0 → OS-picked) against a
 * temp project so we don't depend on a pre-built index.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { startViewerServer, type ViewerHandle } from '../src/viewer/server.js';

describe('viewer HTTP server', () => {
  let testDir: string;
  let cg: Cartograph;
  let handle: ViewerHandle;

  beforeAll(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-test-'));
    fs.mkdirSync(path.join(testDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src', 'lib.ts'),
      `
export function add(a: number, b: number): number { return a + b; }
export function mul(a: number, b: number): number { return a * b; }
export function compute(x: number, y: number): number {
  // Body padded above ANALYSABLE_MIN_LOC so the biomarker pass
  // actually computes + persists metrics for this symbol.
  const a = add(x, y);
  const b = mul(a, 2);
  const c = add(b, x);
  const d = mul(c, y);
  return d;
}
`,
    );
    cg = Cartograph.initSync(testDir, { config: { include: ['src/**/*.ts'], exclude: [] } });
    await cg.indexAll();
    cg.destroy();
    handle = await startViewerServer(testDir, { port: 0 });
  });

  afterAll(async () => {
    await handle.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('serves the static viewer HTML at /', async () => {
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('cartograph viewer');
    expect(body).toContain('<!doctype html>');
  });

  it('returns project metadata at /api/status', async () => {
    const res = await fetch(`${handle.url}api/status`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      projectRoot: string;
      files: number;
      nodes: number;
      edges: number;
      languages: string[];
    };
    expect(body.projectRoot).toBe(testDir);
    expect(body.files).toBeGreaterThan(0);
    expect(body.nodes).toBeGreaterThan(0);
    expect(body.languages).toContain('typescript');
  });

  it('returns a connected default graph when no focus is given', async () => {
    // The no-focus path now anchors on the highest-centrality node
    // and BFS-traverses outward, so every visible node is connected.
    // The response carries that anchor as `focus` (was null in the
    // earlier "top-N by centrality" implementation).
    const res = await fetch(`${handle.url}api/graph`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      focus: string | null;
      nodes: unknown[];
      edges: Array<{ source: string; target: string }>;
    };
    expect(body.focus).not.toBeNull();
    expect(body.nodes.length).toBeGreaterThan(0);
    // Connected — at least one edge exists when the project has any.
    expect(body.edges.length).toBeGreaterThan(0);
  });

  it('returns the focus subgraph when focus= is given', async () => {
    const res = await fetch(`${handle.url}api/graph?focus=compute&depth=2`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      focus: string | null;
      nodes: Array<{ label: string }>;
      edges: Array<{ source: string; target: string; kind: string }>;
    };
    expect(body.focus).not.toBeNull();
    const labels = body.nodes.map((n) => n.label);
    expect(labels).toContain('compute');
    expect(labels).toContain('add');
    expect(labels).toContain('mul');
    expect(body.edges.length).toBeGreaterThan(0);
  });

  it('returns symbol detail at /api/symbol/:name', async () => {
    const res = await fetch(`${handle.url}api/symbol/compute`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      label: string;
      kind: string;
      file: string;
      callers: unknown[];
      callees: Array<{ label: string }>;
      findings: unknown[];
      metrics: {
        loc: number;
        cyclomatic: number | null;
        maxNesting: number | null;
        fileFirstSeenTs: number | null;
        fileLastTouchedTs: number | null;
        fileCommits: number | null;
      };
    };
    expect(body.label).toBe('compute');
    expect(body.kind).toBe('function');
    expect(body.file).toBe('src/lib.ts');
    const calleeLabels = body.callees.map((c) => c.label);
    expect(calleeLabels).toContain('add');
    expect(calleeLabels).toContain('mul');
    // metrics block: loc is always available; with node_metrics
    // persistence (migration 029) cyclomatic + maxNesting are
    // populated even on clean symbols. file churn fields are null
    // in this test (no git history).
    expect(body.metrics.loc).toBeGreaterThan(0);
    expect(typeof body.metrics.cyclomatic).toBe('number');
    expect(typeof body.metrics.maxNesting).toBe('number');
  });

  it('returns coverage: null when no lcov has been loaded', async () => {
    const res = await fetch(`${handle.url}api/symbol/compute`);
    const body = (await res.json()) as { coverage: unknown | null };
    expect(body.coverage).toBeNull();
  });

  it('returns 404 for unknown symbol', async () => {
    const res = await fetch(`${handle.url}api/symbol/__no_such_symbol__`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/unknown symbol/);
  });

  it('returns 404 for unknown path', async () => {
    const res = await fetch(`${handle.url}does-not-exist`);
    expect(res.status).toBe(404);
  });

  it('rejects non-GET methods with 405', async () => {
    const res = await fetch(`${handle.url}api/status`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('returns project-wide findings rollup at /api/findings', async () => {
    const res = await fetch(`${handle.url}api/findings`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      totalFindings: number;
      byBiomarker: Record<string, number>;
      bySeverity: Record<string, number>;
      nodesWithFindings: number;
      totalNodes: number;
      totalFiles: number;
      codeHealth: number;
    };
    expect(body.totalFindings).toBeGreaterThanOrEqual(0);
    expect(body.totalNodes).toBeGreaterThan(0);
    expect(body.codeHealth).toBeGreaterThanOrEqual(1);
    expect(body.codeHealth).toBeLessThanOrEqual(10);
  });

  it('returns hotspots at /api/hotspots', async () => {
    const res = await fetch(`${handle.url}api/hotspots?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { hotspots: unknown[] };
    expect(Array.isArray(body.hotspots)).toBe(true);
  });

  it('returns recent sessions at /api/sessions (empty on a fresh DB)', async () => {
    const res = await fetch(`${handle.url}api/sessions?limit=5`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: unknown[] };
    expect(Array.isArray(body.sessions)).toBe(true);
  });

  it('returns session detail at /api/sessions/:id (empty calls for unknown id)', async () => {
    const res = await fetch(`${handle.url}api/sessions/nonexistent-session-id`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string; calls: unknown[] };
    expect(body.sessionId).toBe('nonexistent-session-id');
    expect(body.calls).toEqual([]);
  });

  it('returns 400 on a malformed percent-encoded symbol id', async () => {
    const res = await fetch(`${handle.url}api/symbol/%GG`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/malformed/);
  });
});

describe('viewer HTTP server — startup errors', () => {
  it('rejects when the project has no cartograph DB', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-viewer-empty-'));
    try {
      await expect(startViewerServer(empty, { port: 0 })).rejects.toThrow(/No cartograph DB/);
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});
