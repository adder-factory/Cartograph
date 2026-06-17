import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { registerLifecycleCommands } from '../src/bin/commands/lifecycle.js';

const actions = new Map<string, (...args: any[]) => unknown>();
const calls: string[] = [];
const stdout: string[] = [];
const stderr: string[] = [];
let projectPath: string;
let failMcpServerLoad = false;
let dirty = false;
// Minimal FreshnessInfo shape — sync-if-dirty's gate reads isStale +
// contentDriftedFiles (via hasFreshnessRisk) only.
let freshness: { isStale: boolean; contentDriftedFiles: number | null } | null = {
  isStale: false,
  contentDriftedFiles: 0,
};
const DEFAULT_TEST_VIEWER_PORT = 8765;
const TEST_MCP_TOOL_COUNT = 12;
const TEST_STALE_BACKEND_PID = 1234;
const TEST_STARTING_BACKEND_PID = 2345;
const FAKE_INDEX_RESULT = {
  success: true,
  filesIndexed: 2,
  filesSkipped: 0,
  filesErrored: 0,
  nodesCreated: 3,
  edgesCreated: 4,
  errors: [],
  durationMs: 5,
};

function projectHasCartographDb(projectPath: string): boolean {
  return fs.existsSync(path.join(projectPath, '.cartograph', 'cartograph.db'));
}

function localhostUrl(port: number): string {
  return `http://localhost:${port}`;
}

class FakeCommand {
  constructor(private readonly name = 'program') {}

  command(name: string): FakeCommand {
    return new FakeCommand(`${this.name}:${name}`);
  }

  description(): this {
    return this;
  }

  option(): this {
    return this;
  }

  action(fn: (...args: any[]) => unknown): this {
    actions.set(this.name, fn);
    return this;
  }
}

