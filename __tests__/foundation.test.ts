/**
 * Foundation Tests
 *
 * Tests for the Cartograph foundation layer.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getAllFiles,
  getFileByPath,
  upsertFile,
  deleteFileNodes,
  reconcileFileNodeCounts,
} from '../src/db/queries-files.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';
import { DatabaseConnection, dbOptimize, getDatabasePath } from '../src/db/index.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { DEFAULT_CONFIG } from '../src/types.js';
import { MAX_INDEX_FILE_SIZE } from '../src/default-config.js';
import { loadConfig } from '../src/config.js';
import { getCartographDir, validateDirectory } from '../src/directory.js';
import { CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';
import { defaultLogger, setLogger, silentLogger } from '../src/errors.js';

// Create a temporary directory for each test
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-test-'));
}

// Clean up temporary directory
function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('Cartograph Foundation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  describe('Initialization', () => {
    it('should initialize a new project', () => {
      const cg = Cartograph.initSync(tempDir);

      expect(Cartograph.isInitialized(tempDir)).toBe(true);
      expect(fs.existsSync(getCartographDir(tempDir))).toBe(true);
      expect(fs.existsSync(getDatabasePath(tempDir))).toBe(true);

      cg.close();
    });

    it('should create .gitignore in .Cartograph directory', () => {
      const cg = Cartograph.initSync(tempDir);

      const gitignorePath = path.join(getCartographDir(tempDir), '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);

      const content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('*.db');

      cg.close();
    });

    it('should create config.json with defaults', () => {
      const cg = Cartograph.initSync(tempDir);

      const configPath = path.join(getCartographDir(tempDir), 'config.json');
      expect(fs.existsSync(configPath)).toBe(true);

      const config = cg.getConfig();
      expect(config.version).toBe(DEFAULT_CONFIG.version);
      expect(config.include).toEqual(DEFAULT_CONFIG.include);
      expect(config.exclude).toEqual(DEFAULT_CONFIG.exclude);

      cg.close();
    });

    it('should throw if already initialized', () => {
      const cg = Cartograph.initSync(tempDir);
      cg.close();

      expect(() => Cartograph.initSync(tempDir)).toThrow(/already initialized/i);
    });

    it('should accept custom config options', () => {
      const cg = Cartograph.initSync(tempDir, {
        config: {
          maxFileSize: 500000,
          extractDocstrings: false,
        },
      });

      const config = cg.getConfig();
      expect(config.maxFileSize).toBe(500000);
      expect(config.extractDocstrings).toBe(false);

      cg.close();
    });

    it('should not treat PostgreSQL config alone as initialized', () => {
      const cartographDir = getCartographDir(tempDir);
      fs.mkdirSync(cartographDir, { recursive: true });
      fs.writeFileSync(
        path.join(cartographDir, 'config.json'),
        JSON.stringify({
          database: {
            provider: 'postgres',
            url: 'postgres://cartograph:cartograph@localhost:5432/cartograph',
          },
        }),
      );

      expect(Cartograph.isInitialized(tempDir)).toBe(false);
    });

    it('should preserve an existing partial config while completing initialization', () => {
      const cartographDir = getCartographDir(tempDir);
      fs.mkdirSync(cartographDir, { recursive: true });
      fs.writeFileSync(path.join(cartographDir, 'config.json'), JSON.stringify({ maxFileSize: 123456 }));

      const cg = Cartograph.initSync(tempDir);

      expect(Cartograph.isInitialized(tempDir)).toBe(true);
      expect(cg.getConfig().maxFileSize).toBe(123456);

      cg.close();
    });
  });

  describe('Opening Projects', () => {
    it('should open an existing project', () => {
      // First initialize
      const cg1 = Cartograph.initSync(tempDir);
      cg1.close();

      // Then open
      const cg2 = Cartograph.openSync(tempDir);
      expect(cg2.projectRoot).toBe(path.resolve(tempDir));
      cg2.close();
    });

    it('should throw if not initialized', () => {
      expect(() => Cartograph.openSync(tempDir)).toThrow(/not initialized/i);
    });

    it('should preserve configuration across open/close', () => {
      const cg1 = Cartograph.initSync(tempDir, {
        config: { maxFileSize: 123456 },
      });
      cg1.close();

      const cg2 = Cartograph.openSync(tempDir);
      expect(cg2.getConfig().maxFileSize).toBe(123456);
      cg2.close();
    });
  });

  describe('Static Methods', () => {
    it('isInitialized should return false for new directory', () => {
      expect(Cartograph.isInitialized(tempDir)).toBe(false);
    });

    it('isInitialized should return true after init', () => {
      const cg = Cartograph.initSync(tempDir);
      expect(Cartograph.isInitialized(tempDir)).toBe(true);
      cg.close();
    });
  });

  describe('Database', () => {
    it('should create database with correct schema', () => {
      const cg = Cartograph.initSync(tempDir);

      // Check that we can get stats (requires tables to exist)
      const stats = cg.stats.getStats();
      expect(stats.nodeCount).toBe(0);
      expect(stats.edgeCount).toBe(0);
      expect(stats.fileCount).toBe(0);

      cg.close();
    });

    it('should return correct database size', () => {
      const cg = Cartograph.initSync(tempDir);
      const stats = cg.stats.getStats();

      // Database should have some size (at least the schema)
      expect(stats.dbSizeBytes).toBeGreaterThan(0);

      cg.close();
    });

    it('should support optimize operation', () => {
      const cg = Cartograph.initSync(tempDir);

      // Should not throw
      expect(() => dbOptimize(cg.db)).not.toThrow();

      cg.close();
    });

    it('should support clear operation', () => {
      const cg = Cartograph.initSync(tempDir);

      // Should not throw
      expect(() => cg.clear()).not.toThrow();

      const stats = cg.stats.getStats();
      expect(stats.nodeCount).toBe(0);

      cg.close();
    });
  });

  describe('Configuration', () => {
    it('should load and merge config with defaults', () => {
      const cg = Cartograph.initSync(tempDir);
      cg.close();

      const config = loadConfig(tempDir);
      expect(config.version).toBe(DEFAULT_CONFIG.version);
      expect(config.rootDir).toBe(path.resolve(tempDir));
    });

    it('should update configuration', () => {
      const cg = Cartograph.initSync(tempDir);

      cg.updateConfig({ maxFileSize: 999999 });

      expect(cg.getConfig().maxFileSize).toBe(999999);

      cg.close();

      // Verify persistence
      const config = loadConfig(tempDir);
      expect(config.maxFileSize).toBe(999999);
    });

    it('rejects maxFileSize values above the hard cap before persisting them', () => {
      const cg = Cartograph.initSync(tempDir);
      try {
        const previous = cg.getConfig().maxFileSize;

        expect(() => cg.updateConfig({ maxFileSize: MAX_INDEX_FILE_SIZE + 1 })).toThrow(
          /CartographConfig\.maxFileSize must be between 1 byte and 10mb/,
        );

        expect(cg.getConfig().maxFileSize).toBe(previous);
        expect(loadConfig(tempDir).maxFileSize).toBe(previous);
      } finally {
        cg.close();
      }
    });

    it('rejects hand-edited maxFileSize values above the hard cap on load', () => {
      const cg = Cartograph.initSync(tempDir);
      cg.close();

      const configPath = path.join(tempDir, '.cartograph', 'config.json');
      const edited = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      edited.maxFileSize = MAX_INDEX_FILE_SIZE + 1;
      fs.writeFileSync(configPath, JSON.stringify(edited, null, 2));

      expect(() => loadConfig(tempDir)).toThrow(/maxFileSize must be at most 10mb/);
    });

    it('unions the persisted include list with registry-derived globs on load (G14)', () => {
      // Caught 2026-05-21 when bench/*.mts files were silently dropped
      // from extraction. The persisted `.cartograph/config.json` had
      // materialised `include` at init time with only `**/*.ts`; even
      // after adding `.mts`/`.cts` to the TypeScript language def,
      // existing projects' configs would replace the registry-derived
      // include and never see the new globs. mergeConfig now unions
      // so new extensions reach existing projects on next load.
      const cg = Cartograph.initSync(tempDir);
      cg.close();

      const configPath = path.join(tempDir, '.cartograph', 'config.json');
      const persisted = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as { include: string[] };
      // Simulate an old config: drop `**/*.mts` to mimic a config
      // written before that extension was registered. (Even if it's
      // currently present, the union semantic should re-add it.)
      persisted.include = persisted.include.filter((g) => g !== '**/*.mts' && g !== '**/*.cts');
      fs.writeFileSync(configPath, JSON.stringify(persisted, null, 2));

      const reloaded = loadConfig(tempDir);
      expect(reloaded.include).toEqual(expect.arrayContaining(['**/*.mts', '**/*.cts']));
      // Persisted entries are preserved (no shuffling), with the
      // missing registry globs appended at the end — locking the
      // contract for downstream readers that care about order.
      const persistedSubset = reloaded.include.slice(0, persisted.include.length);
      expect(persistedSubset).toEqual(persisted.include);
    });

    it('re-reads config.json from disk on sync and indexAll (FRICTION-11)', async () => {
      const cg = Cartograph.initSync(tempDir);
      try {
        const configPath = path.join(tempDir, '.cartograph', 'config.json');
        expect(cg.getConfig().maxFileSize).not.toBe(424242);

        // Simulate an EXTERNAL edit to config.json (another process /
        // the user) — bypassing cg.updateConfig, the in-process path.
        const edited = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        edited.maxFileSize = 424242;
        fs.writeFileSync(configPath, JSON.stringify(edited, null, 2));

        await cg.sync();
        expect(cg.getConfig().maxFileSize).toBe(424242);

        // indexAll path picks it up too.
        const edited2 = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        edited2.maxFileSize = 525252;
        fs.writeFileSync(configPath, JSON.stringify(edited2, null, 2));

        await cg.indexAll();
        expect(cg.getConfig().maxFileSize).toBe(525252);
      } finally {
        cg.close();
      }
    });
  });

  describe('Directory Management', () => {
    it('should validate directory structure', () => {
      const cg = Cartograph.initSync(tempDir);
      cg.close();

      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should detect invalid directory', () => {
      const validation = validateDirectory(tempDir);
      expect(validation.valid).toBe(false);
      expect(validation.errors.length).toBeGreaterThan(0);
    });
  });

  describe('Project .gitignore hygiene (FRICTION-AB)', () => {
    it('creates a .gitignore containing .cartograph/ when none exists', () => {
      const cg = Cartograph.initSync(tempDir);
      cg.close();

      const gitignorePath = path.join(tempDir, '.gitignore');
      expect(fs.existsSync(gitignorePath)).toBe(true);
      const lines = fs.readFileSync(gitignorePath, 'utf-8').split('\n');
      expect(lines).toContain('.cartograph/');
    });

    it('appends .cartograph/ to an existing .gitignore that lacks it (no duplicate on re-init)', async () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      fs.writeFileSync(gitignorePath, 'node_modules/\ndist/\n', 'utf-8');

      const cg1 = Cartograph.initSync(tempDir);
      cg1.close();

      let content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('node_modules/'); // pre-existing lines preserved
      expect(content).toContain('.cartograph/');
      const occurrences = (text: string): number => text.split('\n').filter((l) => l.trim() === '.cartograph/').length;
      expect(occurrences(content)).toBe(1);

      // Re-running init must be idempotent — no duplicate entry.
      await cg1.uninitialize();
      const cg2 = Cartograph.initSync(tempDir);
      cg2.close();
      content = fs.readFileSync(gitignorePath, 'utf-8');
      expect(occurrences(content)).toBe(1);
    });

    it('leaves a .gitignore that already excludes .cartograph/ unchanged', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      const original = '# project ignores\n.cartograph/\ndist/\n';
      fs.writeFileSync(gitignorePath, original, 'utf-8');

      const cg = Cartograph.initSync(tempDir);
      cg.close();

      expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(original);
    });

    it('treats a subsuming glob as already-covered (no append)', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      const original = '.cartograph/**\n';
      fs.writeFileSync(gitignorePath, original, 'utf-8');

      const cg = Cartograph.initSync(tempDir);
      cg.close();

      expect(fs.readFileSync(gitignorePath, 'utf-8')).toBe(original);
    });

    it('does not append into a binary or invalid UTF-8 .gitignore', () => {
      const gitignorePath = path.join(tempDir, '.gitignore');
      const original = Buffer.from([0xff, 0xfe, 0x00, 0x5b, 0x99]);
      const warningContexts: Array<Record<string, unknown> | undefined> = [];
      fs.writeFileSync(gitignorePath, original);
      setLogger({
        ...silentLogger,
        warn: (_message, context) => warningContexts.push(context),
      });

      try {
        const cg = Cartograph.initSync(tempDir);
        cg.close();

        expect(fs.readFileSync(gitignorePath)).toEqual(original);
        expect(warningContexts.some((context) => context?.['path'] === gitignorePath)).toBe(true);
      } finally {
        setLogger(defaultLogger);
      }
    });
  });

  describe('Uninitialize', () => {
    it('should remove .Cartograph directory', async () => {
      const cg = Cartograph.initSync(tempDir);

      await cg.uninitialize();

      expect(fs.existsSync(getCartographDir(tempDir))).toBe(false);
      expect(Cartograph.isInitialized(tempDir)).toBe(false);
    });
  });

  describe('Close/Destroy', () => {
    it('should close database but keep .Cartograph directory', () => {
      const cg = Cartograph.initSync(tempDir);

      cg.close(); // destroy is alias for close

      expect(fs.existsSync(getCartographDir(tempDir))).toBe(true);
      expect(Cartograph.isInitialized(tempDir)).toBe(true);
    });
  });

  describe('Graph Query Methods', () => {
    it('should throw "Node not found" for non-existent nodes', () => {
      const cg = Cartograph.initSync(tempDir);

      // getContext throws for non-existent nodes
      expect(() => cg.internals.graphManager.getContext('non-existent')).toThrow(/not found/i);

      cg.close();
    });

    it('should return empty results for non-existent nodes', () => {
      const cg = Cartograph.initSync(tempDir);

      // These methods return empty results instead of throwing
      const traverseResult = cg.internals.traverser.traverseBFS('non-existent');
      expect(traverseResult.nodes.size).toBe(0);

      const callGraph = cg.internals.traverser.getCallGraph('non-existent');
      expect(callGraph.nodes.size).toBe(0);

      const typeHierarchy = cg.internals.traverser.getTypeHierarchy('non-existent');
      expect(typeHierarchy.nodes.size).toBe(0);

      const usages = cg.internals.traverser.findUsages('non-existent');
      expect(usages.length).toBe(0);

      cg.close();
    });
  });
});

describe('Database Connection', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = createTempDir();
  });

  afterEach(() => {
    cleanupTempDir(tempDir);
  });

  it('should initialize new database', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    expect(db.isOpen()).toBe(true);
    expect(fs.existsSync(dbPath)).toBe(true);

    db.close();
  });

  it('should get schema version', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const version = db.getSchemaVersion();
    expect(version).not.toBeNull();
    // Track the registry's max version instead of a hardcoded number so
    // adding a migration doesn't require touching this assertion. The
    // registry derives `CURRENT_SCHEMA_VERSION` from migration filenames.
    expect(version?.version).toBe(CURRENT_SCHEMA_VERSION);

    db.close();
  });

  it('should support transactions', () => {
    const dbPath = path.join(tempDir, 'test.db');
    const db = DatabaseConnection.initialize(dbPath);

    const result = db.transaction(() => {
      return 42;
    });

    expect(result).toBe(42);

    db.close();
  });

  it('should throw when opening non-existent database', () => {
    const dbPath = path.join(tempDir, 'nonexistent.db');

    expect(() => DatabaseConnection.open(dbPath)).toThrow(/not found/i);
  });

  it('rejects malformed database paths before opening SQLite', () => {
    expect(() => DatabaseConnection.initialize(path.join(tempDir, 'cartograph.sqlite'))).toThrow(
      /expected a \.db file/,
    );
    expect(() => DatabaseConnection.initialize(`${tempDir}/../escape.db`)).toThrow(/path traversal segments/);
    expect(() => DatabaseConnection.initialize(`bad\0path.db`)).toThrow(/non-empty \.db file path/);
  });

  it('rejects directories and symlinked files as database paths', () => {
    const dirPath = path.join(tempDir, 'directory.db');
    fs.mkdirSync(dirPath);
    expect(() => DatabaseConnection.initialize(dirPath)).toThrow(/got a directory/);

    if (process.platform === 'win32') return;
    const targetPath = path.join(tempDir, 'target.db');
    fs.writeFileSync(targetPath, '');
    const linkPath = path.join(tempDir, 'link.db');
    fs.symlinkSync(targetPath, linkPath);
    expect(() => DatabaseConnection.open(linkPath)).toThrow(/symlinked database file/);
  });

  it('refuses to silently migrate when autoMigrate is unset (clear error mentions admin migrate)', () => {
    // Set up a freshly initialized DB at the current binary version,
    // then drop the latest schema_versions row so getCurrentVersion()
    // reports a stale version. The default open() should refuse with
    // the restart-aware error rather than silently re-applying
    // migrations.
    const dbPath = path.join(tempDir, 'gated.db');
    const conn = DatabaseConnection.initialize(dbPath);
    const v = conn.getSchemaVersion();
    expect(v?.version).toBeDefined();
    const target = v!.version - 1;
    conn.getDb().prepare('DELETE FROM schema_versions WHERE version > ?').run(target);
    conn.close();

    // Default (autoMigrate unset): refuse with a clear, recoverable error.
    expect(() => DatabaseConnection.open(dbPath)).toThrow(/Refusing to silently migrate/);
    expect(() => DatabaseConnection.open(dbPath, {})).toThrow(/admin migrate/);
    // Spelled-out fallbacks also surface in the message.
    expect(() => DatabaseConnection.open(dbPath, {})).toThrow(/admin sync/);
  });
});

describe('Query Builder', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(() => {
    tempDir = createTempDir();
    cg = Cartograph.initSync(tempDir);
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  it('should return null for non-existent node', () => {
    const node = cg.queries.getNodeById('nonexistent');
    expect(node).toBeNull();
  });

  it('should return empty array for nodes in non-existent file', () => {
    const nodes = cg.queries.getNodesByFile('nonexistent.ts');
    expect(nodes).toEqual([]);
  });

  it('should return empty array for edges from non-existent node', () => {
    const edges = getOutgoingEdges(cg.queries, 'nonexistent');
    expect(edges).toEqual([]);
  });

  it('should return null for non-existent file', () => {
    const file = getFileByPath(cg.queries, 'nonexistent.ts');
    expect(file).toBeNull();
  });

  it('should return empty array for files when none tracked', () => {
    const files = getAllFiles(cg.queries);
    expect(files).toEqual([]);
  });

  // Task #7 — per-file node_count integrity.
  it('deleteFileNodes zeroes files.node_count alongside the node wipe', () => {
    // Insert a files row claiming 7 nodes (no actual nodes — the wipe
    // path under test does not need them present to demonstrate the
    // node_count is brought to 0).
    upsertFile(cg.queries, {
      path: 'src/x.ts',
      contentHash: 'h',
      language: 'typescript',
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 7,
    });
    expect(getFileByPath(cg.queries, 'src/x.ts')?.nodeCount).toBe(7);
    deleteFileNodes(cg.queries, 'src/x.ts');
    // The files row survives (re-extract path reuses it) but node_count
    // is now in lock-step with the now-empty nodes set.
    expect(getFileByPath(cg.queries, 'src/x.ts')?.nodeCount).toBe(0);
  });

  it('reconcileFileNodeCounts flags an orphaned files row (node_count > actual nodes)', () => {
    // An orphan: files row claims 5 nodes, owns 0 — the drift a
    // partial / interrupted sync leaves behind, invisible to a
    // content-hash sync because the file content never moved.
    upsertFile(cg.queries, {
      path: 'src/orphan.ts',
      contentHash: 'h',
      language: 'typescript',
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 5,
    });
    // A consistent row (node_count 0, owns 0) must NOT be flagged.
    upsertFile(cg.queries, {
      path: 'src/clean.ts',
      contentHash: 'h',
      language: 'typescript',
      size: 1,
      modifiedAt: 1,
      indexedAt: 1,
      nodeCount: 0,
    });
    const flagged = reconcileFileNodeCounts(cg.queries);
    expect(flagged).toEqual(['src/orphan.ts']);
    // The orphan is now marked needs_reextract so the sync heal-flag
    // union re-extracts it; the consistent row is untouched.
    const orphanRow = cg.queries.db
      .prepare('SELECT needs_reextract FROM files WHERE path = ?')
      .get('src/orphan.ts') as { needs_reextract: number };
    expect(orphanRow.needs_reextract).toBe(1);
    const cleanRow = cg.queries.db.prepare('SELECT needs_reextract FROM files WHERE path = ?').get('src/clean.ts') as {
      needs_reextract: number;
    };
    expect(cleanRow.needs_reextract).toBe(0);
    // Stable: reconcile only sets the flag — it does NOT itself fix
    // node_count (the follow-up re-extract does). A re-sweep before
    // that re-extract still reports the same orphan, never the clean row.
    expect(reconcileFileNodeCounts(cg.queries)).toEqual(['src/orphan.ts']);
  });
});
