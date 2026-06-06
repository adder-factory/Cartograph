import { errMsg } from '../../errors.js';

export interface SetupCartographModule {
  default: {
    init: (projectPath: string, options: { index: boolean }) => Promise<{ close: () => void }>;
  };
}

export interface SetupDoctorResult {
  overallStatus: string;
  afterFix?: { overallStatus: string };
}

export interface SetupDoctorModule {
  runDoctor: (opts: { projectPath: string }) => Promise<SetupDoctorResult>;
  formatDoctorReport: (result: SetupDoctorResult) => string;
}

export interface SetupRuntimeDeps {
  isInitialized: (projectPath: string) => boolean;
  info: (message: string) => void;
  error: (message: string) => void;
  writeProgress: (message: string) => void;
  loadCartograph: () => Promise<SetupCartographModule>;
  loadDoctor: () => Promise<SetupDoctorModule>;
  loadInstallModels: () => Promise<{
    installRecommendedModels: (opts: {
      models: readonly unknown[];
      onProgress: (progress: { model: { filename: string }; downloaded: number; total: number }) => void;
    }) => Promise<{ downloaded: unknown[]; skipped: unknown[] }>;
  }>;
  loadRecommendedModels: () => Promise<{ RECOMMENDED_MODELS: readonly unknown[]; MINIMAL_MODELS: readonly unknown[] }>;
  loadRecommendedConfig: () => Promise<{
    writeRecommendedLlmConfig: (opts: {
      projectRoot: string;
      dir?: string;
      includeAsk?: boolean;
      includeReranker?: boolean;
    }) => {
      configPath: string;
      backupPath?: string | null;
    };
  }>;
}

export interface RunSetupOptions {
  projectPath: string;
  minimal?: boolean;
  models?: boolean;
}

export interface SetupRunResult {
  doctor: SetupDoctorResult;
  doctorReport: string;
}

export async function runSetup(options: RunSetupOptions, deps: SetupRuntimeDeps): Promise<SetupRunResult> {
  const { projectPath } = options;
  const { runDoctor, formatDoctorReport } = await deps.loadDoctor();

  await runSetupInitStep(projectPath, deps);
  await runSetupModelStep(projectPath, options, deps);
  deps.info('Step 3/3: running doctor verification');
  const doctor = await runDoctor({ projectPath });
  return { doctor, doctorReport: formatDoctorReport(doctor) };
}

async function runSetupInitStep(projectPath: string, deps: SetupRuntimeDeps): Promise<void> {
  const { isInitialized, info, loadCartograph } = deps;
  if (isInitialized(projectPath)) {
    info(`Step 1/3: ${projectPath} already initialized — skipping init`);
    return;
  }

  info(`Step 1/3: initialising Cartograph at ${projectPath}`);
  const { default: Cartograph } = await loadCartograph();
  const cg = await Cartograph.init(projectPath, { index: false });
  cg.close();
}

async function runSetupModelStep(
  projectPath: string,
  options: { minimal?: boolean; models?: boolean },
  deps: SetupRuntimeDeps,
): Promise<void> {
  const { info, error, writeProgress, loadInstallModels, loadRecommendedModels } = deps;
  if (options.models === false) {
    info('Step 2/3: --no-models → skipping models install');
    info(
      '  Next: configure an existing or backend-managed LLM with `cartograph admin llm-plan` then `cartograph admin llm-apply --preset <id> --project-path <project>`, or hand-edit `.cartograph/config.json`.',
    );
    info('  Then run `cartograph llm smoke <project>` and `cartograph doctor <project>` to verify real requests.');
    return;
  }

  info(`Step 2/3: installing ${options.minimal ? 'minimal' : 'full'} GGUF set`);
  const { installRecommendedModels } = await loadInstallModels();
  const { RECOMMENDED_MODELS, MINIMAL_MODELS } = await loadRecommendedModels();
  const modelSet = options.minimal ? MINIMAL_MODELS : RECOMMENDED_MODELS;
  try {
    const result = await installRecommendedModels({
      models: modelSet,
      onProgress: ({ model, downloaded, total }) => {
        const mb = (n: number): string => (n / BYTES_PER_MIB).toFixed(0);
        const pct = total > 0 ? ((downloaded / total) * PERCENT_SCALE).toFixed(0) : '?';
        writeProgress(`\r  ${model.filename}: ${mb(downloaded)}/${total > 0 ? mb(total) : '?'} MB (${pct}%)   `);
      },
    });
    writeProgress('\n');
    if (result.downloaded.length > 0) info(`  downloaded ${result.downloaded.length} GGUF(s)`);
    if (result.skipped.length > 0) info(`  ${result.skipped.length} already present (skipped)`);
    await writeSetupRecommendedConfig(projectPath, deps, { minimal: options.minimal === true });
  } catch (error_) {
    error(`install-models failed: ${errMsg(error_)}`);
    // Models are needed for LLM features, but the user might already
    // have a working subset from a prior run. doctor will catch a true gap.
  }
}

const BYTES_PER_MIB = 1024 * 1024;
const PERCENT_SCALE = 100;

async function writeSetupRecommendedConfig(
  projectPath: string,
  deps: SetupRuntimeDeps,
  options: { minimal: boolean },
): Promise<void> {
  const { info, loadRecommendedConfig } = deps;
  const { writeRecommendedLlmConfig } = await loadRecommendedConfig();
  const writeOpts: { projectRoot: string; dir?: string; includeAsk?: boolean; includeReranker?: boolean } = {
    projectRoot: projectPath,
  };
  if (options.minimal) {
    writeOpts.includeAsk = false;
    writeOpts.includeReranker = false;
  }
  const { configPath, backupPath } = writeRecommendedLlmConfig(writeOpts);
  info(`  wrote ${options.minimal ? 'minimal' : 'recommended'} LLM config: ${configPath}`);
  if (backupPath) info(`  backup written: ${backupPath}`);
  info(`  next: cartograph backend start ${projectPath}`);
  info(`        cartograph llm smoke ${projectPath}`);
}
