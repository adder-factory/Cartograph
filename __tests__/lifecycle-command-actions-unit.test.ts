import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const actions = new Map<string, (...args: any[]) => unknown>();
const calls: string[] = [];
const stderr: string[] = [];
let projectPath: string;

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

vi.mock('../src/bin/_cli-core.js', () => ({
  program: new FakeCommand('program'),
  llmCmd: new FakeCommand('llm'),
  chalk: { bold: (s: string) => s, blue: (s: string) => s, dim: (s: string) => s, cyan: (s: string) => s },
  resolveProjectPath: vi.fn((pathArg?: string) => pathArg ?? projectPath),
  error: vi.fn((message: string) => calls.push(`error:${message}`)),
  info: vi.fn((message: string) => calls.push(`info:${message}`)),
  assignIntArg: vi.fn(({ args, key, raw }) => {
    if (raw !== undefined) args[key] = Number(raw);
    return true;
  }),
  runViaMCP: vi.fn(async (tool: string, args: Record<string, unknown>, projectPath?: string) =>
    calls.push(`mcp:${tool}:${JSON.stringify(args)}:${projectPath ?? ''}`),
  ),
  loadCartograph: vi.fn(async () => ({ default: {} })),
}));

vi.mock('../src/mcp/index.js', () => ({
  MCPServer: class {
    constructor(private readonly opts: unknown) {
      calls.push(`server:${JSON.stringify(opts)}`);
    }
    async start() {
      calls.push('server.start');
    }
  },
}));

vi.mock('../src/installer/targets/registry.js', () => ({
  getTarget: vi.fn((id: string) => (id === 'claude' ? { printConfig: (loc: string) => `config:${loc}` } : null)),
  listTargetIds: vi.fn(() => ['claude', 'cursor']),
}));

vi.mock('../src/installer/index.js', () => ({
  runInstallerWithOptions: vi.fn(async (opts: unknown) => calls.push(`install:${JSON.stringify(opts)}`)),
}));

vi.mock('../src/installer/llm-setup-cli.js', () => ({
  runLlmSetupCli: vi.fn(async (pathArg?: string) => calls.push(`llm-setup:${pathArg ?? ''}`)),
}));

vi.mock('../src/mcp/tools.js', () => ({
  ToolHandler: class {
    async execute(tool: string) {
      calls.push(`tool:${tool}`);
      return { content: [{ text: 'playbook text' }], isError: false };
    }
    closeAll() {
      calls.push('tool.closeAll');
    }
  },
}));

vi.mock('../src/viewer/server.js', () => ({
  startViewerServer: vi.fn(async (_projectPath: string, opts?: { port?: number }) => ({
    url: `http://localhost:${opts?.port ?? 8765}`,
    close: vi.fn(async () => calls.push('viewer.close')),
  })),
  openInBrowser: vi.fn((url: string) => calls.push(`open:${url}`)),
}));

await import('../src/bin/commands/lifecycle.js');

describe('lifecycle command action bodies', () => {
  beforeEach(() => {
    calls.length = 0;
    stderr.length = 0;
    process.exitCode = 0;
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lifecycle-cli-'));
    fs.mkdirSync(path.join(projectPath, '.cartograph'), { recursive: true });
    fs.writeFileSync(path.join(projectPath, '.cartograph', 'cartograph.db'), '');
  });

  afterEach(() => {
    if (projectPath && fs.existsSync(projectPath)) fs.rmSync(projectPath, { recursive: true, force: true });
  });

  it('starts MCP serve and prints non-MCP serve guidance', async () => {
    await actions.get('program:serve')!({
      projectPath,
      mcp: true,
      writeTools: false,
      allowStaleDefault: true,
      disableTool: ['cartograph_ask'],
      startupSync: false,
    });
    expect(calls).toContain('server.start');
    expect(calls.join('\n')).toContain('"disableWriteTools":true');

    const originalErr = console.error;
    console.error = (message?: unknown) => stderr.push(String(message));
    try {
      await actions.get('program:serve')!({});
    } finally {
      console.error = originalErr;
    }
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

    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (message?: unknown) => logs.push(String(message));
    try {
      await actions.get('program:playbook')!();
    } finally {
      console.log = originalLog;
    }

    await actions.get('program:viewer [path]')!(projectPath, { port: '0', open: true });

    const text = calls.join('\n');
    expect(text).toContain(`llm-setup:${projectPath}`);
    expect(text).toContain('mcp:cartograph_trace_to_culprits');
    expect(logs.join('\n')).toContain('playbook text');
    expect(text).toContain('open:http://localhost:0');
  });
});
