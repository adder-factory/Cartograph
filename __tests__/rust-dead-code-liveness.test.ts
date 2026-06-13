import { describe, it, expect, beforeAll } from 'vitest';
import { Cartograph } from '../src/index.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { findGraphCandidates } from '../src/llm/dead-code.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rust-dead-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeSrc(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('Rust-specific dead-code liveness conventions (#11)', () => {
  // synergyssh bug-hunt FN: `dead-code --via rule` flagged #[allow(dead_code)]
  // suppressions, #[tauri::command] IPC entry points, #[test] functions, and
  // build.rs `fn main` as dead — all reflective / author-suppressed and
  // invisible to the structural resolver. This locks in the exemptions.
  it('attribute-bearing and Cargo-entry Rust fns are not flagged; genuine orphan still is', async () => {
    const tmpDir = tempDir();
    try {
      writeSrc(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');

      // build.rs `fn main` — Cargo build-script entry point.
      writeSrc(path.join(tmpDir, 'build.rs'), `fn main() {\n    println!("cargo:rerun-if-changed=build.rs");\n}\n`);

      writeSrc(
        path.join(tmpDir, 'src', 'browser.rs'),
        `// #[tauri::command] entry points — reflective IPC, no static caller.
#[tauri::command]
fn browser_create() {}

#[tauri::command]
fn browser_navigate() {}

// Explicit author suppression.
#[allow(dead_code)]
fn close_all_panes() {}

// #[test] functions — test code, not dead.
#[test]
fn embeds_code_as_json() {}

#[cfg(test)]
fn helper_for_tests() {}

// A genuinely unused private helper — SHOULD surface as a candidate.
fn truly_unused_helper() -> i32 { 42 }
`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const candidates = findGraphCandidates({ queries: cg.queries, max: 100, includeTests: true });
      cg.close();

      const names = candidates.map((c) => c.name);

      // Cargo build-script entry point.
      expect(names).not.toContain('main');
      // #[tauri::command] reflective entry points.
      expect(names).not.toContain('browser_create');
      expect(names).not.toContain('browser_navigate');
      // #[allow(dead_code)] explicit suppression.
      expect(names).not.toContain('close_all_panes');
      // #[test] / #[cfg(test)] test code.
      expect(names).not.toContain('embeds_code_as_json');
      expect(names).not.toContain('helper_for_tests');

      // The genuine orphan must still surface (no false negative).
      expect(names).toContain('truly_unused_helper');
    } finally {
      cleanup(tmpDir);
    }
  });
});
