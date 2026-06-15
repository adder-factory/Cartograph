import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import {
  buildBackendProcessSpecs,
  renderBackendStartCommand,
  startBackends,
  stopBackends,
  backendStatus,
} from '../src/features/backend/runtime.js';
import * as scanBackends from '../src/installer/scan-backends.js';
import { isProcessAlive } from '../src/utils-concurrency.js';

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

  it('auto-sizes `-c` to parallel × per-slot for a chat tier (issue #27)', () => {
    // ctx is split across --parallel slots; cartograph sizes -c so every
    // slot fits its own summary prompts. parallel 2 × 4096/slot = 8192.
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 2 }));
    const args = specs[0]!.args;
    expect(args.filter((a) => a === '-c')).toHaveLength(1);
    expect(args[args.indexOf('-c') + 1]).toBe('8192');
  });

  it('lets a user `-c`/`--ctx-size` in llamaServerArgs override the auto-sized one', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 2, llamaServerArgs: ['-c', '1024'] }));
    const args = specs[0]!.args;
    // exactly one -c — the user's — no duplicate auto-sized flag
    expect(args.filter((a) => a === '-c')).toHaveLength(1);
    expect(args[args.indexOf('-c') + 1]).toBe('1024');
  });

  it('treats the `--ctx_size` underscore alias as a user-pinned context (no duplicate `-c`)', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 2, llamaServerArgs: ['--ctx_size', '2048'] }));
    const args = specs[0]!.args;
    // user pinned context via the underscore alias → suppress the auto `-c`
    expect(args).not.toContain('-c');
    expect(args.slice(-2)).toEqual(['--ctx_size', '2048']);
  });

  it('skips the auto `-c` when the user pins --parallel (they own the slot math)', () => {
    const specs = buildBackendProcessSpecs(chatLlm({ concurrency: 4, llamaServerArgs: ['--parallel', '1'] }));
    expect(specs[0]!.args).not.toContain('-c');
  });

  it('does not add a chat `-c` to the embed tier (sized by --batch-size, not chat ctx)', () => {
    const specs = buildBackendProcessSpecs({
      embeddingLlm: {
        provider: 'openai-compat',
        endpoint: 'http://localhost:8080',
        model: '/models/jina.gguf',
        concurrency: 4,
      },
    });
    expect(specs[0]!.args).not.toContain('-c');
    expect(specs[0]!.args).toContain('--embeddings');
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
});
