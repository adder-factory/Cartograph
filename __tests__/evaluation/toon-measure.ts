#!/usr/bin/env tsx
/**
 * Measure TOON-vs-current-markdown payload on real query results
 * (#6). Runs a representative set of queries against this project's
 * own .cartograph and prints per-query + aggregate byte savings.
 *
 * The decision is empirical: the backlog cites a 30-60% claim; this
 * measurement says whether that holds for OUR queries on OUR shape.
 * Ship the renderer behind a flag if the average saving justifies
 * the maintenance cost; skip if it's a wash.
 *
 * What "TOON" means here: header-once / rows-as-comma-tuples format.
 * One declaration per result block ("name,kind,file,line"), then one
 * line per row with the values in declaration order. Strings with
 * comma / quote / newline get JSON-escaped + quoted. Empty optional
 * fields render as the empty string between separators.
 *
 * Run: `bun __tests__/evaluation/toon-measure.ts`
 */
import * as path from 'node:path';
import { Cartograph } from '../../src/index.js';
import { searchNodes, suggestSymbolNames } from '../../src/db/queries-search.js';
import { getIncomingEdges } from '../../src/db/queries-edges.js';

interface RowSchema {
  /** Column names in declaration order. */
  fields: ReadonlyArray<string>;
  /** Per-row values, lined up to `fields`. Stringification happens here. */
  values: ReadonlyArray<ReadonlyArray<string | number | null | undefined>>;
}

/**
 * Render rows as TOON. Strings containing the delimiter / quote /
 * newline are JSON-quoted; everything else passes through as the
 * stringified value. Header is `name[N]{f1,f2,…}:` then one indented
 * line per row.
 */
function renderToon(name: string, schema: RowSchema): string {
  const lines: string[] = [`${name}[${schema.values.length}]{${schema.fields.join(',')}}:`];
  for (const row of schema.values) {
    const cells = row.map(toCell);
    lines.push('  ' + cells.join(','));
  }
  return lines.join('\n');
}

function toCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return '';
  const s = String(v);
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    // JSON-quote: handles escaping consistently.
    return JSON.stringify(s);
  }
  return s;
}

/** Markdown render of search results — mirrors `formatSearchResults` in src/mcp/tools/search.ts. */
function renderSearchMarkdown(
  results: ReadonlyArray<{
    node: { name: string; kind: string; filePath: string; startLine: number; signature?: string | null };
  }>,
): string {
  const lines: string[] = [`## Search Results (${results.length} found)`, ''];
  for (const r of results) {
    const loc = r.node.startLine ? `:${r.node.startLine}` : '';
    lines.push(`### ${r.node.name} (${r.node.kind})`);
    lines.push(`${r.node.filePath}${loc}`);
    if (r.node.signature) lines.push(`\`${r.node.signature}\``);
    lines.push('');
  }
  return lines.join('\n');
}

function renderSearchToon(
  results: ReadonlyArray<{
    node: { name: string; kind: string; filePath: string; startLine: number; signature?: string | null };
  }>,
): string {
  const schema: RowSchema = {
    fields: ['name', 'kind', 'file', 'line', 'signature'],
    values: results.map((r) => [
      r.node.name,
      r.node.kind,
      r.node.filePath,
      r.node.startLine ?? '',
      r.node.signature ?? '',
    ]),
  };
  return renderToon('search_results', schema);
}

/** Markdown render of callers (mirrors `formatNodeList`). */
function renderCallersMarkdown(
  rows: ReadonlyArray<{ name: string; kind: string; file: string; line: number; confidence?: string }>,
): string {
  const lines: string[] = [`## Callers of X (${rows.length} found)`, ''];
  for (const r of rows) {
    const loc = r.line ? `:${r.line}` : '';
    const conf = r.confidence && r.confidence !== 'EXTRACTED' ? ` *(${r.confidence})*` : '';
    lines.push(`- ${r.name} (${r.kind}) - ${r.file}${loc}${conf}`);
  }
  return lines.join('\n');
}

function renderCallersToon(
  rows: ReadonlyArray<{ name: string; kind: string; file: string; line: number; confidence?: string }>,
): string {
  const schema: RowSchema = {
    fields: ['name', 'kind', 'file', 'line', 'confidence'],
    values: rows.map((r) => [r.name, r.kind, r.file, r.line, r.confidence ?? '']),
  };
  return renderToon('callers', schema);
}

interface Sample {
  label: string;
  /** Number of rows in the result set. */
  rows: number;
  /** Markdown payload size in bytes. */
  mdBytes: number;
  /** TOON payload size in bytes. */
  toonBytes: number;
  /** TOON savings as a fraction of markdown (0 = no win, 0.5 = 50% smaller). */
  saving: number;
}

