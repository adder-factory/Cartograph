/**
 * scripts/extraction-coverage.ts — extraction blind-spot diagnostic.
 *
 * When a grammar emits a named node type that the extractor has no
 * case for, that construct is silently dropped — no symbol, no edge,
 * no error. This tool surfaces those blind spots: per language it
 * parses a sample, tallies every named node type, and cross-references
 * each against the symbols + references the extractor actually emitted.
 *
 * Coverage rule — a named node type is COVERED when at least one node
 * of that type either:
 *   (a) has a range (start+end) exactly equal to an extracted symbol
 *       `Node`'s range — a definition match (precise), or
 *   (b) starts at the exact position of an extracted
 *       `UnresolvedReference` — a reference match.
 * The reference test (b) is approximate: when several node types share
 * a start position, all are credited, so the tool can UNDER-report
 * blind spots. Treat the uncovered list as a floor, not a ceiling.
 *
 * This changes no extraction behaviour — it is read-only diagnostics.
 * The deliverable is a report; whether a surfaced gap is worth closing
 * is a per-language judgement call left to the reader.
 *
 * Run:
 *   bun scripts/extraction-coverage.ts            # sample docs/test-beds
 *   bun scripts/extraction-coverage.ts <path>     # also sample a file/dir
 *   bun scripts/extraction-coverage.ts --lang=go  # filter to one language
 *   bun scripts/extraction-coverage.ts --json     # machine-readable output
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import { initGrammars, loadGrammarsForLanguages, getParser } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { getLanguageDefs } from '../src/extraction/languages/registry.js';
import type { Language } from '../src/types.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTBEDS = path.join(REPO_ROOT, 'docs', 'test-beds');

/** Node types that are never symbols — excluded from the report as known noise. */
const NOISE_TYPES: ReadonlySet<string> = new Set(['comment', 'line_comment', 'block_comment', 'ERROR']);

/** Directories never worth walking in `<path>` repo-scan mode. */
const SKIP_DIRS: ReadonlySet<string> = new Set(['node_modules', '.git', 'dist', '.cartograph', 'coverage']);

// ── CLI flags ─────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const langFilter = argv.find((a) => a.startsWith('--lang='))?.slice('--lang='.length);
const extraPath = argv.find((a) => !a.startsWith('--'));

// ── Per-language accumulator ──────────────────────────────────────────
interface LangCoverage {
  language: string;
  files: number;
  /** Extracted symbol `Node`s (excluding the synthetic file node),
   *  summed across every sampled file. Zero is a loud signal — a
   *  grammar-backed language should always emit *some* symbol; zero
   *  means a broken extractor (or genuinely empty fixtures). */
  symbolNodes: number;
  /** named node type → total occurrences across every sampled file. */
  typeCounts: Map<string, number>;
  /** node types covered in at least one sampled file. */
  coveredTypes: Set<string>;
  /** node types seen as the parse-tree root (excluded from the report). */
  rootTypes: Set<string>;
  parseErrors: string[];
}

function emptyCoverage(language: string): LangCoverage {
  return {
    language,
    files: 0,
    symbolNodes: 0,
    typeCounts: new Map(),
    coveredTypes: new Set(),
    rootTypes: new Set(),
    parseErrors: [],
  };
}

/** Visit every named node in the tree (root included) depth-first. */
function walkNamedNodes(root: SyntaxNode, visit: (n: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const n = stack.pop()!;
    visit(n);
    for (let i = 0; i < n.namedChildCount; i++) {
      const c = n.namedChild(i);
      if (c) stack.push(c);
    }
  }
}

/**
 * Parse + extract one file and fold its node-type coverage into `acc`.
 * A node type is covered-in-this-file when any node of that type
 * matches an extracted symbol range or a reference start position.
 */
