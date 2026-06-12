import { errMsg } from '../../errors.js';
import { copyPrivateFileSync, writePrivateFileAtomic } from '../../config.js';
import { type ToolOutcome, err, ok } from './_outcome.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';

/**
 * `cartograph_admin({action: 'llm-plan'})` — agent-friendly LLM setup
 * planner. Returns a JSON-shaped plan listing detected backends + the
 * setup presets the agent can offer the user. The user picks one, the
 * agent re-calls with `action: 'llm-apply', preset: <id>`. Designed
 * so an AI agent walking a user through cartograph install doesn't
 * need to drive the interactive @clack wizard.
 */
export async function handleLlmPlan(_ctx: ToolCtx, _args: Record<string, unknown>): Promise<ToolOutcome> {
  const { planLlmSetup } = await import('../../installer/llm-setup-plan.js');
  try {
    const plan = await planLlmSetup();
    const lines: string[] = ['## LLM setup plan', ''];
    appendDetectedBackends(lines, plan);
    appendCloudChatAvailability(lines, plan.cloudChatAvailable);
    lines.push('', `**Recommended preset:** \`${plan.recommendedPresetId}\``, '', '**Available presets:**');
    for (const p of plan.presets) {
      lines.push(`- \`${p.id}\` — **${p.label}**`, `  - ${p.description}`, `  - Summary: ${p.summary}`);
      if (p.nextSteps.length > 0) {
        lines.push('  - Next steps:');
        for (const step of p.nextSteps) lines.push(`    - \`${step}\``);
      }
    }
    lines.push(
      '',
      'To apply a preset: `cartograph_admin({action: "llm-apply", preset: "<id>", projectPath: "<absolute-project-path>"})`. The agent can show this list to the user, take their pick, and call back.',
    );
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`llm-plan failed: ${errMsg(error_)}`);
  }
}

export function appendDetectedBackends(
  lines: string[],
  plan: Awaited<ReturnType<typeof import('../../installer/llm-setup-plan.js')['planLlmSetup']>>,
): void {
  if (plan.detectedBackends.length === 0) {
    lines.push('**No backends detected.** Wizard recommends installing one (see presets below).', '');
    return;
  }
  lines.push('**Detected backends:**');
  for (const b of plan.detectedBackends) {
    const modelHint = b.models.length > 0 ? `${b.models.length} models loaded` : 'no models loaded';
    lines.push(`- ${b.label} at \`${b.endpoint}\` (${modelHint})`);
  }
  lines.push('');
}

export function appendCloudChatAvailability(
  lines: string[],
  cloudChatAvailable: { claudeBin: string | null; anthropicApiKey: boolean; openRouterApiKey?: boolean },
): void {
  if (cloudChatAvailable.claudeBin) {
    lines.push(`**Cloud chat available:** \`claude\` CLI at \`${cloudChatAvailable.claudeBin}\``);
  }
  if (cloudChatAvailable.anthropicApiKey) {
    lines.push('**Cloud chat available:** ANTHROPIC_API_KEY set');
  }
  if (cloudChatAvailable.openRouterApiKey) {
    lines.push('**Cloud chat available:** OPENROUTER_API_KEY set');
  }
}

/**
 * `cartograph_admin({action: 'llm-apply', preset: <id>})` — apply a
 * setup preset returned by `action: 'llm-plan'`. Writes
 * `.cartograph/config.json` (atomic + .bak.<ts> if a prior file
 * existed) and returns the next-step commands the user must run for
 * the configured endpoints to actually serve traffic.
 */
export async function handleLlmApply(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPath = typeof args['projectPath'] === 'string' ? args['projectPath'] : null;
  const preset = typeof args['preset'] === 'string' ? args['preset'] : '';
  if (!projectPath) {
    return err(
      "llm-apply requires `projectPath: <absolute-path>` — the wizard writes `<projectPath>/.cartograph/config.json` and silently falling back to the MCP server's cwd would land the config in the wrong project. Pass the project root explicitly.",
    );
  }
  if (!preset) {
    return err('llm-apply requires `preset: <id>`. Call `action: "llm-plan"` first to see available presets.');
  }
  const { applyLlmSetupChoice } = await import('../../installer/llm-setup-plan.js');
  try {
    const result = await applyLlmSetupChoice({
      projectRoot: projectPath,
      preset: preset as Parameters<typeof applyLlmSetupChoice>[0]['preset'],
    });
    if (result.applied) {
      // config.json was written to disk; the cached Cartograph for this project
      // holds a stale in-memory config copy that won't see the new LLM preset
      // until evicted. Force eviction so the next tool call (e.g. summarize)
      // re-opens the instance and loads the fresh config from disk.
      ctx.evictCachedProject(projectPath);
    }
    const lines: string[] = [`## Applied preset \`${result.preset}\``, '', formatAppliedPresetLine(result)];
    if (result.notes.length > 0) {
      lines.push('', '**Notes:**');
      for (const n of result.notes) lines.push(`- ${n}`);
    }
    if (result.nextSteps.length > 0) {
      lines.push('', '**Next steps (run these to bring the configured endpoints up):**');
      for (const step of result.nextSteps) lines.push(`- \`${step}\``);
    }
    return ok(textResult(lines.join('\n')));
  } catch (error_) {
    return err(`llm-apply failed: ${errMsg(error_)}`);
  }
}

