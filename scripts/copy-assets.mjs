#!/usr/bin/env node
/**
 * Post-build asset copy: tsc emits .js files only; this script copies
 * the non-source assets (the SQL schema, viewer static files, and the
 * tree-sitter grammar `.wasm` files) from src/ to dist/ so the
 * published package is self-contained.
 *
 * Was previously a `node -e "..."` inline script in package.json
 * (using `require()`); extracted to a proper ESM file as part of the
 * ESM migration so it doesn't fight `type: module`.
 *
 * Grammar WASM: cartograph parses with web-tree-sitter, which loads
 * grammars from `.wasm` files. `src/extraction/grammars.ts` resolves
 * them via `import.meta.dirname + '/wasm/'` — which is
 * `dist/extraction/wasm/` in a built artifact — so the grammar set
 * must be copied alongside the compiled JS.
 *
 * Tags queries: `TagsQueryExtractor` (`tags-query-extractor.ts`) loads
 * a vendored `tags.scm` per language from `import.meta.dirname +
 * '/tags/'`, same resolution story as the grammar `.wasm` — so the
 * `src/extraction/tags/*.scm` set is copied alongside too.
 */
import { mkdirSync, copyFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

mkdirSync('dist/db', { recursive: true });
copyFileSync('src/db/schema.sql', 'dist/db/schema.sql');
copyFileSync('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'dist/web-tree-sitter.wasm');

// The src/llm/native/ tree was deleted 2026-05-24c when the in-process
// LLM pathway (mini-nllc + libcgshim) was removed in step 4c of the
// migration. Nothing under llm/ needs special asset handling now —
// the HTTP path lives in plain .ts files that tsc emits straight to
// dist/ along with the rest of the source.

mkdirSync('dist/viewer/static', { recursive: true });
for (const f of readdirSync('src/viewer/static')) {
  copyFileSync(join('src/viewer/static', f), join('dist/viewer/static', f));
}

mkdirSync('dist/extraction/wasm', { recursive: true });
for (const f of readdirSync('src/extraction/wasm')) {
  if (!f.endsWith('.wasm')) continue;
  copyFileSync(join('src/extraction/wasm', f), join('dist/extraction/wasm', f));
}

mkdirSync('dist/extraction/tags', { recursive: true });
for (const f of readdirSync('src/extraction/tags')) {
  if (!f.endsWith('.scm')) continue;
  copyFileSync(join('src/extraction/tags', f), join('dist/extraction/tags', f));
}
