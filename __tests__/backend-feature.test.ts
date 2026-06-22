import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { registerBackendCommand, type BackendRuntimeModule } from '../src/features/backend/index.js';
import {
  type BackendStartResult,
  type BackendLogsReport,
  buildBackendProcessSpecs,
  configuredEndpointsFromLlm,
  configuredModelFilesFromLlm,
  renderBackendStartCommand,
  startBackends,
  stopBackends,
  restartBackends,
  backendStatus,
} from '../src/features/backend/runtime.js';
import type { CliOptionCommand } from '../src/features/shared/cli-command.js';
import * as scanBackends from '../src/installer/scan-backends.js';
import { isProcessAlive } from '../src/utils-concurrency.js';

function withObjectPrototypeProperties<T>(entries: Record<string, unknown>, run: () => T): T {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of Object.keys(entries)) {
    previous.set(key, Object.getOwnPropertyDescriptor(Object.prototype, key));
    Object.defineProperty(Object.prototype, key, {
      configurable: true,
      writable: true,
      value: entries[key],
    });
  }
  try {
    return run();
  } finally {
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(Object.prototype, key, descriptor);
      else Reflect.deleteProperty(Object.prototype, key);
    }
  }
}

describe('backend feature runtime', () => {
  it('shell-quotes backend command arguments with spaces and quotes', () => {
    expect(
      renderBackendStartCommand({
        id: 'embed',
        labels: ['embedding'],
        endpoint: 'http://localhost:8080',
        command: 'llama-server',
        args: ['-m', "/models/jina embed's.gguf", '--port', '8080'],
        modelPath: "/models/jina embed's.gguf",
        host: 'localhost',
        port: '8080',
        parallel: 4,
        extraArgs: [],
      }),
    ).toBe("llama-server -m '/models/jina embed'\\''s.gguf' --port 8080");
  });
});

interface BackendStartCliOptions {
  readonly bin?: string;
  readonly dryRun?: boolean;
  readonly json?: boolean;
}

interface BackendLogsCliOptions {
  readonly tier?: string;
  readonly lines?: string;
  readonly json?: boolean;
}

type BackendStartCliAction = (pathArg: string | undefined, options: BackendStartCliOptions) => Promise<void>;
type BackendLogsCliAction = (pathArg: string | undefined, options: BackendLogsCliOptions) => Promise<void>;

function isBackendStartCliAction(value: unknown): value is BackendStartCliAction {
  return typeof value === 'function';
}

function isBackendLogsCliAction(value: unknown): value is BackendLogsCliAction {
  return typeof value === 'function';
}

function createBackendCommandHarness(): { program: CliOptionCommand; actions: Map<string, unknown> } {
  const actions = new Map<string, unknown>();

  function makeCommand(name: string): CliOptionCommand {
    let command: CliOptionCommand;
    command = {
      command(childName: string) {
        return makeCommand(childName);
      },
      description() {
        return command;
      },
      option() {
        return command;
      },
      action<Args extends unknown[]>(fn: (...args: Args) => unknown) {
        actions.set(name, fn);
        return command;
      },
    };
    return command;
  }

  return { program: makeCommand('root'), actions };
}

function unusedBackendRuntimeCall(name: string): never {
  throw new Error(`unexpected backend runtime call: ${name}`);
}

