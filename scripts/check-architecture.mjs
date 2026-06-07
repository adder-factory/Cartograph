#!/usr/bin/env node
/**
 * Architecture guardrail.
 *
 * This is intentionally static and conservative. It enforces ownership rules
 * that are cheap to verify and expensive to recover from once drift lands:
 * feature/runtime code should not depend on adapters, framework resolvers need
 * language gates, indexing discovery policy stays in its owner module, and the
 * largest legacy pressure files cannot grow quietly.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SKIP_DIRS = new Set(['.git', '.cartograph', 'node_modules', 'dist', 'build', 'coverage', 'release']);

const CENTRAL_FILE_BUDGETS = new Map([
  ['src/extraction/index.ts', 1400],
  ['src/resolution/name-matcher.ts', 1450],
  ['src/mcp/tools.ts', 1000],
  ['src/db/queries-search.ts', 2100],
  ['src/context/index.ts', 950],
  ['src/bin/_cli-core.ts', 980],
  ['src/db/queries.ts', 1030],
]);

const ALLOWED_SHARED_DIRS = new Set(['src/features/shared']);
const FORBIDDEN_BROAD_BUCKET_DIRS = new Set(['common', 'misc', 'shared']);

const EXTRACTION_POLICY_FUNCTIONS = [
  'findEmbeddedGitRepositories',
  'collectEmbeddedRepoFilesInto',
  'collectSubmoduleFilesInto',
  'findCartographIgnoredDirs',
  'isUnderCartographIgnoredDir',
  'hasCartographIgnoreMarker',
];

function normalizeRel(value) {
  return value.split(path.sep).join('/');
}

function readText(rootDir, relPath) {
  return fs.readFileSync(path.join(rootDir, relPath), 'utf8');
}

function readJson(rootDir, relPath) {
  return JSON.parse(readText(rootDir, relPath));
}

function exists(rootDir, relPath) {
  return fs.existsSync(path.join(rootDir, relPath));
}

function listFiles(rootDir, relDir = '') {
  const absDir = path.join(rootDir, relDir);
  if (!fs.existsSync(absDir)) return [];

  const files = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
    const relPath = normalizeRel(path.join(relDir, entry.name));
    if (entry.isDirectory()) files.push(...listFiles(rootDir, relPath));
    else files.push(relPath);
  }
  return files;
}

function listDirs(rootDir, relDir = '') {
  const absDir = path.join(rootDir, relDir);
  if (!fs.existsSync(absDir)) return [];

  const dirs = [];
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
    const relPath = normalizeRel(path.join(relDir, entry.name));
    dirs.push(relPath, ...listDirs(rootDir, relPath));
  }
  return dirs;
}

function lineCount(text) {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

function stripKnownTsRuntimeExtension(relPath) {
  return relPath.replace(/\.(?:js|mjs|cjs)$/, '.ts');
}

function resolveImport(sourceRel, specifier) {
  if (!specifier.startsWith('.')) return null;
  const resolved = normalizeRel(path.normalize(path.join(path.dirname(sourceRel), specifier)));
  return stripKnownTsRuntimeExtension(resolved);
}

function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) specs.push(match[1]);
    }
  }
  return specs;
}

function isFeatureRuntimeFile(relPath) {
  return /^src\/features\/[^/]+\/(?:contract|runtime|render|format)(?:\.ts|\/)/.test(relPath);
}

function isFeatureCliTarget(relPath) {
  return /^src\/features\/[^/]+\/cli(?:\.ts|\/)/.test(relPath);
}

function checkPackageScripts(rootDir, failures) {
  const pkg = readJson(rootDir, 'package.json');
  const scripts = pkg.scripts ?? {};
  if (typeof scripts['check:architecture'] !== 'string') {
    failures.push('package.json must expose `check:architecture`.');
  }
  if (typeof scripts.check !== 'string' || !scripts.check.includes('check:architecture')) {
    failures.push('package.json `check` must run `check:architecture` before the normal lint/format gate.');
  }
}

function checkCiWorkflow(rootDir, failures) {
  const workflowPath = '.github/workflows/check.yml';
  if (!exists(rootDir, workflowPath)) return;
  const workflow = readText(rootDir, workflowPath);
  if (!/(npm|bun)\s+run\s+check\b/.test(workflow)) {
    failures.push(`${workflowPath} must run the package \`check\` script so architecture checks stay in CI.`);
  }
}

function checkArchitectureDocs(rootDir, failures) {
  const doc = readText(rootDir, 'docs/ARCHITECTURE.md');
  for (const required of ['check:architecture', 'scripts/check-architecture.mjs', 'file-discovery-policy.ts']) {
    if (!doc.includes(required)) failures.push(`docs/ARCHITECTURE.md must mention \`${required}\`.`);
  }
}

function checkForbiddenBroadBuckets(rootDir, failures) {
  for (const relPath of listDirs(rootDir, 'src')) {
    const name = path.posix.basename(relPath);
    if (!FORBIDDEN_BROAD_BUCKET_DIRS.has(name)) continue;
    if (ALLOWED_SHARED_DIRS.has(relPath)) continue;
    failures.push(`forbidden broad bucket directory: ${relPath}. Use a feature-owned slice instead.`);
  }
}

function checkCentralFileBudgets(rootDir, failures) {
  for (const [relPath, maxLines] of CENTRAL_FILE_BUDGETS) {
    if (!exists(rootDir, relPath)) {
      failures.push(`central pressure file is missing: ${relPath}`);
      continue;
    }
    const count = lineCount(readText(rootDir, relPath));
    if (count > maxLines) {
      failures.push(`${relPath} has ${count} lines; budget is ${maxLines}. Move behavior into a feature slice.`);
    }
  }
}

function checkAdapterBoundaries(rootDir, failures) {
  for (const relPath of listFiles(rootDir, 'src').filter((file) => /\.(?:ts|tsx)$/.test(file))) {
    const source = readText(rootDir, relPath);
    for (const specifier of importSpecifiers(source)) {
      const target = resolveImport(relPath, specifier);
      if (!target) continue;

      if (relPath.startsWith('src/mcp/') && (target.startsWith('src/bin/') || isFeatureCliTarget(target))) {
        failures.push(`${relPath} imports CLI adapter ${target}; MCP adapters must call feature runtimes/contracts.`);
      }

      if (isFeatureRuntimeFile(relPath) && (target.startsWith('src/mcp/') || target.startsWith('src/bin/'))) {
        failures.push(`${relPath} imports adapter ${target}; feature runtimes/contracts must stay adapter-free.`);
      }

      if (
        (relPath.startsWith('src/extraction/') || relPath.startsWith('src/resolution/')) &&
        target.startsWith('src/mcp/')
      ) {
        failures.push(`${relPath} imports MCP adapter ${target}; extraction/resolution must stay platform-core.`);
      }
    }
  }
}

function resolverObjects(source) {
  const objects = [];
  const pattern = /export\s+const\s+([A-Za-z0-9_]+)\s*:\s*FrameworkResolver\s*=\s*\{/g;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const end = source.indexOf('\n};', start);
    objects.push({
      name: match[1],
      source: end === -1 ? source.slice(start) : source.slice(start, end),
    });
  }
  return objects;
}

function checkFrameworkResolvers(rootDir, failures) {
  const index = readText(rootDir, 'src/resolution/frameworks/index.ts');
  const files = listFiles(rootDir, 'src/resolution/frameworks').filter(
    (file) => file.endsWith('.ts') && file !== 'src/resolution/frameworks/index.ts',
  );

  for (const relPath of files) {
    const source = readText(rootDir, relPath);
    for (const resolver of resolverObjects(source)) {
      if (!/\blanguages\s*:/.test(resolver.source)) {
        failures.push(`${relPath} ${resolver.name} must declare \`languages\` to prevent cross-language regex drift.`);
      }
      if (!index.includes(resolver.name)) {
        failures.push(`${relPath} ${resolver.name} must be registered in src/resolution/frameworks/index.ts.`);
      }
    }
  }
}

function checkExtractionPolicyOwnership(rootDir, failures) {
  const relPath = 'src/extraction/index.ts';
  const source = readText(rootDir, relPath);
  if (!source.includes("from './file-discovery-policy.js'")) {
    failures.push(`${relPath} must consume file-discovery-policy.ts for repository discovery decisions.`);
  }

  for (const name of EXTRACTION_POLICY_FUNCTIONS) {
    const definitionPattern = new RegExp(`\\b(?:function|const)\\s+${name}\\b`);
    if (definitionPattern.test(source)) {
      failures.push(`${relPath} defines ${name}; repository discovery policy belongs in file-discovery-policy.ts.`);
    }
  }
}

export function runArchitectureCheck(rootDir = repoRoot) {
  const failures = [];
  checkPackageScripts(rootDir, failures);
  checkCiWorkflow(rootDir, failures);
  checkArchitectureDocs(rootDir, failures);
  checkForbiddenBroadBuckets(rootDir, failures);
  checkCentralFileBudgets(rootDir, failures);
  checkAdapterBoundaries(rootDir, failures);
  checkFrameworkResolvers(rootDir, failures);
  checkExtractionPolicyOwnership(rootDir, failures);
  return { ok: failures.length === 0, failures };
}

function parseRootArg(argv) {
  const idx = argv.indexOf('--root');
  if (idx === -1) return repoRoot;
  const value = argv[idx + 1];
  if (!value) {
    process.stderr.write('architecture-gate: --root requires a path\n');
    process.exit(2);
  }
  return path.resolve(value);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = runArchitectureCheck(parseRootArg(process.argv.slice(2)));
  if (!result.ok) {
    process.stderr.write(`architecture-gate FAILED:\n- ${result.failures.join('\n- ')}\n`);
    process.exit(1);
  }
  console.log('architecture-gate OK.');
}
