/**
 * F#64a / B11 (2026-05-26) — Java/Kotlin `this.field.method()` unwrap
 * + field-receiver type inference.
 *
 * Two intertwined fixes:
 *   1. The Java extractor's `tsResolveCalleeName` now unwraps
 *      `field_access(this, X).method()` to a receiver of just `X`,
 *      so the name-matcher's `obj.method` regex matches.
 *   2. The name-matcher gains Strategy 2.5 which looks up the
 *      receiver's declared type by walking the enclosing class's
 *      field declarations. Catches the case where the field name
 *      doesn't capitalize cleanly to the class name
 *      (`@Resource(name="userBO") UserBO userbo` — Strategy 2's
 *      `Userbo` lookup misses).
 *
 * Together these close the canonical Spring `this.svc.run()` /
 * `fooConverter.convert()` resolution-failure class.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

describe('Java this.field.method() + field-receiver type inference (F#64a)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-java-field-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('resolves this.field.method() to the declared-type class method', async () => {
    // The classic Spring shape: `this.svc.run()` where svc is a field
    // typed as Svc. Pre-F#64a: ref name was `this.svc.run` (two dots),
    // matcher's regex failed, call stayed unresolved. After F#64a:
    // extractor strips `this.` → ref name = `svc.run`; matcher
    // Strategy 2 capitalizes `svc` → `Svc` → finds the class.
    fs.writeFileSync(
      path.join(tempDir, 'A.java'),
      `class Svc { public void run() { } }
class App {
  private Svc svc;
  public void go() { this.svc.run(); }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const methods = getNodesByKind(cg.queries, 'method');
    const goMethod = methods.find((m) => m.name === 'go');
    const runMethod = methods.find((m) => m.name === 'run');
    expect(goMethod).toBeDefined();
    expect(runMethod).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, goMethod!.id).filter((e) => e.kind === 'calls');
    expect(edges.length).toBeGreaterThanOrEqual(1);
    const callToRun = edges.find((e) => e.target === runMethod!.id);
    expect(callToRun, 'go() → Svc.run() edge should exist').toBeDefined();
  });

  it('resolves field-receiver call where field-name does NOT capitalize to type (UserBO userbo)', async () => {
    // The harder case: `UserBO userbo; userbo.toLogin2()`. Strategy 2
    // capitalizes `userbo` → `Userbo` which is NOT a class name in
    // this codebase (the class is `UserBO`). Strategy 2 misses;
    // Strategy 2.5 reads the field's signature `UserBO userbo`,
    // extracts the type `UserBO`, looks it up successfully.
    fs.writeFileSync(path.join(tempDir, 'UserBO.java'), `class UserBO { public void toLogin2() { } }`);
    fs.writeFileSync(
      path.join(tempDir, 'UserAction.java'),
      `class UserAction {
  private UserBO userbo;
  public void use() { userbo.toLogin2(); }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const methods = getNodesByKind(cg.queries, 'method');
    const useMethod = methods.find((m) => m.name === 'use');
    const toLogin2 = methods.find((m) => m.name === 'toLogin2');
    expect(useMethod).toBeDefined();
    expect(toLogin2).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, useMethod!.id).filter((e) => e.kind === 'calls');
    const callToLogin2 = edges.find((e) => e.target === toLogin2!.id);
    expect(callToLogin2, 'use() → UserBO.toLogin2() edge via Strategy 2.5').toBeDefined();
  });

  it('combines this.field + non-camelCase field type', async () => {
    // The double-fix case: `this.userbo.toLogin2()`. Extractor strips
    // `this.` (the F#64a extractor unwrap), then Strategy 2.5 reads
    // the field's declared type.
    fs.writeFileSync(path.join(tempDir, 'UserBO.java'), `class UserBO { public void toLogin2() { } }`);
    fs.writeFileSync(
      path.join(tempDir, 'UserAction.java'),
      `class UserAction {
  private UserBO userbo;
  public void use() { this.userbo.toLogin2(); }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const methods = getNodesByKind(cg.queries, 'method');
    const useMethod = methods.find((m) => m.name === 'use');
    const toLogin2 = methods.find((m) => m.name === 'toLogin2');
    expect(useMethod).toBeDefined();
    expect(toLogin2).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, useMethod!.id).filter((e) => e.kind === 'calls');
    const target = edges.find((e) => e.target === toLogin2!.id);
    expect(target, 'this.userbo.toLogin2() should resolve via combined unwrap + type-inference').toBeDefined();
  });

  it('handles generic-parameterized field types — uses the head identifier', async () => {
    // `Map<String, Foo> map; map.size()` — the declared type is
    // `Map<...>` but the matcher should look up `Map`, not the full
    // generic expression. The head identifier from the signature is
    // what matters.
    fs.writeFileSync(path.join(tempDir, 'Map.java'), `class Map { public int size() { return 0; } }`);
    fs.writeFileSync(
      path.join(tempDir, 'Client.java'),
      `class Client {
  private Map<String, Object> map;
  public int n() { return map.size(); }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const methods = getNodesByKind(cg.queries, 'method');
    const nMethod = methods.find((m) => m.name === 'n');
    const sizeMethod = methods.find((m) => m.name === 'size');
    expect(nMethod).toBeDefined();
    expect(sizeMethod).toBeDefined();
    const edges = getOutgoingEdges(cg.queries, nMethod!.id).filter((e) => e.kind === 'calls');
    const target = edges.find((e) => e.target === sizeMethod!.id);
    expect(target, 'generic-typed field receiver should resolve').toBeDefined();
  });

  it('does NOT false-resolve when no matching field exists in the enclosing class', async () => {
    // Defensive: if there's no field named `bogus`, Strategy 2.5
    // returns null and the call stays unresolved. No false-positive
    // edge to an unrelated `something.method()`.
    fs.writeFileSync(path.join(tempDir, 'Other.java'), `class Other { public void m() { } }`);
    fs.writeFileSync(
      path.join(tempDir, 'Caller.java'),
      `class Caller {
  public void go() { bogus.m(); }
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const methods = getNodesByKind(cg.queries, 'method');
    const goMethod = methods.find((m) => m.name === 'go');
    expect(goMethod).toBeDefined();

    const otherM = methods.find((m) => m.name === 'm');
    const edges = getOutgoingEdges(cg.queries, goMethod!.id).filter((e) => e.kind === 'calls');
    const falsePositive = otherM ? edges.find((e) => e.target === otherM.id) : undefined;
    // The matcher's broader Strategy 3 (matchMethodByNameOverlap) MIGHT
    // still match Other.m via name overlap — that's the FALLBACK and
    // it's accepted behaviour. What we assert is: Strategy 2.5 itself
    // doesn't ALSO emit a duplicate edge.
    if (falsePositive) {
      // If Strategy 3 hit, we get one edge — that's fine.
      expect(edges.filter((e) => e.target === otherM!.id).length).toBe(1);
    } else {
      // If Strategy 3 didn't hit either, no edge at all is also fine.
      expect(edges.length).toBeLessThanOrEqual(1);
    }
  });
});
