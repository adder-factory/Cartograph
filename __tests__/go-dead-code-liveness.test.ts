import { describe, it, expect, beforeAll } from 'vitest';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { findGraphCandidates } from '../src/llm/dead-code.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-dead-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeSrc(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('Go-specific dead-code liveness conventions', () => {
  // ollama bug-hunt FN: dead-code via=rule flagged main() and well-known
  // interface methods (UnmarshalJSON/MarshalJSON/String/Error) as dead
  // across every Go package. They're framework-dispatched (Go runtime,
  // encoding/json reflection, etc.) and invisible to the structural
  // resolver. This test locks in the Go convention exemptions.
  it('main / init / Test* / Marshal*JSON / String / Error are not flagged as dead', async () => {
    const tmpDir = tempDir();
    try {
      writeSrc(path.join(tmpDir, 'go.mod'), 'module fixture\n\ngo 1.22\n');

      // main package with main() + init() — runtime-dispatched entry points.
      writeSrc(
        path.join(tmpDir, 'cmd', 'main.go'),
        `package main

func main() {
    println("hi")
}

func init() {
    println("init")
}
`,
      );

      // Test file with framework-dispatched test functions.
      writeSrc(
        path.join(tmpDir, 'pkg', 'thing_test.go'),
        `package pkg

import "testing"

func TestThing(t *testing.T) {
    if false { t.Fail() }
}

func BenchmarkThing(b *testing.B) {
    for i := 0; i < b.N; i++ { _ = i }
}

func ExampleThing() {
    // Output: hi
}

func TestMain(m *testing.M) {
    m.Run()
}
`,
      );

      // Interface-satisfaction methods (encoding/json, fmt, error).
      writeSrc(
        path.join(tmpDir, 'pkg', 'shapes.go'),
        `package pkg

type Color struct{ Name string }

func (c Color) MarshalJSON() ([]byte, error)   { return nil, nil }
func (c *Color) UnmarshalJSON(b []byte) error  { return nil }
func (c Color) String() string                  { return c.Name }

type myErr struct{ msg string }

func (e *myErr) Error() string { return e.msg }

// A genuinely unused private helper - SHOULD be flagged as a candidate.
func unusedHelper() int { return 42 }
`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      // includeTests: true so the test file isn't pre-filtered by path —
      // we want to verify the per-function exemption fires even when test
      // paths are in scope.
      const candidates = findGraphCandidates({ queries: cg.queries, max: 100, includeTests: true });
      cg.close();

      const names = candidates.map((c) => c.name);

      // Framework / runtime-dispatched: must NOT be candidates.
      expect(names).not.toContain('main');
      expect(names).not.toContain('init');
      expect(names).not.toContain('TestThing');
      expect(names).not.toContain('BenchmarkThing');
      expect(names).not.toContain('ExampleThing');
      expect(names).not.toContain('TestMain');
      expect(names).not.toContain('MarshalJSON');
      expect(names).not.toContain('UnmarshalJSON');
      expect(names).not.toContain('String');
      expect(names).not.toContain('Error');

      // The genuine orphan must still surface (no false negative).
      expect(names).toContain('unusedHelper');
    } finally {
      cleanup(tmpDir);
    }
  });
});
