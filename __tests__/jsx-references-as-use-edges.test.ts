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
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-jsx-refs-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function writeSrc(p: string, body: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
}

describe('JSX usage emits use-edges so dead-code does not false-flag in-file components', () => {
  it('a component used only via `<X />` in the same file is NOT an orphan', async () => {
    const tmpDir = tempDir();
    try {
      writeSrc(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }),
      );
      writeSrc(
        path.join(tmpDir, 'app.tsx'),
        `
function RailRow({ label }: { label: string }) {
  return <div>{label}</div>;
}

export function ConnectionRail() {
  return (
    <div>
      <RailRow label="a" />
      <RailRow label="b" />
    </div>
  );
}
`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      // Pre-2026-05-22: RailRow surfaced as an orphan despite the two
      // JSX use sites in the same file. The body walker didn't visit
      // jsx_opening_element / jsx_self_closing_element so no use edge
      // was emitted. captureBodyJsxReferences closes that gap.
      const candidates = findGraphCandidates({ queries: cg.queries, max: 50, includeTests: false });
      cg.close();
      const orphanNames = candidates.map((c) => c.name);
      expect(orphanNames).not.toContain('RailRow');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('lowercase HTML primitives (`<div>`, `<span>`) are NOT emitted as references', async () => {
    const tmpDir = tempDir();
    try {
      writeSrc(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }),
      );
      writeSrc(
        path.join(tmpDir, 'div.tsx'),
        [
          '// A standalone function literally named div — should remain an',
          '// orphan candidate even though <div> appears in JSX. The HTML',
          '// primitive use must not satisfy the orphan check for a',
          '// user-defined symbol named div.',
          'function div() {',
          "  return 'standalone';",
          '}',
          '',
          'export function Page() {',
          '  return <div>content</div>;',
          '}',
          '',
        ].join('\n'),
      );
      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const candidates = findGraphCandidates({ queries: cg.queries, max: 50, includeTests: false });
      cg.close();
      // The local `div` function has no PascalCase JSX use — it should
      // still surface as an orphan candidate. (We don't strictly need
      // it TO surface for the test to pass — we just need to be sure
      // the HTML `<div>` token doesn't spuriously mark `div` as used.
      // Checking the use-edge inverse via the orphan-pool would be
      // ideal but findDeadCodeCandidates filters more aggressively;
      // the next test below uses a positive shape.)
      const orphanNames = candidates.map((c) => c.name);
      expect(orphanNames).toContain('div');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('member-expression JSX `<foo.Bar />` emits a reference to the outer binding `foo`', async () => {
    const tmpDir = tempDir();
    try {
      writeSrc(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }),
      );
      writeSrc(
        path.join(tmpDir, 'compound.tsx'),
        `
function Compound({ children }: { children: React.ReactNode }) {
  return <div>{children}</div>;
}

function CompoundItem({ label }: { label: string }) {
  return <span>{label}</span>;
}

// Object-style "compound component" — common React pattern.
const Foo = Object.assign(Compound, { Item: CompoundItem });

export function App() {
  return (
    <Foo>
      <Foo.Item label="hi" />
    </Foo>
  );
}
`,
      );
      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      // Both Compound and Foo should NOT be orphans — both are used
      // via JSX (the second via the member-expression form).
      const candidates = findGraphCandidates({ queries: cg.queries, max: 50, includeTests: false });
      cg.close();
      const orphanNames = candidates.map((c) => c.name);
      expect(orphanNames).not.toContain('Foo');
      expect(orphanNames).not.toContain('Compound');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('a genuinely-unused component remains an orphan (no false negative from JSX detection)', async () => {
    const tmpDir = tempDir();
    try {
      writeSrc(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({ name: 'fixture', dependencies: { react: '^19.0.0' } }),
      );
      writeSrc(
        path.join(tmpDir, 'unused.tsx'),
        `
function UnusedWidget() {
  return <div>orphan</div>;
}

export function Page() {
  return <div>content</div>;
}
`,
      );
      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const candidates = findGraphCandidates({ queries: cg.queries, max: 50, includeTests: false });
      cg.close();
      const orphanNames = candidates.map((c) => c.name);
      expect(orphanNames).toContain('UnusedWidget');
    } finally {
      cleanup(tmpDir);
    }
  });
});
