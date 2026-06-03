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
const DEFAULT_TEST_VIEWER_PORT = 8765;

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
    loadCartograph: async () => ({ default: { init: async () => ({ close: () => undefined }) } }),
    isInitialized: projectHasCartographDb,
    compact: (value: Record<string, unknown>) =>
      Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)),
    loadMcpServer: async () => ({
      MCPServer: class {
        constructor(private readonly opts: unknown) {
          calls.push(`server:${JSON.stringify(opts)}`);
        }
        async start() {
          calls.push('server.start');
        }
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
    loadViewerServer: async () => ({
      startViewerServer: async (_projectPath: string, opts?: { port?: number }) => ({
        url: localhostUrl(opts?.port ?? DEFAULT_TEST_VIEWER_PORT),
        close: vi.fn(async () => calls.push('viewer.close')),
      }),
      openInBrowser: (url: string) => calls.push(`open:${url}`),
    }),
    loadDoctor: async () => ({
      runDoctor: async () => ({ overallStatus: 'pass' }),
      formatDoctorReport: () => 'doctor report',
    }),
    loadInstallModels: async () => ({
      installRecommendedModels: async () => ({ downloaded: [], skipped: [] }),
    }),
    loadRecommendedModels: async () => ({ RECOMMENDED_MODELS: [], MINIMAL_MODELS: [] }),
    loadRecommendedConfig: async () => ({
      writeRecommendedLlmConfig: () => ({ configPath: '/repo/.cartograph/config.json' }),
    }),
  });
}

describe('lifecycle command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    stdout.length = 0;
    stderr.length = 0;
    process.exitCode = 0;
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
    loadLifecycleCommandActions();
  });

  afterEach(() => {
    if (projectPath && fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('starts MCP serve and prints non-MCP serve guidance', async () => {
    await actions.get('program:serve')!({
      projectPath,
      mcp: true,
      profile: 'review',
      writeTools: false,
      allowStaleDefault: true,
      disableTool: ['cartograph_ask'],
      startupSync: false,
    });
    expect(calls).toContain('server.start');
    expect(calls.join('\n')).toContain('"disableWriteTools":true');
    expect(calls.join('\n')).toContain('"profile":"review"');

    await actions.get('program:serve')!({});
    expect(stderr.join('\n')).toContain('Cartograph MCP Server');
    expect(stderr.join('\n')).toContain('Use --mcp flag');
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

  it('routes llm setup, trace-to-culprits, playbook, and viewer actions', async () => {
    await actions.get('llm:setup [path]')!(projectPath);
    await actions.get('program:trace-to-culprits')!({
      projectPath,
      limit: '4',
      trace: 'Error\n at src/a.ts:1',
    });

    await actions.get('program:playbook')!();

    await actions.get('program:viewer [path]')!(projectPath, { port: '0', open: true });

    const text = calls.join('\n');
    expect(text).toContain(`llm-setup:${projectPath}`);
    expect(text).toContain('mcp:cartograph_trace_to_culprits');
    expect(stdout.join('\n')).toContain('playbook text');
    expect(text).toContain('open:http://localhost:0');
  });
});
