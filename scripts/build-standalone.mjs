#!/usr/bin/env bun
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const target = process.argv[2] ?? currentTarget();
const isWindows = target.startsWith('windows-');
const stageName = `cartograph-${target}`;
const stage = path.join(RELEASE_DIR, stageName);
const binaryName = isWindows ? 'cartograph.exe' : 'cartograph-bin';

rm(stage);
fs.mkdirSync(path.join(stage, 'bin'), { recursive: true });
fs.mkdirSync(path.join(stage, 'lib', 'cartograph'), { recursive: true });
fs.mkdirSync(path.join(stage, 'share', 'cartograph'), { recursive: true });

// re2-wasm's emscripten glue resolves re2.wasm via a baked
// `__dirname`, which under `bun build --compile` is the BUILD
// machine's node_modules path — the binary then fails everywhere that
// path doesn't exist (caught by the Docker tarball smoke). Patch the
// glue for the duration of the compile so it prefers the launcher's
// CARTOGRAPH_ASSET_ROOT (where we ship re2.wasm), and restore the
// original afterwards.
const RE2_GLUE = path.join(ROOT, 'node_modules', 're2-wasm', 'build', 'wasm', 're2.js');
const RE2_DIRNAME_LINE = `scriptDirectory = __dirname + '/';`;
const RE2_ASSET_ROOT_LINE =
  `scriptDirectory = (typeof process !== 'undefined' && process.env && process.env.CARTOGRAPH_ASSET_ROOT)` +
  ` ? process.env.CARTOGRAPH_ASSET_ROOT.replace(/\\/?$/, '/') : __dirname + '/';`;

const re2GlueOriginal = fs.readFileSync(RE2_GLUE, 'utf-8');
if (!re2GlueOriginal.includes(RE2_DIRNAME_LINE)) {
  throw new Error(
    `re2-wasm glue no longer contains the __dirname scriptDirectory line — update the standalone patch in ${import.meta.url}`,
  );
}
fs.writeFileSync(RE2_GLUE, re2GlueOriginal.replace(RE2_DIRNAME_LINE, RE2_ASSET_ROOT_LINE), 'utf-8');
try {
  run('bun', [
    'build',
    '--compile',
    // Explicit per-target compile so cross-builds embed the right bun
    // runtime (plain `--target=bun` always compiled for the HOST, which
    // would ship a host binary under a foreign target's archive name).
    `--target=${bunCompileTarget(target)}`,
    '--outfile',
    path.join(stage, 'lib', 'cartograph', binaryName),
    path.join(ROOT, 'src', 'bin', 'cartograph.ts'),
  ]);
} finally {
  fs.writeFileSync(RE2_GLUE, re2GlueOriginal, 'utf-8');
}

copyFile('src/db/schema.sql', 'share/cartograph/db/schema.sql');
copyFile('node_modules/web-tree-sitter/web-tree-sitter.wasm', 'share/cartograph/web-tree-sitter.wasm');
copyFile('node_modules/re2-wasm/build/wasm/re2.wasm', 'share/cartograph/re2.wasm');
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

function run(cmd, args) {
  const result = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${result.status}`);
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
