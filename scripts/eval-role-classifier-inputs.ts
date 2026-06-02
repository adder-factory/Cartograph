/**
 * Empirical eval: how much does role-classifier quality depend on
 * the LLM-generated `summary` field? If we drop summaries from the
 * input feature set and classify on docstring + signature instead,
 * how much agreement do we lose vs the production baseline?
 *
 * Usage:
 *   bun scripts/eval-role-classifier-inputs.ts [--n 50] [--no-batch]
 *
 * Methodology:
 *   1. Sample N nodes that have ALL THREE: docstring, summary, an
 *      already-assigned role. (Subset where every input feature is
 *      available — the apples-to-apples comparison set.)
 *   2. For each sample run the classifier with three input variants:
 *        A. summary + signature  (baseline — what production does)
 *        B. docstring + signature  (proposal — no LLM summary needed)
 *        C. name + kind + signature only  (most aggressive — no prose)
 *   3. Report pairwise agreement % + per-role confusion matrices.
 *
 * Decision criterion (pre-set):
 *   - A ≈ B agreement >= 80%  → docstring-based classification is a
 *     viable replacement; refactor worth pursuing.
 *   - 60-80% agreement      → marginal; per-role analysis needed.
 *   - < 60%                  → keep current coupling; docstrings don't
 *     carry enough role-discriminating signal.
 */

import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Cartograph } from '../src/index.js';
import { llmLocalChat } from '../src/cartograph-llm-service.js';

const N = Number(process.argv.find((a) => a.startsWith('--n='))?.split('=')[1] ?? '50');

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const ROLE_LIST_TEXT = [
  '- api_endpoint: HTTP/RPC handler, route, public-facing entry point.',
  '- business_logic: domain operation, workflow, decision-making.',
  '- data_model: type, struct, schema, DTO, persistence record.',
  '- util: pure helper, formatter, parser, generic utility.',
  '- framework_glue: middleware, adapter, config wiring, lifecycle hook.',
  '- test_helper: fixture, mock builder, assertion helper.',
  '- unknown: cannot determine from the description.',
].join('\n');

const ROLE_LABELS = new Set([
  'api_endpoint',
  'business_logic',
  'data_model',
  'util',
  'framework_glue',
  'test_helper',
  'unknown',
]);

interface Sample {
  nodeId: string;
  name: string;
  kind: string;
  signature: string | null;
  docstring: string;
  summary: string;
  baselineRole: string;
}

type Variant = 'summary+sig' | 'docstring+sig' | 'name+kind+sig' | 'summary+docstring+sig';

function buildPrompt(s: Sample, variant: Variant): string {
  const sig = s.signature ? `\nSignature: ${s.signature}` : '';
  let descLines = '';
  if (variant === 'summary+sig') {
    descLines = `\nDescription: ${s.summary}`;
  } else if (variant === 'docstring+sig') {
    descLines = `\nDescription: ${s.docstring}`;
  } else if (variant === 'summary+docstring+sig') {
    descLines = `\nSummary: ${s.summary}\nDocstring: ${s.docstring}`;
  }
  // 'name+kind+sig' has no description block.
  return [
    'Classify the following code symbol into EXACTLY ONE of these roles:',
    '',
    ROLE_LIST_TEXT,
    '',
    `Symbol: ${s.name} (${s.kind})${sig}${descLines}`,
    '',
    'Reply with JUST the role name on a single line. No prose, no quotes.',
  ].join('\n');
}

function parseRole(text: string): string {
  const lower = text
    .toLowerCase()
    .trim()
    .replaceAll(/^[`'"\s]+|[`'"\s]+$/g, '');
  const firstToken = lower.split(/\s+/)[0]?.replaceAll(/[^a-z_]/g, '') ?? '';
  if (firstToken && ROLE_LABELS.has(firstToken)) return firstToken;
  const joined = lower
    .replaceAll(/[^a-z\s]/g, '')
    .split(/\s+/)
    .filter(Boolean)
    .join('_');
  if (joined && ROLE_LABELS.has(joined)) return joined;
  return 'unknown';
}

interface VariantResult {
  variant: Variant;
  classifications: string[];
}

async function classifyOne(cg: Cartograph, sample: Sample, variant: Variant): Promise<{ role: string; raw: string }> {
  const prompt = buildPrompt(sample, variant);
  try {
    const result = await llmLocalChat(cg.llm, { prompt, maxTokens: 64 });
    return { role: parseRole(result.text), raw: result.text };
  } catch (err) {
    return { role: 'error', raw: err instanceof Error ? err.message : String(err) };
  }
}

async function classifyAllForVariant(
  cg: Cartograph,
  samples: Sample[],
  variant: Variant,
  rawSamples: string[][],
): Promise<VariantResult> {
  const out: string[] = [];
  const rawForVariant: string[] = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    process.stdout.write(`\r  ${variant}: ${i + 1}/${samples.length}        `);
    const { role, raw } = await classifyOne(cg, s, variant);
    out.push(role);
    rawForVariant.push(raw);
  }
  rawSamples.push(rawForVariant);
  process.stdout.write('\n');
  return { variant, classifications: out };
}

function pct(numerator: number, denominator: number): string {
  if (denominator === 0) return '—';
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function agreement(a: string[], b: string[]): { agree: number; total: number } {
  let agree = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) agree++;
  return { agree, total: a.length };
}

function confusionLines(label: string, a: string[], b: string[]): string[] {
  const pairs = new Map<string, number>();
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) continue;
    const key = `${a[i]} → ${b[i]}`;
    pairs.set(key, (pairs.get(key) ?? 0) + 1);
  }
  if (pairs.size === 0) return [`${label}: 100% agreement, no disagreements.`];
  const sorted = [...pairs.entries()].sort((x, y) => y[1] - x[1]);
  const lines = [`${label}: top disagreements (variantA → variantB):`];
  for (const [pair, count] of sorted.slice(0, 8)) lines.push(`  - ${pair}: ${count}`);
  return lines;
}

