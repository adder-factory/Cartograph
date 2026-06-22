import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { applyAliases, loadProjectAliases, projectAliasConfigFingerprint } from '../src/resolution/path-aliases.js';

describe('path alias config parsing', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-path-aliases-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('ignores array-shaped compilerOptions.paths instead of treating indexes as aliases', () => {
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          baseUrl: '.',
          paths: [['src/aliased']],
        },
      }),
    );

    expect(loadProjectAliases(tempDir)).toBeNull();
    expect(projectAliasConfigFingerprint(tempDir)).toBe('alias:none');
  });

  it('treats __proto__ path aliases as data and filters malformed target entries', () => {
    fs.writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      `{
        "compilerOptions": {
          "baseUrl": ".",
          "paths": {
            "__proto__": ["src/proto-entry.ts"],
            "@/*": ["src/*", false, "generated/*"],
            "~/*": "src/*",
            "#/*": [null]
          }
        }
      }`,
    );

    const aliases = loadProjectAliases(tempDir);

    if (aliases === null) throw new Error('expected aliases');
    expect(applyAliases('__proto__', aliases, tempDir)).toEqual(['src/proto-entry.ts']);
    expect(applyAliases('@/button', aliases, tempDir)).toEqual(['src/button', 'generated/button']);
    expect(applyAliases('~/button', aliases, tempDir)).toEqual([]);
    expect(projectAliasConfigFingerprint(tempDir)).toBe(
      '{"baseUrl":".","paths":{"__proto__":["src/proto-entry.ts"],"@/*":["src/*","generated/*"]}}',
    );
  });
});
