/**
 * Cartograph Interactive Installer
 *
 * Multi-target: writes MCP server config + instructions for the
 * agents the user picks (Claude Code, Cursor, Codex CLI, opencode,
 * Hermes, Gemini CLI, Antigravity, Kiro).
 * Defaults to the Claude-only behavior for backwards compatibility
 * when no targets are explicitly chosen and nothing else is detected.
 *
 * Uses @clack/prompts for the interactive UI; `runInstallerWithOptions`
 * is the non-interactive entry point used by the `--target` /
 * `--print-config` CLI flags.
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { promisify } from 'node:util';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import { ALL_TARGETS, detectAll, getTarget, resolveTargetFlag } from './targets/registry.js';
import type { AgentTarget, Location } from './targets/types.js';
import { errMsg } from '../errors.js';
import { resolveAssetPath } from '../assets.js';

// Backwards-compat: keep these named exports — downstream code may
// import them. The shim in `config-writer.ts` continues to re-export
// them too.
export {
  writeMcpConfig,
  writePermissions,
  writeClaudeMd,
  hasMcpConfig,
  hasPermissions,
  hasClaudeMdSection,
} from './config-writer.js';
export type { InstallLocation } from './config-writer.js';

// Direct dynamic import — under ESM-emit (this project's mode as of
// the ESM migration), `await import('@clack/prompts')` works. The
// historical `new Function('return import(...)')` hack was needed
// only when tsc was compiling to CJS and rewriting `import()` to
// `require()`.

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function getVersion(): string {
  try {
    const packageJsonPath = resolveAssetPath('package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    return packageJson.version;
  } catch {
    return '0.0.0';
  }
}

interface RunInstallerOptions {
  /** Comma-separated target list, or `auto` / `all` / `none`. */
  target?: string;
  /** Skip the location prompt; use this value directly. */
  location?: Location;
  /** Skip the auto-allow prompt; use this value directly. */
  autoAllow?: boolean;
  /**
   * Skip every confirm and use defaults: location=global,
   * autoAllow=true, target=auto. For scripting / CI.
   */
  yes?: boolean;
}

/**
 * Interactive entry point — preserves the historical UX (`cartograph
 * install` with no args goes through the prompts), but now starts
 * the targets multi-select pre-populated with detected agents.
 */
export async function runInstaller(): Promise<void> {
  return runInstallerWithOptions({});
}

export async function runInstallerWithOptions(opts: RunInstallerOptions): Promise<void> {
  const clack = await import('@clack/prompts');
  clack.intro(`Cartograph v${getVersion()}`);

  // --yes implies all defaults; explicit flags still win.
  const useDefaults = opts.yes === true;

  await maybeInstallGlobally(clack, useDefaults);
  const location = await resolveLocation(clack, opts, useDefaults);

  const targets = await resolveTargets({ clack, opts, location, useDefaults });
  if (targets.length === 0) {
    clack.log.info('No agent targets selected — skipping agent config writes.');
  }

  const autoAllow = await resolveAutoAllow({ clack, opts, useDefaults, targets });
  installTargetsAt({ clack, targets, location, autoAllow });

  if (location === 'local') {
    await initializeLocalProject(clack, { deferLlmSetup: useDefaults });
  }
  if (location === 'global') {
    clack.note('cd your-project\ncartograph admin init -i', 'Quick start');
  }

  let finalNote = 'Done!';
  if (targets.length > 0) {
    finalNote = `Done! Restart your agent${targets.length > 1 ? 's' : ''} to use Cartograph.`;
  }
  clack.outro(finalNote);
}

type ClackApi = typeof import('@clack/prompts');

/**
 * Bail out cleanly when @clack/prompts returns its cancel sentinel.
 * Lets call sites stay one-liners — they get the narrowed value back
 * without each having to repeat the `isCancel → cancel → exit` triplet.
 */
function assertNotCancelled<T>(clack: ClackApi, value: T | symbol): T {
  if (clack.isCancel(value)) {
    clack.cancel('Installation cancelled.');
    process.exit(0);
  }
  return value;
}

/**
 * Step 1: offer to install cartograph globally on PATH. Skipped when
 * `--yes` (script-mode assumes the binary is already on PATH or the
 * caller handled it).
 */
