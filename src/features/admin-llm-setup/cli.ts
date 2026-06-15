import { errMsg } from '../../errors.js';
import { parseLlmTuneOverride } from './runtime.js';
import type { CliRequiredOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliRequiredOptionCommand;

interface ConfiguredLocalBackends {
  configured: number;
  notRunning: ReadonlyArray<{ labels: readonly string[]; endpoint: string; modelExists: boolean }>;
  llamaServerOnPath: boolean;
  startCommand: string | null;
}

interface LlmSetupPlanModule {
  planLlmSetup: (opts?: { projectPath?: string }) => Promise<{
    recommendedPresetId: string;
    detectedBackends: ReadonlyArray<{ label: string; endpoint: string; models: readonly string[] }>;
    presets: ReadonlyArray<{ id: string; summary: string }>;
    localBackends: ConfiguredLocalBackends;
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
  const { adminCmd, error, loadLlmSetupPlan, resolveProjectPath, writeStdout } = deps;
  adminCmd
    .command('llm-plan [path]')
    .description("Print agent-friendly LLM setup presets (mirrors cartograph_admin MCP tool with action='llm-plan')")
    .action(async (pathArg: string | undefined) => {
      try {
        const projectPath = resolveProjectPath(pathArg);
        const { planLlmSetup } = await loadLlmSetupPlan();
        const plan = await planLlmSetup({ projectPath });
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
        writeConfiguredLocalBackends(plan.localBackends, writeStdout);
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

/** Render configured-but-not-running local tiers so the CLI tells the
 *  user to *start* their backend, not install a new one (issue #25). */
function writeConfiguredLocalBackends(lb: ConfiguredLocalBackends | undefined, writeStdout: (m: string) => void): void {
  if (!lb || lb.notRunning.length === 0) return;
  const tiers = lb.notRunning
    .map((b) => `${b.labels.join('/')} ${b.endpoint}${b.modelExists ? '' : ' (model file missing)'}`)
    .join(', ');
  writeStdout(`\n${lb.notRunning.length} configured local tier(s) not running: ${tiers}\n`);
  if (lb.startCommand && lb.llamaServerOnPath) {
    writeStdout(`  llama-server is installed — run \`${lb.startCommand}\` to start them (no new preset needed).\n`);
  } else if (lb.startCommand) {
    writeStdout('  llama-server is not on PATH — install llama.cpp, then `cartograph backend start <project>`.\n');
  }
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