export function formatAppliedPresetLine(result: {
  readonly applied: boolean;
  readonly configPath: string | null;
  readonly backupPath: string | null;
}): string {
  if (!result.applied) return 'No config written.';
  const backupSuffix = result.backupPath ? ` (backup at \`${result.backupPath}\`)` : '';
  return `Wrote \`${result.configPath}\`${backupSuffix}.`;
}

/**
 * `cartograph_admin({action: 'llm-tune'})` — agent-friendly tuning
 * inspector + writer. Two modes:
 *
 *   Read mode (no `tier` arg) — returns detected hardware + the
 *     recommended per-tier `{llamaServerParallel, cartographConcurrency}`
 *     + the user's current per-tier overrides from config (if any).
 *     Agent renders this in chat so the user can compare what's
 *     auto-tuned vs what they've manually pinned.
 *
 *   Write mode (`tier: '<embed|chat|ask|reranker>', concurrency: N`)
 *     — applies a user override to the corresponding *Llm.concurrency
 *     field in `.cartograph/config.json` (atomic + `.bak.<ts>` backup
 *     if a prior file existed). Cartograph reads the override next
 *     time it embeds/summarizes/etc.
 */
type LlmTier = 'embed' | 'chat' | 'ask' | 'reranker';
type LlmTierConfigKey = 'embeddingLlm' | 'summarizeLlm' | 'askLlm' | 'rerankerLlm';

const LLM_TIERS: ReadonlySet<LlmTier> = new Set(['embed', 'chat', 'ask', 'reranker']);
const LLM_TIER_TO_CONFIG_KEY: Record<LlmTier, LlmTierConfigKey> = {
  embed: 'embeddingLlm',
  chat: 'summarizeLlm',
  ask: 'askLlm',
  reranker: 'rerankerLlm',
};

export async function handleLlmTune(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const projectPathResult = resolveLlmTuneProjectPath(ctx, args);
  if (!projectPathResult.ok) return err(projectPathResult.error);
  const projectPath = projectPathResult.projectPath;
  const tier = typeof args['tier'] === 'string' ? args['tier'] : null;
  const concurrency = typeof args['concurrency'] === 'number' ? args['concurrency'] : null;
  const { describeHardware, recommendedTuning } = await import('../../installer/hardware-tuning.js');
  const tuning = recommendedTuning();
  if (tier !== null) {
    const result = await writeLlmTuneOverride({ projectPath, tier, concurrency });
    if (result.ok) ctx.evictCachedProject(projectPath);
    return result;
  }
  return renderLlmTuneReport({ projectPath, hw: describeHardware(), tuning });
}

type LlmTuneProjectPathResult =
  | { readonly ok: true; readonly projectPath: string }
  | { readonly ok: false; readonly error: string };

function resolveLlmTuneProjectPath(ctx: ToolCtx, args: Record<string, unknown>): LlmTuneProjectPathResult {
  const explicitProjectPath = args['projectPath'];
  try {
    if (typeof explicitProjectPath === 'string') {
      return { ok: true, projectPath: ctx.getCartograph(explicitProjectPath).projectRoot };
    }
    if (ctx.defaultCg) {
      return { ok: true, projectPath: ctx.defaultCg.projectRoot };
    }
    return {
      ok: false,
      error:
        'llm-tune requires `projectPath` when the MCP server has no default project. ' +
        'Pass the initialized project root explicitly.',
    };
  } catch (error_) {
    return { ok: false, error: `llm-tune: could not resolve project: ${errMsg(error_)}` };
  }
}

interface WriteLlmTuneOverrideArgs {
  readonly projectPath: string;
  readonly tier: string;
  readonly concurrency: number | null;
}

