import { errMsg } from '../../errors.js';
import { parseLlmTuneOverride } from './runtime.js';
import type { CliRequiredOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliRequiredOptionCommand;

interface LlmSetupPlanModule {
  planLlmSetup: () => Promise<{
    recommendedPresetId: string;
    detectedBackends: ReadonlyArray<{ label: string; endpoint: string; models: readonly string[] }>;
    presets: ReadonlyArray<{ id: string; summary: string }>;
  }>;
  applyLlmSetupChoice: (opts: { projectRoot: string; preset: string }) => Promise<{
    applied: boolean;
    preset: string;
    configPath: string;
    backupPath?: string | null;
    notes: readonly string[];
    nextSteps: readonly string[];
  }>;
  writeLlmTierConcurrencyOverride: (opts: { projectRoot: string; tier: string; concurrency: number }) => Promise<{
    configPath: string;
    backupPath?: string | null;
    configKey: string;
    previous?: number;
    concurrency: number;
  }>;
}

interface HardwareTuningModule {
  describeHardware: () => string;
  recommendedTuning: () => {
    embed: { cartographConcurrency: number };
    chat: { cartographConcurrency: number };
    ask: { cartographConcurrency: number };
    reranker: { cartographConcurrency: number };
  };
}

export interface AdminLlmSetupCommandDeps {
  adminCmd: CommandLike;
  loadLlmSetupPlan: () => Promise<LlmSetupPlanModule>;
  loadHardwareTuning: () => Promise<HardwareTuningModule>;
  resolveProjectPath: (pathArg?: string) => string;
  writeStdout: (message: string) => void;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminLlmSetupCommands(deps: AdminLlmSetupCommandDeps): void {
  registerLlmPlanCommand(deps);
  registerLlmApplyCommand(deps);
  registerLlmTuneCommand(deps);
}

function registerLlmPlanCommand(deps: AdminLlmSetupCommandDeps): void {
  const { adminCmd, error, loadLlmSetupPlan, writeStdout } = deps;
  adminCmd
    .command('llm-plan')
    .description("Print agent-friendly LLM setup presets (mirrors cartograph_admin MCP tool with action='llm-plan')")
    .action(async () => {
      try {
        const { planLlmSetup } = await loadLlmSetupPlan();
        const plan = await planLlmSetup();
        writeStdout(`Recommended preset: ${plan.recommendedPresetId}\n`);
        writeStdout('\n');
        writeStdout('Detected backends:\n');
        if (plan.detectedBackends.length === 0) {
          writeStdout('- none\n');
        } else {
          for (const b of plan.detectedBackends) {
            writeStdout(
              `- ${b.label} at ${b.endpoint} (${b.models.length} model${b.models.length === 1 ? '' : 's'})\n`,
            );
          }
        }
        writeStdout('\n');
        writeStdout('Available presets:\n');
        for (const preset of plan.presets) {
          writeStdout(`- ${preset.id} — ${preset.summary}\n`);
        }
      } catch (err) {
        error(`llm-plan failed: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

function registerLlmApplyCommand(deps: AdminLlmSetupCommandDeps): void {
  const { adminCmd, error, info, loadLlmSetupPlan, resolveProjectPath, success, writeStdout } = deps;
  adminCmd
    .command('llm-apply')
    .description(
      "Apply an LLM setup preset non-interactively (mirrors cartograph_admin MCP tool with action='llm-apply')",
    )
    .requiredOption('--preset <id>', 'Preset id returned by `cartograph admin llm-plan`')
    .option('-p, --project-path <path>', 'Project root to write config for (default: cwd)')
    .action(async (options: { preset: string; projectPath?: string }) => {
      const projectRoot = resolveProjectPath(options.projectPath);
      try {
        const { applyLlmSetupChoice } = await loadLlmSetupPlan();
        const result = await applyLlmSetupChoice({
          projectRoot,
          preset: options.preset,
        });
        if (result.applied) {
          success(`Applied preset ${result.preset}: ${result.configPath}`);
          if (result.backupPath) info(`Backup written: ${result.backupPath}`);
        } else {
          info(`Preset ${result.preset}: no config written`);
        }
        if (result.notes.length > 0) {
          for (const note of result.notes) info(note);
        }
        if (result.nextSteps.length > 0) {
          info('Next steps:');
          for (const step of result.nextSteps) writeStdout(`  ${step}\n`);
        }
      } catch (err) {
        error(`llm-apply failed: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}

function registerLlmTuneCommand(deps: AdminLlmSetupCommandDeps): void {
  const { adminCmd, error, info, loadHardwareTuning, loadLlmSetupPlan, resolveProjectPath, success, writeStdout } =
    deps;
  adminCmd
    .command('llm-tune [path]')
    .description(
      "Inspect or override LLM concurrency tuning (mirrors cartograph_admin MCP tool with action='llm-tune')",
    )
    .option('--tier <name>', 'Tier to override: embed, chat, ask, reranker')
    .option('--concurrency <n>', 'Positive integer concurrency override for --tier')
    .action(async (pathArg: string | undefined, options: { tier?: string; concurrency?: string }) => {
      const projectPath = resolveProjectPath(pathArg);
      try {
        const { describeHardware, recommendedTuning } = await loadHardwareTuning();
        const tuning = recommendedTuning();
        if (!options.tier) {
          writeStdout(`Detected: ${describeHardware()}\n`);
          writeStdout(`embed: ${tuning.embed.cartographConcurrency}\n`);
          writeStdout(`chat: ${tuning.chat.cartographConcurrency}\n`);
          writeStdout(`ask: ${tuning.ask.cartographConcurrency}\n`);
          writeStdout(`reranker: ${tuning.reranker.cartographConcurrency}\n`);
          return;
        }

        const parsed = parseLlmTuneOverride(options);
        if (!parsed.ok) {
          error(parsed.error);
          process.exit(1);
        }

        const { writeLlmTierConcurrencyOverride } = await loadLlmSetupPlan();
        const result = await writeLlmTierConcurrencyOverride({
          projectRoot: projectPath,
          tier: parsed.tier,
          concurrency: parsed.concurrency,
        });
        success(`Updated ${result.configPath}`);
        if (result.backupPath) info(`Backup written: ${result.backupPath}`);
        info(`llm.${result.configKey}.concurrency: ${result.previous ?? '(unset)'} → ${result.concurrency}`);
      } catch (err) {
        error(`llm-tune failed: ${errMsg(err)}`);
        process.exit(1);
      }
    });
}
