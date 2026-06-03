#!/usr/bin/env node
/**
 * Smoke test the current RAG Q&A surface against an indexed project.
 *
 * Usage:
 *   node scripts/spikes/qa-probe.mjs [project-path]
 *
 * Run `npm run build` first; spike scripts use `dist/` to match the
 * production Node runtime path.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const target = path.resolve(process.argv[2] ?? process.cwd());
if (!fs.existsSync(path.join(target, '.cartograph'))) {
  console.error(`qa-probe: ${target} is not initialized. Run \`cartograph setup ${target}\` first.`);
  process.exit(1);
}

const { Cartograph } = await import('../../dist/index.js');
const cg = await Cartograph.open(target, { autoMigrate: true });

const questions = [
  'Where does the HNSW index live?',
  'What does Cartograph build?',
  'How does status report LLM backend reachability?',
];

try {
  for (const question of questions) {
    const result = await cg.llm.ask(question, { retrieveK: 4, maxTokens: 200 });
    console.log(`Q: ${question}`);
    console.log(`   ${result.answer.replace(/\s+/g, ' ').trim()}`);
    console.log(`   citations=${result.citations.length} retrieve=${result.retrieveMs}ms chat=${result.chatMs}ms`);
  }
} finally {
  cg.close();
}