function loadLifecycleCommandActions(): void {
  actions.clear();
  registerLifecycleCommands({
    program: new FakeCommand('program'),
    llmCmd: new FakeCommand('llm'),
    chalk: { bold: (s: string) => s, blue: (s: string) => s, dim: (s: string) => s, cyan: (s: string) => s },
    resolveProjectPath: (pathArg?: string) => pathArg ?? projectPath,
    error: (message: string) => calls.push(`error:${message}`),
    info: (message: string) => calls.push(`info:${message}`),
    writeStdout: (message = '') => stdout.push(message),
    writeStderr: (message = '') => stderr.push(message),
    assignIntArg: ({ args, key, raw }) => {
      if (raw !== undefined) args[key] = Number(raw);
      return true;
    },
    runViaMCP: async (tool: string, args: Record<string, unknown>, projectPath?: string) =>
      calls.push(`mcp:${tool}:${JSON.stringify(args)}:${projectPath ?? ''}`),
    loadCartograph: async () => ({
      default: {
        init: async () => ({
          indexAll: async (opts: unknown) => {
            calls.push(`indexAll:${JSON.stringify(opts)}`);
            return FAKE_INDEX_RESULT;
          },
          close: () => calls.push('init.close'),
        }),
        open: async (path: string, opts: unknown) => {
          calls.push(`open:${path}:${JSON.stringify(opts)}`);
          return {
            sync: async (syncOpts: unknown) => calls.push(`sync:${JSON.stringify(syncOpts)}`),
            indexAll: async (indexOpts: unknown) => {
              calls.push(`indexAll:${JSON.stringify(indexOpts)}`);
              return FAKE_INDEX_RESULT;
            },
            close: () => calls.push('sync.close'),
            stats: { getFreshness: () => freshness as never },
          };
        },
      },
    }),
    isInitialized: projectHasCartographDb,
    hasUncommittedChanges: () => dirty,
    loadMcpServer: async () => {
      if (failMcpServerLoad) throw new Error('mcp loader exploded');
      return {
        MCPServer: class {
          constructor(private readonly opts: unknown) {
            calls.push(`server:${JSON.stringify(opts)}`);
          }
          async start() {
            calls.push('server.start');
          }
        },
      };
    },
    loadMcpDaemon: async () => ({
      runSharedMcpDaemonProcess: async (opts: unknown) => calls.push(`daemon.child:${JSON.stringify(opts)}`),
      runSharedMcpDaemonProxy: async (opts: unknown) => {
        calls.push(`daemon.proxy:${JSON.stringify(opts)}`);
        return 'fallback' as const;
      },
    }),
    loadInstallerTargets: async () => ({
      getTarget: (id: string) => (id === 'claude' ? { printConfig: (loc: string) => `config:${loc}` } : null),
      listTargetIds: () => ['claude', 'cursor'],
    }),
    loadInstaller: async () => ({
      runInstallerWithOptions: async (opts: unknown) => calls.push(`install:${JSON.stringify(opts)}`),
    }),
    loadLlmSetupCli: async () => ({
      runLlmSetupCli: async (pathArg?: string) => calls.push(`llm-setup:${pathArg ?? ''}`),
    }),
    loadToolHandler: async () => ({
      ToolHandler: class {
        async execute(tool: string) {
          calls.push(`tool:${tool}`);
          return { content: [{ text: 'playbook text' }], isError: false };
        }
        closeAll() {
          calls.push('tool.closeAll');
        }
      },
    }),
    loadMcpLoadBudget: async () => ({
      measureMcpLoadBudget: (_cg: null, opts: unknown) => {
        calls.push(`mcp-budget:${JSON.stringify(opts)}`);
        return { toolCount: TEST_MCP_TOOL_COUNT } as any;
      },
      formatMcpLoadBudgetReport: (report: unknown) => `budget:${JSON.stringify(report)}`,
    }),
    loadViewerServer: async () => ({
      startViewerServer: async (_projectPath: string, opts?: { port?: number }) => ({
        url: localhostUrl(opts?.port ?? DEFAULT_TEST_VIEWER_PORT),
        close: vi.fn(async () => calls.push('viewer.close')),
      }),
      openInBrowser: (url: string) => calls.push(`open:${url}`),
    }),
    loadDoctor: async () => ({
      runDoctor: async (opts: Record<string, unknown>) => {
        calls.push(`doctor:${JSON.stringify(opts)}`);
        return { overallStatus: 'pass' };
      },
      formatDoctorReport: () => 'doctor report',
      formatDoctorJson: () => '{"overallStatus":"pass"}',
    }),
    loadBackendRuntime: async () => {
      const row = {
        state: 'stopped',
        spec: { labels: ['embed'], endpoint: 'http://localhost:8080', modelPath: '/models/embed.gguf' },
        logPath: '/repo/.cartograph/backends/embed.log',
        pidFilePath: '/repo/.cartograph/backends/embed.json',
        pidRecord: null,
        pidAlive: false,
      };
      const staleRow = {
        ...row,
        state: 'running',
        pidRecord: { pid: TEST_STALE_BACKEND_PID },
        pidAlive: false,
      };
      const startingRow = {
        ...row,
        state: 'starting',
        pidRecord: { pid: TEST_STARTING_BACKEND_PID },
        pidAlive: true,
      };
      return {
        backendStatus: async (pathArg: string) => {
          calls.push(`backend-status:${pathArg}`);
          return { projectPath: pathArg, rows: [row, staleRow, startingRow] };
        },
        startBackends: async (opts: unknown) => {
          calls.push(`backend-start:${JSON.stringify(opts)}`);
          return { projectPath, rows: [{ ...row, state: 'running' }], started: [row], skipped: [] };
        },
        stopBackends: async (opts: unknown) => {
          calls.push(`backend-stop:${JSON.stringify(opts)}`);
          return { projectPath, rows: [{ ...row, state: 'stopped' }], stopped: [row], skipped: [] };
        },
        backendLogs: async (opts: unknown) => {
          calls.push(`backend-logs:${JSON.stringify(opts)}`);
          return { projectPath, rows: [row], logs: [{ row, exists: true, content: 'server ready' }] };
        },
        renderBackendStartCommand: () => 'llama-server -m /models/embed.gguf --port 8080',
      };
    },
    loadLlmSmoke: async () => ({
      runLlmSmoke: async (opts: unknown) => {
        calls.push(`llm-smoke:${JSON.stringify(opts)}`);
        return { overallStatus: 'ok', rows: [], durationMs: 1 };
      },
      formatLlmSmokeReport: () => 'smoke report',
      formatLlmSmokeJson: () => '{"overallStatus":"ok"}',
    }),
    loadInstallModels: async () => ({
      installRecommendedModels: async () => ({ downloaded: [], skipped: [] }),
    }),
    loadRecommendedModels: async () => ({ RECOMMENDED_MODELS: [], MINIMAL_MODELS: [] }),
    loadRecommendedConfig: async () => ({
      writeRecommendedLlmConfig: (opts: Record<string, unknown>) => {
        calls.push(`writeRecommended:${JSON.stringify(opts)}`);
        return { configPath: '/repo/.cartograph/config.json' };
      },
    }),
  });
}

