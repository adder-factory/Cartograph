#!/usr/bin/env node
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..');
const RELEASE_DIR = path.join(ROOT, 'release');
const IS_WINDOWS = process.platform === 'win32';

const stage = findStage();
const launcher = path.join(stage, 'bin', IS_WINDOWS ? 'cartograph.cmd' : 'cartograph');
if (!fs.existsSync(launcher)) {
  throw new Error(`standalone launcher not found: ${launcher}`);
}

const version = run(launcher, ['--version']).stdout.trim();
if (!version) throw new Error('standalone --version printed no version');
process.stdout.write(`[standalone-smoke] version ${version}\n`);

run(launcher, ['--help']);
process.stdout.write('[standalone-smoke] help ok\n');

const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-standalone-smoke-'));
try {
  run(launcher, ['admin', 'init', tmpProject]);
  const daemon = run(launcher, ['serve', '--mcp', '--daemon', '--project-path', tmpProject, '--no-startup-sync'], {
    input: '',
    env: {
      ...process.env,
      CARTOGRAPH_DAEMON_IDLE_TIMEOUT_MS: '500',
      // The attach line is opt-in since the message gating landed —
      // without this the smoke can never see it, even on success.
      CARTOGRAPH_MCP_LOG_ATTACH: '1',
    },
    timeout: 10_000,
  });
  const daemonOutput = `${daemon.stdout}${daemon.stderr}`;
  if (!daemonOutput.includes('Attached to shared daemon')) {
    throw new Error(`daemon smoke did not attach to shared daemon:\n${daemonOutput}`);
  }
  process.stdout.write('[standalone-smoke] daemon ok\n');
} finally {
  cleanupDaemon(tmpProject);
  fs.rmSync(tmpProject, { recursive: true, force: true });
}

function findStage() {
  const stages = fs
    .readdirSync(RELEASE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith('cartograph-'))
    .map((entry) => path.join(RELEASE_DIR, entry.name));
  if (stages.length !== 1) {
    throw new Error(`expected one standalone stage under release/, found ${stages.length}`);
  }
  return stages[0];
}

function run(command, args, opts = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: IS_WINDOWS,
    ...opts,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} failed with ${result.status}\n${result.stdout ?? ''}${result.stderr ?? ''}`,
    );
  }
  return result;
}

function cleanupDaemon(projectRoot) {
  const pidPath = path.join(projectRoot, '.cartograph', 'daemon.pid');
  try {
    const parsed = JSON.parse(fs.readFileSync(pidPath, 'utf-8'));
    if (typeof parsed.pid === 'number' && parsed.pid > 0) {
      try {
        process.kill(parsed.pid, 'SIGTERM');
      } catch {
        /* already exited */
      }
    }
  } catch {
    /* no daemon lock */
  }
}
