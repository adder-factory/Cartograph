/**
 * MCP tool registry — drift guard.
 *
 * Adding an MCP tool is a 3-edit ritual: the tool file, the `ENTRIES`
 * array in `src/mcp/tools/registry.ts`, and (historically) an allowlist
 * in `mcp-tool-registry.test.ts`. Those hand-maintained lists can drift
 * — a tool file exists but is never registered, or an `ENTRIES` row
 * points at a renamed/deleted export.
 *
 * This test makes drift fail CI by cross-checking the FILESYSTEM
 * against `registry.ts` in BOTH directions:
 *
 *   forward  — every `src/mcp/tools/*.ts` file that exports a
 *              `<NAME>_TOOL` constant IS listed in `ENTRIES`.
 *   reverse  — every `ENTRIES` row points at a file that exists and
 *              actually exports the named constant.
 *
 * It deliberately does NOT rewrite `registry.ts` to dynamic imports:
 * the static-import `ENTRIES` array gives compile-time export checking
 * and deterministic load order. This test is the safety net that the
 * static array stays in sync with the directory.
 *
 * Convention recap (see `registry.ts` header): files prefixed with `_`
 * are private per-action/per-axis helpers and infra (`_define-tool.ts`,
 * `_outcome.ts`, `_response.ts`, …) — they never export a `<NAME>_TOOL`
 * and are excluded from the glob. Non-`_` files that are pure helpers
 * (`shared.ts`, `types.ts`, `result-formatters.ts`, family sub-handlers
 * like `review-context.ts`, retired-tool bodies like `risk-review.ts`,
 * etc.) are NOT excluded by name — instead the structural rule "a tool
 * file is one that exports a `<NAME>_TOOL`" cleanly separates them, so
 * there is no hand-maintained non-tool allowlist to drift.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { getToolModules } from '../src/mcp/tools/registry.js';

const TOOLS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../src/mcp/tools');
const REGISTRY_PATH = join(TOOLS_DIR, 'registry.ts');
const byString = (a: string, b: string): number => a.localeCompare(b);

/** Matches `export const FOO_TOOL = ` (the `defineTool(...)` result). */
const TOOL_EXPORT_RE = /export\s+const\s+([A-Z][A-Z0-9_]*_TOOL)\s*=/g;

/** Source files in `src/mcp/tools/` that are candidate tool modules:
 *  `.ts`, not `_`-prefixed (private helpers/infra), not a test, not the
 *  registry itself. */
function candidateToolFiles(): string[] {
  return readdirSync(TOOLS_DIR)
    .filter((f) => f.endsWith('.ts'))
    .filter((f) => !f.startsWith('_'))
    .filter((f) => !f.endsWith('.test.ts'))
    .filter((f) => f !== 'registry.ts')
    .sort(byString);
}

/** All `<NAME>_TOOL` identifiers exported from a tool source file. */
function exportedToolNames(file: string): string[] {
  const text = readFileSync(join(TOOLS_DIR, file), 'utf8');
  const names: string[] = [];
  for (const m of text.matchAll(TOOL_EXPORT_RE)) names.push(m[1]);
  return names;
}

/** Parse `registry.ts`'s `ENTRIES` array — a flat list of imported
 *  `<NAME>_TOOL` identifiers — and pair each with the specifier from
 *  the static `import { <NAME>_TOOL } from './foo.js'` block at the
 *  top of the file. Reads the source text rather than importing
 *  internals so the test pins the literal arrays a contributor edits. */
function parseEntries(): { exportName: string; specifier: string }[] {
  const text = readFileSync(REGISTRY_PATH, 'utf8');
  const importRe = /import\s+\{\s*([A-Z][A-Z0-9_]*_TOOL)\s*\}\s+from\s+'(\.\/[A-Za-z0-9_-]+\.js)';/g;
  const specByExport = new Map<string, string>();
  for (const m of text.matchAll(importRe)) specByExport.set(m[1], m[2]);

  const start = text.indexOf('const ENTRIES');
  expect(start, 'ENTRIES array not found in registry.ts').toBeGreaterThan(-1);
  const end = text.indexOf('];', start);
  expect(end, 'ENTRIES array terminator not found').toBeGreaterThan(start);
  const block = text.slice(start, end);
  const idRe = /\b([A-Z][A-Z0-9_]*_TOOL)\b/g;
  const rows: { exportName: string; specifier: string }[] = [];
  for (const m of block.matchAll(idRe)) {
    const exportName = m[1];
    const specifier = specByExport.get(exportName);
    expect(specifier, `ENTRIES references ${exportName} but no matching import was found in registry.ts`).toBeDefined();
    rows.push({ exportName, specifier: specifier! });
  }
  return rows;
}