function printRawResponses(rawSamples: string[][], samples: Sample[]): void {
  console.log('\n=== Raw LLM responses (first 3 samples per variant) ===');
  const variantNames = ['summary+sig', 'docstring+sig', 'name+kind+sig', 'summary+docstring+sig'];
  for (let v = 0; v < 4; v++) {
    console.log(`\n--- ${variantNames[v]} ---`);
    for (let i = 0; i < Math.min(3, rawSamples[v]!.length); i++) {
      const raw = rawSamples[v]![i]!.replaceAll('\n', String.raw`\n`).slice(0, 200);
      console.log(`  [${i}] (${samples[i]!.name}): "${raw}"`);
    }
  }
}

function printRoleDistribution(samples: Sample[], variants: ReadonlyArray<readonly [string, string[]]>): void {
  console.log('\n=== Role distribution per variant ===');
  for (const [variantName, results] of variants) {
    printDistribution(`  ${variantName}:`, results);
  }
  printDistribution(
    '  baseline:',
    samples.map((s) => s.baselineRole),
  );
}

function printDistribution(prefix: string, values: string[]): void {
  const dist = new Map<string, number>();
  for (const value of values) dist.set(value, (dist.get(value) ?? 0) + 1);
  const sorted = [...dist.entries()].sort((x, y) => y[1] - x[1]);
  const formatted = sorted.map(([k, v]) => `${k}=${v}`).join(', ');
  console.log(`${prefix} ${formatted}`);
}

function printDecisionCriterion(
  ab: { agree: number; total: number },
  ad: { agree: number; total: number },
  aBaseline: { agree: number; total: number },
  dBaseline: { agree: number; total: number },
): void {
  console.log('\n=== Decision criterion (pre-set) ===');
  const abPct = (ab.agree / ab.total) * 100;
  const adPct = (ad.agree / ad.total) * 100;
  const dBaselinePct = (dBaseline.agree / dBaseline.total) * 100;
  const aBaselinePct = (aBaseline.agree / aBaseline.total) * 100;
  if (abPct >= 80) {
    console.log(`A↔B >=80% (${pct(ab.agree, ab.total)}): docstring-only is a VIABLE replacement.`);
  } else if (abPct >= 60) {
    console.log(`A↔B 60-80% (${pct(ab.agree, ab.total)}): marginal — docstring-only is close but not a drop-in.`);
  } else {
    console.log(`A↔B <60% (${pct(ab.agree, ab.total)}): docstring-only loses too much signal.`);
  }
  console.log(`A↔D agreement: ${pct(ad.agree, ad.total)} — does adding docstring NEXT TO summary change outputs?`);
  if (adPct >= 90) {
    console.log('  >=90%: docstring contributes negligible signal beyond summary; pure summary is sufficient.');
  } else if (adPct >= 75) {
    console.log('  75-90%: docstring shifts some classifications when added — partial signal complement.');
  } else {
    console.log('  <75%: docstring substantially changes classifier output — meaningful added signal.');
  }
  if (dBaselinePct > aBaselinePct + 5) {
    console.log(
      `Hybrid D beats summary-only A on baseline agreement by ${(dBaselinePct - aBaselinePct).toFixed(1)} pts — adding docstring HELPS.`,
    );
  } else if (dBaselinePct < aBaselinePct - 5) {
    console.log(
      `Hybrid D LOSES vs summary-only A by ${(aBaselinePct - dBaselinePct).toFixed(1)} pts — adding docstring is NOISE.`,
    );
  } else {
    console.log(`Hybrid D and summary-only A within ±5 pts on baseline agreement — adding docstring is a wash.`);
  }
}

