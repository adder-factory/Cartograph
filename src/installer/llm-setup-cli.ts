/**
 * `cartograph llm setup` — interactive wizard for configuring
 * cartograph's openai-compat HTTP LLM stack. Wraps `runLlmSetup` (the
 * core flow that handles model download + config building) with
 * project-init checks and atomic config-file writing.
 *
 * Three setup paths (handled by `runLlmSetup`):
 *   - **Local** — download the curated GGUFs, wire `provider:
 *     'openai-compat'` to all four chat / embed / rerank slots.
 *     User runs one `llama-server -m <gguf> --port <port>` per tier
 *     (or points everything at Ollama / mlx_lm / LM Studio).
 *   - **Hybrid** — download local GGUFs (skip the 7B ask), route
 *     `askLlm` to Claude (claude-bridge if `claude` is on PATH,
 *     otherwise anthropic-api).
 *   - **Skip** — leave LLM features disabled.
 *
 * The in-process pathway (mini-nllc + libcgshim) was deleted
 * 2026-05-24c — see `project_llm_pivot_to_llama_server` in auto-memory.
 */

import * as path from 'path';
import * as fs from 'fs';
import { errMsg } from '../errors.js';
import type { CartographConfig } from '../types.js';
import { MODELS_DIR_DEFAULT } from '../llm/recommended-models.js';

/** Abort with an error message if the project is not initialized. */
function assertInitialized(projectPath: string): void {
  if (!fs.existsSync(path.join(projectPath, '.cartograph'))) {
    process.stderr.write(`cartograph: not initialized in ${projectPath}. Run \`cartograph admin init\` first.\n`);
    process.exit(1);
  }
}

/** Atomic write of `config.json` with the merged llm block. */
function writeLlmConfig(projectPath: string, llm: NonNullable<CartographConfig['llm']>): void {
  const configPath = path.join(projectPath, '.cartograph', 'config.json');
  const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '{}';
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`config.json is malformed: ${errMsg(err)}`);
  }
  config['llm'] = llm;
  const tmp = configPath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, configPath);
}

/** Summarise the chosen config — one line per non-null slot. */
function describeWrittenConfig(llm: NonNullable<CartographConfig['llm']>): string[] {
  const lines: string[] = [];
  if (llm.summarizeLlm) {
    lines.push(`  summarize: ${llm.summarizeLlm.provider} — ${llm.summarizeLlm.model ?? '(model unset)'}`);
  }
  if (llm.askLlm) {
    lines.push(`  ask:       ${llm.askLlm.provider} — ${llm.askLlm.model ?? '(model unset)'}`);
  }
  if (llm.localLlm) {
    lines.push(`  local:     ${llm.localLlm.provider} — ${llm.localLlm.model ?? '(model unset)'}`);
  }
  if (llm.embeddingLlm) {
    lines.push(`  embed:     ${llm.embeddingLlm.provider} — ${llm.embeddingLlm.model}`);
  }
  if (llm.rerankerLlm) {
    lines.push(`  rerank:    ${llm.rerankerLlm.provider} — ${llm.rerankerLlm.model ?? '(model unset)'}`);
  }
  return lines;
}

export async function runLlmSetupCli(pathArg: string | undefined): Promise<void> {
  const projectPath = path.resolve(pathArg ?? process.cwd());
  assertInitialized(projectPath);

  const clack = await import('@clack/prompts');
  clack.intro('Cartograph LLM setup (openai-compat HTTP)');
  clack.log.info(
    `Models dir: ${MODELS_DIR_DEFAULT} (one shared install across all your projects — override with CARTOGRAPH_MODELS_DIR)`,
  );

  const { runLlmSetup } = await import('./llm-setup.js');
  const llm = await runLlmSetup(clack, undefined, projectPath);
  if (!llm) {
    clack.outro('No changes made.');
    return;
  }

  try {
    writeLlmConfig(projectPath, llm);
  } catch (err) {
    clack.log.error(`Failed to write config: ${errMsg(err)}`);
    clack.outro('Setup aborted.');
    return;
  }

  clack.note(describeWrittenConfig(llm).join('\n'), 'Wrote .cartograph/config.json');
  clack.outro('✓ Setup complete.');
}
