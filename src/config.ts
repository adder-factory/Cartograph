/**
 * Configuration Management
 *
 * Load, save, and validate Cartograph configuration.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesGlob } from './glob.js';
import { type CartographConfig, DEFAULT_CONFIG } from './types.js';
import { MAX_INDEX_FILE_SIZE, MAX_INDEX_FILE_SIZE_LABEL } from './default-config.js';
import { normalizePath, compact } from './utils.js';
import { migrateLegacyLlmFieldNames } from './config/legacy-llm-migration.js';
import { assertValidCartographConfig } from './config/schema.js';
export { _resetLegacyLlmMigrationForTest } from './config/legacy-llm-migration.js';
export { VALID_LANGUAGES } from './config/languages.js';

/**
 * Configuration filename
 */
const CONFIG_FILENAME = 'config.json';

/**
 * Get the config file path for a project
 */
export function getConfigPath(projectRoot: string): string {
  return path.join(projectRoot, '.cartograph', CONFIG_FILENAME);
}

// `isSafeRegex` lives in `src/regex.ts` (RE2-backed; linear-time;
// rejects lookahead / lookbehind / backreferences alongside obvious
// invalid syntax). Imported at the top of this file.

/**
 * Merge configuration with defaults.
 *
 * Special case for `include`: the language registry can grow (new
 * extensions added to existing language defs, e.g. `.mts`/`.cts`
 * joining the TypeScript def). When a persisted config materialized
 * its `include` list at init time, replacing it on every load means
 * the project would silently miss the new extension forever. So `include`
 * is UNIONED with the registry-derived defaults: every user-listed
 * glob is preserved in its original order, then any registry glob the
 * user doesn't already have is appended. This is the "auto-pickup" of
 * new language extensions on next load (G14, 2026-05-21).
 *
 * Trade-off accepted: if a user deliberately removed the Python glob
 * from their include to exclude Python files, the next load re-adds
 * it. That is counted as a misuse of `include` — the supported
 * pattern for excluding a language is the `exclude` array.
 */
function mergeConfig(defaults: CartographConfig, overrides: Partial<CartographConfig>): CartographConfig {
  // Spread `defaults` then `compact(overrides)`:
  //   - undefined-valued overrides (common when callers forward an
  //     unset CLI flag) don't clobber a populated default
  //   - any new field added to `CartographConfig` flows through
  //     automatically — no per-field listing to keep in sync
  // The previous form listed all fields manually; adding a new
  // field meant remembering to update this function or the
  // override would silently no-op.
  const merged: CartographConfig = { ...defaults, ...compact(overrides) };
  const persisted = compact(overrides).include;
  if (Array.isArray(persisted)) {
    const seen = new Set(persisted);
    const extras = defaults.include.filter((g) => !seen.has(g));
    merged.include = extras.length > 0 ? [...persisted, ...extras] : persisted;
  }
  return merged;
}

function assertPersistableMaxFileSize(configPath: string, maxFileSize: number): void {
  if (!Number.isSafeInteger(maxFileSize) || maxFileSize < 1 || maxFileSize > MAX_INDEX_FILE_SIZE) {
    throw new Error(
      `Invalid configuration in ${configPath}:\nmaxFileSize must be between 1 byte and ${MAX_INDEX_FILE_SIZE_LABEL}`,
    );
  }
}

/**
 * Load configuration from a project
 */
export function loadConfig(projectRoot: string): CartographConfig {
  const configPath = getConfigPath(projectRoot);

  if (!fs.existsSync(configPath)) {
    // Return default config with adjusted rootDir
    return {
      ...DEFAULT_CONFIG,
      rootDir: projectRoot,
    };
  }

  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content) as unknown;

    // Migrate legacy llm field names (`chat` / `askChat` / `localChat` /
    // `embeddings`) to the purpose-suffixed scheme (`summarizeLlm` /
    // `askLlm` / `localLlm` / `embeddingLlm`). One-shot: writes the
    // migrated config back to disk with a `.bak.legacy-llm-names`
    // backup so any tooling reading the file later sees the new shape.
    const migrated = migrateLegacyLlmFieldNames(parsed, configPath);

    // Merge with defaults to ensure all fields are present
    const merged = mergeConfig(DEFAULT_CONFIG, migrated as Partial<CartographConfig>);
    merged.rootDir = projectRoot; // Always use actual project root

    // Validation-only: `merged` (not parsed result data) is returned so
    // the `DEFAULT_CONFIG` getter-derived fields survive untouched. The
    // formatted error names the offending field/path so the user can fix
    // `config.json` without guessing.
    assertValidCartographConfig(configPath, merged);

    return merged;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in config file: ${configPath}`);
    }
    throw error;
  }
}

/**
 * Save configuration to a project
 */
export function saveConfig(projectRoot: string, config: CartographConfig): void {
  const configPath = getConfigPath(projectRoot);
  const dir = path.dirname(configPath);

  assertPersistableMaxFileSize(configPath, config.maxFileSize);

  // Ensure directory exists
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Create a copy without rootDir (it's always derived from project path)
  const toSave = { ...config };
  delete (toSave as Partial<CartographConfig>).rootDir;

  const content = JSON.stringify(toSave, null, 2);

  // Atomic write: write to temp file then rename to prevent partial/corrupt configs
  const tmpPath = configPath + '.tmp';
  fs.writeFileSync(tmpPath, content, 'utf-8');
  fs.renameSync(tmpPath, configPath);
}

/**
 * Create default configuration for a new project
 */
export function createDefaultConfig(projectRoot: string): CartographConfig {
  return {
    ...DEFAULT_CONFIG,
    rootDir: projectRoot,
  };
}

/**
 * Check if a file path matches the include/exclude patterns
 */
export function shouldIncludeFile(filePath: string, config: CartographConfig): boolean {
  // Normalize to forward slashes so Windows backslash paths match glob patterns
  filePath = normalizePath(filePath);

  const matchesPattern = (pattern: string, filePath: string): boolean => {
    return matchesGlob(filePath, pattern);
  };

  // Check exclude patterns first
  for (const pattern of config.exclude) {
    if (matchesPattern(pattern, filePath)) {
      return false;
    }
  }

  // Check include patterns
  for (const pattern of config.include) {
    if (matchesPattern(pattern, filePath)) {
      return true;
    }
  }

  // Default to not including if no pattern matches
  return false;
}
