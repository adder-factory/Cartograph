/**
 * go-implements hook: derive `implements` edges from structural
 * method-set match. Go's interface satisfaction is structural; this
 * hook recovers it from the post-extraction graph.
 *
 * Agent A FN5 from the ollama bug-hunt — 2 implements edges across
 * 120 Go interfaces × 1320 Go structs (effectively zero coverage)
 * before this hook landed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';

beforeEach(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-implements-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('go-implements hook (Agent A FN5)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('emits implements edges for structs whose method set covers an interface', async () => {
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pkg', 'reader.go'),
      `package pkg

type Reader interface {
    Read(p []byte) (int, error)
    Close() error
}

type FileReader struct{}

func (f *FileReader) Read(p []byte) (int, error) { return 0, nil }
func (f *FileReader) Close() error               { return nil }
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0' }));
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const rows = cg.queries.db
      .prepare(
        `SELECT s.name AS structName, t.name AS ifaceName
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'implements' AND s.language = 'go' AND t.kind = 'interface'`,
      )
      .all() as Array<{ structName: string; ifaceName: string }>;
    cg.close();

    expect(rows.length).toBe(1);
    expect(rows[0]).toEqual({ structName: 'FileReader', ifaceName: 'Reader' });
  });

  it('does NOT emit when the struct is missing one of the interface methods', async () => {
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pkg', 'partial.go'),
      `package pkg

type ReadCloser interface {
    Read(p []byte) (int, error)
    Close() error
}

type ReadOnly struct{}

func (r *ReadOnly) Read(p []byte) (int, error) { return 0, nil }
// missing Close
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0' }));
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const count = (
      cg.queries.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'implements'`).get() as { n: number }
    ).n;
    cg.close();
    expect(count).toBe(0);
  });

  it('skips empty interfaces (no false-positive flood)', async () => {
    fs.mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'pkg', 'empty.go'),
      `package pkg

type Empty interface{}

type Any struct{}

func (a *Any) Do() {}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0' }));
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const count = (
      cg.queries.db.prepare(`SELECT COUNT(*) AS n FROM edges WHERE kind = 'implements'`).get() as { n: number }
    ).n;
    cg.close();
    // Empty interface = trivially satisfied by everything. Skipped to
    // avoid an S × emptyCount edge flood with zero signal.
    expect(count).toBe(0);
  });

  it('matches across packages (interface in one package, struct in another)', async () => {
    fs.mkdirSync(path.join(dir, 'io'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'app'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'io', 'iface.go'),
      `package io

type Writer interface {
    Write(p []byte) (int, error)
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'app', 'impl.go'),
      `package app

type Buf struct{}

func (b *Buf) Write(p []byte) (int, error) { return 0, nil }
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0' }));
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const rows = cg.queries.db
      .prepare(
        `SELECT s.name AS structName, t.name AS ifaceName, s.file_path AS sFile, t.file_path AS tFile
         FROM edges e
         JOIN nodes s ON s.id = e.source
         JOIN nodes t ON t.id = e.target
         WHERE e.kind = 'implements' AND s.language = 'go' AND t.kind = 'interface'`,
      )
      .all() as Array<{ structName: string; ifaceName: string; sFile: string; tFile: string }>;
    cg.close();

    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ structName: 'Buf', ifaceName: 'Writer' });
    // Cross-package: source and target live in different files / dirs.
    expect(rows[0]!.sFile).not.toBe(rows[0]!.tFile);
  });
});