describe('backend feature CLI', () => {
  it('sets exitCode instead of hard-exiting when start has no usable backends', async () => {
    const { program, actions } = createBackendCommandHarness();
    const stdout: string[] = [];
    const errors: string[] = [];
    let startOptions: unknown;
    const startResult: BackendStartResult = {
      projectPath: '/repo',
      stateDir: '/repo/.cartograph/backends',
      rows: [],
      unmanagedReason: 'no configured managed tiers',
      started: [],
      skipped: [],
    };

    registerBackendCommand({
      program,
      resolveProjectPath: (pathArg) => pathArg ?? '/resolved',
      error: (message) => errors.push(message),
      writeStdout: (message = '') => stdout.push(message),
      loadBackendRuntime: async (): Promise<BackendRuntimeModule> => ({
        backendStatus: async () => unusedBackendRuntimeCall('backendStatus'),
        startBackends: async (options) => {
          startOptions = options;
          return startResult;
        },
        stopBackends: async () => unusedBackendRuntimeCall('stopBackends'),
        restartBackends: async () => unusedBackendRuntimeCall('restartBackends'),
        backendLogs: async () => unusedBackendRuntimeCall('backendLogs'),
        renderBackendStartCommand,
      }),
    });

    const action = actions.get('start [path]');
    if (!isBackendStartCliAction(action)) throw new Error('backend start action was not registered');

    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    let exitCalled = false;
    let observedExitCode: string | number | undefined;
    process.exitCode = 0;
    process.exit = (code?: string | number | null | undefined): never => {
      exitCalled = true;
      throw new Error(`process.exit(${String(code)})`);
    };

    try {
      await action('/repo', { dryRun: true, json: true });
      observedExitCode = process.exitCode;
    } finally {
      process.exit = originalExit;
      process.exitCode = originalExitCode;
    }

    expect(exitCalled).toBe(false);
    expect(observedExitCode).toBe(1);
    expect(startOptions).toEqual({ projectPath: '/repo', dryRun: true });
    expect(stdout.join('\n')).toContain('"rows": []');
    expect(errors).toEqual([]);
  });

  it('sets exitCode instead of hard-exiting when a requested log tier has no rows', async () => {
    const { program, actions } = createBackendCommandHarness();
    const stdout: string[] = [];
    const errors: string[] = [];
    let logsOptions: unknown;
    const logsResult: BackendLogsReport = {
      projectPath: '/repo',
      stateDir: '/repo/.cartograph/backends',
      rows: [],
      unmanagedReason: 'no configured managed tiers',
      logs: [],
    };

    registerBackendCommand({
      program,
      resolveProjectPath: (pathArg) => pathArg ?? '/resolved',
      error: (message) => errors.push(message),
      writeStdout: (message = '') => stdout.push(message),
      loadBackendRuntime: async (): Promise<BackendRuntimeModule> => ({
        backendStatus: async () => unusedBackendRuntimeCall('backendStatus'),
        startBackends: async () => unusedBackendRuntimeCall('startBackends'),
        stopBackends: async () => unusedBackendRuntimeCall('stopBackends'),
        restartBackends: async () => unusedBackendRuntimeCall('restartBackends'),
        backendLogs: async (options) => {
          logsOptions = options;
          return logsResult;
        },
        renderBackendStartCommand,
      }),
    });

    const action = actions.get('logs [path]');
    if (!isBackendLogsCliAction(action)) throw new Error('backend logs action was not registered');

    const originalExit = process.exit;
    const originalExitCode = process.exitCode;
    let exitCalled = false;
    let observedExitCode: string | number | undefined;
    process.exitCode = 0;
    process.exit = (code?: string | number | null | undefined): never => {
      exitCalled = true;
      throw new Error(`process.exit(${String(code)})`);
    };

    try {
      await action('/repo', { tier: 'ask', lines: '5' });
      observedExitCode = process.exitCode;
    } finally {
      process.exit = originalExit;
      process.exitCode = originalExitCode;
    }

    expect(exitCalled).toBe(false);
    expect(observedExitCode).toBe(1);
    expect(logsOptions).toEqual({ projectPath: '/repo', tier: 'ask', lines: 5 });
    expect(stdout.join('\n')).toContain('_No managed backend processes._ no configured managed tiers');
    expect(errors).toEqual([]);
  });
});

