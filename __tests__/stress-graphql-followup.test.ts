/**
 * Follow-ups from the 2026-05-01 PM stress test against real OSS repos.
 *
 * Three contracts locked in:
 *   - Default maxFileSize is 5 MB (was 1 MB, silently dropped real
 *     GraphQL schemas — the GitHub public schema is 1.4 MB).
 *   - findAllSymbols returns NO matches when no exact name hits, instead
 *     of silently picking the top FTS fuzzy result. Pre-fix, querying
 *     `callers Node` on a graphql index with thousands of fields named
 *     `node` (lowercase) returned "no callers" because the populous
 *     fuzzy result (a field with no incoming edges) eclipsed the
 *     interface `Node` further down the FTS ranking.
 *   - End-to-end: callers --edge-kind implements on a GraphQL interface
 *     surfaces the classes that declare `implements <Interface>`.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { DEFAULT_CONFIG } from '../src/types.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('Stress-test follow-ups (2026-05-01 PM)', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-stress-fu-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  describe('Default maxFileSize', () => {
    it('is 5 MB so real-world GraphQL/SQL schemas are not silently dropped', () => {
      expect(DEFAULT_CONFIG.maxFileSize).toBe(5 * 1024 * 1024);
    });
  });

  describe('findAllSymbols no-fuzzy-fallthrough', () => {
    it('returns "not found" with did-you-mean instead of silently substituting a fuzzy match', async () => {
      // A small fixture where searching for a case-mismatched name will
      // FTS-match many lowercase variants. Pre-fix, the handler picked
      // the top FTS hit and reported zero callers; post-fix it reports
      // a clean "not found" so the agent can correct course.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `export function node(): void {}\n` +
          `export function getNode(): void { node(); }\n` +
          `export function lookupNode(): void { node(); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      // Capital "Node" has no exact match. Pre-fix: silently picks
      // `node` (lowercase) and reports its callers. Post-fix: not-found.
      const r = await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'Node' });
      const text = textOf(r);
      expect(text.toLowerCase()).toContain('not found');
      // Specifically assert the did-you-mean prefix is present, not
      // just that the substring "node" leaks into the response (which
      // would be vacuous since "Node" is in the not-found message).
      expect(text.toLowerCase()).toContain('did you mean');
    });
  });

  describe('GraphQL: callers --edge-kind implements', () => {
    it('surfaces classes that implement an interface', async () => {
      fs.mkdirSync(path.join(tempDir, 'schema'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'schema/types.graphql'),
        `interface Node {\n  id: ID!\n}\n` +
          `interface Timestamps {\n  createdAt: String!\n}\n` +
          `type User implements Node & Timestamps {\n  id: ID!\n  createdAt: String!\n  email: String!\n}\n` +
          `type Post implements Node {\n  id: ID!\n  body: String!\n}\n` +
          `type Tag {\n  name: String!\n}\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', {
        direction: 'callers',
        start: 'Node',
        edgeKind: 'implements',
      });
      const text = textOf(r);
      // The two classes declaring `implements Node` should appear.
      expect(text).toMatch(/User/);
      expect(text).toMatch(/Post/);
      // `Tag` does not implement Node and should NOT appear.
      expect(text).not.toMatch(/^- Tag /m);
    });

    it('returns no callers when the edge-kind filter excludes every incoming edge', async () => {
      fs.mkdirSync(path.join(tempDir, 'schema'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'schema/types.graphql'),
        `interface Node { id: ID! }\ntype User implements Node { id: ID! }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      // `Node` has only `implements` callers. Filtering by `calls` should
      // produce zero, which the handler must surface cleanly.
      const r = await handler.runHandler('cartograph_graph', {
        direction: 'callers',
        start: 'Node',
        edgeKind: 'calls',
      });
      const text = textOf(r);
      expect(text.toLowerCase()).toContain('no callers');
      expect(text.toLowerCase()).toContain('edgekind=calls');
    });
  });
});
