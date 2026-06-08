/**
 * B11/F#64c (2026-05-26) — Spring `@Value` config-key linkage hook
 * end-to-end test.
 *
 * Indexes a project containing both `application.properties` and Java
 * source with `@Value("${k}")` fields, then verifies the hook emitted
 * a `references` edge from each annotated field to its matching
 * constant node mined by the `.properties` extractor.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

describe('Spring @Value config-key linkage (B11/F#64c)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-spring-value-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('emits one constant per key in application.properties', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'application.properties'),
      `# Spring application config
app.cache.ttl=60
app.cache.size = 1024
server.port:8080
! exclamation comment
db.url = jdbc:postgresql://localhost/x
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const constants = getNodesByKind(cg.queries, 'constant').filter((c) => c.language === 'properties');
    const keys = constants.map((c) => c.qualifiedName).sort(byString);
    expect(keys).toEqual(['app.cache.size', 'app.cache.ttl', 'db.url', 'server.port']);

    // Signatures carry the value.
    const ttl = constants.find((c) => c.name === 'app.cache.ttl');
    expect(ttl?.signature).toBe('60');
    const port = constants.find((c) => c.name === 'server.port');
    expect(port?.signature).toBe('8080');
    const url = constants.find((c) => c.name === 'db.url');
    expect(url?.signature).toBe('jdbc:postgresql://localhost/x');
  });

  it('links @Value("${app.cache.ttl}") to the matching constant', async () => {
    fs.writeFileSync(path.join(tempDir, 'application.properties'), 'app.cache.ttl=60\n');
    fs.writeFileSync(
      path.join(tempDir, 'CacheConfig.java'),
      `public class CacheConfig {
  @Value("\${app.cache.ttl}")
  private int cacheTtl;
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const constants = getNodesByKind(cg.queries, 'constant').filter((c) => c.language === 'properties');
    const ttlConst = constants.find((c) => c.qualifiedName === 'app.cache.ttl');
    expect(ttlConst, 'app.cache.ttl constant should exist').toBeDefined();

    const fields = getNodesByKind(cg.queries, 'field').filter((f) => f.language === 'java');
    const cacheTtlField = fields.find((f) => f.name === 'cacheTtl');
    expect(cacheTtlField, 'cacheTtl field should exist').toBeDefined();

    const edges = getOutgoingEdges(cg.queries, cacheTtlField!.id).filter(
      (e) => e.kind === 'references' && e.target === ttlConst!.id,
    );
    expect(edges.length).toBe(1);
    expect(edges[0]!.metadata?.synthesizedBy).toBe('spring-value-binding');
    expect(edges[0]!.metadata?.configKey).toBe('app.cache.ttl');
  });

  it('strips ${k:default} default-value suffix before lookup', async () => {
    fs.writeFileSync(path.join(tempDir, 'application.properties'), 'app.timeout.ms=5000\n');
    fs.writeFileSync(
      path.join(tempDir, 'TimeoutConfig.java'),
      `public class TimeoutConfig {
  @Value("\${app.timeout.ms:3000}")
  private long timeoutMs;
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const timeoutConst = getNodesByKind(cg.queries, 'constant').find(
      (c) => c.language === 'properties' && c.qualifiedName === 'app.timeout.ms',
    );
    const timeoutField = getNodesByKind(cg.queries, 'field').find(
      (f) => f.language === 'java' && f.name === 'timeoutMs',
    );
    expect(timeoutConst).toBeDefined();
    expect(timeoutField).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, timeoutField!.id).filter(
      (e) => e.kind === 'references' && e.target === timeoutConst!.id,
    );
    expect(edges.length).toBe(1);
    expect(edges[0]!.metadata?.configKey).toBe('app.timeout.ms');
  });

  it('emits no edge when @Value placeholder has no matching key (defensive)', async () => {
    fs.writeFileSync(path.join(tempDir, 'application.properties'), 'app.cache.ttl=60\n');
    fs.writeFileSync(
      path.join(tempDir, 'MissingConfig.java'),
      `public class MissingConfig {
  @Value("\${app.nonexistent.key}")
  private String missing;
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const missingField = getNodesByKind(cg.queries, 'field').find((f) => f.language === 'java' && f.name === 'missing');
    expect(missingField).toBeDefined();

    // No spring-value-binding edge originates from the field for an
    // unresolvable placeholder.
    const edges = getOutgoingEdges(cg.queries, missingField!.id).filter(
      (e) => e.metadata?.synthesizedBy === 'spring-value-binding',
    );
    expect(edges.length).toBe(0);
  });

  it('links across packages — config in src/main/resources, field elsewhere', async () => {
    const resourcesDir = path.join(tempDir, 'src', 'main', 'resources');
    fs.mkdirSync(resourcesDir, { recursive: true });
    fs.writeFileSync(path.join(resourcesDir, 'application.properties'), 'service.endpoint=https://api.example.com\n');

    const javaDir = path.join(tempDir, 'src', 'main', 'java', 'com', 'example');
    fs.mkdirSync(javaDir, { recursive: true });
    fs.writeFileSync(
      path.join(javaDir, 'ApiClient.java'),
      `package com.example;
public class ApiClient {
  @Value("\${service.endpoint}")
  private String endpoint;
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const endpointConst = getNodesByKind(cg.queries, 'constant').find(
      (c) => c.language === 'properties' && c.qualifiedName === 'service.endpoint',
    );
    const endpointField = getNodesByKind(cg.queries, 'field').find(
      (f) => f.language === 'java' && f.name === 'endpoint',
    );
    expect(endpointConst).toBeDefined();
    expect(endpointField).toBeDefined();
    // Confirm cross-file: source and target live in different files.
    expect(endpointConst!.filePath).not.toBe(endpointField!.filePath);

    const edges = getOutgoingEdges(cg.queries, endpointField!.id).filter(
      (e) => e.kind === 'references' && e.target === endpointConst!.id,
    );
    expect(edges.length).toBe(1);
  });

  it('links @ConditionalOnProperty prefix/name annotations to matching config keys', async () => {
    fs.writeFileSync(path.join(tempDir, 'application.properties'), 'feature.payments.enabled=true\n');
    fs.writeFileSync(
      path.join(tempDir, 'PaymentsAutoConfig.java'),
      `import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;

@ConditionalOnProperty(prefix = "feature.payments", name = "enabled", havingValue = "true")
public class PaymentsAutoConfig {
}
`,
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const configConst = getNodesByKind(cg.queries, 'constant').find(
      (c) => c.language === 'properties' && c.qualifiedName === 'feature.payments.enabled',
    );
    const configClass = getNodesByKind(cg.queries, 'class').find(
      (c) => c.language === 'java' && c.name === 'PaymentsAutoConfig',
    );
    expect(configConst).toBeDefined();
    expect(configClass).toBeDefined();

    const edges = getOutgoingEdges(cg.queries, configClass!.id).filter(
      (e) => e.kind === 'references' && e.target === configConst!.id,
    );
    expect(edges.length).toBe(1);
    expect(edges[0]!.metadata?.synthesizedBy).toBe('spring-conditional-on-property-binding');
    expect(edges[0]!.metadata?.configKey).toBe('feature.payments.enabled');
  });
});