describe('buildBackendProcessSpecs — per-tier llama-server tuning (issue #24)', () => {
  function chatLlm(extra: Record<string, unknown>): Record<string, unknown> {
    return {
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8081',
        model: '/models/chat-30b.Q4_K_M.gguf',
        ...extra,
      },
    };
  }

  it('ignores inherited LLM tier blocks and tier fields', () => {
    const inheritedTier = {
      provider: 'openai-compat',
      endpoint: 'http://localhost:8181',
      model: '/models/polluted.gguf',
    };

    withObjectPrototypeProperties({ summarizeLlm: inheritedTier }, () => {
      expect(buildBackendProcessSpecs({})).toEqual([]);
      expect(configuredModelFilesFromLlm({})).toEqual([]);
      expect(configuredEndpointsFromLlm({})).toEqual([]);
    });

    withObjectPrototypeProperties(inheritedTier, () => {
      const llm = { summarizeLlm: {} };

      expect(buildBackendProcessSpecs(llm)).toEqual([]);
      expect(configuredModelFilesFromLlm(llm)).toEqual([]);
      expect(configuredEndpointsFromLlm(llm)).toEqual([]);
    });
  });

  it('drives --parallel from a concurrency override (lets llm-tune cut KV memory)', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 1 }));
    expect(specs).toHaveLength(1);
    const args = specs[0]!.args;
    // exactly one --parallel, with the override value
    expect(args.filter((a) => a === '--parallel')).toHaveLength(1);
    expect(args[args.indexOf('--parallel') + 1]).toBe('1');
    expect(specs[0]!.parallel).toBe(1);
  });

  it('appends llamaServerArgs verbatim after the computed flags', () => {
    const specs = buildBackendProcessSpecs(
      chatLlm({ concurrency: 1, llamaServerArgs: ['--cache-ram', '1024', '-c', '8192'] }),
    );
    const args = specs[0]!.args;
    expect(args.slice(-4)).toEqual(['--cache-ram', '1024', '-c', '8192']);
    // the computed --parallel is still present (passthrough had none)
    expect(args).toContain('--parallel');
  });

  it('lets an explicit --parallel in llamaServerArgs override the computed one', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 4, llamaServerArgs: ['--parallel', '1'] }));
    const args = specs[0]!.args;
    // only the user's --parallel survives — no duplicate computed flag
    expect(args.filter((a) => a === '--parallel')).toHaveLength(1);
    expect(args[args.indexOf('--parallel') + 1]).toBe('1');
  });

  it('honours the -np short form as a parallel override too', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 4, llamaServerArgs: ['-np', '2'] }));
    const args = specs[0]!.args;
    expect(args).not.toContain('--parallel');
    expect(args).toContain('-np');
  });

  it('ignores a malformed (non-array) llamaServerArgs without breaking command construction', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ llamaServerArgs: 'not-an-array' as unknown }));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.args).toContain('--parallel');
  });

  it('keys identity by endpoint — same port, different model keeps the same id (no orphan)', () => {
    const a = buildBackendProcessSpecs(chatLlm({ model: '/models/old.gguf' } as never));
    const b = buildBackendProcessSpecs({
      summarizeLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8081',
        model: '/models/new-30b.gguf',
      },
    });
    expect(a[0]!.id).toBe(b[0]!.id);
  });

  it('collapses multiple chat tiers on one endpoint into a single process with merged labels', () => {
    const specs = buildBackendProcessSpecs({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/m/chat.gguf' },
      localLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model: '/m/chat.gguf' },
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]!.labels).toEqual(['summarize', 'local']);
  });

  it('keeps an embed tier distinct from a chat tier on the same port (mode flags differ)', () => {
    // A llama-server in --embeddings mode cannot also serve chat, so an
    // embed tier sharing a port must stay its own process and keep its
    // --embeddings flag instead of merging into chat (regression guard).
    const specs = buildBackendProcessSpecs({
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:1', model: '/m/chat.gguf' },
      embeddingLlm: { provider: 'openai-compat', endpoint: 'http://localhost:1', model: '/m/embed.gguf' },
    });
    expect(specs).toHaveLength(2);
    const embed = specs.find((s) => s.labels.includes('embed'))!;
    expect(embed.args).toContain('--embeddings');
    // distinct pid/log identity so the two never collide on disk
    expect(specs[0]!.id).not.toBe(specs[1]!.id);
  });
});

