/**
 * Top-level read-query CLI commands (at-range / ask / status / find /
 * digest / files / affected) — extracted from the bin/cartograph.ts
 * decomposition; side-effecting module: importing it registers the
 * commands on `program`.
 */
import * as fs from 'node:fs';
import { getAllFilesWithSymbolCount } from '../../db/queries-files.js';
import { getFileSummaries } from '../../db/queries-file-summaries.js';
import { buildIndexedPathSets, findAffectedTests } from '../../affected-core.js';
import { buildDirRollup, filterFilesByDir } from '../../mcp/tools/files.js';
import { registerAffectedCommand as registerAffectedFeatureCommand } from '../../features/affected/index.js';
import { registerAskCommand as registerAskFeatureCommand } from '../../features/ask/index.js';
import { registerAtRangeCommand as registerAtRangeFeatureCommand } from '../../features/at-range/index.js';
import { registerDigestCommand } from '../../features/digest/index.js';
import { registerFilesCommand as registerFilesFeatureCommand } from '../../features/files/index.js';
import { isValidFindAxis, parseFieldsOption, registerFindCommand } from '../../features/find/index.js';
import { registerStatusCommand as registerStatusFeatureCommand } from '../../features/status/index.js';
import { isInitialized } from '../../directory.js';
import { detectPackageManager, packageScriptCommand, readPackageScripts } from '../../package-scripts.js';
import {
  program,
  error,
  success,
  info,
  warn,
  chalk,
  resolveProjectPath,
  loadCartograph,
  formatNumber,
  runViaMCP,
} from '../_cli-core.js';

function out(message = ''): void {
  process.stdout.write(`${message}\n`);
}

interface CommandLike {
  command(name: string): CommandLike;
  description(text: string): CommandLike;
  argument(...args: unknown[]): CommandLike;
  option(...args: unknown[]): CommandLike;
  action(fn: (...args: any[]) => unknown): CommandLike;
}

interface ReadCartographModule {
  default: {
    open: (projectPath: string) => Promise<any>;
  };
}

export interface ReadCommandDeps {
  program: CommandLike;
  error: typeof error;
  info: typeof info;
  resolveProjectPath: typeof resolveProjectPath;
  loadCartograph: () => Promise<ReadCartographModule>;
  runViaMCP: typeof runViaMCP;
  isInitialized: typeof isInitialized;
  getAllFilesWithSymbolCount: typeof getAllFilesWithSymbolCount;
  getFileSummaries: typeof getFileSummaries;
  filterFilesByDir: typeof filterFilesByDir;
  buildDirRollup: typeof buildDirRollup;
  buildIndexedPathSets: typeof buildIndexedPathSets;
  findAffectedTests: typeof findAffectedTests;
  loadGitUtils: () => Promise<{ listChangedFilesSince: (projectPath: string, ref: string) => string[] | null }>;
}

const defaultReadCommandDeps: ReadCommandDeps = {
  program,
  error,
  info,
  resolveProjectPath,
  loadCartograph: loadCartograph as () => Promise<ReadCartographModule>,
  runViaMCP,
  isInitialized,
  getAllFilesWithSymbolCount,
  getFileSummaries,
  filterFilesByDir,
  buildDirRollup,
  buildIndexedPathSets,
  findAffectedTests,
  loadGitUtils: (() => import('../../git-utils.js')) as ReadCommandDeps['loadGitUtils'],
};

function registerAtRangeReadCommand(deps: ReadCommandDeps): void {
  registerAtRangeFeatureCommand({ ...deps, warn });
}

function registerAskReadCommand(deps: ReadCommandDeps): void {
  registerAskFeatureCommand({
    ...deps,
    writeLine: out,
    dim: chalk.dim,
  });
}

function registerStatusReadCommand(deps: ReadCommandDeps): void {
  registerStatusFeatureCommand({
    ...deps,
    success,
    warn,
    formatNumber,
    writeLine: out,
    style: {
      bold: chalk.bold,
      cyan: chalk.cyan,
      dim: chalk.dim,
      magenta: chalk.magenta,
      yellow: chalk.yellow,
    },
  });
}

function registerFilesReadCommand(deps: ReadCommandDeps): void {
  registerFilesFeatureCommand({
    ...deps,
    writeLine: out,
    style: {
      bold: chalk.bold,
      cyan: chalk.cyan,
      dim: chalk.dim,
    },
  });
}

function registerAffectedReadCommand(deps: ReadCommandDeps): void {
  registerAffectedFeatureCommand({
    ...deps,
    readStdin: () => fs.readFileSync(0, 'utf-8'),
    packageDeps: {
      detectPackageManager,
      readPackageScripts,
      packageScriptCommand,
    },
    writeLine: out,
    style: {
      bold: chalk.bold,
      cyan: chalk.cyan,
      dim: chalk.dim,
      yellow: chalk.yellow,
    },
  });
}

export function registerReadCommands(deps: ReadCommandDeps = defaultReadCommandDeps): void {
  registerAtRangeReadCommand(deps);
  registerAskReadCommand(deps);
  registerStatusReadCommand(deps);
  registerFindCommand(deps);
  registerDigestCommand(deps);
  registerFilesReadCommand(deps);
  registerAffectedReadCommand(deps);
}

registerReadCommands();

export const __readCommandInternals = {
  parseFieldsOption,
  isValidFindAxis,
};
