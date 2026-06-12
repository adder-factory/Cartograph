#!/usr/bin/env node
/**
 * Static guardrail for top-level Vitest mocks of shared source modules.
 *
 * Policy for tests under __tests__:
 * - Prefer vi.spyOn(realModule, ...) when only one export needs control.
 * - If a top-level vi.mock('../src/...') factory is unavoidable, preserve
 *   actual exports via importOriginal / vi.importActual and spread them.
 * - Partial full-module mocks must be intentionally allowlisted here. The
 *   serial module-leak canary then verifies they do not poison later tests.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const testsRoot = path.join(repoRoot, '__tests__');

const ALLOWED_PARTIAL_SOURCE_MOCKS = new Set([
  '__tests__/biomarkers-layering-unit.test.ts::../src/db/queries-files.js',
  '__tests__/cartograph-llm-service-bg.test.ts::../src/cartograph-llm-pass.js',
  '__tests__/cartograph-llm-service-bg.test.ts::../src/llm/client.js',
  '__tests__/cartograph-llm-service-bg.test.ts::../src/llm/embedding-client.js',
  '__tests__/cochange-hook-unit.test.ts::../src/cochange/index.js',
  '__tests__/cochange-hook-unit.test.ts::../src/db/queries-commit-intents.js',
  '__tests__/cochange-hook-unit.test.ts::../src/db/queries-files.js',
  '__tests__/cochange-hook-unit.test.ts::../src/db/queries-history.js',
  '__tests__/cochange-hook-unit.test.ts::../src/db/queries-metadata.js',
  '__tests__/cochange-hook-unit.test.ts::../src/errors.js',
  '__tests__/cochange-hook-unit.test.ts::../src/git-utils.js',
  '__tests__/cochange-hook-unit.test.ts::../src/llm/commit-intent.js',
  '__tests__/dynamic-import-edges-hook.test.ts::../src/index-hooks/edge-resolution-helpers.js',
  '__tests__/re-export-edges-hook.test.ts::../src/index-hooks/edge-resolution-helpers.js',
  '__tests__/value-ref-edges-hook-unit.test.ts::../src/index-hooks/edge-resolution-helpers.js',
  '__tests__/value-ref-edges-hook-unit.test.ts::../src/index-hooks/value-ref-edges-pool.js',
]);

function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

function listTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listTestFiles(abs));
    } else if (entry.isFile() && entry.name.endsWith('.test.ts')) {
      out.push(abs);
    }
  }
  return out;
}

function lineNumberAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function consumeLineComment(state, ch) {
  if (!state.lineComment) return false;
  if (ch === '\n') state.lineComment = false;
  return true;
}

function consumeBlockComment(state, ch, next) {
  if (!state.blockComment) return false;
  if (ch === '*' && next === '/') {
    state.blockComment = false;
    state.skipNext = true;
  }
  return true;
}

function consumeQuotedString(state, ch) {
  if (!state.quote) return false;
  if (state.escaped) {
    state.escaped = false;
  } else if (ch === '\\') {
    state.escaped = true;
  } else if (ch === state.quote) {
    state.quote = null;
  }
  return true;
}

function consumeIgnoredState(state, ch, next) {
  return consumeLineComment(state, ch) || consumeBlockComment(state, ch, next) || consumeQuotedString(state, ch);
}

function enterIgnoredState(state, ch, next) {
  if (ch === '/' && next === '/') {
    state.lineComment = true;
    state.skipNext = true;
    return true;
  }
  if (ch === '/' && next === '*') {
    state.blockComment = true;
    state.skipNext = true;
    return true;
  }
  if (ch === '"' || ch === "'" || ch === '`') {
    state.quote = ch;
    return true;
  }
  return false;
}

function findCallEnd(source, start) {
  const state = { depth: 0, quote: null, escaped: false, lineComment: false, blockComment: false, skipNext: false };
  for (let i = start; i < source.length; i++) {
    if (state.skipNext) {
      state.skipNext = false;
      continue;
    }
    const ch = source[i];
    const next = source[i + 1];
    if (consumeIgnoredState(state, ch, next) || enterIgnoredState(state, ch, next)) continue;
    if (ch === '(') state.depth++;
    if (ch === ')') {
      state.depth--;
      if (state.depth === 0) return i + 1;
    }
  }
  return source.length;
}

function hasActualExportPreservation(mockCall) {
  return (
    /\bimportOriginal\b/.test(mockCall) ||
    /\bvi\.importActual\b/.test(mockCall) ||
    /\.\.\.\s*(actual|real|original|mod|module)\b/.test(mockCall)
  );
}

function isTopLevelSourceMock(spec) {
  return /^(\.\.\/)+src\//.test(spec);
}

/** Value-namespace imports of shared source modules (`import * as x
 *  from '../src/...'`). Bun REBINDS these identifiers to the mock when
 *  the module gets vi.mock'd, so a factory body that references one
 *  calls the mock from inside itself — runtime self-recursion that
 *  only surfaces on some file orderings (the 06-09 → 06-11
 *  module-leak-canary saga). The safe pattern is a value snapshot
 *  taken BEFORE the vi.mock calls (`const REAL_X = { ...x }`) with the
 *  factory referencing only the snapshot. */