describe('lifecycle command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    stdout.length = 0;
    stderr.length = 0;
    failMcpServerLoad = false;
    dirty = false;
    freshness = { isStale: false, contentDriftedFiles: 0 };
    process.exitCode = 0;
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
    loadLifecycleCommandActions();
  });

  afterEach(() => {
    if (projectPath && fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('runs a standalone MCP serve under --no-daemon and prints non-MCP serve guidance', async () => {
    await actions.get('program:serve')!({
      projectPath,
      mcp: true,
      daemon: false, // --no-daemon: standalone server, skip the shared daemon
      profile: 'review',
      writeTools: false,
      allowStaleDefault: true,
      lowTokensDefault: true,
      disableTool: ['cartograph_ask'],
      startupSync: false,
    });
    expect(calls).toContain('server.start');
    expect(calls.join('\n')).not.toContain('daemon.proxy:');
    expect(calls.join('\n')).toContain('"disableWriteTools":true');
    expect(calls.join('\n')).toContain('"profile":"review"');
    expect(calls.join('\n')).toContain('"lowTokensDefault":true');

    await actions.get('program:serve')!({});
    expect(stderr.join('\n')).toContain('Cartograph MCP Server');
    expect(stderr.join('\n')).toContain('Use --mcp flag');
  });

  it('defaults MCP serve to the shared per-project daemon when --no-daemon is absent', async () => {
    // No `daemon` key → commander leaves it undefined → daemon mode is the
    // default. The proxy mock returns non-'proxied', so it falls through to a
    // standalone start — but the daemon path must have been attempted.
    await actions.get('program:serve')!({ projectPath, mcp: true });
    expect(calls.join('\n')).toContain('daemon.proxy:');
  });

  it('routes MCP daemon child and proxy serve paths', async () => {
    await actions.get('program:serve')!({ projectPath, mcp: true, daemonChild: true });
    await actions.get('program:serve')!({ projectPath, mcp: true, daemon: true });

    const text = calls.join('\n');
    expect(text).toContain('daemon.child:');
    expect(text).toContain('daemon.proxy:');
    expect(text).toContain('server.start');
  });

  it('reports MCP serve startup failures through the CLI error channel', async () => {
    failMcpServerLoad = true;
    const originalExit = process.exit;
    process.exit = ((code?: string | number | null) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;
    try {
      // daemon: false isolates standalone startup failure (skip the daemon path).
      await expect(actions.get('program:serve')!({ projectPath, mcp: true, daemon: false })).rejects.toThrow('exit:1');
    } finally {
      process.exit = originalExit;
    }

    expect(calls.join('\n')).toContain('error:Failed to start server: mcp loader exploded');
  });

  it('runs install print-config and non-interactive install paths', async () => {
    const originalWrite = process.stdout.write;
    const stdout: string[] = [];
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout.push(chunk.toString());
      return true;
    }) as typeof process.stdout.write;
    try {
      await actions.get('program:install')!({ printConfig: 'claude', location: 'local' });
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(stdout.join('')).toBe('config:local');

    await actions.get('program:install')!({ target: 'auto', location: 'global', yes: true, permissions: true });
    expect(calls.join('\n')).toContain('"autoAllow":true');
  });

  it('routes llm setup, trace-to-culprits, playbook, guide, mcp-budget, index, and viewer actions', async () => {
    await actions.get('llm:setup [path]')!(projectPath);
    await actions.get('llm:smoke [path]')!(projectPath, { timeoutMs: '1234' });
    await actions.get('program:trace-to-culprits')!({
      projectPath,
      limit: '4',
      trace: 'Error\n at src/a.ts:1',
    });

    await actions.get('program:playbook')!();
    await actions.get('program:guide')!();
    await actions.get('program:mcp-budget')!({
      profile: 'review',
      writeTools: false,
      disableTool: ['cartograph_ask'],
      top: '3',
    });

    await actions.get('program:index [path]')!(projectPath);
    await actions.get('program:viewer [path]')!(projectPath, { port: '0', open: true });

    const text = calls.join('\n');
    expect(text).toContain(`llm-setup:${projectPath}`);
    expect(text).toContain(`llm-smoke:{"projectPath":"${projectPath}","timeoutMs":1234}`);
    expect(text).toContain('mcp:cartograph_trace_to_culprits');
    expect(text).toContain('mcp-budget:');
    expect(text).toContain(`open:${projectPath}:{"autoMigrate":true}`);
    expect(text).toContain('indexAll:{"summarize":false}');
    expect(text).toContain('"profile":"review"');
    expect(text).toContain('"disableWriteTools":true');
    expect(text).toContain('"topContributors":3');
    expect(stdout.join('\n')).toContain('playbook text');
    expect(stdout.join('\n')).toContain('cartograph index');
    expect(stdout.join('\n')).toContain('cartograph status --verbose');
    expect(stdout.join('\n')).toContain('smoke report');
    expect(stdout.join('\n')).toContain('budget:');
    expect(stdout.join('\n')).toContain('cartograph index');
    expect(text).toContain('open:http://localhost:0');
  });

  it('runs sync-if-dirty only when the tree is dirty or the index lags HEAD', async () => {
    // Clean tree + in-sync index: the gate opens the graph to consult
    // freshness (and must close it), but does NOT sync.
    await actions.get('program:sync-if-dirty [path]')!(projectPath, {});
    expect(calls).toContain('info:No source changes and index in sync with HEAD; skipping sync');
    expect(calls.some((call) => call.startsWith('sync:'))).toBe(false);
    expect(calls).toContain('sync.close');

    // Clean tree but HEAD moved since the last index (commits/merges/
    // checkouts/rebases) — the original bug: this must sync now.
    calls.length = 0;
    freshness = { isStale: true, contentDriftedFiles: 0 };
    await actions.get('program:sync-if-dirty [path]')!(projectPath, {});
    expect(calls).toContain('sync:{"summarize":false}');
    expect(calls).toContain('sync.close');

    calls.length = 0;
    freshness = { isStale: false, contentDriftedFiles: 0 };
    dirty = true;
    await actions.get('program:sync-if-dirty [path]')!(projectPath, { quiet: true, maxFileSize: '2mb' });

    expect(calls).toEqual([
      `open:${projectPath}:{"autoMigrate":true}`,
      `sync:{"summarize":false,"maxFileSize":2097152}`,
      'sync.close',
    ]);
  });

  it('routes backend lifecycle commands', async () => {
    await actions.get('program:backend:status [path]')!(projectPath, {});
    await actions.get('program:backend:start [path]')!(projectPath, { bin: '/usr/local/bin/llama-server' });
    await actions.get('program:backend:stop [path]')!(projectPath, { force: true });
    await actions.get('program:backend:logs [path]')!(projectPath, { tier: 'embed', lines: '20' });

    const text = calls.join('\n');
    expect(text).toContain(`backend-status:${projectPath}`);
    expect(text).toContain(
      `backend-start:{"projectPath":"${projectPath}","bin":"/usr/local/bin/llama-server","dryRun":false}`,
    );
    expect(text).toContain(`backend-stop:{"projectPath":"${projectPath}","force":true}`);
    expect(text).toContain(`backend-logs:{"projectPath":"${projectPath}","tier":"embed","lines":20}`);
    expect(stdout.join('\n')).toContain('cartograph backend status');
    expect(stdout.join('\n')).toContain('cartograph backend start');
    expect(stdout.join('\n')).toContain('cartograph backend stop');
    expect(stdout.join('\n')).toContain('cartograph backend logs');
    expect(stdout.join('\n')).toContain('server ready');
    expect(stdout.join('\n')).toContain('pid=1234 stale');
    expect(stdout.join('\n')).toContain('stale pid cleanup');
    expect(stdout.join('\n')).toContain('readiness: process is alive');
  });

  it('passes minimal config options during setup --minimal', async () => {
    await actions.get('program:setup [path]')!(projectPath, { minimal: true });

    const text = calls.join('\n');
    expect(text).toContain('writeRecommended:');
    expect(text).toContain('"includeAsk":false');
    expect(text).toContain('"includeReranker":false');
    expect(text).toContain('doctor:{"projectPath":"');
    expect(stdout.join('\n')).toContain('doctor report');
  });

  it('setup --no-models points at non-model config paths', async () => {
    await actions.get('program:setup [path]')!(projectPath, { models: false });

    const text = calls.join('\n');
    expect(text).not.toContain('writeRecommended:');
    expect(text).toContain('cartograph admin llm-plan');
    expect(text).toContain('cartograph admin llm-apply');
  });

  it('accepts --skip-project-checks on top-level doctor as an alias', async () => {
    await actions.get('program:doctor [path]')!(projectPath, { skipProjectChecks: true, json: true });

    expect(calls.join('\n')).toContain(`doctor:{"projectPath":"${projectPath}","skipProjectChecks":true,"fix":false}`);
    expect(stdout.join('\n')).toContain('{"overallStatus":"pass"}');
  });
});