/** Write mode — apply a per-tier concurrency override to .cartograph/config.json. */
async function writeLlmTuneOverride(args: WriteLlmTuneOverrideArgs): Promise<ToolOutcome> {
  const { projectPath, tier, concurrency } = args;
  if (!LLM_TIERS.has(tier as LlmTier)) {
    return err(`llm-tune: \`tier\` must be one of 'embed' / 'chat' / 'ask' / 'reranker' (got '${tier}').`);
  }
  if (concurrency === null || !Number.isInteger(concurrency) || concurrency < 1) {
    return err('llm-tune: write mode requires `concurrency: <positive int>`.');
  }
  const configKey = LLM_TIER_TO_CONFIG_KEY[tier as LlmTier];
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const configPath = path.join(projectPath, '.cartograph', 'config.json');
    const exists = await fsp
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      return err(
        `llm-tune: no config.json at ${configPath}. Run \`cartograph_admin({action: 'llm-apply', preset: 'install-ollama', projectPath: '${projectPath}'})\` first.`,
      );
    }
    const parsed = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    const llm = (parsed['llm'] as Record<string, unknown> | undefined) ?? {};
    const tierBlock = (llm[configKey] as Record<string, unknown> | null | undefined) ?? null;
    if (!tierBlock) {
      return err(
        `llm-tune: no \`llm.${configKey}\` block in ${configPath}. Configure it first via \`llm-apply\` or hand-edit.`,
      );
    }
    const previous = (tierBlock['concurrency'] as number | undefined) ?? null;
    tierBlock['concurrency'] = concurrency;
    llm[configKey] = tierBlock;
    parsed['llm'] = llm;
    const backupPath = `${configPath}.bak.${Date.now()}`;
    copyPrivateFileSync(configPath, backupPath);
    writePrivateFileAtomic(configPath, JSON.stringify(parsed, null, 2));
    return ok(
      textResult(buildOverrideAppliedReport({ tier, configKey, previous, concurrency, configPath, backupPath })),
    );
  } catch (error_) {
    return err(`llm-tune write failed: ${errMsg(error_)}`);
  }
}

interface OverrideAppliedReportArgs {
  readonly tier: string;
  readonly configKey: LlmTierConfigKey;
  readonly previous: number | null;
  readonly concurrency: number;
  readonly configPath: string;
  readonly backupPath: string;
}

export function buildOverrideAppliedReport(args: OverrideAppliedReportArgs): string {
  return [
    '## Applied tuning override',
    '',
    `**Tier:** \`${args.tier}\` (config key \`llm.${args.configKey}\`)`,
    `**Concurrency:** ${args.previous ?? '(unset)'} → **${args.concurrency}**`,
    `**Config:** \`${args.configPath}\``,
    `**Backup:** \`${args.backupPath}\``,
    '',
    `Takes effect on the next embed / summarize / rerank pass. ` +
      `To match this on the backend side, restart the corresponding llama-server with \`--parallel ${args.concurrency}\`.`,
  ].join('\n');
}

interface RenderLlmTuneReportArgs {
  readonly projectPath: string;
  readonly hw: string;
  readonly tuning: Awaited<ReturnType<typeof import('../../installer/hardware-tuning.js')['recommendedTuning']>>;
}

/** Read mode — describe hardware + recommendation + current overrides. */
async function renderLlmTuneReport(args: RenderLlmTuneReportArgs): Promise<ToolOutcome> {
  const currentOverrides = await readCurrentOverrides(args.projectPath);
  const lines: string[] = [
    '## LLM tuning',
    '',
    `**Detected hardware:** ${args.hw}`,
    '',
    '**Per-tier recommendation:** (auto-applied unless overridden)',
    '',
    '| Tier | Recommended `llama-server --parallel N` | Recommended cartograph concurrency | Your override |',
    '|---|---|---|---|',
    `| embed (jina, :8080)                | ${args.tuning.embed.llamaServerParallel} | ${args.tuning.embed.cartographConcurrency} | ${currentOverrides['embed'] ?? '(none)'} |`,
    `| chat (Qwen 3B, :8081)              | ${args.tuning.chat.llamaServerParallel} | ${args.tuning.chat.cartographConcurrency} | ${currentOverrides['chat'] ?? '(none)'} |`,
    `| ask (Qwen 7B, :8082)               | ${args.tuning.ask.llamaServerParallel} | ${args.tuning.ask.cartographConcurrency} | ${currentOverrides['ask'] ?? '(none)'} |`,
    `| reranker (bge, :8083 --reranking)  | ${args.tuning.reranker.llamaServerParallel} | ${args.tuning.reranker.cartographConcurrency} | ${currentOverrides['reranker'] ?? '(none)'} |`,
    '',
    '**To apply a manual override:** call `cartograph_admin({action: "llm-tune", projectPath: "<abs>", tier: "<embed|chat|ask|reranker>", concurrency: N})`. ',
    'To match on the backend side, restart the corresponding llama-server with `--parallel N`.',
  ];
  return ok(textResult(lines.join('\n')));
}

async function readCurrentOverrides(projectPath: string): Promise<Record<string, number | null>> {
  try {
    const fsp = await import('node:fs/promises');
    const path = await import('node:path');
    const configPath = path.join(projectPath, '.cartograph', 'config.json');
    const exists = await fsp
      .access(configPath)
      .then(() => true)
      .catch(() => false);
    if (!exists) return {};
    const parsed = JSON.parse(await fsp.readFile(configPath, 'utf-8')) as Record<string, unknown>;
    const llm = (parsed['llm'] as Record<string, unknown> | undefined) ?? {};
    const readConc = (k: string): number | null => {
      const block = llm[k] as Record<string, unknown> | null | undefined;
      return typeof block?.['concurrency'] === 'number' ? block['concurrency'] : null;
    };
    return {
      embed: readConc('embeddingLlm'),
      chat: readConc('summarizeLlm'),
      ask: readConc('askLlm'),
      reranker: readConc('rerankerLlm'),
    };
  } catch {
    return {};
  }
}
