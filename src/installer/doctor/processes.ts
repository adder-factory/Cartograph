import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { CheckResult } from './contract.js';

const execFileAsync = promisify(execFile);

const PROCESS_LIST_TIMEOUT_MS = 1_500;
const PROCESS_LIST_MAX_BUFFER_BYTES = 512 * 1_024;
const MAX_RENDERED_CARTOGRAPH_PROCESSES = 4;
const MAX_PROCESS_COMMAND_CHARS = 140;

interface CartographProcessRow {
  readonly pid: number;
  readonly command: string;
}

export async function activeCartographProcessesCheck(projectPath: string): Promise<CheckResult> {
  const rows = await listCartographSiblingProcesses(projectPath);
  if (rows.length === 0) {
    return {
      id: 'cartograph-processes',
      name: 'Cartograph processes',
      status: 'ok',
      detail: 'No sibling MCP/admin/hook processes detected for this project.',
    };
  }

  const rendered = rows
    .slice(0, MAX_RENDERED_CARTOGRAPH_PROCESSES)
    .map((row) => `pid ${row.pid}: ${truncateProcessCommand(row.command)}`)
    .join('; ');
  const suffix =
    rows.length > MAX_RENDERED_CARTOGRAPH_PROCESSES ? `; +${rows.length - MAX_RENDERED_CARTOGRAPH_PROCESSES} more` : '';
  return {
    id: 'cartograph-processes',
    name: 'Cartograph processes',
    status: 'ok',
    detail:
      `${rows.length} sibling Cartograph process${rows.length === 1 ? '' : 'es'} visible (${rendered}${suffix}). ` +
      'If an admin/index command reports `database is locked`, stop or restart those MCP/hook/admin processes, then retry.',
  };
}

async function listCartographSiblingProcesses(projectPath: string): Promise<CartographProcessRow[]> {
  if (process.platform === 'win32') return [];
  const args = process.platform === 'darwin' ? ['-axo', 'pid=,command='] : ['-eo', 'pid=,command='];
  try {
    const { stdout } = await execFileAsync('ps', args, {
      timeout: PROCESS_LIST_TIMEOUT_MS,
      maxBuffer: PROCESS_LIST_MAX_BUFFER_BYTES,
    });
    return parseCartographProcessList(stdout, projectPath).filter(
      (row) => row.pid !== process.pid && isRelevantCartographProcess(row.command, projectPath),
    );
  } catch {
    return [];
  }
}

export function parseCartographProcessList(stdout: string, projectPath: string): CartographProcessRow[] {
  return stdout
    .split('\n')
    .map(parsePsLine)
    .filter((row): row is CartographProcessRow => row !== null)
    .filter((row) => isRelevantCartographProcess(row.command, projectPath));
}

function parsePsLine(line: string): CartographProcessRow | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const pidEnd = findFirstShellWhitespace(trimmed);
  if (pidEnd <= 0) return null;
  const pidText = trimmed.slice(0, pidEnd);
  const pid = parseUnsignedIntegerText(pidText);
  if (pid === null) return null;
  const commandStart = skipShellWhitespace(trimmed, pidEnd);
  const command = trimmed.slice(commandStart);
  return command ? { pid, command } : null;
}

function isRelevantCartographProcess(command: string, projectPath: string): boolean {
  const tokens = commandTokens(command);
  const invokesCartograph =
    tokens.some(isCartographExecutableToken) ||
    command.includes('src/bin/cartograph.ts') ||
    command.includes('src/index-hooks/hook-worker.ts');
  if (!invokesCartograph) return false;
  if (command.includes(projectPath)) return true;
  return command.includes('--mcp') || command.includes('hook-worker.ts') || hasCartographAdminCommand(tokens);
}

function commandTokens(command: string): string[] {
  const tokens: string[] = [];
  let start: number | null = null;
  for (let pos = 0; pos < command.length; pos++) {
    if (isShellWhitespace(command[pos]!)) {
      if (start !== null) {
        tokens.push(command.slice(start, pos));
        start = null;
      }
      continue;
    }
    start ??= pos;
  }
  if (start !== null) tokens.push(command.slice(start));
  return tokens;
}

function isShellWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function findFirstShellWhitespace(value: string): number {
  for (let pos = 0; pos < value.length; pos++) {
    if (isShellWhitespace(value[pos]!)) return pos;
  }
  return -1;
}

function skipShellWhitespace(value: string, start: number): number {
  let pos = start;
  while (pos < value.length && isShellWhitespace(value[pos]!)) pos++;
  return pos;
}

function parseUnsignedIntegerText(value: string): number | null {
  for (const ch of value) {
    if (ch < '0' || ch > '9') return null;
  }
  if (value.length === 0) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

function isCartographExecutableToken(token: string): boolean {
  const name = token.replaceAll('\\', '/').split('/').at(-1);
  return name === 'cartograph' || name === 'cartograph.ts';
}

function hasCartographAdminCommand(tokens: readonly string[]): boolean {
  return tokens.some((token, index) => isCartographExecutableToken(token) && tokens[index + 1] === 'admin');
}

function truncateProcessCommand(command: string): string {
  return command.length <= MAX_PROCESS_COMMAND_CHARS ? command : `${command.slice(0, MAX_PROCESS_COMMAND_CHARS - 1)}…`;
}
