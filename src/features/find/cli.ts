import { buildFindMcpArgs, type FindOptions } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface FindCommandDeps {
  program: CommandLike;
  error: (message: string) => void;
  runViaMCP: (toolName: string, args: Record<string, unknown>, projectPath?: string) => Promise<void>;
}

export function registerFindCommand(deps: FindCommandDeps): void {
  deps.program
    .command('find [query]')
    .description(
      'Find a thing in the codebase — symbol by name (--by name), regex content (--by content), env-var reads (--by env), or SQL table refs (--by sql). Mirrors cartograph_find MCP tool.',
    )
    .option('-p, --project-path <path>', 'Project path')
    .option('-b, --by <axis>', "Axis: 'name' (default) | 'content' | 'env' | 'sql'", 'name')
    .option('--query <text>', 'Alias for the [query] positional (mirrors MCP arg name)')
    .option('-l, --limit <number>', 'Maximum results (default 10 for name, 50 for content, 30 for env/sql)')
    .option('-k, --kind <kind>', '(--by name) Filter by node kind (function, class, etc.)')
    .option('-m, --mode <m>', '(--by name) Search mode: exact (default) | fuzzy | semantic | intent', 'exact')
    .option(
      '-s, --symbol <name>',
      '(--by name --mode semantic) Source symbol name for peer lookup; mutually exclusive with [query]',
    )
    .option('--same-language', '(--by name --mode semantic + symbol) Restrict to same language as source')
    .option('--different-language', '(--by name --mode semantic + symbol) Restrict to a different language than source')
    .option(
      '--language-filter <lang>',
      '(--by name --mode semantic + query / --mode intent) Restrict results to one language',
    )
    .option('-c, --case-sensitive', '(--by content) Case-sensitive regex (default: insensitive)')
    .option(
      '--path-filter <prefix>',
      '(--by content / --by name --mode intent) Restrict to files under this path prefix',
    )
    .option('--language <lang>', '(--by content) Restrict to one language (typescript / python / …)')
    .option('--key <key>', '(--by env / --by sql) Specific env-var name or table name; omit for the top-N listing')
    .option('--op <op>', '(--by sql) Filter by op (read | write | ddl)')
    .option(
      '--no-include-tests',
      '(--by env / --by sql) Hide test-only entries (default: keep them, ranked behind prod)',
    )
    .option(
      '--since <call-id>',
      'Delta mode: pass a `c_xxxxxxxx` UID to return only NEW rows (--by name + --mode exact, or --by content)',
    )
    .option('--allow-stale', 'Bypass the freshness gate; query the cached index even when stale')
    .option('--low-tokens', 'Prefer compact output: compact exact-name rows and lower default caps')
    .option('--compact', '(--by name --mode exact) Emit terse pipe-delimited rows (name|kind|path:line|sig:…|id:…)')
    .option(
      '--fields <fields>',
      '(--by name --mode exact, with --compact) Comma-separated subset of fields (name,kind,path,line,signature,id)',
    )
    .action(async (query: string | undefined, options: FindOptions) => {
      const result = buildFindMcpArgs(query, options);
      if (!result.ok) {
        deps.error(result.error);
        process.exitCode = 1;
        return;
      }
      await deps.runViaMCP('cartograph_find', result.args, options.projectPath);
    });
}