async function main(): Promise<void> {
  console.log(`Eval: role classifier input-feature ablation (N=${N})`);
  console.log(`Project: ${PROJECT_ROOT}`);

  const cg = await Cartograph.open(PROJECT_ROOT);
  try {
    const db = cg.db.getDb();
    const sampleSql = `
      SELECT n.id AS nodeId, n.name, n.kind, n.signature, n.docstring,
             ss.summary, ss.role AS baselineRole
        FROM nodes n
        JOIN symbol_summaries ss ON ss.node_id = n.id
       WHERE n.docstring IS NOT NULL AND n.docstring != ''
         AND ss.summary IS NOT NULL AND ss.summary != ''
         AND ss.role IS NOT NULL AND ss.role != ''
         AND n.kind IN ('function', 'method', 'class', 'interface')
       ORDER BY RANDOM()
       LIMIT ?
    `;
    const samples = db.prepare(sampleSql).all(N) as Sample[];
    if (samples.length === 0) {
      console.error('No samples available. Run `cartograph summarize` and `cartograph classify` first.');
      process.exit(1);
    }
    console.log(`Sampled ${samples.length} nodes (random) with all three input features available.`);
    console.log();

    console.log('Running classifier across four input variants:');
    const rawSamples: string[][] = [];
    const resA = await classifyAllForVariant(cg, samples, 'summary+sig', rawSamples);
    const resB = await classifyAllForVariant(cg, samples, 'docstring+sig', rawSamples);
    const resC = await classifyAllForVariant(cg, samples, 'name+kind+sig', rawSamples);
    const resD = await classifyAllForVariant(cg, samples, 'summary+docstring+sig', rawSamples);

    printRawResponses(rawSamples, samples);
    printRoleDistribution(samples, [
      ['A', resA.classifications],
      ['B', resB.classifications],
      ['C', resC.classifications],
      ['D', resD.classifications],
    ]);

    const baseline = samples.map((s) => s.baselineRole);
    const ab = agreement(resA.classifications, resB.classifications);
    const ac = agreement(resA.classifications, resC.classifications);
    const ad = agreement(resA.classifications, resD.classifications);
    const bd = agreement(resB.classifications, resD.classifications);
    const bc = agreement(resB.classifications, resC.classifications);
    const aBaseline = agreement(resA.classifications, baseline);
    const bBaseline = agreement(resB.classifications, baseline);
    const cBaseline = agreement(resC.classifications, baseline);
    const dBaseline = agreement(resD.classifications, baseline);

    console.log('\n=== Pairwise agreement ===');
    console.log(
      `A (summary+sig)            ↔ B (docstring+sig):           ${ab.agree}/${ab.total} = ${pct(ab.agree, ab.total)}`,
    );
    console.log(
      `A (summary+sig)            ↔ C (name+kind+sig):           ${ac.agree}/${ac.total} = ${pct(ac.agree, ac.total)}`,
    );
    console.log(
      `A (summary+sig)            ↔ D (summary+docstring+sig):   ${ad.agree}/${ad.total} = ${pct(ad.agree, ad.total)}`,
    );
    console.log(
      `B (docstring+sig)          ↔ D (summary+docstring+sig):   ${bd.agree}/${bd.total} = ${pct(bd.agree, bd.total)}`,
    );
    console.log(
      `B (docstring+sig)          ↔ C (name+kind+sig):           ${bc.agree}/${bc.total} = ${pct(bc.agree, bc.total)}`,
    );

    console.log('\n=== Agreement vs persisted baseline (production label on this DB) ===');
    console.log(
      `A (summary+sig)            ↔ baseline: ${aBaseline.agree}/${aBaseline.total} = ${pct(aBaseline.agree, aBaseline.total)}`,
    );
    console.log(
      `B (docstring+sig)          ↔ baseline: ${bBaseline.agree}/${bBaseline.total} = ${pct(bBaseline.agree, bBaseline.total)}`,
    );
    console.log(
      `C (name+kind+sig)          ↔ baseline: ${cBaseline.agree}/${cBaseline.total} = ${pct(cBaseline.agree, cBaseline.total)}`,
    );
    console.log(
      `D (summary+docstring+sig)  ↔ baseline: ${dBaseline.agree}/${dBaseline.total} = ${pct(dBaseline.agree, dBaseline.total)}`,
    );

    console.log('\n=== Confusion (where they disagree) ===');
    for (const line of confusionLines('A vs B', resA.classifications, resB.classifications)) console.log(line);
    console.log();
    for (const line of confusionLines('A vs D', resA.classifications, resD.classifications)) console.log(line);

    printDecisionCriterion(ab, ad, aBaseline, dBaseline);
  } finally {
    cg.close();
  }
}

try {
  await main();
} catch (err) {
  console.error('Eval failed:', err);
  process.exit(1);
}