function analyzeFile(language: Language, filePath: string, source: string, acc: LangCoverage): void {
  const parser = getParser(language);
  if (!parser) return; // caller filtered grammar-less languages; defensive.

  let result: ReturnType<typeof extractFromSource> | undefined;
  try {
    result = extractFromSource(filePath, source, language);
  } catch (err) {
    acc.parseErrors.push(`${filePath}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Anchor sets — what the extractor actually emitted.
  // Definition match needs the full 4-tuple range; reference match
  // only has a start position.
  const nodeRanges = new Set<string>();
  for (const n of result.nodes) {
    nodeRanges.add(`${n.startLine - 1}:${n.startColumn}:${n.endLine - 1}:${n.endColumn}`);
    if (n.kind !== 'file') acc.symbolNodes++;
  }
  const refStarts = new Set<string>();
  for (const r of result.unresolvedReferences) {
    refStarts.add(`${r.line - 1}:${r.column}`);
  }

  let tree: ReturnType<typeof parser.parse> | undefined;
  try {
    tree = parser.parse(source);
  } catch (err) {
    acc.parseErrors.push(`${filePath} (tree-sitter parse): ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!tree) {
    acc.parseErrors.push(`${filePath}: parser returned no tree`);
    return;
  }

  try {
    acc.rootTypes.add(tree.rootNode.type);
    const seenThisFile = new Map<string, number>();
    const coveredThisFile = new Set<string>();
    walkNamedNodes(tree.rootNode, (n) => {
      const type = n.type;
      seenThisFile.set(type, (seenThisFile.get(type) ?? 0) + 1);
      const s = n.startPosition;
      const e = n.endPosition;
      const rangeKey = `${s.row}:${s.column}:${e.row}:${e.column}`;
      const startKey = `${s.row}:${s.column}`;
      if (nodeRanges.has(rangeKey) || refStarts.has(startKey)) {
        coveredThisFile.add(type);
      }
    });
    for (const [type, count] of seenThisFile) {
      acc.typeCounts.set(type, (acc.typeCounts.get(type) ?? 0) + count);
    }
    for (const type of coveredThisFile) acc.coveredTypes.add(type);
    acc.files++;
  } finally {
    // web-tree-sitter trees hold native WASM heap memory invisible to V8.
    tree.delete();
  }
}

// ── Sample collection ─────────────────────────────────────────────────

interface Sample {
  language: Language;
  filePath: string;
}

/** Extension → language map, built from the registry. */
function buildExtensionMap(): Map<string, Language> {
  const map = new Map<string, Language>();
  for (const def of getLanguageDefs()) {
    if (!def.grammar) continue; // node-type walk needs a tree-sitter grammar
    for (const ext of def.extensions) map.set(ext.toLowerCase(), def.name as Language);
  }
  return map;
}

/** `fs.statSync` that returns null instead of throwing (broken symlink, race). */
function safeStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

/** Collect the `docs/test-beds/<lang>/fixture.*` sample set. */
function collectTestbedSamples(): Sample[] {
  const out: Sample[] = [];
  if (!fs.existsSync(TESTBEDS)) return out;
  for (const lang of fs.readdirSync(TESTBEDS).sort()) {
    const dir = path.join(TESTBEDS, lang);
    if (!safeStat(dir)?.isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith('fixture.')) out.push({ language: lang as Language, filePath: path.join(dir, f) });
    }
  }
  return out;
}

/** Collect samples from a user-supplied file or directory. */
function collectPathSamples(target: string, extMap: Map<string, Language>): Sample[] {
  const out: Sample[] = [];
  const visit = (p: string): void => {
    const stat = safeStat(p);
    if (!stat) return; // broken symlink / unreadable entry — skip.
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(p))) return;
      for (const entry of fs.readdirSync(p)) visit(path.join(p, entry));
      return;
    }
    const lang = extMap.get(path.extname(p).toLowerCase());
    if (lang) out.push({ language: lang, filePath: p });
  };
  visit(path.resolve(target));
  return out;
}

// ── Report ────────────────────────────────────────────────────────────

interface LangReport {
  language: string;
  files: number;
  symbolNodes: number;
  kinds: number;
  covered: number;
  coveragePct: number;
  uncovered: Array<{ type: string; count: number }>;
  parseErrors: string[];
}

function buildReport(acc: LangCoverage): LangReport {
  const uncovered: Array<{ type: string; count: number }> = [];
  let kinds = 0;
  let covered = 0;
  for (const [type, count] of acc.typeCounts) {
    if (NOISE_TYPES.has(type) || acc.rootTypes.has(type)) continue;
    kinds++;
    if (acc.coveredTypes.has(type)) covered++;
    else uncovered.push({ type, count });
  }
  uncovered.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
  return {
    language: acc.language,
    files: acc.files,
    symbolNodes: acc.symbolNodes,
    kinds,
    covered,
    coveragePct: kinds === 0 ? 0 : Math.round((covered / kinds) * 100),
    uncovered,
    parseErrors: acc.parseErrors,
  };
}

