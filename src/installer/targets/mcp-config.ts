import * as path from 'node:path';

export interface McpCommandOptions {
  command?: string | undefined;
  projectPath?: string | undefined;
}

export function getMcpCommand(options: McpCommandOptions = {}): string {
  return options.command ?? 'cartograph';
}

export function getMcpServerArgs(options: McpCommandOptions = {}): string[] {
  const args = ['serve', '--mcp'];
  if (options.projectPath) args.push('--project-path', path.resolve(options.projectPath));
  return args;
}

export function mcpCommandOptionsForLocation(
  loc: 'global' | 'local',
  options: McpCommandOptions = {},
): McpCommandOptions {
  if (loc !== 'local') return options;
  return { ...options, projectPath: options.projectPath ?? process.cwd() };
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
