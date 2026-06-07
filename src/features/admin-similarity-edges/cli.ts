import { DEFAULT_SIMILAR_K, DEFAULT_SIMILAR_MIN_SCORE } from '../../embeddings/similarity-defaults.js';
import { errMsg } from '../../errors.js';
import { resolveSimilarityEdgeBuildOptions } from './runtime.js';
import type { CliOptionCommand } from '../shared/cli-command.js';

type CommandLike = CliOptionCommand;

interface AssignNumericArgInput {
  args: Record<string, unknown>;
  key: string;
  raw: string | undefined;
  optionName: string;
  opts?: { min?: number; max?: number };
}

interface SimilarityEdgesGraph {
  close: () => void;
}

export interface AdminSimilarityEdgesCommandDeps {
  adminCmd: CommandLike;
  resolveProjectPath: (pathArg?: string) => string;
  isInitialized: (projectPath: string) => boolean;
  loadCartograph: () => Promise<{ default: { open: (projectPath: string) => Promise<SimilarityEdgesGraph> } }>;
  loadSimilarEdges: () => Promise<{
    buildSimilarToEdges: (
      cg: SimilarityEdgesGraph,
      options: { k: number; minScore: number },
    ) => Promise<{ written: number; processed: number; reason?: string }>;
  }>;
  assignIntArg: (args: AssignNumericArgInput) => boolean;
  assignFloatArg: (args: AssignNumericArgInput) => boolean;
  success: (message: string) => void;
  info: (message: string) => void;
  error: (message: string) => void;
}

export function registerAdminSimilarityEdgesCommand(deps: AdminSimilarityEdgesCommandDeps): void {
  const {
    adminCmd,
    assignFloatArg,
    assignIntArg,
    error,
    info,
    isInitialized,
    loadCartograph,
    loadSimilarEdges,
    resolveProjectPath,
    success,
  } = deps;
  adminCmd
    .command('build-similarity-edges [path]')
    .option('--k <number>', `Number of nearest neighbors to find (default ${DEFAULT_SIMILAR_K})`)
    .option('--min-score <number>', `Minimum similarity threshold 0..1 (default ${DEFAULT_SIMILAR_MIN_SCORE})`)
    .description(
      "Build similar_to edges from embeddings (mirrors cartograph_admin MCP tool with action='build-similarity-edges')",
    )
    .action(async (pathArg: string | undefined, opts) => {
      const projectPath = resolveProjectPath(pathArg);
      let cg: SimilarityEdgesGraph | undefined;
      try {
        if (!isInitialized(projectPath)) {
          error(`Cartograph not initialized in ${projectPath}`);
          process.exit(1);
        }
        const { default: Cartograph } = await loadCartograph();
        cg = await Cartograph.open(projectPath);
        const { buildSimilarToEdges } = await loadSimilarEdges();
        // Route --k / --min-score through the shared validators so bad
        // input (NaN, negative, out-of-range) is rejected with a clean
        // error instead of being silently coerced to the default / clamped.
        const o = opts as Record<string, string | undefined>;
        const parsed: Record<string, unknown> = {};
        if (!assignIntArg({ args: parsed, key: 'k', raw: o['k'], optionName: '--k', opts: { min: 1, max: 100 } })) {
          return;
        }
        if (
          !assignFloatArg({
            args: parsed,
            key: 'minScore',
            raw: o['minScore'],
            optionName: '--min-score',
            opts: { min: 0, max: 1 },
          })
        ) {
          return;
        }
        const parsedOptions: { k?: number; minScore?: number } = {};
        if (parsed['k'] !== undefined) parsedOptions.k = parsed['k'] as number;
        if (parsed['minScore'] !== undefined) parsedOptions.minScore = parsed['minScore'] as number;
        const result = await buildSimilarToEdges(cg, resolveSimilarityEdgeBuildOptions(parsedOptions));
        success(`Built similarity edges: ${result.written} edges from ${result.processed} nodes.`);
        if (result.reason) {
          info(`Note: ${result.reason}`);
        }
      } catch (err) {
        error(`Failed to build similarity edges: ${errMsg(err)}`);
        process.exit(1);
      } finally {
        cg?.close();
      }
    });
}
