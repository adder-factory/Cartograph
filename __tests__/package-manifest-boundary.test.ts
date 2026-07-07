import { afterEach, describe, expect, it } from 'vitest';
import { packageJsonDeclaresEsm, readPackageJsonScripts, readPackageJsonVersion } from '../src/package-manifest.js';
import { hasPackageDependency } from '../src/resolution/frameworks/package-dependencies.js';

afterEach(() => {
  Reflect.deleteProperty(Object.prototype, 'type');
  Reflect.deleteProperty(Object.prototype, 'version');
  Reflect.deleteProperty(Object.prototype, 'dependencies');
  Reflect.deleteProperty(Object.prototype, 'devDependencies');
});

describe('package manifest JSON boundaries', () => {
  it('reads an own package version field', () => {
    expect(readPackageJsonVersion('{"version":" 1.2.3 "}')).toBe('1.2.3');
  });

  it('ignores inherited package version fields', () => {
    Object.defineProperty(Object.prototype, 'version', {
      configurable: true,
      writable: true,
      value: '9.9.9',
    });

    expect(readPackageJsonVersion('{}')).toBeNull();
  });

  it('detects an own module type field', () => {
    expect(packageJsonDeclaresEsm('{"type":"module"}')).toBe(true);
  });

  it('ignores inherited package type fields', () => {
    Object.defineProperty(Object.prototype, 'type', {
      configurable: true,
      writable: true,
      value: 'module',
    });

    expect(packageJsonDeclaresEsm('{}')).toBe(false);
  });

  it('ignores inherited package dependency fields', () => {
    Object.defineProperty(Object.prototype, 'dependencies', {
      configurable: true,
      writable: true,
      value: { react: '^19.0.0' },
    });

    expect(hasPackageDependency('{}', ['react'])).toBe(false);
  });

  it('ignores inherited package devDependency fields', () => {
    Object.defineProperty(Object.prototype, 'devDependencies', {
      configurable: true,
      writable: true,
      value: { vite: '^7.0.0' },
    });

    expect(hasPackageDependency('{}', ['vite'])).toBe(false);
  });

  it('treats special dependency names as data and ignores malformed dependency versions', () => {
    const packageJson = `{
      "dependencies": {
        "__proto__": "1.0.0",
        "react": "19.0.0",
        "bad": false
      },
      "devDependencies": {
        "constructor": "5.0.0",
        "vite": null
      }
    }`;

    expect(hasPackageDependency(packageJson, ['__proto__'])).toBe(true);
    expect(hasPackageDependency(packageJson, ['constructor'])).toBe(true);
    expect(hasPackageDependency(packageJson, ['react'])).toBe(true);
    expect(hasPackageDependency(packageJson, ['bad'])).toBe(false);
    expect(hasPackageDependency(packageJson, ['vite'])).toBe(false);
  });

  it('treats special script names as data and ignores malformed script values', () => {
    const packageJson = `{
      "scripts": {
        "__proto__": "echo proto",
        "constructor": "echo ctor",
        "test": "bun test",
        "bad": false
      }
    }`;

    const scripts = readPackageJsonScripts(packageJson);

    expect(Object.hasOwn(scripts, '__proto__')).toBe(true);
    expect(Object.getOwnPropertyDescriptor(scripts, '__proto__')?.value).toBe('echo proto');
    expect(scripts['constructor']).toBe('echo ctor');
    expect(scripts['test']).toBe('bun test');
    expect(Object.hasOwn(scripts, 'bad')).toBe(false);
  });
});
