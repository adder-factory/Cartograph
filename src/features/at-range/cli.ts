import * as fsp from 'node:fs/promises';
import { buildAtRangeMcpArgs, type AtRangeOptions, type BuildAtRangeArgsInput } from './runtime.js';

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

export interface AtRangeCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  warn: (message: string) => void;
  runViaMCP: (toolName: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
  readStdin?: () => Promise<string>;
  fileExists?: (path: string) => Promise<boolean>;
  readFile?: (path: string) => Promise<string>;
}

export function registerAtRangeCommand(deps: AtRangeCommandDeps): void {
  deps.program
    .command('at-range [file] [startLine] [endLine]')
    .description('List indexed symbols whose ranges overlap the given file:line span (R*Tree-backed, O(log n))')
    .option('-p, --project-path <path>', 'Path to the project (defaults to current directory)')
    .option('-l, --limit <n>', 'Maximum results (default 20)', '20')
    .option(
      '--diff <pathOrText>',
      "Unified diff to query — accepts a file path, '-' for stdin, or the diff TEXT itself (the MCP `diff` param takes the text; this flag accepts either). Server parses hunks and queries each. Mutually exclusive with the positional file/startLine/endLine and --ranges.",
    )
    .option(
      '--ranges <list>',
      "Bulk mode — comma-separated `file:startLine-endLine` specs (e.g. 'src/a.ts:10-20,src/b.ts:5-9'). Queries up to 100 ranges in one call. Mutually exclusive with the positional file/startLine/endLine and --diff.",
    )
    .option(
      '--compact',
      'Emit terse pipe-delimited rows instead of a markdown table (saves 50-70% output tokens on chained range queries)',
    )
    .option(
      '--fields <names>',
      '(--compact only) Comma-separated subset of fields to emit: name,kind,path,line,endLine,signature. Default: all six.',
    )
    .option('--low-tokens', 'Prefer compact projected rows plus a lower per-range cap')
    .action(
      async (
        file: string | undefined,
        startLine: string | undefined,
        endLine: string | undefined,
        options: AtRangeOptions,
      ) => {
        const diffText = options.diff === undefined ? undefined : await resolveDiffOption(options.diff, deps);
        const input: BuildAtRangeArgsInput = {
          file,
          startLine,
          endLine,
          options,
        };
        if (diffText !== undefined) input.diffText = diffText;
        const result = buildAtRangeMcpArgs(input);
        if (!result.ok) {
          deps.error(result.error);
          process.exitCode = 1;
          return;
        }
        await deps.runViaMCP('cartograph_at_range', result.args, options.projectPath);
      },
    );
}

export async function resolveDiffOption(
  diff: string,
  deps: Pick<AtRangeCommandDeps, 'readStdin' | 'fileExists' | 'readFile' | 'warn'>,
): Promise<string> {
  if (diff === '-') return deps.readStdin ? deps.readStdin() : readProcessStdin();
  if (diff.includes('\n') || diff.startsWith('@@') || diff.startsWith('diff --git')) return diff;
  const exists = deps.fileExists ? await deps.fileExists(diff) : await defaultFileExists(diff);
  if (exists) return deps.readFile ? deps.readFile(diff) : fsp.readFile(diff, 'utf-8');
  deps.warn(`--diff: "${diff}" is not an existing file — treating it as inline diff text.`);
  return diff;
}

async function defaultFileExists(path: string): Promise<boolean> {
  return fsp
    .access(path)
    .then(() => true)
    .catch(() => false);
}

function readProcessStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}
