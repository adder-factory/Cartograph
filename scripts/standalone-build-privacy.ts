import { Buffer } from 'node:buffer';

const RE2_DIRNAME_LINE = `scriptDirectory = __dirname + '/';`;
const RE2_ASSET_ROOT_LINE =
  `scriptDirectory = (typeof process !== 'undefined' && process.env && process.env.CARTOGRAPH_ASSET_ROOT)` +
  ` ? process.env.CARTOGRAPH_ASSET_ROOT.replace(/\\/?$/, '/')` +
  ` : (typeof process !== 'undefined' && typeof process.cwd === 'function'` +
  ` ? process.cwd().replace(/\\/?$/, '/') : './');`;
const USEARCH_BINDINGS_IMPORT = 'import { getFileName, getRoot } from "bindings";';
const USEARCH_GET_DIRNAME = [
  'function getDirName() {',
  '    try {',
  '        if (__dirname)',
  '            return __dirname;',
  '    }',
  '    catch (e) { }',
  '    return getRoot(getFileName());',
  '}',
].join('\n');
const USEARCH_ASSET_DIRNAME = [
  'function getDirName() {',
  '    const assetRoot = process.env.CARTOGRAPH_ASSET_ROOT;',
  '    if (assetRoot)',
  '        return path.join(assetRoot, "usearch");',
  '    return process.cwd();',
  '}',
].join('\n');
const USEARCH_NATIVE_INCLUDE_BLOCK = [
  '// dummy code for ncc to include the native module',
  'if (process.uptime() < 0) {',
  '    require(__dirname + "/../../../prebuilds/darwin-arm64+x64/usearch.node");',
  '    require(__dirname + "/../../../prebuilds/linux-arm64/usearch.node");',
  '    require(__dirname + "/../../../prebuilds/linux-x64/usearch.node");',
  '    require(__dirname + "/../../../prebuilds/win32-ia32/usearch.node");',
  '    require(__dirname + "/../../../prebuilds/win32-x64/usearch.node");',
  '    require(__dirname + "/../../../build/Release/usearch.node");',
  '}',
].join('\n');
const USEARCH_PREBUILDS = new Map<string, string>([
  ['darwin-arm64', 'darwin-arm64+x64/usearch.node'],
  ['darwin-x64', 'darwin-arm64+x64/usearch.node'],
  ['linux-arm64', 'linux-arm64/usearch.node'],
  ['linux-x64', 'linux-x64/usearch.node'],
]);

export function patchRe2GlueForStandalone(source: string): string {
  const occurrences = source.split(RE2_DIRNAME_LINE).length - 1;
  if (occurrences !== 1) {
    throw new Error('re2-wasm glue no longer contains the expected scriptDirectory line');
  }

  const patched = source.replace(RE2_DIRNAME_LINE, RE2_ASSET_ROOT_LINE);
  if (patched.includes('__dirname')) {
    throw new Error('re2-wasm glue still contains build-directory metadata after patching');
  }
  return patched;
}

export function patchUsearchForStandalone(source: string): string {
  for (const expected of [USEARCH_BINDINGS_IMPORT, USEARCH_GET_DIRNAME, USEARCH_NATIVE_INCLUDE_BLOCK]) {
    if (source.split(expected).length - 1 !== 1) {
      throw new Error('usearch loader no longer matches the expected standalone patch shape');
    }
  }

  const patched = source
    .replace(USEARCH_BINDINGS_IMPORT, '')
    .replace(USEARCH_GET_DIRNAME, USEARCH_ASSET_DIRNAME)
    .replace(USEARCH_NATIVE_INCLUDE_BLOCK, '');
  if (patched.includes('__dirname') || patched.includes(USEARCH_BINDINGS_IMPORT)) {
    throw new Error('usearch standalone patch still contains build-directory metadata');
  }
  return patched;
}

export function usearchPrebuildRelativePath(target: string): string | null {
  return USEARCH_PREBUILDS.get(target) ?? null;
}

export function buildRootVariants(root: string, realRoot: string, platform: NodeJS.Platform): readonly string[] {
  const variants = new Set<string>();
  for (const candidate of [root, realRoot]) {
    if (candidate.length === 0) continue;
    const forward = candidate.replaceAll('\\', '/');
    const backward = candidate.replaceAll('/', '\\');
    for (const variant of [candidate, forward, backward, backward.replaceAll('\\', '\\\\')]) {
      variants.add(variant);
    }
  }

  if (platform === 'win32') {
    for (const variant of [...variants]) {
      variants.add(variant.toLowerCase());
      variants.add(variant.toUpperCase());
    }
  }

  return [...variants].sort(compareLongestFirst);
}

export function assertBytesOmitBuildRoots(bytes: Uint8Array, buildRoots: readonly string[]): void {
  const binary = Buffer.from(bytes);
  for (const buildRoot of uniqueNonEmptyRoots(buildRoots)) {
    if (binary.includes(Buffer.from(buildRoot, 'utf8'))) {
      throw new Error('compiled binary embeds a build-root variant');
    }
  }
}

function uniqueNonEmptyRoots(buildRoots: readonly string[]): readonly string[] {
  return [...new Set(buildRoots.filter((root) => root.length > 0))].sort(compareLongestFirst);
}

function compareLongestFirst(left: string, right: string): number {
  const lengthDelta = Buffer.byteLength(right, 'utf8') - Buffer.byteLength(left, 'utf8');
  if (lengthDelta !== 0) return lengthDelta;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
