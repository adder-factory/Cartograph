/**
 * Regression tests for the tests-edges imports-walk fallback.
 *
 * Convention-based test → subject mapping uses basenames
 * (`foo.test.ts` → `foo.ts`). Tests named after the *bug* they cover —
 * e.g. `dead-code-pagination.test.ts` testing `src/llm/dead-code.ts` —
 * have no name overlap with their subject and the convention finder
 * returns nothing. The imports-walk fallback resolves the test's
 * relative imports to indexed files and emits `tests` edges to those.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';

describe('tests-edges imports-walk fallback', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-tests-edges-fallback-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('emits a tests edge when convention misses but imports point to the subject', async () => {
    fs.mkdirSync(path.join(tempDir, 'src/llm'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/llm/dead-code.ts'),
      `export function findGraphCandidates(): number[] { return []; }\n`,
    );
    // Test file is named after the BUG, not the subject. Convention
    // finder cannot map this without the imports-walk fallback.
    fs.writeFileSync(
      path.join(tempDir, '__tests__/dead-code-pagination.test.ts'),
      `import { findGraphCandidates } from '../src/llm/dead-code';
test('it works', () => { findGraphCandidates(); });
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const tests = cg.stats.getTestsForFile('src/llm/dead-code.ts');
    expect(tests.map((f) => f.path)).toContain('__tests__/dead-code-pagination.test.ts');
  });

  it('does not emit a tests edge when the convention finder already mapped the test', async () => {
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/util.ts'), `export function u(): void {}\n`);
    fs.writeFileSync(path.join(tempDir, 'src/other.ts'), `export function o(): void {}\n`);
    // Co-located test by basename — convention will map this directly.
    // The imports-walk fallback should NOT additionally emit an edge to
    // `other.ts` (we trust the convention answer when present).
    fs.writeFileSync(
      path.join(tempDir, 'src/util.test.ts'),
      `import { u } from './util';
import { o } from './other';
test('it', () => { u(); o(); });
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const utilTests = cg.stats.getTestsForFile('src/util.ts');
    expect(utilTests.map((f) => f.path)).toContain('src/util.test.ts');
    const otherTests = cg.stats.getTestsForFile('src/other.ts');
    expect(otherTests.map((f) => f.path)).not.toContain('src/util.test.ts');
  });

  it('skips bare specifiers (npm packages) and unresolvable paths', async () => {
    fs.mkdirSync(path.join(tempDir, 'src/llm'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/llm/dead-code.ts'), `export function f(): void {}\n`);
    fs.writeFileSync(
      path.join(tempDir, '__tests__/edge.test.ts'),
      `import { describe, it } from 'vitest';     // bare — skip
import { f } from '../src/llm/dead-code';
import { x } from '../src/llm/missing-file';   // unresolvable — skip
describe('e', () => it('e', () => f()));
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const tests = cg.stats.getTestsForFile('src/llm/dead-code.ts');
    expect(tests.map((f) => f.path)).toContain('__tests__/edge.test.ts');
  });

  it('does not edge a test to test-only paths (no test-on-test mapping)', async () => {
    fs.mkdirSync(path.join(tempDir, '__tests__/helpers'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, '__tests__/helpers/util.ts'),
      `export function helper(): number { return 1; }\n`,
    );
    fs.writeFileSync(
      path.join(tempDir, '__tests__/integration-bug-42.test.ts'),
      `import { helper } from './helpers/util';
test('repro', () => { helper(); });
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    // The helper is under __tests__/, so the fallback must skip it.
    const helperTests = cg.stats.getTestsForFile('__tests__/helpers/util.ts');
    expect(helperTests.map((f) => f.path)).not.toContain('__tests__/integration-bug-42.test.ts');
  });

  it('resolves directory-with-index imports', async () => {
    fs.mkdirSync(path.join(tempDir, 'src/feature'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/feature/index.ts'), `export function publicApi(): void {}\n`);
    fs.writeFileSync(
      path.join(tempDir, '__tests__/feature-spec.test.ts'),
      `import { publicApi } from '../src/feature';   // dir-with-index
test('e', () => publicApi());
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const tests = cg.stats.getTestsForFile('src/feature/index.ts');
    expect(tests.map((f) => f.path)).toContain('__tests__/feature-spec.test.ts');
  });

  // F#46 (2026-05-26): Kotlin / Java / Scala use package-path imports
  // (`import com.example.foo.Bar`), not relative paths. The
  // imports-walk fallback resolves those via a basename → suffix-match
  // index built from the indexed file set.
  it('resolves Kotlin package-path imports to indexed source files (F#46)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src/main/kotlin/com/example/foo'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src/test/kotlin/com/example/foo'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/main/kotlin/com/example/foo/Bar.kt'),
      `package com.example.foo

class Bar {
  fun greet(): String = "hi"
}
`,
    );
    // The test file's name (`UpsertTests.kt`) doesn't map 1:1 to a
    // source file via the convention finder — Upsert.kt doesn't exist.
    // The package-path import below is the only signal.
    fs.writeFileSync(
      path.join(tempDir, 'src/test/kotlin/com/example/foo/UpsertTests.kt'),
      `package com.example.foo

import com.example.foo.Bar
import kotlin.test.Test

class UpsertTests {
  @Test
  fun smoke() {
    val b = Bar()
    b.greet()
  }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const tests = cg.stats.getTestsForFile('src/main/kotlin/com/example/foo/Bar.kt');
    expect(tests.map((f) => f.path)).toContain('src/test/kotlin/com/example/foo/UpsertTests.kt');
  });

  it('skips package-path imports whose target is not indexed (external libs) (F#46)', async () => {
    fs.mkdirSync(path.join(tempDir, 'src/main/kotlin/com/example'), { recursive: true });
    fs.mkdirSync(path.join(tempDir, 'src/test/kotlin/com/example'), { recursive: true });
    fs.writeFileSync(
      path.join(tempDir, 'src/main/kotlin/com/example/Service.kt'),
      `package com.example
class Service { fun doIt() {} }
`,
    );
    // The external `java.util.UUID` import has NO matching project
    // file — the fallback must skip it without crashing or
    // false-positive-attributing the test to an unrelated file.
    fs.writeFileSync(
      path.join(tempDir, 'src/test/kotlin/com/example/BehaviorTests.kt'),
      `package com.example

import com.example.Service
import java.util.UUID
import kotlin.test.Test

class BehaviorTests {
  @Test fun smoke() {
    val s = Service()
    val u = UUID.randomUUID()
    s.doIt()
  }
}
`,
    );
    cg = await Cartograph.init(tempDir, { index: true });

    const tests = cg.stats.getTestsForFile('src/main/kotlin/com/example/Service.kt');
    expect(tests.map((f) => f.path)).toContain('src/test/kotlin/com/example/BehaviorTests.kt');
  });
});
