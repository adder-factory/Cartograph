/* eslint-disable no-console */
/**
 * Companion to bench-llm-vs-baseline.js: indexes once, then targets a
 * curated set of interesting symbols (instead of iterating
 * file_path order) so the qualitative demo lands on names the user
 * actually searched. Also dumps every summary that was produced for
 * inspection.
 *
 *   node scripts/bench-targeted-summaries.js
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const { default: Cartograph } = require(path.join(PROJECT_ROOT, 'dist', 'index.js'));
const { LlmClient } = require(path.join(PROJECT_ROOT, 'dist', 'llm', 'client.js'));

const TARGETS = [
  // From src/sync/watcher.ts
  { name: 'FileWatcher', kind: 'class' },
  { name: 'shouldDebounce', kind: 'method' },
  // From src/llm
  { name: 'detectLocalLlm', kind: 'function' },
  { name: 'pickChatModel', kind: 'function' },
  { name: 'summarizeAll', kind: 'function' },
  { name: 'isReachable', kind: 'method' },
  { name: 'listModels', kind: 'method' },
  { name: 'contentHashFor', kind: 'function' },
  // From src/index.ts
  { name: 'startBackgroundSummarization', kind: 'method' },
  { name: 'awaitBackgroundSummarization', kind: 'method' },
  { name: 'getEffectiveLlmConfig', kind: 'method' },
  // From src/extraction
  { name: 'hashContent', kind: 'function' },
  // From src/db
  { name: 'searchNodes', kind: 'method' },
  { name: 'getSymbolSummaries', kind: 'method' },
  { name: 'upsertSymbolSummary', kind: 'method' },
  // From src/mcp
  { name: 'formatSearchResults', kind: 'method' },
  { name: 'formatNodeDetails', kind: 'method' },
  { name: 'handleSearch', kind: 'method' },
  // From src/resolution
  { name: 'resolveAndPersist', kind: 'method' },
  // From src/context
  { name: 'buildContext', kind: 'method' },
];

function header(t) {
  console.log('\n' + '='.repeat(80) + '\n  ' + t + '\n' + '='.repeat(80));
}
function fmtMs(ms) {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${((ms % 60000) / 1000).toFixed(0)}s`;
}
function copyRecursive(src, dst) {
  const skip = new Set(['node_modules', '.git', '.cartograph', 'dist', 'coverage']);
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(e.name)) continue;
    const sp = path.join(src, e.name);
    const dp = path.join(dst, e.name);
    if (e.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true });
      copyRecursive(sp, dp);
    } else if (e.isFile()) fs.copyFileSync(sp, dp);
  }
}

async function main() {
  header('Targeted summary bench');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-targeted-'));
  console.log(`  Working copy: ${tmpDir}`);
  copyRecursive(PROJECT_ROOT, tmpDir);

  const cg = await Cartograph.init(tmpDir);
  const t0 = performance.now();
  await cg.indexAll({ summarize: false });
  console.log(`  Indexed in ${fmtMs(performance.now() - t0)}`);

  const llmConfig = await cg.getEffectiveLlmConfig();
  if (!llmConfig) {
    console.log('  No LLM detected');
    cg.close();
    return;
  }
  console.log(`  LLM: ${llmConfig.chatModel} @ ${llmConfig.endpoint}`);

  const client = new LlmClient(llmConfig);

  // Resolve target nodes by (name, kind, prefer src/* path)
  const resolved = [];
  for (const t of TARGETS) {
    const hits = cg.searchNodes(t.name, { limit: 20, kinds: [t.kind] });
    const inSrc = hits.find((h) => h.node.filePath.startsWith('src/') && h.node.name === t.name);
    const exact = inSrc || hits.find((h) => h.node.name === t.name);
    if (exact) resolved.push(exact.node);
    else console.log(`  (no node for ${t.kind} ${t.name})`);
  }
  console.log(`\n  Resolved ${resolved.length}/${TARGETS.length} targets\n`);

  header('Generating summaries (targeted)');
  const tStart = performance.now();
  let generated = 0;
  for (const node of resolved) {
    const symStart = performance.now();
    try {
      // Read body
      const filePath = path.join(tmpDir, node.filePath);
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const body = lines.slice(Math.max(0, node.startLine - 1), node.endLine).join('\n');
      const truncated = body.length > 4000 ? body.slice(0, 4000) + '\n// ... (truncated)' : body;
      const prompt = [
        'You are a senior code reviewer documenting an unfamiliar codebase.',
        '',
        `Write a SINGLE LINE summary (max 200 chars) of what this ${node.kind} does.`,
        'Start with an action verb. No "This function...", no fluff, no markdown. Just the summary.',
        '',
        '```',
        truncated,
        '```',
        '',
        'Summary:',
      ].join('\n');

      const result = await client.chat([{ role: 'user', content: prompt }], {
        temperature: 0,
        maxTokens: 80,
      });
      const summary = (result.text.split('\n')[0] || '').trim();
      const elapsed = performance.now() - symStart;

      // Use the queries layer reflectively via the singleton — test surface
      // exposes upsertSymbolSummary on QueryBuilder, accessed through
      // direct require since we're a bench script.
      // (We just print here; persistence not strictly needed for the demo.)

      generated++;
      console.log(`  [${generated}/${resolved.length}] ${fmtMs(elapsed).padStart(7)}  ${node.name} (${node.kind})`);
      console.log(`           ${node.filePath}:${node.startLine}`);
      console.log(`           ↳ ${summary}`);
    } catch (err) {
      console.log(`  ! ${node.name} failed: ${err.message || err}`);
    }
  }

  const total = performance.now() - tStart;
  header('Done');
  console.log(`  ${generated} summaries in ${fmtMs(total)}`);
  console.log(`  Avg: ${fmtMs(total / Math.max(1, generated))} / symbol`);

  cg.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
  await main();
} catch (err) {
  console.error('failed:', err);
  process.exit(1);
}
