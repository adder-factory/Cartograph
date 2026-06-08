/**
 * Language-coverage parity-guard.
 *
 * Extracts every `docs/test-beds/<lang>/fixture.*` and asserts a
 * per-language extraction FLOOR: the fixture parses without a hard
 * error, and the extractor emits at least one real symbol and at least
 * one edge for symbol-emitting language modes. One `it` row per
 * language, so a regression names the language that broke.
 *
 * A floor — deliberately NOT exact node/edge counts. Exact counts are
 * brittle against fixture edits and grammar bumps; the regression that
 * actually matters is an extractor silently producing nothing (a
 * grammar swap, a refactor, a bad `.wasm`). The floor catches that
 * without the day-to-day churn.
 *
 * Always on. With `COVERAGE=1` it ALSO writes a per-language
 * node/edge/ref breakdown to /tmp/language-coverage.json (for an
 * offline report builder) and logs a one-line-per-language summary.
 *
 * Scope: one `fixture.<ext>` per supported language mode — pure
 * LANGUAGE-extraction coverage. Parser-only modes are documented
 * zero-symbol exceptions. Schema-DSL recognizers (Zod, Pydantic, …)
 * have their own
 * fixtures under `__tests__/fixtures/schema-recognizers/`, exercised
 * by the `schema-recognizers-*.test.ts` suites — not here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { ExtractionResult } from '../src/types.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

/** When set, also dump the JSON breakdown + log a per-language line. */
const DUMP = process.env.COVERAGE === '1';
const TESTBEDS = path.join(__dirname, '..', 'docs', 'test-beds');
const OUT = '/tmp/language-coverage.json';

/** Node kinds that are not, on their own, evidence the extractor works
 *  — every file yields a `file` node, and `import` nodes come almost
 *  for free. A real symbol is anything else. */
const TRIVIAL_KINDS: ReadonlySet<string> = new Set(['file', 'import']);

/** Languages whose extractor is INTENTIONALLY zero-emit by design —
 *  they exist for file recognition, parse diagnostics, framework
 *  dispatch, or future query support. The fixture still gets a
 *  parse-without-error check, but the symbol-floor + edge-floor
 *  assertions are skipped because requiring them would force a
 *  feature-creep extractor change. */
const KNOWN_ZERO_SYMBOL_LANGUAGES: ReadonlySet<string> = new Set([
  'css',
  'embedded_template',
  'html',
  'jsdoc',
  'json',
  'regex',
  'yaml',
]);

interface LangResult {
  language: string;
  fixturePath: string;
  /** False only when `extractFromSource` itself threw. */
  parsed: boolean;
  /** Count of `severity: 'error'` extraction errors (warnings excluded —
   *  the error-recovering parser emits those on broken spans by design). */
  hardErrors: number;
  nodes: { total: number; symbols: number; byKind: Record<string, number> };
  edges: { total: number; byKind: Record<string, number> };
  refs: { total: number; byKind: Record<string, number> };
  errors: string[];
}

function byKind(
  xs: ReadonlyArray<{ kind?: string; referenceKind?: string }>,
  key: 'kind' | 'referenceKind',
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = x[key];
    if (k) out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function summarise(language: string, fixture: string): LangResult {
  const empty = {
    language,
    fixturePath: fixture,
    nodes: { total: 0, symbols: 0, byKind: {} },
    edges: { total: 0, byKind: {} },
    refs: { total: 0, byKind: {} },
  };
  let result: ExtractionResult;
  try {
    result = extractFromSource(fixture, fs.readFileSync(fixture, 'utf-8'));
  } catch (err) {
    return { ...empty, parsed: false, hardErrors: 1, errors: [String(err)] };
  }

  const rawErrors = result.errors ?? [];
  return {
    language,
    fixturePath: fixture,
    parsed: true,
    hardErrors: rawErrors.filter((e) => e.severity === 'error').length,
    nodes: {
      total: result.nodes.length,
      symbols: result.nodes.filter((n) => !TRIVIAL_KINDS.has(n.kind)).length,
      byKind: byKind(result.nodes, 'kind'),
    },
    edges: { total: result.edges.length, byKind: byKind(result.edges, 'kind') },
    refs: {
      total: (result.unresolvedReferences ?? []).length,
      byKind: byKind(result.unresolvedReferences ?? [], 'referenceKind'),
    },
    errors: rawErrors.map((e) => `${e.severity}: ${e.message}`).slice(0, 5),
  };
}

/** Discover `<lang>/fixture.*` at module load — `it.each` needs the
 *  list at collection time. */
function discoverFixtures(): Array<{ language: string; fixture: string }> {
  const out: Array<{ language: string; fixture: string }> = [];
  for (const lang of fs.readdirSync(TESTBEDS).sort(byString)) {
    const dir = path.join(TESTBEDS, lang);
    if (!fs.statSync(dir).isDirectory()) continue;
    const fixture = fs.readdirSync(dir).find((f) => f.startsWith('fixture.'));
    if (fixture) out.push({ language: lang, fixture: path.join(dir, fixture) });
  }
  return out;
}
const FIXTURES = discoverFixtures();

describe('language-coverage parity-guard', () => {
  const results: LangResult[] = [];

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  afterAll(() => {
    if (!DUMP) return;
    fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
    console.log(`\nWrote ${results.length} language results to ${OUT}`);
  });

  // A vacuous pass guard: if discovery silently returns too little,
  // `it.each([])` or a stale fixture tree can pass for free.
  it('discovers the test-bed fixtures', () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(60);
  });

  it.each(FIXTURES)('$language extracts to a non-empty graph', ({ language, fixture }) => {
    const r = summarise(language, fixture);
    results.push(r);
    if (DUMP) {
      console.log(
        `[${language.padEnd(11)}] nodes=${String(r.nodes.total).padStart(3)} ` +
          `symbols=${String(r.nodes.symbols).padStart(3)} edges=${String(r.edges.total).padStart(3)} ` +
          `refs=${String(r.refs.total).padStart(3)}  kinds: ${Object.keys(r.nodes.byKind).join(',')}`,
      );
    }
    // The floor — three independent failure modes, each named.
    expect(r.parsed, `${language}: extractFromSource threw — ${r.errors.join(' | ')}`).toBe(true);
    expect(r.hardErrors, `${language}: hard extraction error(s) — ${r.errors.join(' | ')}`).toBe(0);
    // Symbol + edge floors only apply to languages whose extractor is
    // designed to emit real graph content. KNOWN_ZERO_SYMBOL_LANGUAGES
    // are grammar-loaded shims (yaml) whose nodes/edges come from a
    // resolver, not the extractor — see the set's JSDoc above.
    if (!KNOWN_ZERO_SYMBOL_LANGUAGES.has(language)) {
      expect(
        r.nodes.symbols,
        `${language}: extractor emitted no real symbols (only file/import nodes)`,
      ).toBeGreaterThan(0);
      expect(r.edges.total, `${language}: extractor emitted no edges`).toBeGreaterThan(0);
    }
  });
});
