#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  assertBytesOmitBuildRoots,
  buildRootVariants,
  patchRe2GlueForStandalone,
  patchUsearchForStandalone,
  usearchPrebuildRelativePath,
} from './standalone-build-privacy.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const target = process.argv[2] ?? currentTarget();
const isWindows = target.startsWith('windows-');
const stageName = `cartograph-${target}`;
const stage = path.join(RELEASE_DIR, stageName);
const binaryName = isWindows ? 'cartograph.exe' : 'cartograph-bin';
const compiledBinary = path.join(stage, 'lib', 'cartograph', binaryName);

rm(stage);
fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
fs.mkdirSync(path.join(stage, 'lib', 'cartograph'), { recursive: true });
fs.mkdirSync(path.join(stage, 'share', 'cartograph'), { recursive: true });
const compileRoot = createNeutralCompileRoot();

// Compile from a disposable path outside the checkout so Bun's virtual
// filesystem can keep internally-consistent native-module paths without
// embedding the developer or CI checkout path in the public executable.
// Copying (rather than symlinking) is required because Bun resolves symlinks
// back to the private source path. The mirror also lets us patch re2-wasm
// without mutating the installed dependency used by concurrent test shards.
try {
  prepareCompileMirror();
  const re2Glue = path.join(compileRoot, 'node_modules', 're2-wasm', 'build', 'wasm', 're2.js');
  const re2GlueOriginal = fs.readFileSync(re2Glue, 'utf-8');
  fs.writeFileSync(re2Glue, patchRe2GlueForStandalone(re2GlueOriginal), 'utf-8');
  const usearchLoader = path.join(compileRoot, 'node_modules', 'usearch', 'javascript', 'dist', 'esm', 'usearch.js');
  const usearchLoaderOriginal = fs.readFileSync(usearchLoader, 'utf-8');
  fs.writeFileSync(usearchLoader, patchUsearchForStandalone(usearchLoaderOriginal), 'utf-8');
  run(
    'bun',
    [
      'build',
      '--compile',
      // Explicit per-target compile so cross-builds embed the right bun
      // runtime (plain `--target=bun` always compiled for the HOST, which
      // would ship a host binary under a foreign target's archive name).
      `--target=${bunCompileTarget(target)}`,
      '--outfile',
      compiledBinary,
      path.join(compileRoot, 'src', 'bin', 'cartograph.ts'),
    ],
    compileRoot,
  );
} finally {
  rm(compileRoot);
}
const embeddedBuildRoots = buildRootVariantsForCurrentCheckout();
assertBytesOmitBuildRoots(fs.readFileSync(compiledBinary), embeddedBuildRoots);