/** Turn a `./foo.js` specifier into the `foo.ts` source basename. */
function specifierToSourceFile(specifier: string): string {
  return specifier.replace(/^\.\//, '').replace(/\.js$/, '.ts');
}

describe('MCP tool registry — completeness (filesystem ⇄ ENTRIES)', () => {
  const entries = parseEntries();
  const toolFiles = candidateToolFiles();

  it('parses a non-trivial ENTRIES array from registry.ts', () => {
    // Sanity floor: if the regex silently matched nothing the
    // direction tests below would vacuously pass.
    expect(entries.length).toBeGreaterThan(20);
  });

  it('ENTRIES exactly mirrors the live getToolModules() count', () => {
    expect(entries.length).toBe(getToolModules().length);
  });

  it('ENTRIES rows are unique by exportName and by specifier', () => {
    const exportNames = entries.map((e) => e.exportName);
    const specifiers = entries.map((e) => e.specifier);
    expect(new Set(exportNames).size, 'duplicate exportName in ENTRIES').toBe(exportNames.length);
    expect(new Set(specifiers).size, 'duplicate specifier in ENTRIES').toBe(specifiers.length);
  });

  // forward: filesystem → registry
  it('every tool file that exports a *_TOOL is registered in ENTRIES', () => {
    const registeredFiles = new Set(entries.map((e) => specifierToSourceFile(e.specifier)));
    const registeredExports = new Set(entries.map((e) => e.exportName));

    const unregistered: string[] = [];
    for (const file of toolFiles) {
      const names = exportedToolNames(file);
      if (names.length === 0) continue; // pure helper file — not a tool
      // A tool file is registered iff its file is an ENTRIES specifier
      // AND each exported *_TOOL has a matching ENTRIES exportName.
      if (!registeredFiles.has(file)) {
        unregistered.push(`${file} exports ${names.join(', ')} but is not in ENTRIES`);
        continue;
      }
      for (const name of names) {
        if (!registeredExports.has(name)) {
          unregistered.push(`${file} exports ${name} but no ENTRIES row references it`);
        }
      }
    }
    expect(
      unregistered,
      `unregistered tool module(s) — add an import + ENTRIES row to registry.ts:\n  ${unregistered.join('\n  ')}`,
    ).toEqual([]);
  });

  // reverse: registry → filesystem
  it('every ENTRIES row points at a file that exports that name', () => {
    const broken: string[] = [];
    for (const { exportName, specifier } of entries) {
      const file = specifierToSourceFile(specifier);
      const abs = join(TOOLS_DIR, file);
      if (!existsSync(abs)) {
        broken.push(`${specifier} → ${file} does not exist`);
        continue;
      }
      const names = exportedToolNames(file);
      if (!names.includes(exportName)) {
        broken.push(`${file} does not export ${exportName} (exports: ${names.join(', ') || 'none'})`);
      }
    }
    expect(
      broken,
      `stale ENTRIES row(s) — registry.ts references a missing/renamed export:\n  ${broken.join('\n  ')}`,
    ).toEqual([]);
  });

  // The import block and the ENTRIES array are two hand-maintained lists
  // in the same file; a stray import without a row (or vice versa) is its
  // own flavour of drift.
  it('every ENTRIES exportName has a matching static import in registry.ts', () => {
    const text = readFileSync(REGISTRY_PATH, 'utf8');
    const importedNames = new Set<string>();
    const importRe = /import\s+\{\s*([A-Z][A-Z0-9_]*_TOOL)\s*\}\s+from\s+'(\.\/[A-Za-z0-9_-]+\.js)';/g;
    const importedSpecifiers = new Map<string, string>();
    for (const m of text.matchAll(importRe)) {
      importedNames.add(m[1]);
      importedSpecifiers.set(m[1], m[2]);
    }
    const missing: string[] = [];
    for (const { exportName, specifier } of entries) {
      if (!importedNames.has(exportName)) {
        missing.push(`${exportName} is in ENTRIES but never imported`);
        continue;
      }
      const importedFrom = importedSpecifiers.get(exportName);
      if (importedFrom !== specifier) {
        missing.push(`${exportName} imported from ${importedFrom} but ENTRIES uses specifier ${specifier}`);
      }
    }
    expect(missing, missing.join('\n  ')).toEqual([]);
  });
});
