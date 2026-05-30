/* eslint-disable */
/**
 * End-to-end demo of every LLM feature shipped in this PR.
 *
 *   node scripts/demo-all-features.js [--summary-cap-s=120]
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { performance } = require('perf_hooks');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const { default: Cartograph } = require(path.join(PROJECT_ROOT, 'dist', 'index.js'));
const { LlmClient } = require(path.join(PROJECT_ROOT, 'dist', 'llm', 'client.js'));
const { embedAllNodes } = require(path.join(PROJECT_ROOT, 'dist', 'llm', 'embeddings.js'));
const { summarizeAllDirectories } = require(path.join(PROJECT_ROOT, 'dist', 'llm', 'dir-summarizer.js'));
const { classifyAllRoles } = require(path.join(PROJECT_ROOT, 'dist', 'llm', 'classifier.js'));

const CAP = Number((process.argv.find((a) => a.startsWith('--summary-cap-s=')) || '').split('=')[1] || '120');

function header(t) {
  console.log('\n' + '='.repeat(78) + '\n  ' + t + '\n' + '='.repeat(78));
}
function sub(t) {
  console.log('\n' + '-'.repeat(60) + '\n  ' + t + '\n' + '-'.repeat(60));
}
function fmt(ms) {
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
  header(`Demo: every LLM feature from PR #111 (cap ${CAP}s on the slow phase)`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-demo-'));
  console.log(`  Working copy: ${tmpDir}`);
  copyRecursive(PROJECT_ROOT, tmpDir);

  // -------------------------------------------------------------------
  // Phase 0: index + auto-detect
  // -------------------------------------------------------------------
  header('Phase 0: index + LLM auto-detection');
  const cg = await Cartograph.init(tmpDir);
  const t0 = performance.now();
  const idx = await cg.indexAll({ summarize: false });
  console.log(
    `  Indexed ${idx.filesIndexed} files (${cg.getStats().nodeCount} nodes, ${cg.getStats().edgeCount} edges) in ${fmt(performance.now() - t0)}`,
  );

  const llm = await cg.getEffectiveLlmConfig();
  if (!llm) {
    console.log('\n  No local LLM detected. Demo would now fall through to the agent-bridge path.');
    cg.close();
    return;
  }
  console.log(`\n  Auto-detected:`);
  console.log(`    Endpoint:    ${llm.endpoint}`);
  console.log(`    Chat model:  ${llm.chatModel}`);
  console.log(`    Embed model: ${llm.embeddingModel || '(none)'}`);

  const client = new LlmClient(llm);

  // -------------------------------------------------------------------
  // Phase 1: summary pass with hard cap
  // -------------------------------------------------------------------
  header(`Phase 1: symbol summaries (cap ${CAP}s)`);
  const ctrl = new AbortController();
  const cap = setTimeout(() => {
    console.log(`\n  ⏱  Cap reached, aborting...`);
    ctrl.abort();
  }, CAP * 1000);
  let lastReport = 0,
    lastDone = 0;
  const sumStart = performance.now();
  let sumResult = null;
  try {
    sumResult = await cg.summarizeAll({
      signal: ctrl.signal,
      concurrency: 2,
      onProgress: (done, total) => {
        const now = performance.now();
        if (now - lastReport >= 8000 || done === total) {
          const elapsed = (now - sumStart) / 1000;
          console.log(
            `  ${done}/${total}   ${(done / elapsed).toFixed(2)}/s   +${done - lastDone} since last tick   ${fmt(elapsed * 1000)}`,
          );
          lastReport = now;
          lastDone = done;
        }
      },
    });
  } catch (e) {
    console.log(`  summarizeAll: ${e.message}`);
  } finally {
    clearTimeout(cap);
  }
  if (sumResult) {
    console.log(
      `  → generated=${sumResult.generated} cacheHits=${sumResult.cacheHits} errors=${sumResult.errors} in ${fmt(performance.now() - sumStart)}`,
    );
  }
  const cov = cg.getSummaryCoverage();
  console.log(
    `  Coverage: ${cov.summarised}/${cov.total} (${cov.total ? Math.round((cov.summarised / cov.total) * 100) : 0}%)`,
  );

  // -------------------------------------------------------------------
  // Phase 2: embed the summaries we have
  // -------------------------------------------------------------------
  if (llm.embeddingModel) {
    header('Phase 2: embeddings');
    const eStart = performance.now();
    const eRes = await embedAllNodes({
      queries: cg.queries || cg['queries'],
      client,
      embeddingModel: llm.embeddingModel,
      options: { concurrency: 2 },
    });
    console.log(`  Embedded ${eRes.generated} nodes in ${fmt(performance.now() - eStart)} (errors: ${eRes.errors})`);
  }

  // -------------------------------------------------------------------
  // Phase 3: directory summaries
  // -------------------------------------------------------------------
  header('Phase 3: directory summaries');
  const dStart = performance.now();
  const dRes = await summarizeAllDirectories(cg.queries || cg['queries'], client, llm.chatModel, { concurrency: 1 });
  console.log(
    `  Generated ${dRes.generated} directory paragraphs (cache hits: ${dRes.cacheHits}) in ${fmt(performance.now() - dStart)}`,
  );

  // -------------------------------------------------------------------
  // Phase 4: role classification (capped to first 30 symbols for time)
  // -------------------------------------------------------------------
  header('Phase 4: role classification');
  const cStart = performance.now();
  const classifierCtrl = new AbortController();
  const classifierCap = setTimeout(() => classifierCtrl.abort(), 60_000);
  const cRes = await classifyAllRoles(cg.queries || cg['queries'], client, llm.chatModel, {
    concurrency: 3,
    signal: classifierCtrl.signal,
  });
  clearTimeout(classifierCap);
  console.log(
    `  Classified ${cRes.classified}/${cRes.candidates} symbols in ${fmt(performance.now() - cStart)} (errors: ${cRes.errors})`,
  );
  const roleCounts = cg.getRoleCounts();
  console.log(`  Role distribution:`);
  for (const [role, n] of [...roleCounts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${role.padEnd(18)} ${n}`);
  }

  // ====================================================================
  // FEATURE DEMOS
  // ====================================================================

  // -------------------------------------------------------------------
  // Demo 1: hybrid search vs FTS
  // -------------------------------------------------------------------
  header('Demo 1 — Hybrid search (FTS + semantic) vs FTS-only');
  for (const q of ['file watcher debounce', 'detect ollama']) {
    sub(`Q: "${q}"`);
    const fts = cg.searchNodes(q, { limit: 3 });
    console.log(`  FTS-only:`);
    for (const r of fts) console.log(`    • ${r.node.name} (${r.node.kind}) ${r.node.filePath}:${r.node.startLine}`);
    const hybrid = await cg.searchHybrid(q, { limit: 3 });
    const summaries = cg.getSymbolSummaries(hybrid.map((r) => r.node.id));
    console.log(`  Hybrid:`);
    for (const r of hybrid) {
      console.log(`    • ${r.node.name} (${r.node.kind}) ${r.node.filePath}:${r.node.startLine}`);
      const s = summaries.get(r.node.id);
      if (s) console.log(`      ↳ ${s}`);
    }
  }

  // -------------------------------------------------------------------
  // Demo 2: ask
  // -------------------------------------------------------------------
  header('Demo 2 — cartograph_ask (RAG Q&A)');
  const questions = [
    'How does the LLM auto-detection pick which chat model to use?',
    'What does the FileWatcher do, and how does it decide when to sync?',
  ];
  for (const q of questions) {
    sub(`Q: ${q}`);
    try {
      const a = await cg.ask(q, { retrieveK: 8 });
      console.log(`  Answer (retrieve ${a.retrieveMs}ms, chat ${a.chatMs}ms):\n`);
      console.log(
        a.answer
          .split('\n')
          .map((l) => '    ' + l)
          .join('\n'),
      );
      console.log(`\n  Sources:`);
      for (const c of a.citations.slice(0, 5)) {
        console.log(`    • ${c.node.name} ${c.node.filePath}:${c.node.startLine}`);
      }
    } catch (e) {
      console.log(`  ask failed: ${e.message}`);
    }
  }

  // -------------------------------------------------------------------
  // Demo 3: module summaries
  // -------------------------------------------------------------------
  header('Demo 3 — cartograph_module (directory summaries)');
  const allDirs = cg.getAllDirectorySummaries();
  if (allDirs.length === 0) {
    console.log('  (no directory summaries yet)');
  } else {
    for (const { dirPath, summary } of allDirs.slice(0, 6)) {
      sub(dirPath);
      console.log(
        '  ' +
          summary
            .split('\n')
            .map((l) => l)
            .join('\n  '),
      );
    }
  }

  // -------------------------------------------------------------------
  // Demo 4: role filtering
  // -------------------------------------------------------------------
  header('Demo 4 — cartograph_role (filter by LLM-assigned role)');
  for (const role of ['data_model', 'business_logic', 'util']) {
    sub(`role = ${role}`);
    const nodes = cg.findNodesByRole(role, 8);
    if (nodes.length === 0) {
      console.log('  (none)');
      continue;
    }
    const sums = cg.getSymbolSummaries(nodes.map((n) => n.id));
    for (const n of nodes) {
      console.log(`    • ${n.name} (${n.kind}) ${n.filePath}:${n.startLine}`);
      const s = sums.get(n.id);
      if (s) console.log(`      ↳ ${s}`);
    }
  }

  // -------------------------------------------------------------------
  // Demo 5: cross-language similar
  // -------------------------------------------------------------------
  header('Demo 5 — cartograph_similar (semantic neighbors)');
  // Pick a well-known symbol with a summary
  const summarizedNodes = cg.searchNodes('summarize', { limit: 5 });
  const seed = summarizedNodes.find((r) => cg.getSymbolSummaries([r.node.id]).get(r.node.id));
  if (!seed) {
    console.log('  (no summarised seed node found yet)');
  } else {
    sub(`Seed: ${seed.node.name} ${seed.node.filePath}:${seed.node.startLine}`);
    const similar = await cg.findSimilar(seed.node.id, { limit: 5 });
    const sums = cg.getSymbolSummaries(similar.map((r) => r.node.id));
    for (const r of similar) {
      console.log(
        `    [${r.score.toFixed(3)}] ${r.node.name} (${r.node.language}) ${r.node.filePath}:${r.node.startLine}`,
      );
      const s = sums.get(r.node.id);
      if (s) console.log(`        ↳ ${s}`);
    }
  }

  // -------------------------------------------------------------------
  // Demo 6: dead code judge (capped tiny)
  // -------------------------------------------------------------------
  header('Demo 6 — cartograph_dead_code (graph filter + LLM judge)');
  try {
    const dead = await cg.findDeadCodeCandidates({ maxCandidates: 5 });
    console.log(`  Judged ${dead.judged}/${dead.candidates} candidates in ${fmt(dead.durationMs)}`);
    for (const r of dead.results) {
      console.log(
        `    [${r.verdict.toUpperCase()} ${(r.confidence * 100).toFixed(0)}%] ${r.node.name} ${r.node.filePath}:${r.node.startLine}`,
      );
      if (r.reason) console.log(`        ↳ ${r.reason}`);
    }
  } catch (e) {
    console.log(`  dead-code failed: ${e.message}`);
  }

  // -------------------------------------------------------------------
  // Demo 7: change-intent
  // -------------------------------------------------------------------
  header('Demo 7 — summarizeChange (PR-review intent helper)');
  const before = `function add(a, b) {
  return a + b;
}`;
  const after = `function add(a, b) {
  if (typeof a !== 'number' || typeof b !== 'number') {
    throw new TypeError('add requires numbers');
  }
  return a + b;
}`;
  try {
    const ci = await cg.summarizeChange('add', 'function', before, after);
    console.log(`  add (modified):\n    ↳ ${ci.intent}`);

    const added = await cg.summarizeChange('multiply', 'function', '', 'function multiply(a, b) { return a * b; }');
    console.log(`  multiply (added):\n    ↳ ${added.intent}`);
  } catch (e) {
    console.log(`  change-intent failed: ${e.message}`);
  }

  // -------------------------------------------------------------------
  // Demo 8: naming drift
  // -------------------------------------------------------------------
  header('Demo 8 — checkNamingDrift (advisory)');
  const probes = [
    { name: 'getUserById', kind: 'function' },
    { name: 'do_thing', kind: 'function' }, // snake_case in a camelCase codebase
    { name: 'XMLParser', kind: 'class' },
  ];
  for (const p of probes) {
    try {
      const v = await cg.checkNamingDrift({ ...p, filePath: 'src/probe.ts' });
      const tag = v.consistent ? 'OK' : 'DRIFT';
      console.log(`  [${tag}] ${p.name} (${p.kind})`);
      if (!v.consistent && v.suggestion) console.log(`        suggestion: ${v.suggestion}`);
      if (v.reason) console.log(`        reason: ${v.reason}`);
    } catch (e) {
      console.log(`  naming-drift failed: ${e.message}`);
    }
  }

  // -------------------------------------------------------------------
  // Demo 9: agent-as-LLM bridge (works WITHOUT a local LLM)
  // -------------------------------------------------------------------
  header('Demo 9 — agent-as-LLM bridge (no local LLM required)');
  const batch = cg.pendingSummariesBatch({ limit: 3, modelHint: 'demo-agent' });
  console.log(
    `  pendingSummariesBatch returned ${batch.items.length} items (${batch.remaining} remaining of ${batch.total})`,
  );
  if (batch.items.length > 0) {
    for (const it of batch.items) {
      console.log(
        `    - ${it.name} (${it.kind}) ${it.filePath}:${it.startLine} contentHash=${it.contentHash.slice(0, 8)}…`,
      );
    }
    // Pretend the agent answered each one
    const fake = batch.items.map((it) => ({
      nodeId: it.nodeId,
      contentHash: it.contentHash,
      summary: `Demo summary written by the calling agent for ${it.name}.`,
    }));
    const saved = cg.saveAgentSummaries(fake, 'demo-agent');
    console.log(`  saveAgentSummaries → saved=${saved.saved} skipped=${saved.skipped}`);

    // Show that re-issuing the batch with the same modelHint short-circuits
    const batch2 = cg.pendingSummariesBatch({ limit: 3, modelHint: 'demo-agent' });
    const overlap = batch2.items.filter((b) => batch.items.some((a) => a.nodeId === b.nodeId));
    console.log(`  Re-issued batch overlap with first batch: ${overlap.length} (expect 0 — cache short-circuit)`);
  }

  // -------------------------------------------------------------------
  // Final coverage snapshot
  // -------------------------------------------------------------------
  header('Final state');
  const finalCov = cg.getSummaryCoverage();
  console.log(
    `  Symbol summaries: ${finalCov.summarised}/${finalCov.total} (${finalCov.total ? Math.round((finalCov.summarised / finalCov.total) * 100) : 0}%)`,
  );
  console.log(`  Directory summaries: ${cg.getAllDirectorySummaries().length}`);
  console.log(`  Role-classified symbols: ${[...cg.getRoleCounts().values()].reduce((a, b) => a + b, 0)}`);

  cg.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error('Demo failed:', err);
  process.exit(1);
});