describe('backend orphan reclamation (issue #24)', () => {
  const tmpDirs: string[] = [];
  const children: number[] = [];

  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-backend-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.cartograph', 'backends'), { recursive: true });
    return dir;
  }

  function spawnSleeper(): number {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    const pid = child.pid!;
    children.push(pid);
    child.unref();
    return pid;
  }

  function writePidFile(projectPath: string, id: string, record: Record<string, unknown>): void {
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'backends', `${id}.json`), JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
  }

  it('start skips a model-missing configured tier and an orphan without spawning anything', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    fs.writeFileSync(
      path.join(project, '.cartograph', 'config.json'),
      JSON.stringify({
        llm: {
          summarizeLlm: {
            provider: 'openai-compat',
            endpoint: 'http://localhost:8191',
            model: path.join(project, 'does-not-exist.gguf'),
          },
        },
      }),
    );
    // a dead-pid orphan on a different port
    writePidFile(project, 'llama-orphan00aa', {
      schemaVersion: 1,
      pid: 2147483646, // not a live pid
      startedAt: new Date().toISOString(),
      command: 'llama-server',
      args: ['-m', '/models/gone.gguf', '--host', 'localhost', '--port', '8192'],
      endpoint: 'http://localhost:8192',
      modelPath: '/models/gone.gguf',
      labels: ['ask'],
      logPath: path.join(project, '.cartograph', 'backends', 'llama-orphan00aa.log'),
    });

    const result = await startBackends({ projectPath: project });
    expect(result.started).toHaveLength(0);
    const reasons = result.skipped.map((s) => s.reason).join('\n');
    expect(reasons).toContain('model file missing');
    expect(reasons).toContain('orphaned backend');
  });

  it('surfaces a pid file whose endpoint is no longer configured as orphaned, and stop reclaims it', async () => {
    // No config.json → no configured tiers → the pid file is an orphan.
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const pid = spawnSleeper();
    writePidFile(project, 'llama-deadbeef0001', {
      schemaVersion: 1,
      pid,
      startedAt: new Date().toISOString(),
      command: 'llama-server',
      args: ['-m', '/models/old.gguf', '--host', 'localhost', '--port', '8199', '--parallel', '4'],
      endpoint: 'http://localhost:8199',
      modelPath: '/models/old.gguf',
      labels: ['summarize'],
      logPath: path.join(project, '.cartograph', 'backends', 'llama-deadbeef0001.log'),
    });

    const status = await backendStatus(project);
    expect(status.rows).toHaveLength(1);
    expect(status.rows[0]!.origin).toBe('orphan');
    expect(status.rows[0]!.pidAlive).toBe(true);

    const result = await stopBackends({ projectPath: project });
    expect(result.stopped).toHaveLength(1);
    expect(isProcessAlive(pid)).toBe(false);
    expect(fs.existsSync(path.join(project, '.cartograph', 'backends', 'llama-deadbeef0001.json'))).toBe(false);
  });

  it('ignores malformed and incomplete orphan pid files', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const stateDir = path.join(project, '.cartograph', 'backends');
    fs.writeFileSync(path.join(stateDir, 'bad-json.json'), '{not json');
    writePidFile(project, 'empty-fields', {
      schemaVersion: 1,
      pid: 2147483646,
      startedAt: '',
      command: '',
      args: [],
      endpoint: '',
      modelPath: '',
      labels: [],
      logPath: '',
    });

    const status = await backendStatus(project);

    expect(status.rows).toHaveLength(0);
  });
});

