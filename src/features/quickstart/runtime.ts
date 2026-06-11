import { errMsg } from '../../errors.js';

const INDEX_ERROR_PREVIEW_LIMIT = 5;
const MS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const SHELL_SINGLE_QUOTE_ESCAPE = String.raw`'\''`;

interface QuickstartIndexResult {
  success: boolean;
  filesIndexed: number;
  filesSkipped: number;
  filesErrored: number;
  nodesCreated: number;
  edgesCreated: number;
  durationMs: number;
  errors?: Array<{ message: string; filePath?: string }>;
}

interface QuickstartGraph {
  indexAll: (options: { summarize: false }) => Promise<QuickstartIndexResult>;
  close: () => void;
}

export interface QuickstartCartographModule {
  default: {
    init: (projectPath: string, options: { index: false }) => Promise<QuickstartGraph>;
    open: (projectPath: string, options: { autoMigrate: true }) => Promise<QuickstartGraph>;
  };
}

interface QuickstartDoctorResult {
  overallStatus: string;
  afterFix?: { overallStatus: string };
}

interface QuickstartDoctorModule {
  runDoctor: (opts: { projectPath: string }) => Promise<QuickstartDoctorResult>;
}

export interface QuickstartRuntimeDeps {
  isInitialized: (projectPath: string) => boolean;
  info: (message: string) => void;
  loadCartograph: () => Promise<QuickstartCartographModule>;
  loadDoctor: () => Promise<QuickstartDoctorModule>;
}

export interface RunQuickstartOptions {
  projectPath: string;
}

export interface QuickstartRunResult {
  projectPath: string;
  initialized: boolean;
  index: QuickstartIndexResult;
  doctor: QuickstartDoctorResult;
}

export async function runQuickstart(
  options: RunQuickstartOptions,
  deps: QuickstartRuntimeDeps,
): Promise<QuickstartRunResult> {
  const { projectPath } = options;
  const { default: Cartograph } = await deps.loadCartograph();
  const alreadyInitialized = deps.isInitialized(projectPath);
  let cg: QuickstartGraph | undefined;

  try {
    if (alreadyInitialized) {
      deps.info(`Step 1/3: ${projectPath} already initialized`);
      cg = await Cartograph.open(projectPath, { autoMigrate: true });
    } else {
      deps.info(`Step 1/3: initialising Cartograph at ${projectPath}`);
      cg = await Cartograph.init(projectPath, { index: false });
    }

    deps.info('Step 2/3: indexing structural graph');
    const index = await cg.indexAll({ summarize: false });

    deps.info('Step 3/3: running doctor verification');
    const { runDoctor } = await deps.loadDoctor();
    const doctor = await runDoctor({ projectPath });

    return {
      projectPath,
      initialized: !alreadyInitialized,
      index,
      doctor,
    };
  } catch (err) {
    throw new Error(`quickstart failed: ${errMsg(err)}`);
  } finally {
    cg?.close();
  }
}

export function renderQuickstartReport(result: QuickstartRunResult): string {
  const { projectPath, index, doctor } = result;
  const lines = [
    '## cartograph quickstart',
    '',
    initializationLine(result),
    indexStatusLine(index),
    doctorStatusLine(doctor),
  ];

  appendIndexErrors(lines, index);
  lines.push(
    '',
    '### Try next',
    '',
    '```sh',
    `cd ${shellQuote(projectPath)}`,
    'cartograph status --verbose',
    'cartograph find "SymbolName" --mode fuzzy',
    'cartograph viewer .',
    '```',
    '',
    '### Wire up your coding agent (MCP config + git hooks)',
    '',
    '```sh',
    'cartograph install --yes --location=local',
    '```',
    '',
    '### Optional LLM setup',
    '',
    '```sh',
    'cartograph admin llm-plan .',
    'cartograph admin llm-apply --preset <id> .',
    'cartograph backend start .',
    'cartograph llm smoke .',
    'cartograph doctor .',
    '```',
  );
  return lines.join('\n');
}

function initializationLine(result: QuickstartRunResult): string {
  if (result.initialized) return `✓ Initialized: ${result.projectPath}`;
  return `✓ Already initialized: ${result.projectPath}`;
}

function indexStatusLine(index: QuickstartIndexResult): string {
  const marker = index.success ? '✓' : '✗';
  return `${marker} Indexed: ${indexSummary(index)}`;
}

function indexSummary(index: QuickstartIndexResult): string {
  if (!index.success) return `failed after ${formatDuration(index.durationMs)}`;
  return `${formatNumber(index.filesIndexed)} files, ${formatNumber(index.nodesCreated)} nodes, ${formatNumber(index.edgesCreated)} edges in ${formatDuration(index.durationMs)}`;
}

function doctorStatusLine(doctor: QuickstartDoctorResult): string {
  const status = finalDoctorStatus(doctor);
  return `${doctorMarker(status)} Doctor: ${doctorSummary(status)}`;
}

function appendIndexErrors(lines: string[], index: QuickstartIndexResult): void {
  if (index.success) return;
  const errors = index.errors ?? [];
  if (errors.length === 0) return;

  lines.push('', '### Index errors');
  for (const err of errors.slice(0, INDEX_ERROR_PREVIEW_LIMIT)) {
    const prefix = err.filePath ? `${err.filePath}: ` : '';
    lines.push(`- ${prefix}${err.message}`);
  }
}

function finalDoctorStatus(result: QuickstartDoctorResult): string {
  return result.afterFix?.overallStatus ?? result.overallStatus;
}

function doctorMarker(status: string): string {
  return status === 'fail' ? '⚠' : '✓';
}

function doctorSummary(status: string): string {
  switch (status) {
    case 'ok':
      return 'ready';
    case 'warn':
      return 'ready with follow-up';
    default:
      return 'core index ready; doctor found setup gaps';
  }
}

function formatNumber(value: number): string {
  return value.toLocaleString();
}

function formatDuration(ms: number): string {
  if (ms < MS_PER_SECOND) return `${ms}ms`;
  const seconds = ms / MS_PER_SECOND;
  if (seconds < SECONDS_PER_MINUTE) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / SECONDS_PER_MINUTE);
  return `${minutes}m ${(seconds % SECONDS_PER_MINUTE).toFixed(0)}s`;
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", SHELL_SINGLE_QUOTE_ESCAPE)}'`;
}
