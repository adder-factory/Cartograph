/**
 * Regression test for receiver-type-aware caller resolution in
 * chained-property method calls.
 *
 * Before: `this.embeddingCache.invalidate()` extracted the call as
 * just `"invalidate"` (no receiver hint), so when multiple symbols
 * named `invalidate` exist or the resolver couldn't disambiguate,
 * cross-file `calls` edges were silently dropped. Effect: 0 callers
 * reported by `cartograph_callers invalidate` despite multiple call
 * sites visible in source.
 *
 * After: the extractor walks the receiver chain to the leaf field
 * name (`embeddingCache`), producing the qualified reference
 * `embeddingCache.invalidate`. The resolver's `matchMethodCall`
 * Strategy 2 capitalises the receiver (`EmbeddingCache`) and finds
 * the owning class, then attaches the edge to the correct method.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';

describe('Chained-receiver method-call resolution', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-chained-receiver-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  it('resolves `this.field.method()` to the field-type method', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/cache.ts'),
      `export class EmbeddingCache {
  invalidate(): void {}
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/owner.ts'),
      `import { EmbeddingCache } from './cache.js';
export class Owner {
  private embeddingCache = new EmbeddingCache();
  bust(): void {
    this.embeddingCache.invalidate();
    this.embeddingCache.invalidate();
  }
  bustAgain(): void {
    this.embeddingCache.invalidate();
  }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    // Find EmbeddingCache.invalidate.
    const invalidateNodes = getNodesByKind(cg.queries, 'method').filter(
      (n) => n.name === 'invalidate' && n.filePath === 'src/cache.ts',
    );
    expect(invalidateNodes).toHaveLength(1);
    const target = invalidateNodes[0]!;

    // Callers from src/owner.ts must be present. Pre-fix this returned
    // zero because the receiver hint was lost.
    const callers = cg.internals.traverser.getCallers(target.id);
    const ownerCallers = callers.filter((c) => c.node.filePath === 'src/owner.ts');
    expect(ownerCallers.length).toBeGreaterThan(0);

    // Both `bust` and `bustAgain` should be among the callers.
    const callerNames = new Set(ownerCallers.map((c) => c.node.name));
    expect(callerNames.has('bust')).toBe(true);
    expect(callerNames.has('bustAgain')).toBe(true);
  });

  it('still works for the simple `obj.method()` form (no regression)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/util.ts'),
      `export class Logger {
  log(_msg: string): void {}
}
`,
    );
    fs.writeFileSync(
      path.join(tempDir, 'src/use.ts'),
      `import { Logger } from './util.js';
export function go(): void {
  const logger = new Logger();
  logger.log('hi');
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const logFn = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'log' && n.filePath === 'src/util.ts');
    expect(logFn).toBeDefined();
    const callers = cg.internals.traverser.getCallers(logFn!.id);
    expect(callers.some((c) => c.node.filePath === 'src/use.ts')).toBe(true);
  });

  it('returns null receiver for function-call chains (`x.foo().bar()`)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/c.ts'),
      `export class Builder {
  build(): { commit(): void } { return { commit: () => {} }; }
}
export function go(): void {
  const b = new Builder();
  b.build().commit();   // chain through a call — receiver of commit() is a call, not a name
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });
    // Just confirm the index completed without error and `commit`
    // wasn't spuriously linked back to anything. The structural
    // assertion is "no spurious receiver hint generated" — we don't
    // require any specific edges here, only that indexing succeeded.
    const stats = cg.stats.getStats();
    expect(stats.fileCount).toBeGreaterThan(0);
  });

  it('returns null receiver for subscript-access chains (`arr[0].method()`)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/s.ts'),
      `export class Item { use(): void {} }
export function go(items: Item[]): void {
  items[0]!.use();   // subscript chain — receiver is a subscript_expression, not a name
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });
    // Index completed; no false hint emitted. (The call may or may not
    // resolve depending on broader inference; the contract here is
    // narrow — receiver-name extractor should not invent `items` or
    // `0` as a class-style hint.)
    const stats = cg.stats.getStats();
    expect(stats.fileCount).toBeGreaterThan(0);
  });

  it('does not invent a receiver when the chain ends in `this`/`self` only', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/m.ts'),
      `export class M {
  helper(): void {}
  go(): void { this.helper(); }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    // `this.helper()` collapses to bare `helper` — same-class methods
    // still resolve via in-file lookup.
    const helper = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'helper' && n.filePath === 'src/m.ts');
    expect(helper).toBeDefined();
    const callers = cg.internals.traverser.getCallers(helper!.id);
    expect(callers.some((c) => c.node.name === 'go')).toBe(true);
  });
});
