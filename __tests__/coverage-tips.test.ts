import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectTestRunner } from '../src/mcp/tools/_coverage-tips.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-coverage-tips-'));
});

afterEach(() => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('coverage tips package manifest parsing', () => {
  it('ignores dependency entries whose versions are not strings', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: 1 } }));
    expect(detectTestRunner(dir)).toBeNull();
  });

  it('detects dependency entries whose versions are strings', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ devDependencies: { vitest: '^1.0.0' } }));
    expect(detectTestRunner(dir)?.name).toBe('vitest');
  });
});
