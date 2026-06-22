import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDatabase } from '../src/db/sqlite-adapter.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const gateScript = path.join(repoRoot, 'scripts', 'check-biomarkers.mjs');

function writeFile(root: string, relPath: string, content: string): void {
  const absPath = path.join(root, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content);
}

function createFixtureRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-biomarker-gate-'));
  writeFile(root, 'src/bin/cartograph.ts', 'process.exit(0);\n');
  fs.mkdirSync(path.join(root, '.cartograph'), { recursive: true });
  return root;
}

function createGateDatabase(root: string, severity: 'error' | 'warning' | 'info' | null): void {
  const { db } = createDatabase(path.join(root, '.cartograph', 'cartograph.db'));
  try {
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        start_line INTEGER NOT NULL
      );

      CREATE TABLE code_health_findings (
        node_id TEXT NOT NULL,
        biomarker TEXT NOT NULL,
        severity TEXT NOT NULL
      );

      CREATE TABLE project_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    db.prepare(`INSERT INTO project_metadata (key, value) VALUES ('biomarker_cross_file_errors', '0')`).run();
    if (severity) {
      db.prepare(`INSERT INTO nodes (id, name, file_path, start_line) VALUES ('n1', 'smokeInfo', 'src/a.ts', 1)`).run();
      db.prepare(
        `INSERT INTO code_health_findings (node_id, biomarker, severity) VALUES ('n1', 'duplicate_code', ?)`,
      ).run(severity);
    }
  } finally {
    db.close();
  }
}

function createWalGateDatabaseWithoutSidecars(root: string): void {
  createGateDatabase(root, null);
  const dbPath = path.join(root, '.cartograph', 'cartograph.db');
  const { db } = createDatabase(dbPath);
  try {
    db.exec('PRAGMA journal_mode=WAL');
  } finally {
    db.close();
  }
  fs.rmSync(`${dbPath}-wal`, { force: true });
  fs.rmSync(`${dbPath}-shm`, { force: true });
}

function runGate(root: string): { code: number; output: string } {
  const result = spawnSync('bun', [gateScript], {
    cwd: root,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: result.status ?? 1, output: `${result.stdout}${result.stderr}` };
}

describe('biomarker gate smoke', () => {
  it('passes a clean 0/0/0 findings table', () => {
    const root = createFixtureRoot();
    try {
      createGateDatabase(root, null);

      const result = runGate(root);

      expect(result.code).toBe(0);
      expect(result.output).toContain('biomarker floor: 0 error / 0 warning / 0 info');
      expect(result.output).toContain('biomarker-gate OK — 0 error / 0 warning / 0 info.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads a WAL-mode database when checkpoint sidecars are absent', () => {
    const root = createFixtureRoot();
    try {
      createWalGateDatabaseWithoutSidecars(root);

      const result = runGate(root);

      expect(result.code).toBe(0);
      expect(result.output).toContain('biomarker floor: 0 error / 0 warning / 0 info');
      expect(result.output).toContain('biomarker-gate OK — 0 error / 0 warning / 0 info.');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails when the only finding is info severity', () => {
    const root = createFixtureRoot();
    try {
      createGateDatabase(root, 'info');

      const result = runGate(root);

      expect(result.code).not.toBe(0);
      expect(result.output).toContain('biomarker floor: 0 error / 0 warning / 1 info');
      expect(result.output).toContain('biomarker-gate FAILED — the floor is 0 error / 0 warning / 0 info.');
      expect(result.output).toContain('[info] duplicate_code — smokeInfo  (src/a.ts)');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