function sourceNamespaceImports(source) {
  const ids = [];
  const nsImportRe = /^import \* as (\w+) from ['"]((?:\.\.\/)+src\/[^'"]+)['"]/gm;
  let m;
  while ((m = nsImportRe.exec(source)) !== null) ids.push(m[1]);
  return ids;
}

/** Drop string-literal and comment spans so identifier matching can't
 *  false-positive on prose. Reuses the same state machine findCallEnd
 *  walks with. */
function stripIgnoredSpans(text) {
  const state = { quote: null, escaped: false, lineComment: false, blockComment: false, skipNext: false };
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (state.skipNext) {
      state.skipNext = false;
      continue;
    }
    const ch = text[i];
    const next = text[i + 1];
    if (consumeIgnoredState(state, ch, next) || enterIgnoredState(state, ch, next)) continue;
    out += ch;
  }
  return out;
}

function liveNamespaceRefsInFactory(mockCall, namespaceIds) {
  // Skip the spec argument; scan only the factory body, with strings
  // and comments removed.
  const body = stripIgnoredSpans(mockCall.slice(mockCall.indexOf(',') + 1));
  return namespaceIds.filter((id) => new RegExp(`\\b${id}\\b`).test(body));
}

const failures = [];
const seenAllowed = new Set();
let allowlisted = 0;
let preserved = 0;

for (const file of listTestFiles(testsRoot)) {
  const rel = toPosixPath(path.relative(repoRoot, file));
  const source = fs.readFileSync(file, 'utf8');
  const namespaceIds = sourceNamespaceImports(source);
  const mockStartRe = /^vi\.mock\(\s*(['"])([^'"]+)\1\s*,/gm;
  let match;
  while ((match = mockStartRe.exec(source)) !== null) {
    const spec = match[2];
    const mockCall = source.slice(match.index, findCallEnd(source, match.index));

    // Snapshot rule (every vi.mock factory): no LIVE source-module
    // namespace references inside a factory body.
    const liveRefs = liveNamespaceRefsInFactory(mockCall, namespaceIds);
    if (liveRefs.length > 0) {
      failures.push(
        `${rel}:${lineNumberAt(source, match.index)} vi.mock factory references live namespace import(s) ` +
          `${liveRefs.join(', ')} — bun rebinds these to the mock itself (self-recursion). Take a value ` +
          `snapshot BEFORE the vi.mock call (const REAL_X = { ...${liveRefs[0]} }) and reference the snapshot.`,
      );
    }

    if (!isTopLevelSourceMock(spec)) continue;

    const key = `${rel}::${spec}`;
    if (hasActualExportPreservation(mockCall)) {
      preserved++;
      continue;
    }
    if (ALLOWED_PARTIAL_SOURCE_MOCKS.has(key)) {
      seenAllowed.add(key);
      allowlisted++;
      continue;
    }

    failures.push(
      `${rel}:${lineNumberAt(source, match.index)} mocks ${spec} with a partial top-level factory. ` +
        'Use vi.spyOn, preserve actual exports, or add an intentional allowlist entry.',
    );
  }
}

for (const key of ALLOWED_PARTIAL_SOURCE_MOCKS) {
  if (!seenAllowed.has(key)) failures.push(`stale mock-hygiene allowlist entry: ${key}`);
}

if (failures.length > 0) {
  process.stderr.write(`Mock hygiene check failed:\n- ${failures.join('\n- ')}\n`);
  process.exit(1);
}

console.log(
  `Mock hygiene check passed. ${preserved} source mocks preserve exports; ` +
    `${allowlisted} intentional partial source mocks are guarded by test:leaks.`,
);