function printReport(reports: LangReport[], skipped: string[]): void {
  console.log('Extraction coverage — node-type blind-spot diagnostic');
  console.log('A node type is "covered" when it anchors an extracted symbol (exact');
  console.log('range match) or a reference (start-position match). The reference');
  console.log('test is approximate — the uncovered list is a FLOOR on real gaps.\n');

  const broken: string[] = [];
  for (const r of reports) {
    console.log(
      `[${r.language.padEnd(11)}] files ${String(r.files).padStart(3)} · ` +
        `kinds ${String(r.kinds).padStart(3)} · covered ${String(r.covered).padStart(3)} ` +
        `(${String(r.coveragePct).padStart(3)}%) · uncovered ${r.uncovered.length}`,
    );
    if (r.symbolNodes === 0 && r.files > 0) {
      broken.push(r.language);
      console.log('    ⚠⚠ extracted ZERO symbol nodes — likely a broken extractor');
      console.log('       (grammar node types vs the LanguageExtractor config drifted) or empty fixtures');
    }
    for (const u of r.uncovered) {
      console.log(`    ${u.type.padEnd(34)} ×${u.count}`);
    }
    for (const e of r.parseErrors) console.log(`    ⚠ ${e}`);
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped (no tree-sitter grammar): ${skipped.join(', ')}`);
  }

  const ranked = [...reports].sort((a, b) => a.coveragePct - b.coveragePct);
  const avg = reports.length > 0 ? Math.round(reports.reduce((s, r) => s + r.coveragePct, 0) / reports.length) : 0;
  console.log(`\n${reports.length} languages analysed · mean coverage ${avg}%`);
  if (ranked.length > 0) {
    const lowest = ranked.slice(0, 5).map((r) => `${r.language} ${r.coveragePct}%`);
    console.log(`Lowest coverage: ${lowest.join(' · ')}`);
  }
  if (broken.length > 0) {
    console.log(`⚠⚠ ZERO-symbol languages (act on these first): ${broken.join(', ')}`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const extMap = buildExtensionMap();

  let samples = extraPath ? collectPathSamples(extraPath, extMap) : collectTestbedSamples();
  if (langFilter) samples = samples.filter((s) => s.language === langFilter);

  if (samples.length === 0) {
    if (langFilter) {
      console.error(`✗ --lang='${langFilter}' matched no sample (unknown language, or no fixture for it)`);
    } else {
      console.error(
        extraPath
          ? `✗ no source files with a tree-sitter grammar found under '${extraPath}'`
          : `✗ no test-bed fixtures found under ${path.relative(REPO_ROOT, TESTBEDS)}/`,
      );
    }
    process.exit(1);
  }

  // Grammar-less languages (Liquid, Svelte) can't be node-type-walked.
  const grammarLanguages = new Set(
    getLanguageDefs()
      .filter((d) => d.grammar)
      .map((d) => d.name),
  );
  const skipped = [...new Set(samples.map((s) => s.language))].filter((l) => !grammarLanguages.has(l)).sort();
  samples = samples.filter((s) => grammarLanguages.has(s.language));

  await initGrammars();
  await loadGrammarsForLanguages([...new Set(samples.map((s) => s.language))]);

  const byLang = new Map<string, LangCoverage>();
  for (const { language, filePath } of samples) {
    let source: string;
    try {
      source = fs.readFileSync(filePath, 'utf-8');
    } catch (err) {
      console.error(`✗ cannot read ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    let acc = byLang.get(language);
    if (!acc) {
      acc = emptyCoverage(language);
      byLang.set(language, acc);
    }
    analyzeFile(language, filePath, source, acc);
  }

  const reports = [...byLang.values()].map(buildReport).sort((a, b) => a.language.localeCompare(b.language));

  if (asJson) {
    console.log(JSON.stringify({ reports, skipped }, null, 2));
  } else {
    printReport(reports, skipped);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