describe('backend restart + drift + externallyManaged (issue #30)', () => {
  const tmpDirs: string[] = [];
  const children: number[] = [];

  afterEach(() => {
    for (const pid of children.splice(0)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        // already gone
      }
    }
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function makeProject(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-backend30-'));
    tmpDirs.push(dir);
    fs.mkdirSync(path.join(dir, '.cartograph', 'backends'), { recursive: true });
    return dir;
  }

  function spawnSleeper(): number {
    const child = spawn('sleep', ['60'], { stdio: 'ignore' });
    const pid = child.pid!;
    children.push(pid);
    child.unref();
    return pid;
  }

  function writeConfig(project: string, llm: Record<string, unknown>): void {
    fs.writeFileSync(path.join(project, '.cartograph', 'config.json'), JSON.stringify({ llm }));
  }

  function writePidFile(project: string, id: string, record: Record<string, unknown>): void {
    fs.writeFileSync(path.join(project, '.cartograph', 'backends', `${id}.json`), JSON.stringify(record, null, 2), {
      mode: 0o600,
    });
  }

  function pidFileCount(project: string): number {
    return fs.readdirSync(path.join(project, '.cartograph', 'backends')).filter((f) => f.endsWith('.json')).length;
  }

  it('flags config drift when a live managed backend was started with different args', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const model = path.join(project, 'chat.gguf');
    fs.writeFileSync(model, 'x');
    const llm = {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8181', model, concurrency: 4 },
    };
    writeConfig(project, llm);
    const spec = buildBackendProcessSpecs(llm)[0]!;
    // started with --parallel 8 (an older concurrency); current config wants 4
    const oldArgs = spec.args.map((a) => (a === '4' ? '8' : a));
    writePidFile(project, spec.id, {
      schemaVersion: 1,
      pid: spawnSleeper(),
      startedAt: new Date().toISOString(),
      command: 'llama-server',
      args: oldArgs,
      endpoint: spec.endpoint,
      modelPath: model,
      labels: ['summarize'],
      logPath: path.join(project, '.cartograph', 'backends', `${spec.id}.log`),
    });

    const status = await backendStatus(project);
    const row = status.rows.find((r) => r.spec.id === spec.id)!;
    expect(row.configDrift).toBeTruthy();
    expect(row.configDrift!.current).toContain('8');
    expect(row.configDrift!.requested).toContain('4');
  });

  it('reports no drift when the live backend args match current config', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const model = path.join(project, 'chat.gguf');
    fs.writeFileSync(model, 'x');
    const llm = {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8181', model, concurrency: 4 },
    };
    writeConfig(project, llm);
    const spec = buildBackendProcessSpecs(llm)[0]!;
    writePidFile(project, spec.id, {
      schemaVersion: 1,
      pid: spawnSleeper(),
      startedAt: new Date().toISOString(),
      command: 'llama-server',
      args: [...spec.args],
      endpoint: spec.endpoint,
      modelPath: model,
      labels: ['summarize'],
      logPath: path.join(project, '.cartograph', 'backends', `${spec.id}.log`),
    });

    const status = await backendStatus(project);
    const row = status.rows.find((r) => r.spec.id === spec.id)!;
    expect(row.configDrift ?? null).toBeNull();
  });

  it('start skips and stop never signals a tier declared externallyManaged', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const model = path.join(project, 'chat.gguf');
    fs.writeFileSync(model, 'x');
    writeConfig(project, {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8181', model, externallyManaged: true },
    });

    const startResult = await startBackends({ projectPath: project });
    expect(startResult.started).toHaveLength(0);
    expect(startResult.skipped.map((s) => s.reason).join('\n')).toContain('externallyManaged');
    expect(pidFileCount(project)).toBe(0);

    const stopResult = await stopBackends({ projectPath: project });
    expect(stopResult.stopped).toHaveLength(0);
    expect(stopResult.skipped.map((s) => s.reason).join('\n')).toContain('does not stop it');
  });

  it('restart returns an externally-managed tier in `external` with a relaunch hint (no spawn)', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const model = path.join(project, 'chat.gguf');
    fs.writeFileSync(model, 'x');
    writeConfig(project, {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8181', model, externallyManaged: true },
    });

    const result = await restartBackends({ projectPath: project });
    expect(result.restarted).toHaveLength(0);
    expect(result.external).toHaveLength(1);
    expect(result.external[0]!.message).toContain('http://localhost:8181');
    expect(pidFileCount(project)).toBe(0);
  });

  it('restart --dry-run plans configured tiers without spawning, honouring --tier', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject();
    const chat = path.join(project, 'chat.gguf');
    const ask = path.join(project, 'ask.gguf');
    fs.writeFileSync(chat, 'x');
    fs.writeFileSync(ask, 'x');
    writeConfig(project, {
      summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8181', model: chat },
      askLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8182', model: ask },
    });

    const all = await restartBackends({ projectPath: project, dryRun: true });
    expect(all.restarted).toHaveLength(2);

    const one = await restartBackends({ projectPath: project, dryRun: true, tier: 'summarize' });
    expect(one.restarted).toHaveLength(1);
    expect(one.restarted[0]!.spec.labels).toContain('summarize');

    expect(pidFileCount(project)).toBe(0); // dry-run spawned nothing
  });

  it('restart skips an orphan (stop-only) instead of relaunching it', async () => {
    vi.spyOn(scanBackends, 'scanForLlmBackends').mockResolvedValue([]);
    const project = makeProject(); // no config → the pid file is an orphan
    writePidFile(project, 'llama-orphanrst01', {
      schemaVersion: 1,
      pid: spawnSleeper(),
      startedAt: new Date().toISOString(),
      command: 'llama-server',
      args: ['-m', '/models/old.gguf', '--host', 'localhost', '--port', '8199'],
      endpoint: 'http://localhost:8199',
      modelPath: '/models/old.gguf',
      labels: ['summarize'],
      logPath: path.join(project, '.cartograph', 'backends', 'llama-orphanrst01.log'),
    });

    const result = await restartBackends({ projectPath: project });
    expect(result.restarted).toHaveLength(0);
    expect(result.external).toHaveLength(0);
    expect(result.skipped.map((s) => s.reason).join('\n')).toContain('orphaned backend');
  });
});
