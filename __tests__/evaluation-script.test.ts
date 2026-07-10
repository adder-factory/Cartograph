import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

interface PackageManifest {
  readonly scripts?: Readonly<Record<string, string>>;
}

describe('evaluation package script', () => {
  it('runs the executable ranking and payload regression tests instead of an empty directory filter', () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dir, '..', 'package.json'), 'utf8'),
    ) as PackageManifest;
    const command = manifest.scripts?.['test:eval'];

    expect(command).toContain('__tests__/ranking-regression.test.ts');
    expect(command).toContain('__tests__/eval-payload-budget.test.ts');
    expect(command).not.toContain('__tests__/evaluation/');
  });
});
