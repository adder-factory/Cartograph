import { afterEach, describe, expect, it } from 'vitest';
import { mock } from 'bun:test';

type ExecCall = {
  command: string;
  args: string[];
  cwd?: string;
};

type ClackEvent = {
  kind: string;
  message: string;
};

const execCalls: ExecCall[] = [];
const clackEvents: ClackEvent[] = [];
const execFailures: Error[] = [];
const confirmAnswers: boolean[] = [];

function nextTick(cb: (err?: Error) => void, err?: Error): void {
  queueMicrotask(() => cb(err));
}

mock.module('node:child_process', () => ({
  execSync() {
    return '';
  },
  execFileSync() {
    return '';
  },
  spawn() {
    throw new Error('unexpected spawn call in installer PATH-link test');
  },
  execFile(
    command: string,
    args: string[],
    optionsOrCallback?: { cwd?: string } | ((err?: Error) => void),
    callback?: (err?: Error) => void,
  ) {
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    execCalls.push({ command, args, cwd: options?.cwd });
    const err = execFailures.shift();
    if (cb) nextTick(cb, err);
  },
}));

mock.module('@clack/prompts', () => ({
  intro(message: string) {
    clackEvents.push({ kind: 'intro', message });
  },
  outro(message: string) {
    clackEvents.push({ kind: 'outro', message });
  },
  note(message: string, title: string) {
    clackEvents.push({ kind: 'note', message: `${title}: ${message}` });
  },
  cancel(message: string) {
    clackEvents.push({ kind: 'cancel', message });
  },
  isCancel() {
    return false;
  },
  async confirm({ message }: { message: string }) {
    clackEvents.push({ kind: 'confirm', message });
    return confirmAnswers.shift() ?? true;
  },
  log: {
    info(message: string) {
      clackEvents.push({ kind: 'info', message });
    },
    warn(message: string) {
      clackEvents.push({ kind: 'warn', message });
    },
    success(message: string) {
      clackEvents.push({ kind: 'success', message });
    },
    error(message: string) {
      clackEvents.push({ kind: 'error', message });
    },
  },
  spinner() {
    return {
      start(message: string) {
        clackEvents.push({ kind: 'spinner-start', message });
      },
      stop(message: string) {
        clackEvents.push({ kind: 'spinner-stop', message });
      },
    };
  },
}));

const { runInstallerWithOptions } = await import('../src/installer/index.js');

function resetStores(): void {
  execCalls.length = 0;
  clackEvents.length = 0;
  execFailures.length = 0;
  confirmAnswers.length = 0;
}

function eventMessages(kind: string): string[] {
  return clackEvents.filter((event) => event.kind === kind).map((event) => event.message);
}

describe('runInstallerWithOptions PATH linking', () => {
  afterEach(() => {
    resetStores();
  });

  it('does not prompt for linking when cartograph is already on PATH', async () => {
    await runInstallerWithOptions({ location: 'global', target: 'none' });

    expect(execCalls).toEqual([{ command: 'cartograph', args: ['--version'], cwd: undefined }]);
    expect(eventMessages('info')).toContain('cartograph is already on PATH');
    expect(eventMessages('confirm')).toEqual([]);
  });

  it('keeps going without writing PATH links when the user declines bun link', async () => {
    execFailures.push(new Error('cartograph not found'));
    confirmAnswers.push(false);

    await runInstallerWithOptions({ location: 'global', target: 'none' });

    expect(execCalls).toEqual([{ command: 'cartograph', args: ['--version'], cwd: undefined }]);
    expect(eventMessages('confirm')[0]).toMatch(/Link cartograph onto PATH/);
    expect(eventMessages('info')).toContain(
      'Skipped PATH linking — MCP server may not work unless your config uses an absolute command path',
    );
  });

  it('links the current source checkout globally when the user accepts', async () => {
    execFailures.push(new Error('cartograph not found'));
    confirmAnswers.push(true);

    await runInstallerWithOptions({ location: 'global', target: 'none' });

    expect(execCalls.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: 'cartograph', args: ['--version'] },
      { command: 'bun', args: ['link'] },
    ]);
    expect(execCalls[1]!.cwd).toEndWith('cartograph');
    expect(eventMessages('spinner-start')).toContain('Linking cartograph globally...');
    expect(eventMessages('spinner-stop')).toContain('Linked cartograph globally');
  });

  it('reports bun link failures with the remediation command', async () => {
    execFailures.push(new Error('cartograph not found'), new Error('permission denied'));
    confirmAnswers.push(true);

    await runInstallerWithOptions({ location: 'global', target: 'none' });

    expect(eventMessages('spinner-stop')).toContain('Could not link cartograph globally');
    const warning = eventMessages('warn')[0] ?? '';
    expect(warning).toContain('Run from the Cartograph source checkout: `bun link`');
    expect(warning).toContain('cartograph --version');
    expect(warning).toContain('bun src/bin/cartograph.ts <command>');
    expect(warning).toContain('bun pm bin -g');
    expect(warning).toContain('dirname "$(command -v bun)"');
    expect(warning).toContain('permission denied');
  });
});