copyFile('src/db/schema.sql', 'share/cartograph/db/schema.sql');
copyFile('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'share/cartograph/web-tree-sitter.wasm');
copyFile('node_modules/re2-wasm/build/wasm/re2.wasm', 'share/cartograph/re2.wasm');
copyUsearchPrebuild();
copyDir('src/extraction/wasm', 'share/cartograph/extraction/wasm', (name) => name.endsWith('.wasm'));
copyDir('src/extraction/tags', 'share/cartograph/extraction/tags', (name) => name.endsWith('.scm'));
copyDir('src/features/viewer/static', 'share/cartograph/features/viewer/static');
copyDir('src', 'share/cartograph/algo-sources/src', (name) => name.endsWith('.ts'));
copyFile('package.json', 'share/cartograph/package.json');
copyFile('README.md', 'README.md');
copyFile('docs/AGENT-INSTALL.md', 'AGENT-INSTALL.md');
copyFile('package.json', 'package.json');

if (isWindows) writeWindowsLauncher();
else writePosixLauncher();

archiveStage();

function bunCompileTarget(t) {
  const [os, arch] = t.split('-');
  // darwin/linux x64 use bun's baseline (pre-AVX2) build: the default
  // x64 binaries SIGILL on CPUs/emulators without AVX2 (Rosetta, older
  // Xeons, some VMs). Windows stays on the default build — bun's
  // compile fetcher failed deterministically on the windows baseline
  // asset (CI, 2026-06-11), and AVX2 is effectively universal on the
  // Windows x64 fleet.
  const suffix = arch === 'x64' && os !== 'windows' ? '-baseline' : '';
  return `bun-${os}-${arch}${suffix}`;
}

function currentTarget() {
  // Node reports Windows as `win32` regardless of bitness; the public
  // target/artifact name is `windows-x64` (only 64-bit is supported).
  const osMap = new Map([
    ['darwin', 'darwin'],
    ['linux', 'linux'],
    ['win32', 'windows'],
  ]);
  const archMap = new Map([
    ['x64', 'x64'],
    ['arm64', 'arm64'],
  ]);
  const os = osMap.get(process.platform);
  const arch = archMap.get(process.arch);
  if (!os || !arch) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
  return `${os}-${arch}`;
}

function run(cmd, args, cwd = ROOT) {
  const result = spawnSync(cmd, args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${result.status}`);
}

function buildRootVariantsForCurrentCheckout() {
  return buildRootVariants(ROOT, fs.realpathSync.native(ROOT), process.platform);
}

function createNeutralCompileRoot() {
  const base = process.platform === 'win32' ? path.parse(ROOT).root : '/tmp';
  const uniqueRoot = fs.mkdtempSync(path.join(base, `.cartograph-standalone-${target}-`));
  if (process.platform !== 'win32') fs.chmodSync(uniqueRoot, 0o700);
  return uniqueRoot;
}

function prepareCompileMirror() {
  fs.mkdirSync(compileRoot, { recursive: true });
  for (const relativePath of ['src', 'node_modules']) {
    fs.cpSync(path.join(ROOT, relativePath), path.join(compileRoot, relativePath), {
      recursive: true,
      dereference: true,
    });
  }
  for (const relativePath of ['package.json', 'tsconfig.json']) {
    fs.copyFileSync(path.join(ROOT, relativePath), path.join(compileRoot, relativePath));
  }
}

function copyUsearchPrebuild() {
  const relativePath = usearchPrebuildRelativePath(target);
  if (!relativePath) return;
  const sourcePath = path.join('node_modules', 'usearch', 'prebuilds', relativePath);
  if (!fs.existsSync(path.join(ROOT, sourcePath))) {
    throw new Error(`usearch prebuild is missing for standalone target ${target}`);
  }
  copyFile(sourcePath, path.join('share', 'cartograph', 'usearch', 'prebuilds', relativePath));
}

function rm(filePath) {
  fs.rmSync(filePath, { recursive: true, force: true });
}

function copyFile(fromRel, toRel) {
  const from = path.join(ROOT, fromRel);
  const to = path.join(stage, toRel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(fromRel, toRel, filter = () => true) {
  const from = path.join(ROOT, fromRel);
  const to = path.join(stage, toRel);
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      copyDir(path.join(fromRel, entry.name), path.join(toRel, entry.name), filter);
    } else if (entry.isFile() && filter(entry.name)) {
      copyFile(path.join(fromRel, entry.name), path.join(toRel, entry.name));
    }
  }
}

function writePosixLauncher() {
  const launcher = path.join(stage, 'bin', 'cartograph');
  fs.writeFileSync(
    launcher,
    `#!/bin/sh
SELF="$0"
while [ -L "$SELF" ]; do
  target="$(readlink "$SELF")"
  case "$target" in
    /*) SELF="$target" ;;
    *) SELF="$(dirname "$SELF")/$target" ;;
  esac
done
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
export CARTOGRAPH_ASSET_ROOT="$ROOT/share/cartograph"
exec "$ROOT/lib/cartograph/cartograph-bin" "$@"
`,
    'utf-8',
  );
  fs.chmodSync(launcher, 0o755);
  fs.chmodSync(path.join(stage, 'lib', 'cartograph', binaryName), 0o755);
}

function writeWindowsLauncher() {
  fs.writeFileSync(
    path.join(stage, 'bin', 'cartograph.cmd'),
    `@echo off\r\nset "ROOT=%~dp0.."\r\nset "CARTOGRAPH_ASSET_ROOT=%ROOT%\\share\\cartograph"\r\n"%ROOT%\\lib\\cartograph\\cartograph.exe" %*\r\n`,
    'utf-8',
  );
}

function archiveStage() {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  if (isWindows) {
    const archive = path.join(RELEASE_DIR, `${stageName}.zip`);
    rm(archive);
    run('powershell', [
      '-NoProfile',
      '-Command',
      `Compress-Archive -Path ${JSON.stringify(stage)} -DestinationPath ${JSON.stringify(archive)} -Force`,
    ]);
    return;
  }

  const archive = path.join(RELEASE_DIR, `${stageName}.tar.gz`);
  rm(archive);
  const tarArgs = ['-czf', archive, '-C', RELEASE_DIR, stageName];
  run('tar', tarArgs);
  const size = fs.statSync(archive).size;
  process.stdout.write(`[standalone] wrote ${archive} (${(size / 1024 / 1024).toFixed(1)} MiB)\n`);
}
