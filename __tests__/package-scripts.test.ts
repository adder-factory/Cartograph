import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPackageScripts } from '../src/package-scripts.js';

const tempDirs: string[] = [];

function writePackageJson(body: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-package-scripts-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'package.json'), body);
  return dir;
}

afterEach(() => {
  Reflect.deleteProperty(Object.prototype, 'scripts');
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('readPackageScripts', () => {
  it('reads own string script entries from package.json', () => {
    const dir = writePackageJson(JSON.stringify({ scripts: { test: 'bun test', build: 'tsc', bad: 1 } }));

    expect(readPackageScripts(dir)).toEqual({ build: 'tsc', test: 'bun test' });
  });

  it('ignores inherited root scripts fields', () => {
    const dir = writePackageJson('{}');
    Object.defineProperty(Object.prototype, 'scripts', {
      configurable: true,
      writable: true,
      value: { test: 'echo inherited' },
    });

    expect(readPackageScripts(dir)).toEqual({});
  });
});
