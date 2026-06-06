#!/usr/bin/env bun
/**
 * Local acceptance smoke for the recommended llama.cpp path.
 *
 * This intentionally stays out of the default unit suite: it requires
 * `llama-server` plus the recommended minimal GGUFs. When available,
 * it exercises the operator flow end to end against a tiny temporary
 * project:
 *
 *   init -> write recommended config -> backend start -> llm smoke ->
 *   index -> summarize -> embed -> classify -> doctor -> backend stop
 */

import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { buildRecommendedLlmConfig } from '../src/installer/recommended-config.js';

const repoRoot = path.resolve(import.meta.dir, '..');
const cli = path.join(repoRoot, 'src/bin/cartograph.ts');
const required = process.env['CARTOGRAPH_MANAGED_BACKEND_SMOKE_REQUIRED'] === '1';
const modelsDir = process.env['CARTOGRAPH_MODELS_DIR'];
let projectPath = '';

async function main(): Promise<void> {
  if (!(await commandExists('llama-server'))) return skip('llama-server is not on PATH');
  const missing = await missingMinimalModelFiles();
  if (missing.length > 0) return skip(`minimal GGUFs missing: ${missing.join(', ')}`);

  projectPath = await fsp.mkdtemp(path.join(os.tmpdir(), 'cartograph-managed-backend-smoke-'));
  await writeFixtureProject(projectPath);

  try {
    await runCartograph(['admin', 'init', projectPath]);
    await runCartograph([
      'admin',
      'install-models',
      '--minimal',
      '--write-config',
      '--project-path',
      projectPath,
      ...(modelsDir ? ['--dir', modelsDir] : []),
    ]);
    await runCartograph(['backend', 'start', projectPath]);
    await waitForLlmSmoke(projectPath);
    await runCartograph(['admin', 'index', projectPath, '--quiet', '--force', '--parse-workers', '1']);
    await runCartograph(['admin', 'summarize', projectPath, '--quiet', '--limit', '4', '--concurrency', '1']);
    await runCartograph(['admin', 'embed', projectPath, '--quiet', '--concurrency', '1']);
    await runCartograph(['admin', 'classify', projectPath, '--quiet', '--concurrency', '1']);
    await runCartograph(['doctor', projectPath]);
    console.log('managed-backend-e2e-smoke: passed');
  } finally {
    await runCartograph(['backend', 'stop', projectPath, '--force'], { allowFailure: true });
    await fsp.rm(projectPath, { recursive: true, force: true });
  }
}

async function missingMinimalModelFiles(): Promise<string[]> {
  const llm = buildRecommendedLlmConfig({
    ...(modelsDir ? { dir: modelsDir } : {}),
    includeAsk: false,
    includeReranker: false,
  }) as Record<string, { model?: string }>;
  const paths = [llm['embeddingLlm']?.model, llm['summarizeLlm']?.model].filter(
    (model): model is string => typeof model === 'string',
  );
  const missing: string[] = [];
  for (const modelPath of paths) {
    const exists = await fsp
      .access(modelPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) missing.push(modelPath);
  }
  return missing;
}

async function writeFixtureProject(root: string): Promise<void> {
  await fsp.mkdir(path.join(root, 'src'), { recursive: true });
  await fsp.writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'cartograph-managed-backend-smoke', type: 'module' }, null, 2),
    'utf8',
  );
  await fsp.writeFile(
    path.join(root, 'src/math.ts'),
    [
      '/** Adds two numbers for the managed backend smoke fixture. */',
      'export function add(left: number, right: number): number {',
      '  return left + right;',
      '}',
      '',
      '/** Formats a total for display in test output. */',
      'export function formatTotal(total: number): string {',
      '  return `total:${total}`;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  await fsp.writeFile(
    path.join(root, 'src/index.ts'),
    "import { add, formatTotal } from './math.js';\n\nexport const label = formatTotal(add(2, 3));\n",
    'utf8',
  );
}

async function commandExists(command: string): Promise<boolean> {
  const result = await run('sh', ['-lc', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    allowFailure: true,
    quiet: true,
  });
  return result === 0;
}

async function waitForLlmSmoke(projectPath: string): Promise<void> {
  const deadline = Date.now() + 180_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    const status = await runCartograph(['llm', 'smoke', projectPath, '--timeout-ms', '120000', '--json'], {
      allowFailure: true,
      quiet: true,
    });
    if (status === 0) {
      await runCartograph(['llm', 'smoke', projectPath, '--timeout-ms', '120000']);
      return;
    }
    console.log(`managed-backend-e2e-smoke: waiting for LLM readiness (attempt ${attempt})`);
    await sleep(5_000);
  }
  await runCartograph(['llm', 'smoke', projectPath, '--timeout-ms', '120000'], { allowFailure: true });
  throw new Error('LLM smoke did not pass before readiness timeout');
}

async function runCartograph(
  args: readonly string[],
  options: { allowFailure?: boolean; quiet?: boolean } = {},
): Promise<number> {
  return run('bun', [cli, ...args], options);
}

async function run(
  command: string,
  args: readonly string[],
  options: { allowFailure?: boolean; quiet?: boolean } = {},
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: repoRoot,
      stdio: options.quiet ? 'ignore' : 'inherit',
      env: process.env,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      const status = code ?? (signal ? 128 : 1);
      if (status === 0 || options.allowFailure) {
        resolve(status);
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with ${status}`));
    });
  });
}

function skip(reason: string): void {
  const message = `managed-backend-e2e-smoke: skipped (${reason})`;
  if (required) {
    console.error(message);
    process.exit(1);
  }
  console.log(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

await main();
