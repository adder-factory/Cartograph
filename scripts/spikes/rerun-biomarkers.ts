/**
 * One-off: re-run the biomarker analyser over an already-indexed project.
 * No LLM calls — just reads `nodes` + writes `code_health_findings`.
 *
 * Used when a code change touches biomarker-relevant signal (god_class
 * member counts, large_method LOC, etc.) and you need to validate the
 * findings table without the slow summarize/embed/classify passes that
 * a full `admin index --force` triggers.
 */

import { Cartograph } from '../../src/index.js';
import { analyseProject } from '../../src/biomarkers/index.js';

async function main(): Promise<void> {
  const root = process.argv[2] ?? process.cwd();
  const cg = await Cartograph.open(root);
  try {
    const t0 = Date.now();
    const result = await analyseProject(cg.queries, root);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`biomarkers re-run done in ${elapsed}s`, {
      files: result.filesScanned,
      symbols: result.symbolsAnalysed,
      findings: result.findingsEmitted,
      errors: result.errors,
    });
  } finally {
    cg.close();
  }
}

main().catch((err) => {
  console.error('rerun-biomarkers failed:', err);
  process.exit(1);
});
