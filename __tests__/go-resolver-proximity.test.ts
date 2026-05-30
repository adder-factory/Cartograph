/**
 * goResolver.resolve proximity tiebreak — Agent A FP1.
 *
 * When N same-named structs exist across the project, the resolver's
 * preferred-dirs filter could leave many candidates, and the legacy
 * `pool[0]` pick was alphabetical name-index order. For ollama's 14
 * `Options` structs (one per `model/models/<pkg>/`), every model's
 * `*Options` embed resolved to `bert/embed.go:Options` (alphabetical
 * winner) — 13 of 14 edges wrong.
 *
 * After the fix, sortByProximityToRef picks same-file first, then
 * nearest by shared-segment count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';

beforeEach(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-resolver-prox-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('goResolver proximity tiebreak (Agent A FP1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('resolves same-named structs to the same-file definition (not the alphabetical winner)', async () => {
    // Recreate the ollama shape: multiple `model/models/<pkg>/model.go`
    // files, each with its own `Options` struct. Embed `*Options` in
    // each Model. Without the proximity tiebreak, all extends edges
    // would resolve to alpha's Options (first alphabetical).
    fs.mkdirSync(path.join(dir, 'model', 'models', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'model', 'models', 'beta'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'model', 'models', 'gamma'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'model', 'models', 'alpha', 'model.go'),
      `package alpha

type Options struct {
    Size int
}

type Model struct {
    *Options
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'model', 'models', 'beta', 'model.go'),
      `package beta

type Options struct {
    Width int
}

type Model struct {
    *Options
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'model', 'models', 'gamma', 'model.go'),
      `package gamma

type Options struct {
    Height int
}

type Model struct {
    *Options
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // Each Model→Options extends edge should land on the same-file Options.
    const rows = cg.queries.db
      .prepare(
        `SELECT src.file_path AS srcFile, tgt.file_path AS tgtFile
         FROM edges e
         JOIN nodes src ON src.id = e.source
         JOIN nodes tgt ON tgt.id = e.target
         WHERE e.kind = 'extends' AND tgt.name = 'Options' AND src.name = 'Model'`,
      )
      .all() as Array<{ srcFile: string; tgtFile: string }>;

    cg.close();

    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.tgtFile).toBe(r.srcFile);
    }
  });

  it('falls back to nearest-by-shared-segments when no same-file candidate exists', async () => {
    // Cross-package reference: foo/widget.go references Helper which exists
    // in foo/utils.go and bar/utils.go. Same-file shares all dirs; bar
    // shares zero (different second segment). Without proximity, alpha
    // wins; with proximity, foo wins.
    fs.mkdirSync(path.join(dir, 'foo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bar'), { recursive: true });
    // `Helper` is named so PathMatch ends with 'Helper' (no special suffix)
    // but the PascalCase pattern still catches it via Pattern 4 (model).
    // For this test use a name that hits Pattern 1 (`Handler`-suffix).
    fs.writeFileSync(
      path.join(dir, 'foo', 'handler.go'),
      `package foo
func MyHandler() {}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'bar', 'handler.go'),
      `package bar
func MyHandler() {}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'foo', 'caller.go'),
      `package foo
func Caller() {
    MyHandler()
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix2', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const rows = cg.queries.db
      .prepare(
        `SELECT src.file_path AS srcFile, tgt.file_path AS tgtFile
         FROM edges e
         JOIN nodes src ON src.id = e.source
         JOIN nodes tgt ON tgt.id = e.target
         WHERE e.kind = 'calls' AND tgt.name = 'MyHandler' AND src.name = 'Caller'`,
      )
      .all() as Array<{ srcFile: string; tgtFile: string }>;

    cg.close();

    expect(rows.length).toBe(1);
    // The caller is in foo/. The resolver should prefer foo/handler.go
    // (shared dir `foo`) over bar/handler.go (shares only the root).
    expect(rows[0]!.tgtFile).toBe('foo/handler.go');
  });
});
