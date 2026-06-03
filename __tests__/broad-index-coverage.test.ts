import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Cartograph from '../src/index.js';

const TESTBEDS = path.join(__dirname, '..', 'docs', 'test-beds');

let dir: string | null = null;

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-broad-index-'));
}

function copyLanguageFixtures(root: string): number {
  let copied = 0;
  for (const language of fs.readdirSync(TESTBEDS).sort()) {
    const sourceDir = path.join(TESTBEDS, language);
    if (!fs.statSync(sourceDir).isDirectory()) continue;
    const fixture = fs.readdirSync(sourceDir).find((name) => name.startsWith('fixture.'));
    if (!fixture) continue;
    const targetDir = path.join(root, 'src', language);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(path.join(sourceDir, fixture), path.join(targetDir, fixture));
    copied++;
  }
  return copied;
}

describe('broad multi-language index coverage', () => {
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('indexes and syncs a mixed-language fixture corpus through the real orchestrator', async () => {
    dir = tempDir();
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'broad-index-fixture' }));
    const fixtureCount = copyLanguageFixtures(dir);

    fs.mkdirSync(path.join(dir, 'src', 'typescript-extra'), { recursive: true });
    const entryPath = path.join(dir, 'src', 'typescript-extra', 'entry.ts');
    fs.writeFileSync(
      entryPath,
      [
        'export function broadAlpha(n: number): number {',
        '  return broadBeta(n) + 1;',
        '}',
        '',
        'export function broadBeta(n: number): number {',
        '  return n * 2;',
        '}',
        '',
      ].join('\n'),
    );

    const cg = await Cartograph.init(dir, {
      config: {
        llm: { endpoint: '' },
        exclude: ['.cartograph/**'],
      },
    });
    try {
      const indexed = await cg.indexAll({ summarize: false });
      expect(indexed.success).toBe(true);
      expect(fixtureCount).toBeGreaterThanOrEqual(20);
      expect(indexed.filesIndexed).toBeGreaterThanOrEqual(fixtureCount);
      expect(indexed.nodesCreated).toBeGreaterThan(50);

      fs.appendFileSync(entryPath, '\nexport function broadGamma(): number { return broadAlpha(3); }\n');
      fs.writeFileSync(path.join(dir, 'src', 'typescript-extra', 'added.ts'), 'export const broadAdded = true;\n');
      const sync = await cg.sync();

      expect(sync.filesAdded + sync.filesModified).toBeGreaterThanOrEqual(1);
      expect(sync.lockContention).not.toBe(true);
      expect(cg.stats.getStats().nodeCount).toBeGreaterThan(50);
    } finally {
      cg.close();
    }
  }, 120_000);
});
