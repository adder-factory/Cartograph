/**
 * `scanForLlmBackends` — detects which OpenAI-compat backends are
 * running locally so cartograph can offer them as alternatives instead
 * of telling the user "install Ollama". Tests run against Bun.serve
 * mocks bound to OS-assigned ports + the natural negative case (no
 * server on the well-known ports).
 *
 * Bound: the scanner walks a fixed list of well-known ports (8080,
 * 11434, 8000, 1234, 5000). We can't reasonably bind those ports in
 * tests (race with the user's actual backends). Instead we test the
 * scanner's behaviour against the `extraEndpoints` parameter — which
 * is the same code path the real flow uses for non-default ports.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { backendInstallHint, backendLabel, scanForLlmBackends } from '../src/installer/scan-backends.js';

interface MockServer {
  url: string;
  stop(): void;
}

function startMockServer(handler: (req: Request) => Response | Promise<Response>): MockServer {
  const server = Bun.serve({ port: 0, fetch: handler });
  return { url: `http://localhost:${server.port}`, stop: () => server.stop() };
}

describe('scanForLlmBackends', () => {
  const servers: MockServer[] = [];

  afterEach(() => {
    while (servers.length > 0) servers.pop()!.stop();
  });

  it('returns empty array when no extra endpoints respond', async () => {
    // Don't start any mock servers; just probe a port that's not bound.
    const result = await scanForLlmBackends(['http://localhost:1']);
    // Well-known ports MAY or may not be live on the user's machine, but
    // the explicit unreachable URL must NOT show up.
    expect(result.find((d) => d.endpoint === 'http://localhost:1')).toBeUndefined();
  });

  it('detects a backend at an explicitly-passed extra endpoint', async () => {
    const server = startMockServer(() =>
      Response.json({
        object: 'list',
        data: [
          { id: 'model-a', object: 'model' },
          { id: 'model-b', object: 'model' },
        ],
      }),
    );
    servers.push(server);
    const result = await scanForLlmBackends([server.url]);
    const match = result.find((d) => d.endpoint === server.url);
    expect(match).toBeDefined();
    expect(match!.kind).toBe('unknown'); // OS-assigned port, no header hint
    expect(match!.models).toEqual(['model-a', 'model-b']);
  });

  it('passes bearer auth when an explicitly-passed extra endpoint has an apiKey', async () => {
    const server = startMockServer((req) => {
      if (req.headers.get('authorization') !== 'Bearer scanner-token') {
        return Response.json({ error: 'missing token' }, { status: 401 });
      }
      return Response.json({ data: [{ id: 'private-model', object: 'model' }] });
    });
    servers.push(server);

    const result = await scanForLlmBackends([{ endpoint: server.url, apiKey: 'scanner-token' }]);

    const match = result.find((d) => d.endpoint === server.url);
    expect(match).toBeDefined();
    expect(match!.models).toEqual(['private-model']);
  });

  it('passes bearer auth when a configured extra endpoint normalizes to a built-in target', async () => {
    const realFetch = globalThis.fetch;
    const seenAuth: string[] = [];
    try {
      globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const url = String(input);
        if (url !== 'http://localhost:8080/v1/models') {
          return new Response('not found', { status: 404 });
        }
        const auth = new Headers(init?.headers).get('authorization') ?? '';
        seenAuth.push(auth);
        if (auth !== 'Bearer known-target-token') {
          return Response.json({ error: 'missing token' }, { status: 401 });
        }
        return Response.json({ data: [{ id: 'private-known-target-model', object: 'model' }] });
      }) as typeof fetch;

      const result = await scanForLlmBackends([{ endpoint: 'http://localhost:8080/', apiKey: 'known-target-token' }]);

      const match = result.find((d) => d.endpoint === 'http://localhost:8080');
      expect(match).toBeDefined();
      expect(match!.kind).toBe('llama-server');
      expect(match!.models).toEqual(['private-known-target-model']);
      expect(seenAuth).toEqual(['Bearer known-target-token']);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it('identifies the backend from the Server header when port-based fallback would be "unknown"', async () => {
    const server = startMockServer(() => {
      const headers = new Headers({ Server: 'ollama-server/0.1.0' });
      return new Response(JSON.stringify({ data: [{ id: 'nomic', object: 'model' }] }), {
        status: 200,
        headers: { ...Object.fromEntries(headers.entries()), 'Content-Type': 'application/json' },
      });
    });
    servers.push(server);
    const result = await scanForLlmBackends([server.url]);
    const match = result.find((d) => d.endpoint === server.url);
    expect(match).toBeDefined();
    expect(match!.kind).toBe('ollama');
    expect(match!.serverHeader).toMatch(/ollama/i);
  });

  it('handles non-OpenAI-compat (non-JSON) responses gracefully', async () => {
    const server = startMockServer(() => new Response('<html>HelloWorld</html>', { status: 200 }));
    servers.push(server);
    const result = await scanForLlmBackends([server.url]);
    // Non-JSON 200 → scanner treats endpoint as absent (not OpenAI-compat).
    expect(result.find((d) => d.endpoint === server.url)).toBeUndefined();
  });

  it('handles non-2xx responses as absent', async () => {
    const server = startMockServer(() => new Response('not implemented', { status: 404 }));
    servers.push(server);
    const result = await scanForLlmBackends([server.url]);
    expect(result.find((d) => d.endpoint === server.url)).toBeUndefined();
  });

  it('handles JSON without `data` array (e.g. error envelope) as absent', async () => {
    const server = startMockServer(() => Response.json({ error: 'no model loaded' }));
    servers.push(server);
    const result = await scanForLlmBackends([server.url]);
    // 2xx + JSON but no `data: [{id}]` shape → scanner records the
    // endpoint with empty models (still a valid OpenAI-compat probe).
    const match = result.find((d) => d.endpoint === server.url);
    expect(match).toBeDefined();
    expect(match!.models).toEqual([]);
  });

  it('strips trailing slash from an extra endpoint when deduping vs known ports', async () => {
    // Pass a trailing-slash variant of one of the well-known ports.
    // The scanner normalises both, so the dedup logic prevents a
    // duplicate entry. (Whether the well-known port actually responds
    // depends on the user's machine; this test only checks no double-
    // probing logic, via the result list's len being ≤ well-known count.)
    const knownCount = (await scanForLlmBackends()).length;
    const withExtra = await scanForLlmBackends(['http://localhost:8080/']);
    expect(withExtra.length).toBe(knownCount);
  });

  it('preserves the extra endpoint URL in the result (so the caller can recognise their own config)', async () => {
    const server = startMockServer(() => Response.json({ data: [{ id: 'm', object: 'model' }] }));
    servers.push(server);
    const result = await scanForLlmBackends([server.url]);
    const match = result.find((d) => d.endpoint === server.url);
    expect(match).toBeDefined();
    expect(match!.endpoint).toBe(server.url); // exact URL, no /v1 suffix
  });
});

describe('backendLabel + backendInstallHint', () => {
  it('returns human-readable labels for every backend kind', () => {
    expect(backendLabel('llama-server')).toMatch(/llama/i);
    expect(backendLabel('ollama')).toMatch(/ollama/i);
    expect(backendLabel('mlx_lm')).toMatch(/mlx/i);
    expect(backendLabel('lm-studio')).toMatch(/lm studio/i);
    expect(backendLabel('localai')).toMatch(/localai/i);
    expect(backendLabel('unknown')).toMatch(/openai-compatible/i);
  });

  it('returns install hints with actionable install / run commands', () => {
    expect(backendInstallHint('llama-server')).toMatch(/brew install llama\.cpp/);
    expect(backendInstallHint('llama-server')).toMatch(/llama-server -m/);
    expect(backendInstallHint('ollama')).toMatch(/ollama\.com/);
    expect(backendInstallHint('ollama')).toMatch(/ollama pull/);
    expect(backendInstallHint('mlx_lm')).toMatch(/pip install mlx-lm/);
    expect(backendInstallHint('lm-studio')).toMatch(/lmstudio\.ai/);
    expect(backendInstallHint('localai')).toMatch(/localai\.io/);
    expect(backendInstallHint('unknown')).toMatch(/OpenAI-compat/);
  });
});
