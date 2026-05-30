/**
 * Unit tests for `detectModuleFormat` — focused on edge cases that
 * are awkward to exercise via the full status-handler integration
 * (esp. JSONC comment handling on tsconfig).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { detectModuleFormat } from '../src/module-format.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-modfmt-unit-'));
});

afterEach(() => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('detectModuleFormat — JSONC handling', () => {
  it('parses a tsconfig with line comments', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{
        // strict mode setup
        "compilerOptions": {
          "module": "NodeNext", // node-compatible ESM
          "target": "ES2022"
        }
      }`,
    );
    const info = detectModuleFormat(dir);
    expect(info?.format).toBe('ESM');
    expect(info?.tsModule).toBe('NodeNext');
    expect(info?.tsTarget).toBe('ES2022');
  });

  it('does NOT corrupt URL string values in tsconfig (regression)', () => {
    // Reviewer caught this: a naive `(^|[^:])\/\/` strip eats the
    // tail of `"https://..."` because the char before `//` is `s`,
    // not `:`. The state-machine strip should preserve string
    // contents verbatim.
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"x"}');
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{
        // header comment
        "compilerOptions": {
          "module": "CommonJS",
          "target": "ES2020",
          "baseUrl": "https://example.com/types"
        }
      }`,
    );
    const info = detectModuleFormat(dir);
    expect(info?.format).toBe('CJS');
    expect(info?.tsModule).toBe('CommonJS');
    // Most importantly: parse must NOT fail because of the URL.
    expect(info).not.toBeNull();
  });

  it('handles block comments', () => {
    fs.writeFileSync(
      path.join(dir, 'tsconfig.json'),
      `{ /* multi
            line
            block */ "compilerOptions": { "module": "ESNext" } }`,
    );
    const info = detectModuleFormat(dir);
    expect(info?.format).toBe('ESM');
  });

  it('returns null when neither file exists', () => {
    expect(detectModuleFormat(dir)).toBeNull();
  });

  it('returns CJS when only package.json exists with type=commonjs', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"commonjs"}');
    expect(detectModuleFormat(dir)?.format).toBe('CJS');
  });

  it('returns mixed when package.json says module but tsconfig says CommonJS', () => {
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, 'tsconfig.json'), '{"compilerOptions":{"module":"CommonJS"}}');
    expect(detectModuleFormat(dir)?.format).toBe('mixed');
  });
});
