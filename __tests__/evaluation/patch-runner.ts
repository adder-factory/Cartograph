import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../../src/index.js';
import { PATCH_FIXTURE_FILES } from './fixtures/patch-corpus.js';
import { patchFixtureCases } from './cases-patch-fixture.js';
import { patchSelfCases } from './cases-patch-self.js';
import { comparePatchReports } from './patch-compare.js';
import { runPatchTaskEvaluation } from './patch-evaluator.js';
import {
  PatchRetrievalModeSchema,
  PatchTaskEvalReportSchema,
  type PatchRetrievalMode,
  type PatchTaskCase,
  type PatchTaskEvalReport,
} from './patch-types.js';

interface RunnerArgs {
  codebase: string | null;
  cases: 'fixture' | 'self';
  modes: PatchRetrievalMode[];
  comparePath: string | null;
  outPath: string | null;
}

function parseArgs(argv: string[]): RunnerArgs {
  let codebase: string | null = null;
  let cases: RunnerArgs['cases'] = 'self';
  let modes: PatchRetrievalMode[] = ['deterministic', 'auto', 'hybrid'];
  let comparePath: string | null = null;
  let outPath: string | null = null;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--cases') {
      const value = argv[++index];
      if (value !== 'fixture' && value !== 'self') throw new Error(`--cases must be fixture or self, got ${value}`);
      cases = value;
    } else if (arg === '--modes') {
      const value = argv[++index];
      if (!value) throw new Error('--modes requires a comma-separated value');
      modes = value.split(',').map((mode) => PatchRetrievalModeSchema.parse(mode));
    } else if (arg === '--compare') {
      comparePath = requiredValue(argv[++index], '--compare');
    } else if (arg === '--out') {
      outPath = requiredValue(argv[++index], '--out');
    } else if (arg && !arg.startsWith('-') && codebase === null) {
      codebase = arg;
    } else if (arg) {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { codebase, cases, modes: [...new Set(modes)], comparePath, outPath };
}

function requiredValue(value: string | undefined, flag: string): string {
  if (!value || value.startsWith('-')) throw new Error(`${flag} requires a path`);
  return value;
}

interface EvaluationProject {
  cg: Cartograph;
  cases: PatchTaskCase[];
  cleanup: () => void;
}

async function openEvaluationProject(args: RunnerArgs): Promise<EvaluationProject> {
  if (args.cases === 'fixture') {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-patch-eval-'));
    for (const [relativePath, content] of Object.entries(PATCH_FIXTURE_FILES)) {
      const absolutePath = path.join(projectRoot, relativePath);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, content);
    }
    const cg = await Cartograph.init(projectRoot, { index: true, config: { llm: { endpoint: '' } } });
    return {
      cg,
      cases: patchFixtureCases,
      cleanup: () => {
        cg.close();
        fs.rmSync(projectRoot, { recursive: true, force: true });
      },
    };
  }
  const projectRoot = path.resolve(args.codebase ?? process.cwd());
  if (!Cartograph.isInitialized(projectRoot)) {
    throw new Error(`Cartograph is not initialized at ${projectRoot}`);
  }
  const cg = Cartograph.openSync(projectRoot);
  return { cg, cases: patchSelfCases, cleanup: () => cg.close() };
}

async function evaluate(args: RunnerArgs): Promise<{ report: PatchTaskEvalReport; close: () => void }> {
  const project = await openEvaluationProject(args);
  try {
    const report = await runPatchTaskEvaluation(project.cg, project.cases, { modes: args.modes, topK: 5 });
    return { report, close: project.cleanup };
  } catch (error) {
    project.cleanup();
    throw error;
  }
}

function printReport(report: PatchTaskEvalReport): void {
  process.stdout.write(`\nCartograph patch-task evaluation — top@${report.topK}\n`);
  process.stdout.write(`Codebase: ${report.codebasePath}\nCases: ${report.caseCount}\n\n`);
  for (const result of report.results) {
    const status = result.skipped ? 'SKIP' : result.pass ? 'PASS' : 'FAIL';
    const skip = result.skipped ? ` ${result.skipped}` : '';
    process.stdout.write(
      `${result.mode.padEnd(13)} ${result.caseId.padEnd(36)} ${status} hit=${result.hitAtK.toFixed(0)} mrr=${result.mrr.toFixed(2)} editP=${result.editSitePrecision.toFixed(2)} testR=${result.testSelectionRecall?.toFixed(2) ?? '-'} ${result.latencyMs.toFixed(0)}ms ${result.estimatedTokens}tok${skip}\n`,
    );
  }
  process.stdout.write('\n');
  for (const summary of report.modes) {
    process.stdout.write(
      `${summary.mode}: scored=${summary.scored} skipped=${summary.skipped} hit@k=${summary.meanHitAtK.toFixed(2)} mrr=${summary.meanMrr.toFixed(2)} editP=${summary.meanEditSitePrecision.toFixed(2)} testR=${summary.meanTestSelectionRecall?.toFixed(2) ?? '-'} abstain=${summary.abstentionAccuracy.toFixed(2)} p95=${summary.p95LatencyMs.toFixed(0)}ms payload=${summary.meanEstimatedTokens.toFixed(0)}tok\n`,
    );
  }
}

function reportPath(explicit: string | null): string {
  if (explicit) return path.resolve(explicit);
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, '-');
  return path.join(import.meta.dirname, 'results', `patch-${stamp}.json`);
}

function readReport(filePath: string): PatchTaskEvalReport {
  return PatchTaskEvalReportSchema.parse(JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf8')));
}

function currentSha(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { report, close } = await evaluate(args);
  try {
    printReport(report);
    const out = reportPath(args.outPath);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ ...report, cartographSha: currentSha() }, null, 2));
    process.stdout.write(`\nReport saved: ${out}\n`);

    let failed = report.results.some((result) => !result.pass && !result.skipped);
    if (args.comparePath) {
      const comparison = comparePatchReports(readReport(args.comparePath), report);
      process.stdout.write(
        comparison.withinBudget
          ? 'Baseline comparison: within budget.\n'
          : `Baseline regressions:\n${comparison.regressions.map((regression) => `- ${regression}`).join('\n')}\n`,
      );
      failed ||= !comparison.withinBudget;
    }
    process.exitCode = failed ? 1 : 0;
  } finally {
    close();
  }
}

await main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
