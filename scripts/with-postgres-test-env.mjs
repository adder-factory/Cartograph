#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_IMAGE = 'pgvector/pgvector:pg18';
const POSTGRES_USER = 'cartograph';
const POSTGRES_PASSWORD = 'cartograph';
const POSTGRES_DB = 'cartograph';
const READY_ATTEMPTS = 90;
const READY_SLEEP_MS = 1000;

export async function runWithPostgresTestEnv(command, args = [], options = {}) {
  if (!command) throw new Error('with-postgres-test-env: command is required');

  const prepared = await preparePostgresTestEnv(options.env ?? process.env);

  try {
    return await runInherited(command, args, prepared.env);
  } finally {
    if (prepared.containerName) stopPostgresContainer(prepared.containerName);
  }
}

async function preparePostgresTestEnv(baseEnv) {
  const env = { ...baseEnv };
  if (env.CARTOGRAPH_TEST_POSTGRES_URL) {
    env.CARTOGRAPH_TEST_PGVECTOR_URL ||= env.CARTOGRAPH_TEST_POSTGRES_URL;
    return { env };
  }

  if (env.CARTOGRAPH_TEST_POSTGRES_OPTIONAL === '1' && env.CARTOGRAPH_TEST_POSTGRES_AUTOSTART === '0') {
    writeStderr('with-postgres-test-env: no CARTOGRAPH_TEST_POSTGRES_URL; optional mode will allow skips.');
    return { env };
  }
  if (env.CARTOGRAPH_TEST_POSTGRES_AUTOSTART === '0') {
    throw new Error('CARTOGRAPH_TEST_POSTGRES_URL is required when CARTOGRAPH_TEST_POSTGRES_AUTOSTART=0.');
  }
  if (!(await commandExists('docker'))) {
    if (env.CARTOGRAPH_TEST_POSTGRES_OPTIONAL === '1') {
      writeStderr('with-postgres-test-env: docker is unavailable; optional mode will allow skips.');
      return { env };
    }
    throw new Error('docker is required to auto-start PostgreSQL tests when CARTOGRAPH_TEST_POSTGRES_URL is unset.');
  }

  const started = await startPostgresContainer(env);
  env.CARTOGRAPH_TEST_POSTGRES_URL = started.url;
  env.CARTOGRAPH_TEST_PGVECTOR_URL ||= started.url;
  return { env, containerName: started.containerName };
}

async function startPostgresContainer(env) {
  const image = env.CARTOGRAPH_TEST_POSTGRES_IMAGE || DEFAULT_IMAGE;
  const port = await findFreePort();
  const containerName = `cartograph-test-postgres-${process.pid}-${Date.now()}`;
  const args = [
    'run',
    '--rm',
    '-d',
    '--name',
    containerName,
    '-e',
    `POSTGRES_USER=${POSTGRES_USER}`,
    '-e',
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    '-e',
    `POSTGRES_DB=${POSTGRES_DB}`,
    '-p',
    `${port}:5432`,
    image,
  ];

  writeStderr(`with-postgres-test-env: starting ${image} on localhost:${port}`);
  const result = await runCaptured('docker', args);
  if (result.status !== 0) {
    throw new Error(`docker ${args.join(' ')} failed:\n${result.stderr || result.stdout || '(no output)'}`);
  }

  await waitForPostgres(containerName);
  return {
    containerName,
    url: `postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@localhost:${port}/${POSTGRES_DB}`,
  };
}

async function waitForPostgres(containerName) {
  let lastOutput = '';
  for (let attempt = 1; attempt <= READY_ATTEMPTS; attempt++) {
    const result = await runCaptured('docker', [
      'exec',
      containerName,
      'pg_isready',
      '-U',
      POSTGRES_USER,
      '-d',
      POSTGRES_DB,
    ]);
    if (result.status === 0) return;
    lastOutput = `${result.stdout}${result.stderr}`.trim();
    await sleep(READY_SLEEP_MS);
  }

  const logs = await runCaptured('docker', ['logs', containerName]);
  throw new Error(
    [
      `PostgreSQL test container did not become ready after ${READY_ATTEMPTS}s.`,
      lastOutput ? `Last readiness output:\n${lastOutput}` : '',
      logs.stdout || logs.stderr ? `Container logs:\n${logs.stdout}${logs.stderr}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  );
}

function stopPostgresContainer(containerName) {
  spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
}

async function commandExists(command) {
  const result = await runCaptured('sh', ['-c', `command -v ${shellQuote(command)} >/dev/null 2>&1`]);
  return result.status === 0;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, 'localhost', () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address?.port) resolve(address.port);
        else reject(new Error('Could not allocate a localhost port for PostgreSQL tests.'));
      });
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCaptured(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      resolve({ status: 1, stdout, stderr: stderr || err.message });
    });
    child.on('close', (code, signal) => {
      resolve({ status: code ?? 1, signal, stdout, stderr });
    });
  });
}

function runInherited(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { env, stdio: 'inherit' });
    child.on('error', (err) => {
      writeStderr(err.message);
      resolve(1);
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

function writeStderr(message) {
  process.stderr.write(`${message}${osEol()}`);
}

function osEol() {
  return process.platform === 'win32' ? '\r\n' : '\n';
}

function cliCommand(argv) {
  const separator = argv.indexOf('--');
  if (separator < 0 || separator === argv.length - 1) {
    throw new Error('Usage: node scripts/with-postgres-test-env.mjs -- <command> [...args]');
  }
  return {
    command: argv[separator + 1],
    args: argv.slice(separator + 2),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { command, args } = cliCommand(process.argv.slice(2));
    const status = await runWithPostgresTestEnv(command, args);
    process.exit(status);
  } catch (err) {
    writeStderr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
