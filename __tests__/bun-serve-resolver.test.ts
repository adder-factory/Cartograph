import { describe, it, expect } from 'vitest';
import { bunServeResolver } from '../src/resolution/frameworks/bun-serve.js';

describe('bunServeResolver — language gate', () => {
  it('declares languages: [typescript, javascript, tsx, jsx]', () => {
    // Matches the express resolver's set so a `.get('a.ts')` SQLite
    // call in a Python file can't get matched by Bun.serve regex.
    expect(bunServeResolver.languages).toEqual(['typescript', 'javascript', 'tsx', 'jsx']);
  });

  it('declares name: "bun-serve" for diagnostic surfaces', () => {
    expect(bunServeResolver.name).toBe('bun-serve');
  });
});

describe('bunServeResolver.extractNodes — route extraction', () => {
  it('extracts each path from a single-handler `Bun.serve({ routes: {...} })` call', () => {
    const content = `
import { health, vaultStatus, connectionsItem } from './routes';
const server = Bun.serve({
  port: 39499,
  routes: {
    '/healthz': health,
    '/vault/status': vaultStatus,
    '/connections/:id': connectionsItem,
  },
  fetch: handleFallback,
});
`;
    const nodes = bunServeResolver.extractNodes!('apps/server/server.ts', content);
    expect(nodes.length).toBe(3);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['/connections/:id', '/healthz', '/vault/status']);
    for (const n of nodes) {
      expect(n.kind).toBe('route');
      expect(n.filePath).toBe('apps/server/server.ts');
      expect(n.language).toBe('typescript');
      expect(n.startLine).toBeGreaterThan(0);
    }
  });

  it('emits one node per method on `path: { GET, POST }` method-explicit shape', () => {
    const content = `
const server = Bun.serve({
  routes: {
    '/items': { GET: listItems, POST: createItem },
    '/items/:id': { GET: getItem, PUT: updateItem, DELETE: deleteItem },
  },
});
`;
    const nodes = bunServeResolver.extractNodes!('server.ts', content);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['DELETE /items/:id', 'GET /items', 'GET /items/:id', 'POST /items', 'PUT /items/:id']);
  });

  it('mixes single-handler and method-explicit shapes in one call', () => {
    const content = `
Bun.serve({
  routes: {
    '/healthz': health,
    '/items': { GET: listItems, POST: createItem },
  },
});
`;
    const nodes = bunServeResolver.extractNodes!('mixed.ts', content);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['/healthz', 'GET /items', 'POST /items']);
  });

  it('ignores `Bun.serve` in a JSDoc comment so docs do not leak as real routes', () => {
    const content = `
/**
 * Example usage:
 * Bun.serve({ routes: { '/example': handler } });
 */
export const x = 1;
`;
    const nodes = bunServeResolver.extractNodes!('docs.ts', content);
    expect(nodes).toEqual([]);
  });

  it('does NOT confuse a nested `{ key: ... }` in a handler body for a route entry', () => {
    // depthAtIndex gate: an entry inside a handler's body literal must
    // not surface as a top-level route.
    const content = `
Bun.serve({
  routes: {
    '/healthz': () => {
      const x = { '/nested-fake': true };
      return new Response('ok');
    },
  },
});
`;
    const nodes = bunServeResolver.extractNodes!('nested.ts', content);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['/healthz']);
  });

  it('returns no nodes for files that do not contain `Bun.serve`', () => {
    const content = `
import express from 'express';
const app = express();
app.get('/x', (req, res) => res.send('hi'));
`;
    const nodes = bunServeResolver.extractNodes!('app.ts', content);
    expect(nodes).toEqual([]);
  });

  it('handles a routes block declared before other keys (port/idleTimeout below routes)', () => {
    const content = `
Bun.serve({
  routes: {
    '/healthz': health,
  },
  port: 3000,
  idleTimeout: 0,
});
`;
    const nodes = bunServeResolver.extractNodes!('order.ts', content);
    expect(nodes.length).toBe(1);
    expect(nodes[0]!.name).toBe('/healthz');
  });

  it('survives a malformed Bun.serve call (no closing paren) — no throw AND no partial nodes', () => {
    const content = `
Bun.serve({ routes: { '/healthz': health,
`; // intentionally truncated
    // The extractor bails on the unbalanced call site (findMatchingClose
    // returns -1, the outer loop continues) and yields the empty result.
    // The tightened assertion catches a future regression that would
    // start emitting partial / incorrect nodes for unparseable input.
    let result: unknown;
    expect(() => {
      result = bunServeResolver.extractNodes!('bad.ts', content);
    }).not.toThrow();
    expect(result).toEqual([]);
  });

  it('depth-guards `routes:` so a nested object key named `routes` is not mistaken for the top-level block', () => {
    // Contrived but defensive: a Bun.serve call body that contains an
    // inner-object property literally named `routes:` ALONGSIDE the
    // real routes block. The pre-2026-05-22 routesKeyRe matched the
    // FIRST `routes: {` lexeme without checking object depth — fixed
    // by gating on `depthAtIndex(...) === 0`.
    const content = `
Bun.serve({
  custom: { routes: { '/fake': () => null } },
  routes: {
    '/real': real,
  },
});
`;
    const nodes = bunServeResolver.extractNodes!('depth.ts', content);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['/real']);
  });

  it('parses a method map with no whitespace after the opening brace (`{GET:handler}`)', () => {
    // Reviewer-flagged edge: pre-2026-05-22 methodKeyRe started its
    // scan AFTER the `{`, so the first method key in a brace-tight
    // method map (`{GET:h, POST:h}` — no space after `{`) would slip
    // past the leading-char anchor and the entry would fall back to
    // a single method-less route. Fixed by starting the scan AT the
    // opening `{` so the brace itself is the leading delimiter.
    const content = `
Bun.serve({
  routes: {
    '/items': {GET: listItems, POST: createItem},
  },
});
`;
    const nodes = bunServeResolver.extractNodes!('tight.ts', content);
    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['GET /items', 'POST /items']);
  });
});