async function maybeInstallGlobally(clack: ClackApi, useDefaults: boolean): Promise<void> {
  if (useDefaults) return;
  try {
    await promisify(execFile)('cartograph', ['--version']);
    clack.log.info('cartograph is already on PATH');
    return;
  } catch {
    // Not on PATH yet; offer to link this source checkout below.
  }

  const shouldInstall = assertNotCancelled(
    clack,
    await clack.confirm({
      message: 'Link cartograph onto PATH with `bun link`? (Required for MCP server configs that use `cartograph`)',
      initialValue: true,
    }),
  );
  if (!shouldInstall) {
    clack.log.info('Skipped PATH linking — MCP server may not work unless your config uses an absolute command path');
    return;
  }

  const s = clack.spinner();
  s.start('Linking cartograph globally...');
  try {
    await promisify(execFile)('bun', ['link'], { cwd: path.join(import.meta.dirname, '..', '..') });
    s.stop('Linked cartograph globally');
  } catch (err) {
    s.stop('Could not link cartograph globally');
    clack.log.warn(
      `Run from the Cartograph source checkout: \`bun link\`, then verify with \`cartograph --version\`. ` +
        `Until PATH is fixed, use the repo-local fallback \`bun src/bin/cartograph.ts <command>\`. ` +
        `If Bun's global bin lookup fails, add \`$(bun pm bin -g 2>/dev/null || dirname "$(command -v bun)")\` to PATH. ` +
        `(${errMsg(err)})`,
    );
  }
}

/** Step 2: pick the install location, honoring `--location` and `--yes` flags. */
async function resolveLocation(clack: ClackApi, opts: RunInstallerOptions, useDefaults: boolean): Promise<Location> {
  if (opts.location) return opts.location;
  if (useDefaults) return 'global';
  return assertNotCancelled(
    clack,
    await clack.select({
      message: 'Where would you like to install?',
      options: [
        { value: 'global' as const, label: 'Global', hint: 'available in all projects' },
        { value: 'local' as const, label: 'Local', hint: 'this project only' },
      ],
      initialValue: 'global' as const,
    }),
  );
}

interface ResolveAutoAllowArgs {
  clack: ClackApi;
  opts: RunInstallerOptions;
  useDefaults: boolean;
  targets: AgentTarget[];
}

/**
 * Step 4: decide whether to auto-allow Cartograph commands. Only
 * meaningful for Claude; skipped silently by other targets.
 */
async function resolveAutoAllow(args: ResolveAutoAllowArgs): Promise<boolean> {
  const { clack, opts, useDefaults, targets } = args;
  if (opts.autoAllow !== undefined) return opts.autoAllow;
  if (useDefaults) return true;
  if (!targets.some((t) => t.id === 'claude')) return false;
  return assertNotCancelled(
    clack,
    await clack.confirm({
      message: 'Auto-allow Cartograph commands? (Skips permission prompts in Claude Code)',
      initialValue: true,
    }),
  );
}

interface InstallTargetsArgs {
  clack: ClackApi;
  targets: AgentTarget[];
  location: Location;
  autoAllow: boolean;
}

/**
 * Step 5: run each target's install method, log per-file results,
 * and surface any target-supplied notes.
 */
function installTargetsAt(args: InstallTargetsArgs): void {
  const { clack, targets, location, autoAllow } = args;
  for (const target of targets) {
    if (!target.supportsLocation(location)) {
      clack.log.warn(`${target.displayName}: skipped — does not support --location=${location}.`);
      continue;
    }
    const result = target.install(location, { autoAllow });
    for (const file of result.files) {
      let verb = 'Updated';
      if (file.action === 'unchanged') {
        verb = 'Unchanged';
      } else if (file.action === 'created') {
        verb = 'Created';
      }
      clack.log.success(`${target.displayName}: ${verb} ${tildify(file.path)}`);
    }
    for (const note of result.notes ?? []) {
      clack.log.info(`${target.displayName}: ${note}`);
    }
  }
}

/**
 * Replace home-directory prefix in a path with `~/` for cleaner log
 * lines. Pure cosmetic.
 */
function tildify(p: string): string {
  const home = homedir();
  if (p.startsWith(home + path.sep)) return '~' + p.substring(home.length);
  return p;
}

interface ResolveTargetsArgs {
  clack: ClackApi;
  opts: RunInstallerOptions;
  location: Location;
  useDefaults: boolean;
}

