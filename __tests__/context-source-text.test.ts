import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';
import { extractCodeLikeSourceTerms } from '../src/context/source-text.js';

describe('extractCodeLikeSourceTerms', () => {
  it('keeps code-like source strings and config keys', () => {
    const terms = extractCodeLikeSourceTerms('find `deepseek-r1`, "OPENAI_API_KEY", and feature.flag.');

    expect(terms).toEqual(expect.arrayContaining(['deepseek-r1', 'OPENAI_API_KEY', 'feature.flag']));
  });

  it('ignores generic lowercase prose even when quoted', () => {
    const terms = extractCodeLikeSourceTerms('find "message" and status in the handler');

    expect(terms).not.toContain('message');
    expect(terms).not.toContain('status');
  });
});

describe('Context Builder — source-text context fallback', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-context-source-text-'));
    const srcDir = path.join(testDir, 'src');
    fs.mkdirSync(srcDir);

    fs.writeFileSync(
      path.join(srcDir, 'providers.ts'),
      `export function providerEnvVars(): string[] {
  return ['env_var_for'];
}

export function env_var_for(provider: string): string {
  return provider.toUpperCase() + '_API_KEY';
}

export function normalizeProviderAlias(provider: string): string {
  if (provider === 'deepseek-r1') return 'deepseek';
  return provider;
}

export function unrelated(): string {
  return 'message';
}
`,
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('maps exact source-text hits back to the enclosing implementation symbol', async () => {
    const result = await cg.internals.contextBuilder.buildContext('where is deepseek-r1 handled', { format: 'json' });
    const parsed = JSON.parse(result as string);
    const entryNames: string[] = parsed.entryPoints.map((node: { name: string }) => node.name);

    expect(entryNames).toContain('normalizeProviderAlias');
  });

  it('keeps exact symbol-name intent ahead of source-text string matches', async () => {
    const result = await cg.internals.contextBuilder.buildContext('env_var_for', { format: 'json' });
    const parsed = JSON.parse(result as string);
    const entryNames: string[] = parsed.entryPoints.map((node: { name: string }) => node.name);

    expect(entryNames[0]).toBe('env_var_for');
  });
});
