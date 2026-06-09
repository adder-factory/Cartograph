import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createDirectory,
  findNearestCartographRoot,
  getCartographDir,
  isInitialized,
  PROJECT_GITIGNORE_COMMENT,
  PROJECT_GITIGNORE_ENTRY,
  removeDirectory,
  validateDirectory,
} from '../src/directory.js';

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-directory-'));
});

afterEach(() => {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

function touchDb(root = dir): void {
  fs.mkdirSync(getCartographDir(root), { recursive: true });
  fs.writeFileSync(path.join(getCartographDir(root), 'cartograph.db'), '');
}

function expectOwnerOnlyFile(filePath: string): void {
  if (process.platform === 'win32') return;
  expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
}

function expectOwnerOnlyDirectory(dirPath: string): void {
  if (process.platform === 'win32') return;
  expect(fs.statSync(dirPath).mode & 0o777).toBe(0o700);
}

describe('directory management helpers', () => {
  it('initialization requires a .cartograph directory and database file', () => {
    expect(isInitialized(dir)).toBe(false);

    fs.writeFileSync(getCartographDir(dir), 'not a directory');
    expect(isInitialized(dir)).toBe(false);

    fs.unlinkSync(getCartographDir(dir));
    fs.mkdirSync(getCartographDir(dir));
    expect(isInitialized(dir)).toBe(false);

    fs.writeFileSync(path.join(getCartographDir(dir), 'cartograph.db'), '');
    expect(isInitialized(dir)).toBe(true);
  });

  it('finds the nearest initialized ancestor and returns null when none exists', () => {
    const project = path.join(dir, 'project');
    const nested = path.join(project, 'src', 'feature');
    fs.mkdirSync(nested, { recursive: true });
    touchDb(project);

    expect(findNearestCartographRoot(nested)).toBe(project);
    expect(findNearestCartographRoot(path.join(dir, 'unindexed'))).toBeNull();
  });

  it('creates cartograph metadata and appends the project gitignore entry idempotently', () => {
    fs.mkdirSync(getCartographDir(dir));
    fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules');

    createDirectory(dir);
    createDirectory(dir);

    const metaIgnore = fs.readFileSync(path.join(getCartographDir(dir), '.gitignore'), 'utf-8');
    const projectIgnore = fs.readFileSync(path.join(dir, '.gitignore'), 'utf-8');

    expect(metaIgnore).toContain('*.db');
    expectOwnerOnlyDirectory(getCartographDir(dir));
    expectOwnerOnlyFile(path.join(getCartographDir(dir), '.gitignore'));
    expect(projectIgnore).toContain('node_modules\n');
    expect(projectIgnore).toContain(PROJECT_GITIGNORE_COMMENT);
    expect(projectIgnore.match(new RegExp(`${PROJECT_GITIGNORE_ENTRY.replace('.', '\\.')}`, 'g'))).toHaveLength(1);
  });

  it('does not append duplicate project gitignore entries when an existing pattern covers .cartograph', () => {
    for (const existing of ['.cartograph', '/.cartograph/', '.cartograph/**', '.cartograph/*', '*', '**']) {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-directory-ignore-'));
      try {
        fs.writeFileSync(path.join(root, '.gitignore'), `${existing}\n`);
        createDirectory(root);

        const projectIgnore = fs.readFileSync(path.join(root, '.gitignore'), 'utf-8');
        expect(projectIgnore).toBe(`${existing}\n`);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it('throws only when the database already exists', () => {
    createDirectory(dir);
    expect(() => createDirectory(dir)).not.toThrow();

    fs.writeFileSync(path.join(getCartographDir(dir), 'cartograph.db'), '');
    expect(() => createDirectory(dir)).toThrow(/already initialized/);
  });

  it('removes symlink, file, directory, and missing metadata paths safely', () => {
    removeDirectory(dir);
    expect(fs.existsSync(getCartographDir(dir))).toBe(false);

    fs.writeFileSync(getCartographDir(dir), 'single file');
    removeDirectory(dir);
    expect(fs.existsSync(getCartographDir(dir))).toBe(false);

    const target = path.join(dir, 'outside-target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, getCartographDir(dir));
    removeDirectory(dir);
    expect(fs.existsSync(getCartographDir(dir))).toBe(false);
    expect(fs.existsSync(target)).toBe(true);

    createDirectory(dir);
    removeDirectory(dir);
    expect(fs.existsSync(getCartographDir(dir))).toBe(false);
  });

  it('validates metadata shape and repairs missing internal gitignore', () => {
    expect(validateDirectory(dir)).toEqual({
      valid: false,
      errors: ['Cartograph directory does not exist'],
    });

    fs.writeFileSync(getCartographDir(dir), 'not a directory');
    expect(validateDirectory(dir)).toEqual({
      valid: false,
      errors: ['.cartograph exists but is not a directory'],
    });

    fs.unlinkSync(getCartographDir(dir));
    fs.mkdirSync(getCartographDir(dir));
    const result = validateDirectory(dir);

    expect(result).toEqual({ valid: true, errors: [] });
    expect(fs.existsSync(path.join(getCartographDir(dir), '.gitignore'))).toBe(true);
    expectOwnerOnlyFile(path.join(getCartographDir(dir), '.gitignore'));
  });
});