async function resolveTargets(args: ResolveTargetsArgs): Promise<AgentTarget[]> {
  const { clack, opts, location, useDefaults } = args;
  // Explicit --target flag wins.
  if (opts.target !== undefined) {
    return resolveTargetFlag(opts.target, location);
  }

  // --yes implies auto-detect.
  if (useDefaults) {
    return resolveTargetFlag('auto', location);
  }

  // Interactive multi-select.
  const detected = detectAll(location);
  const initialValues = detected.filter(({ detection }) => detection.installed).map(({ target }) => target.id);
  // If nothing detected, default to Claude alone (matches the
  // historical default and the smallest-surprise outcome).
  const initial = initialValues.length > 0 ? initialValues : ['claude'];

  const choice = assertNotCancelled(
    clack,
    await clack.multiselect<string>({
      message: 'Which agents should Cartograph configure?',
      options: ALL_TARGETS.map((t) => {
        const det = detected.find(({ target }) => target.id === t.id)!.detection;
        const flag = det.installed ? '(detected)' : '(not found)';
        const supportsHere = t.supportsLocation(location);
        const support = supportsHere ? '' : ` — no ${location} support, will skip`;
        return {
          value: t.id,
          label: `${t.displayName} ${flag}${support}`,
        };
      }),
      initialValues: initial,
      required: false,
    }),
  );

  return choice.map((id) => getTarget(id)).filter((t): t is AgentTarget => t !== undefined);
}

interface InitializeLocalProjectOptions {
  deferLlmSetup?: boolean;
}

/**
 * Initialize Cartograph in the current project for local installs.
 */
async function initializeLocalProject(
  clack: typeof import('@clack/prompts'),
  options: InitializeLocalProjectOptions = {},
): Promise<void> {
  const projectPath = process.cwd();

  let Cartograph: typeof import('../index.js').default;
  try {
    Cartograph = (await import('../index.js')).default;
  } catch (err) {
    const msg = errMsg(err);
    clack.log.error(`Could not load native modules: ${msg}`);
    clack.log.info('Skipping project initialization. Run "cartograph admin init -i" later.');
    return;
  }

  if (Cartograph.isInitialized(projectPath)) {
    clack.log.info('Cartograph already initialized in this project');
    return;
  }

  const cg = await Cartograph.init(projectPath);
  clack.log.success('Created .cartograph/ directory');

  if (options.deferLlmSetup) {
    clack.log.info('Skipped interactive LLM setup in --yes mode. Run `cartograph llm setup` later if needed.');
  } else {
    try {
      const { runLlmSetup } = await import('./llm-setup.js');
      const llmConfig = await runLlmSetup(clack, undefined, projectPath);
      if (llmConfig) {
        cg.updateConfig({ llm: llmConfig });
        const summary = [
          llmConfig.summarizeLlm?.provider ? `summarize=${llmConfig.summarizeLlm.provider}` : null,
          llmConfig.embeddingLlm?.provider ? `embed=${llmConfig.embeddingLlm.provider}` : null,
        ]
          .filter(Boolean)
          .join(', ');
        clack.log.success(`Configured LLM (${summary || 'features disabled'})`);
      }
    } catch (err) {
      clack.log.warn(`LLM setup skipped: ${errMsg(err)}`);
    }
  }

  await runInitialIndex(cg, clack);
  cg.close();
}

/**
 * Run a full index on a newly-initialized project, showing shimmer
 * progress and logging a success line with the result summary.
 */
async function runInitialIndex(
  cg: Awaited<ReturnType<typeof import('../index.js').default.init>>,
  clack: typeof import('@clack/prompts'),
): Promise<void> {
  const { createShimmerProgress } = await import('../ui/shimmer-progress.js');
  process.stdout.write(`\x1b[2m│\x1b[0m\n`);
  const progress = createShimmerProgress();

  const result = await cg.indexAll({ onProgress: progress.onProgress });
  await progress.stop();

  if (result.filesErrored > 0) {
    clack.log.success(
      `Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.filesErrored)} failed, ${formatNumber(result.nodesCreated)} symbols)`,
    );
  } else {
    clack.log.success(
      `Indexed ${formatNumber(result.filesIndexed)} files (${formatNumber(result.nodesCreated)} symbols)`,
    );
  }
}
