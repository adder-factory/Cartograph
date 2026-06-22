import { errMsg } from '../../errors.js';
import {
  buildRecommendedConfigWriteOptions,
  formatInstallModelProgress,
  printInstallModelResults,
  type InstallModelResult,
} from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

export interface AdminInstallModelsCommandDeps {
  adminCmd: CommandLike;
  loadInstallModels: () => Promise<{
    installRecommendedModels: (opts: {
      dir?: string;
      models: readonly unknown[];
      onProgress: (progress: { model: { filename: string }; downloaded: number; total: number }) => void;
    }) => Promise<InstallModelResult>;
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
      diff: { addedOrUpdated: readonly string[] };
    };
  }>;
  resolveProjectPath: (pathArg?: string) => string;
  writeStderr: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminInstallModelsCommand(deps: AdminInstallModelsCommandDeps): void {
  const {
    adminCmd,
    error,
    info,
    loadInstallModels,
    loadRecommendedConfig,
    loadRecommendedModels,
    resolveProjectPath,
    success,
    writeStderr,
  } = deps;
  adminCmd
    .command('install-models')
    .description(
      "Download the recommended GGUF set into ~/.cartograph/models/ (mirrors cartograph_admin MCP tool with action='install-models').",
    )
    .option('--dir <path>', 'Directory to install GGUFs into (overrides ~/.cartograph/models)')
    .option(
      '--minimal',
      'Only install the smallest viable subset (embed + 3B chat, ~2.1 GB) instead of the full ~7 GB set.',
    )
    .option(
      '--write-config',
      'After download, merge the recommended LLM block into .cartograph/config.json (creates a .bak.<timestamp> first). Default off for back-compat.',
    )
    .option('-p, --project-path <path>', 'Project root for --write-config (default: cwd)')
    .action(async (options: { dir?: string; minimal?: boolean; writeConfig?: boolean; projectPath?: string }) => {
      try {
        const { installRecommendedModels } = await loadInstallModels();
        const { RECOMMENDED_MODELS, MINIMAL_MODELS } = await loadRecommendedModels();
        const installOpts = options.dir ? { dir: options.dir } : {};
        const result = await installRecommendedModels({
          ...installOpts,
          models: options.minimal ? MINIMAL_MODELS : RECOMMENDED_MODELS,
          onProgress: (progress) => {
            writeStderr(formatInstallModelProgress(progress));
          },
        });
        writeStderr('\n');
        printInstallModelResults(result, { success, info });

        if (options.writeConfig) {
          const projectRoot = resolveProjectPath(options.projectPath);
          const { writeRecommendedLlmConfig } = await loadRecommendedConfig();
          const writeConfigInput: { projectRoot: string; dir?: string; minimal?: boolean } = { projectRoot };
          if (options.dir) writeConfigInput.dir = options.dir;
          if (options.minimal !== undefined) writeConfigInput.minimal = options.minimal;
          const { configPath, backupPath, diff } = writeRecommendedLlmConfig(
            buildRecommendedConfigWriteOptions(writeConfigInput),
          );
          if (backupPath) {
            info(`Backup written: ${backupPath}`);
          }
          success(`Updated ${configPath}`);
          if (diff.addedOrUpdated.length > 0) {
            info(`  added/updated: ${diff.addedOrUpdated.join(', ')}`);
          }
          info(`Next: cartograph backend start ${projectRoot}`);
          info(`      cartograph llm smoke ${projectRoot}`);
          info(`      cartograph doctor ${projectRoot}`);
        } else {
          info(
            'Next: re-run with `--write-config` to merge the recommended LLM block into .cartograph/config.json, or run `cartograph admin llm-plan` then `cartograph admin llm-apply --preset <id>` for a detected/cloud backend.',
          );
        }
      } catch (err) {
        error(`install-models failed: ${errMsg(err)}`);
        process.exitCode = 1;
      }
    });
}