function record(label: string, md: string, toon: string, rows: number): Sample {
  const mdBytes = md.length;
  const toonBytes = toon.length;
  const saving = mdBytes > 0 ? (mdBytes - toonBytes) / mdBytes : 0;
  return { label, rows, mdBytes, toonBytes, saving };
}

async function main(): Promise<void> {
  const projectRoot = path.resolve(import.meta.dirname, '../../');
  const cg = Cartograph.openSync(projectRoot);
  const samples: Sample[] = [];

  // ─── cartograph_search representative queries ────────────────────
  for (const query of ['Cartograph', 'extractFromSource', 'compareToRef', 'handleSearch', 'parseTrace']) {
    const results = searchNodes(cg.queries, query, { limit: 10 });
    if (results.length === 0) continue;
    const md = renderSearchMarkdown(results);
    const toon = renderSearchToon(results);
    samples.push(record(`search "${query}" (${results.length} rows)`, md, toon, results.length));
  }

  // suggest fallback for the few-row shape
  for (const query of ['CodGrap', 'extracFromSorce']) {
    const ranked = suggestSymbolNames(cg.queries, query, 10);
    if (ranked.length === 0) continue;
    const fakeResults = ranked.map((r) => ({
      node: { name: r.name, kind: 'function', filePath: 'unknown', startLine: 0, signature: null },
    }));
    const md = renderSearchMarkdown(fakeResults);
    const toon = renderSearchToon(fakeResults);
    samples.push(record(`suggest "${query}" (${ranked.length} rows)`, md, toon, ranked.length));
  }

  // ─── synthesised callers rows (mix of confidences) ──────────────
  const callerNode = searchNodes(cg.queries, 'extractFromSource', { limit: 1 })[0]?.node;
  if (callerNode) {
    const callerEdges = getIncomingEdges(cg.queries, callerNode.id);
    const rows = callerEdges
      .slice(0, 20)
      .map((e) => {
        const src = cg.queries.getNodeById(e.source);
        if (!src) return null;
        return {
          name: src.name,
          kind: src.kind,
          file: src.filePath,
          line: src.startLine ?? 0,
          confidence: e.confidence ?? 'EXTRACTED',
        };
      })
      .filter((r): r is { name: string; kind: string; file: string; line: number; confidence: string } => !!r);
    if (rows.length > 0) {
      const md = renderCallersMarkdown(rows);
      const toon = renderCallersToon(rows);
      samples.push(record(`callers of extractFromSource (${rows.length} rows)`, md, toon, rows.length));
    }
  }

  cg.close();

  // ─── report ─────────────────────────────────────────────────────
  console.log('\n# TOON vs markdown payload measurement (#6)\n');
  const idLen = Math.max(...samples.map((s) => s.label.length));
  console.log(`  ${'sample'.padEnd(idLen)}  rows  md(B)  toon(B)  saving`);
  console.log(`  ${'─'.repeat(idLen)}  ────  ─────  ───────  ──────`);
  let totalMd = 0,
    totalToon = 0;
  for (const s of samples) {
    const sign = s.saving >= 0 ? '+' : '';
    console.log(
      `  ${s.label.padEnd(idLen)}  ${String(s.rows).padStart(4)}  ${String(s.mdBytes).padStart(5)}  ${String(s.toonBytes).padStart(7)}  ${sign}${(s.saving * 100).toFixed(1)}%`,
    );
    totalMd += s.mdBytes;
    totalToon += s.toonBytes;
  }
  const overall = totalMd > 0 ? (totalMd - totalToon) / totalMd : 0;
  console.log('');
  console.log(`  TOTAL: md=${totalMd}B  toon=${totalToon}B  aggregate saving ${(overall * 100).toFixed(1)}%`);

  // Backlog claim is 30-60%. Decision rule: ship if aggregate >= 25%
  // (cheaper to maintain a real save than a marginal one), skip if <
  // 15% (not worth the format-divergence cost), gather more data
  // between.
  console.log('');
  if (overall >= 0.25) {
    console.log(`  ✓ Aggregate saving >= 25% — TOON renderer worth shipping behind a flag.`);
  } else if (overall < 0.15) {
    console.log(`  ✗ Aggregate saving < 15% — TOON not worth the format-divergence cost.`);
  } else {
    console.log(
      `  ? Aggregate saving in 15-25% — borderline. Consider per-tool selectivity (TOON only on the highest-row-count tools).`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
