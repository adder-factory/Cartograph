// Smoke test the FIXED QaClient (post 2026-05-10 positional-arg patch).
import { QaClient } from '../../src/llm/qa-client.js';

const qa = new QaClient({ provider: 'local' });

const cases = [
  ['What color is the sky?', 'The sky is blue during the day.'],
  ['Where does the HNSW index live?', 'Cartograph builds a SQLite knowledge graph of every symbol in the workspace. The HNSW approximate-KNN index lives in the .cartograph directory and gives O(log N) similarity queries.'],
  ['What does Cartograph build?', 'Cartograph builds a SQLite knowledge graph of every symbol in the workspace.'],
  ['What language is the codebase?', 'The codebase is written in TypeScript with optional Rust extensions.'],
];

for (const [q, ctx] of cases) {
  const r = await qa.answer(q, ctx);
  console.log(`Q: ${q}`);
  console.log(`   → "${r.answer}" (score=${r.score.toFixed(3)})`);
}
