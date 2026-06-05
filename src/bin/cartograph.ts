#!/usr/bin/env bun
/**
 * Cartograph CLI — entry point.
 *
 * Shebang is `#!/usr/bin/env bun` (not node) because the cartograph
 * runtime imports `bun:sqlite` + `bun:ffi` — Node has no module
 * resolver for those URL schemes and crashes with
 * ERR_UNSUPPORTED_ESM_URL_SCHEME the moment the db layer is reached.
 * `engines.bun >= 1.3.0` makes Bun a hard requirement of the package;
 * the shebang matches that contract. Users without Bun installed see
 * the clear "bun: command not found" message (vs the cryptic ESM
 * error they got under the old node shebang), and AGENTS.md Step 0
 * tells them how to fix it.
 *
 * Command-line interface for Cartograph code intelligence.
 *
 * Usage:
 *   cartograph                      Run interactive installer (when no args)
 *   cartograph install              Run interactive installer
 *   cartograph admin init [path]    Initialize Cartograph in a project
 *   cartograph admin index [path]   Index all files in the project
 *   cartograph status [path]        Show index status
 *   cartograph find [query]         Find symbols / content / refs
 *   cartograph context <task>       Build context for a task
 *
 * STRUCTURE — this file used to be a ~3900-line god-module. It is now
 * decomposed:
 *   - `_cli-core.ts`     — the commander `program`, family-parent
 *                          commands, and stateless helpers.
 *   - `commands/*.ts`    — the command definitions, one module per
 *                          group; each is SIDE-EFFECTING — importing it
 *                          registers its commands on `program`.
 * This entry point is thin: the Node-version preflight, the command-
 * module imports, and `program.parse()`.
 */

// FIRST import — a Node-version preflight that must run before any
// import below pulls in the db layer's `node:sqlite` dependency. See
// version-check.ts. On Node < 22.5 it prints a clear message + exits.
import './version-check.js';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { errMsg } from '../errors.js';
import { editDistance } from '../text-distance.js';
import { program, error } from './_cli-core.js';
export { program } from './_cli-core.js';

// Command groups — each module is side-effecting: importing it
// registers that group's commands on `program` / a family parent.
// `_cli-core.js` (imported above) has already created `program` and
// the family-parent commands, so these are safe to pull in here.
import './commands/admin.js';
import './commands/read.js';
import './commands/lifecycle.js';
import './commands/review.js';
import './commands/summaries.js';
import './commands/session.js';
import './commands/generated.js';

function isEpipe(error: unknown): boolean {
  return (error as { code?: string } | undefined)?.code === 'EPIPE';
}

function exitOnEpipe(error: unknown): void {
  if (isEpipe(error)) process.exit(0);
}

process.stdout.on('error', exitOnEpipe);
process.stderr.on('error', exitOnEpipe);

// Warn about unsupported Node.js versions (Node 25+ has V8 turboshaft WASM bugs)
const nodeVersion = process.versions.node;
const nodeMajor = Number.parseInt(nodeVersion.split('.')[0] ?? '0', 10);
if (nodeMajor >= 25) {
  process.stderr.write(
    `\x1b[33m⚠\x1b[0m  Cartograph may crash on Node.js ${nodeVersion} due to a V8 WASM compiler bug in Node 25+.\n`,
  );
  process.stderr.write('   Please use Node.js 22 LTS instead: https://nodejs.org/en/download\n');
  process.stderr.write('   See: https://github.com/adder-factory/cartograph/issues\n\n');
}

// Global error handlers — attached before any registration work so
// early throws (e.g. corrupted lazy imports) are caught.
process.on('uncaughtException', (error) => {
  if ((error as NodeJS.ErrnoException).code === 'EPIPE') process.exit(0);
  process.stderr.write(`[Cartograph] Uncaught exception: ${String(error)}\n`);
});

process.on('unhandledRejection', (reason) => {
  if ((reason as NodeJS.ErrnoException | undefined)?.code === 'EPIPE') process.exit(0);
  process.stderr.write(`[Cartograph] Unhandled rejection: ${String(reason)}\n`);
});

// The configured commander program is re-exported above so structural
// tests can introspect the command tree without spawning the CLI.

// Hand off the no-arg path to the interactive installer; otherwise
// dispatch the CLI normally. Done at the bottom so all command
// registrations above have run before parse().
//
// Run only when this file IS the process entry point. Tests that
// `import` this module to introspect `program` will skip this block
// because `process.argv[1]` points at the test runner, not this file.
// Symlinks (e.g. npm-installed `cartograph` bin) are resolved on both
// sides via `realpathSync` so a `node /path/to/cartograph` invocation
// through a wrapper still matches.
//
// Error handling: ENOENT means the path doesn't exist on disk (most
// commonly: argv[1] is a wrapper that was deleted between launch and
// import) — fall through silently because there's nothing to compare.
// Anything else (EACCES, EIO, etc.) is unexpected and would silently
// suppress CLI parse if swallowed, so we log to stderr before
// returning false so an operator sees why the CLI didn't dispatch.
function isBunStandaloneModulePath(modulePath: string): boolean {
  return modulePath.startsWith('/$bunfs/');
}

function cliUserArgs(): string[] {
  return process.argv.slice(2);
}

function isEntryPoint(): boolean {
  const modulePath = fileURLToPath(import.meta.url);
  // Bun standalone executables expose bundled modules under a virtual
  // `/$bunfs/root/...` path. There is no on-disk module path to compare
  // with argv[1], and this file is only bundled as the executable entry.
  if (isBunStandaloneModulePath(modulePath)) return true;
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(modulePath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      process.stderr.write(`cartograph: entry-point check failed (${code ?? 'unknown'}); CLI dispatch skipped\n`);
    }
    return false;
  }
}

function topLevelCommandSuggestion(input: string): string | undefined {
  let best: { name: string; dist: number } | undefined;
  for (const command of program.commands) {
    const name = command.name();
    if (!name || name === 'help') continue;
    const dist = editDistance(input, name);
    if (!best || dist < best.dist) best = { name, dist };
  }
  if (!best) return undefined;
  return best.dist <= Math.max(3, Math.ceil(input.length / 3)) ? best.name : undefined;
}

function rejectUnknownCommandHelp(): boolean {
  const args = cliUserArgs();
  if (!args.some((arg) => arg === '--help' || arg === '-h')) return false;
  const firstCommand = args.find((arg) => arg !== '--help' && arg !== '-h' && !arg.startsWith('-'));
  if (!firstCommand || firstCommand === 'help') return false;
  const known = new Set(program.commands.map((command) => command.name()));
  if (known.has(firstCommand)) return false;
  const suggestion = topLevelCommandSuggestion(firstCommand);
  error(
    `Unknown command '${firstCommand}'.` +
      (suggestion ? ` Did you mean ${suggestion}?` : ` Run 'cartograph --help' for available commands.`),
  );
  process.exitCode = 1;
  return true;
}

if (isEntryPoint()) {
  if (cliUserArgs().length === 0) {
    try {
      const { runInstaller } = await import('../installer/index.js');
      await runInstaller();
    } catch (err) {
      process.stderr.write(`Installation failed: ${errMsg(err)}\n`);
      process.exit(1);
    }
  } else if (!rejectUnknownCommandHelp()) {
    program.parse();
  }
}
