/**
 * F#57 — Java/Kotlin same-name class disambiguation via import FQN.
 *
 * Pre-F#57 the resolver had no Java branch at extractImportMappings,
 * so a multi-module Maven repo where `dao/converter/FooConverter` and
 * `service/converter/FooConverter` both expose a `convert` method
 * resolved by getNodesByName iteration order — picking whichever class
 * happened to be first, which is wrong any time the caller's import
 * names the other one.
 *
 * F#57 adds a JVM-only FQN-disambiguation step at matchMethodCall:
 *   1. Read the caller file's `kind:'import'` graph nodes (already
 *      tree-sitter-extracted; no source re-parse).
 *   2. Build a localName → FQN map; Kotlin `as` aliases override the
 *      simple-name key.
 *   3. When multiple class candidates share the simple name, prefer
 *      the one whose file-path-suffix matches the imported FQN.
 *   4. Allow Java ↔ Kotlin cross-resolution at the JVM language level
 *      (mixed-language Spring Boot projects routinely import across).
 *   5. Confidence policy: 0.9 + `fqn-disambiguated` when an FQN match
 *      narrows the choice; 0.6 downgrade when an FQN is provided but
 *      matches no candidate (genuinely ambiguous fallback).
 *
 * These tests drive the real ReferenceResolver against real Cartograph
 * indexes — no mocking — so the same code path production uses is the
 * one under test.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

describe('F#57 JVM FQN-based same-name disambiguation', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jvm-fqn-'));
  });

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('Java caller importing service.FooConverter resolves to service, not dao', async () => {
    // Same simple name in two packages — the import is the only signal.
    const daoDir = path.join(tempDir, 'dao/src/main/java/com/example/dao/converter');
    const serviceDir = path.join(tempDir, 'service/src/main/java/com/example/service/converter');
    const webDir = path.join(tempDir, 'web/src/main/java/com/example/web');
    fs.mkdirSync(daoDir, { recursive: true });
    fs.mkdirSync(serviceDir, { recursive: true });
    fs.mkdirSync(webDir, { recursive: true });

    fs.writeFileSync(
      path.join(daoDir, 'FooConverter.java'),
      'package com.example.dao.converter;\npublic class FooConverter { public String convert(String x) { return "dao:" + x; } }\n',
    );
    fs.writeFileSync(
      path.join(serviceDir, 'FooConverter.java'),
      'package com.example.service.converter;\npublic class FooConverter { public String convert(String x) { return "svc:" + x; } }\n',
    );
    // Field name camelCases to the type — the canonical Java DI shape
    // Strategy 2 handles (capitalize `fooConverter` → `FooConverter`).
    // The capitalized lookup hits BOTH dao + service FooConverter; the
    // import FQN is the only signal that picks service.
    fs.writeFileSync(
      path.join(webDir, 'Handler.java'),
      [
        'package com.example.web;',
        '',
        'import com.example.service.converter.FooConverter;',
        '',
        'public class Handler {',
        '  private FooConverter fooConverter;',
        '  public String use() { return fooConverter.convert("input"); }',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true });

    const useMethod = getNodesByKind(cg.queries, 'method').find(
      (n) => n.qualifiedName.endsWith('Handler::use') || n.qualifiedName === 'Handler::use',
    );
    expect(useMethod, 'Handler.use should be indexed').toBeDefined();

    const calls = getOutgoingEdges(cg.queries, useMethod!.id).filter((e) => e.kind === 'calls');
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const target = cg.queries.getNodeById(calls[0]!.target);
    expect(target?.name).toBe('convert');
    expect(target?.filePath.replaceAll(/\\/g, '/')).toContain('service/');
    expect(target?.filePath.replaceAll(/\\/g, '/')).not.toContain('dao/');
  });

  it('Kotlin import with no `;` still feeds the FQN map (regex bug upstream had)', async () => {
    // Kotlin imports are newline-terminated — upstream's regex required `;` and
    // missed every Kotlin import in practice. We use the tree-sitter-extracted
    // import nodes, so the `;` requirement is irrelevant; this test locks in
    // that Kotlin gets the same disambiguation as Java.
    const aDir = path.join(tempDir, 'mod-a/src/main/kotlin/com/example/a');
    const bDir = path.join(tempDir, 'mod-b/src/main/kotlin/com/example/b');
    const callerDir = path.join(tempDir, 'mod-c/src/main/kotlin/com/example/c');
    fs.mkdirSync(aDir, { recursive: true });
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(callerDir, { recursive: true });

    fs.writeFileSync(
      path.join(aDir, 'Service.kt'),
      'package com.example.a\nclass Service { fun run(): String { return "a" } }\n',
    );
    fs.writeFileSync(
      path.join(bDir, 'Service.kt'),
      'package com.example.b\nclass Service { fun run(): String { return "b" } }\n',
    );
    // Field-name `service` capitalizes to `Service` — Strategy 2 finds
    // both mod-a + mod-b Service classes by simple name; the import FQN
    // disambiguates to mod-b.
    fs.writeFileSync(
      path.join(callerDir, 'Caller.kt'),
      [
        'package com.example.c',
        '',
        'import com.example.b.Service', // no `;` — Kotlin canonical style
        '',
        'class Caller {',
        '  private val service: Service = Service()',
        '  fun go(): String = service.run()',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true });

    const goMethod = getNodesByKind(cg.queries, 'method').find(
      (n) => n.qualifiedName.endsWith('Caller::go') || n.qualifiedName === 'Caller::go',
    );
    expect(goMethod, 'Caller.go should be indexed').toBeDefined();

    const calls = getOutgoingEdges(cg.queries, goMethod!.id).filter((e) => e.kind === 'calls');
    expect(calls.length).toBeGreaterThanOrEqual(1);

    const target = cg.queries.getNodeById(calls[0]!.target);
    expect(target?.name).toBe('run');
    expect(target?.filePath.replaceAll(/\\/g, '/')).toContain('mod-b/');
    expect(target?.filePath.replaceAll(/\\/g, '/')).not.toContain('mod-a/');
  });

  it('Kotlin `as` alias maps local-name to imported FQN', async () => {
    // `import com.example.a.Service as ABackend` — when the caller writes
    // `ABackend.run()`, the resolver must look up `ABackend` in the import
    // map, find FQN `com.example.a.Service`, and resolve to mod-a's Service
    // (NOT mod-b's, despite mod-b also having a class named `Service`).
    const aDir = path.join(tempDir, 'mod-a/src/main/kotlin/com/example/a');
    const bDir = path.join(tempDir, 'mod-b/src/main/kotlin/com/example/b');
    const callerDir = path.join(tempDir, 'mod-c/src/main/kotlin/com/example/c');
    fs.mkdirSync(aDir, { recursive: true });
    fs.mkdirSync(bDir, { recursive: true });
    fs.mkdirSync(callerDir, { recursive: true });

    fs.writeFileSync(
      path.join(aDir, 'Service.kt'),
      'package com.example.a\nclass Service { fun run(): String { return "a" } }\n',
    );
    fs.writeFileSync(
      path.join(bDir, 'Service.kt'),
      'package com.example.b\nclass Service { fun run(): String { return "b" } }\n',
    );
    // Aliased: field `aBackend` capitalizes to `ABackend` — Strategy 2
    // looks up the alias key in the FQN map, gets `com.example.a.Service`,
    // and uses the FQN's last segment (`Service`) for the class lookup.
    fs.writeFileSync(
      path.join(callerDir, 'Caller.kt'),
      [
        'package com.example.c',
        '',
        'import com.example.a.Service as ABackend',
        '',
        'class Caller {',
        '  private val aBackend: ABackend = ABackend()',
        '  fun go(): String = aBackend.run()',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true });

    const goMethod = getNodesByKind(cg.queries, 'method').find((n) => n.qualifiedName.endsWith('Caller::go'));
    expect(goMethod).toBeDefined();

    const calls = getOutgoingEdges(cg.queries, goMethod!.id).filter((e) => e.kind === 'calls');
    const target = calls.length > 0 ? cg.queries.getNodeById(calls[0]!.target) : null;
    expect(target?.name).toBe('run');
    expect(target?.filePath.replaceAll(/\\/g, '/')).toContain('mod-a/');
  });

  it('Kotlin caller importing a Java class resolves across the language boundary', async () => {
    // Mixed-language Spring Boot: Java class, Kotlin caller. Pre-F#57 the
    // resolver filtered candidates by `classNode.language !== ref.language`,
    // dropping every Java class when resolving a Kotlin ref. F#57 relaxes
    // the filter inside the JVM family.
    const javaDir = path.join(tempDir, 'src/main/java/com/example/svc');
    const kotlinDir = path.join(tempDir, 'src/main/kotlin/com/example/web');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.mkdirSync(kotlinDir, { recursive: true });

    fs.writeFileSync(
      path.join(javaDir, 'JavaService.java'),
      'package com.example.svc;\npublic class JavaService { public String process(String x) { return x.toUpperCase(); } }\n',
    );
    // Field `javaService` capitalizes to `JavaService` — Strategy 2's
    // class lookup must accept a Java-language candidate even though
    // the caller is Kotlin (mixed-language compatibility).
    fs.writeFileSync(
      path.join(kotlinDir, 'KotlinCaller.kt'),
      [
        'package com.example.web',
        '',
        'import com.example.svc.JavaService',
        '',
        'class KotlinCaller {',
        '  private val javaService: JavaService = JavaService()',
        '  fun handle(): String = javaService.process("hi")',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true });

    const handle = getNodesByKind(cg.queries, 'method').find((n) => n.qualifiedName.endsWith('KotlinCaller::handle'));
    expect(handle).toBeDefined();

    const calls = getOutgoingEdges(cg.queries, handle!.id).filter((e) => e.kind === 'calls');
    const processed = calls.map((e) => cg!.queries.getNodeById(e.target)).find((n) => n?.name === 'process');
    expect(processed, 'Kotlin caller should resolve into Java JavaService.process').toBeDefined();
    expect(processed!.language).toBe('java');
    expect(processed!.filePath.replaceAll(/\\/g, '/')).toContain('com/example/svc/JavaService.java');
  });
});
