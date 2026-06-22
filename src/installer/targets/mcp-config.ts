import * as path from 'node:path';
import { asJsonObject } from './file-writes.js';

export interface McpCommandOptions {
  command?: string | undefined;
  projectPath?: string | undefined;
}

function ownStringOption(options: McpCommandOptions, key: keyof McpCommandOptions): string | undefined {
  const value = Object.hasOwn(options, key) ? options[key] : undefined;
  return typeof value === 'string' ? value : undefined;
}

export function getMcpCommand(options: McpCommandOptions = {}): string {
  return ownStringOption(options, 'command') ?? 'cartograph';
}

export function getMcpServerArgs(options: McpCommandOptions = {}): string[] {
  const args = ['serve', '--mcp'];
  const projectPath = ownStringOption(options, 'projectPath');
  if (projectPath) args.push('--project-path', path.resolve(projectPath));
  return args;
}

export function mcpCommandOptionsForLocation(
  loc: 'global' | 'local',
  options: McpCommandOptions = {},
): McpCommandOptions {
  if (loc !== 'local') return options;
  return { ...options, projectPath: ownStringOption(options, 'projectPath') ?? process.cwd() };
}

/**
 * The MCP-server config block cartograph injects. Same shape across
 * all JSON-shaped agent configs (Claude, Cursor, opencode), only the
 * surrounding wrapper differs. Codex (TOML) builds its own block.
 */
export function getMcpServerConfig(options: McpCommandOptions = {}): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
  };
}

export function renderMcpServersPrintConfig(
  targetPath: string,
  loc: 'global' | 'local',
  options: McpCommandOptions = {},
): string {
  const snippet = JSON.stringify(
    { mcpServers: { cartograph: getMcpServerConfig(mcpCommandOptionsForLocation(loc, options)) } },
    null,
    2,
  );
  return `# Add to ${targetPath}\n\n${snippet}\n`;
}

/**
 * True when an existing MCP entry runs cartograph FROM THE PROJECT'S
 * OWN SOURCE TREE — dev wiring like
 * `bun <project>/src/bin/cartograph.ts serve --mcp`. Overwriting such
 * an entry with the released binary would silently de-source a
 * development setup (found dogfooding `install --location=local` on
 * the cartograph repo itself), so installers keep it and report
 * `kept` instead.
 *
 * Discriminator: any command/args token that is a script file
 * (.ts/.js/.mjs/.cjs) located INSIDE the project. The standard
 * entries never have one — their only project-rooted token is the
 * bare `--project-path` directory argument.
 *
 * Known limitation (intentional): an in-project COMPILED binary with
 * no script extension does not match and will be overwritten with the
 * standard entry — extensionless tokens are too ambiguous to treat as
 * dev wiring without false positives.
 */
export function isProjectSourceRunEntry(entry: unknown, projectPath: string): boolean {
  const record = asJsonObject(entry);
  if (!record) return false;
  const tokens: string[] = [];
  const command = Object.hasOwn(record, 'command') ? record['command'] : undefined;
  const args = Object.hasOwn(record, 'args') ? record['args'] : undefined;
  for (const value of [command, args]) {
    if (typeof value === 'string') tokens.push(value);
    else if (Array.isArray(value)) tokens.push(...value.filter((token): token is string => typeof token === 'string'));
  }
  const root = path.resolve(projectPath) + path.sep;
  return tokens.some((token) => token.startsWith(root) && /\.(ts|js|mjs|cjs)$/.test(token));
}
