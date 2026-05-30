/**
 * Hermes Agent target.
 *
 * Hermes reads MCP servers from `$HERMES_HOME/config.yaml` (default
 * `~/.hermes/config.yaml`) under the top-level `mcp_servers` key, and
 * exposes discovered MCP tools through dynamic toolsets named
 * `mcp-<server>`. We add:
 *
 *   mcp_servers.cartograph     → `cartograph serve --mcp`
 *   platform_toolsets.cli     → includes `- mcp-cartograph`
 *
 * The second entry matters because Hermes CLI profiles typically
 * enable an explicit `platform_toolsets.cli` list. Without
 * `mcp-cartograph` in that list, the MCP server can be configured
 * AND connected but its tools may still be filtered out of CLI
 * sessions.
 *
 * YAML manipulation note (issue #456): Hermes serializes via
 * PyYAML's default block style, which writes list items at the SAME
 * indent as the parent mapping key:
 *
 *   platform_toolsets:
 *     cli:
 *     - hermes-cli       # indent 2 — belongs to cli, NOT a sibling
 *     - browser
 *
 * A naive line-based YAML patcher mistakes that first `  - hermes-cli`
 * for the next sibling key and truncates the block, splicing inserts
 * at the wrong indent. `listChildBlock` handles both this default
 * style and the 4-space-nested form by recognizing `  - ` as a list-
 * item continuation and reporting back the actual indent used so the
 * inserter matches it.
 *
 * Location: `supportsLocation('local')` returns false — Hermes has no
 * project-scoped config concept.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import { atomicWriteFileSync, getHomeDir } from './shared.js';
import { escapeRegExp } from '../../utils.js';

type LineRange = { start: number; end: number };

class HermesTarget implements AgentTarget {
  readonly id = 'hermes' as const;
  readonly displayName = 'Hermes Agent';
  readonly docsUrl = 'https://hermes-agent.nousresearch.com';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = configPath();
    const content = readText(file);
    const installed = fs.existsSync(hermesHome()) || fs.existsSync(file);
    return {
      installed,
      alreadyConfigured: hasCartographMcpServer(content),
      configPath: file,
    };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Hermes Agent uses $HERMES_HOME/config.yaml; re-run with --location=global.'],
      };
    }
    return {
      files: [writeHermesConfig()],
      notes: ['Start a new Hermes session for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const file = configPath();
    if (!fs.existsSync(file)) {
      return { files: [{ path: file, action: 'not-found' }] };
    }

    const before = readText(file);
    const after = removeCartographToolset(removeCartographMcpServer(before));
    if (after === before) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    atomicWriteFileSync(file, ensureTrailingNewline(after));
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    if (loc !== 'global') {
      return '# Hermes Agent uses $HERMES_HOME/config.yaml; use --location=global.\n';
    }
    return [
      `# Add to ${configPath()}`,
      '',
      renderCartographMcpBlock().join('\n'),
      '',
      'platform_toolsets:',
      '  cli:',
      '    - hermes-cli',
      '    - mcp-cartograph',
      '',
    ].join('\n');
  }

  describePaths(loc: Location): string[] {
    return loc === 'global' ? [configPath()] : [];
  }
}

function hermesHome(): string {
  return process.env['HERMES_HOME'] ? path.resolve(process.env['HERMES_HOME']) : path.join(getHomeDir(), '.hermes');
}

function configPath(): string {
  return path.join(hermesHome(), 'config.yaml');
}

function readText(file: string): string {
  try {
    return fs.readFileSync(file, 'utf-8');
  } catch {
    return '';
  }
}

function writeHermesConfig(): WriteResult['files'][number] {
  const file = configPath();
  const existed = fs.existsSync(file);
  const before = readText(file);
  const afterMcp = upsertCartographMcpServer(before);
  const after = upsertCartographToolset(afterMcp);

  if (after === before) {
    return { path: file, action: 'unchanged' };
  }
  if (!fs.existsSync(path.dirname(file))) fs.mkdirSync(path.dirname(file), { recursive: true });
  atomicWriteFileSync(file, ensureTrailingNewline(after));
  return { path: file, action: existed ? 'updated' : 'created' };
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : text + '\n';
}

function splitLines(content: string): string[] {
  return content.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
}

function joinLines(lines: string[]): string {
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n') + '\n';
}

function topLevelRange(lines: string[], key: string): LineRange | null {
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*(?:#.*)?$/.test(line)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function childRange(lines: string[], parent: LineRange, child: string): LineRange | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    if (/^ {2}\S/.test(line)) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }
  return { start, end };
}

/**
 * Block-range for a 2-space-indented child whose value is a YAML
 * block list. Unlike `childRange`, this handles PyYAML's default
 * `default_flow_style=False` serialization where list items sit at
 * the SAME indent as the parent key (issue #456). Recognizes `  - `
 * as a list-item continuation (not a sibling key) and reports the
 * actual indent used by existing items so the inserter matches it.
 */
function listChildBlock(
  lines: string[],
  parent: LineRange,
  child: string,
): (LineRange & { itemIndent: string }) | null {
  const startPattern = new RegExp(`^  ${escapeRegExp(child)}:\\s*(?:#.*)?$`);
  let start = -1;
  for (let i = parent.start + 1; i < parent.end; i++) {
    if (startPattern.test(lines[i] ?? '')) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;

  let end = parent.end;
  for (let i = start + 1; i < parent.end; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '') continue;
    const indentMatch = line.match(/^( *)/);
    const indent = indentMatch?.[1]?.length ?? 0;
    if (indent >= 4) continue;
    if (indent === 2 && /^ {2}- /.test(line)) continue;
    end = i;
    break;
  }
  while (end > start + 1 && (lines[end - 1] ?? '').trim() === '') {
    end--;
  }

  let itemIndent = '    ';
  for (let i = start + 1; i < end; i++) {
    const m = (lines[i] ?? '').match(/^( +)- /);
    if (m?.[1]) {
      itemIndent = m[1];
      break;
    }
  }
  return { start, end, itemIndent };
}

function renderCartographMcpChild(): string[] {
  return [
    '  cartograph:',
    '    command: cartograph',
    '    args:',
    '      - serve',
    '      - --mcp',
    '    timeout: 120',
    '    connect_timeout: 60',
    '    enabled: true',
  ];
}

function renderCartographMcpBlock(): string[] {
  return ['mcp_servers:', ...renderCartographMcpChild()];
}

function hasCartographMcpServer(content: string): boolean {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  return !!parent && !!childRange(lines, parent, 'cartograph');
}

function upsertCartographMcpServer(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  const child = parent ? childRange(lines, parent, 'cartograph') : null;
  const replacement = renderCartographMcpChild();

  if (!parent) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...renderCartographMcpBlock());
    return joinLines(lines);
  }

  if (child) {
    const existing = lines.slice(child.start, child.end);
    if (arrayEqual(existing, replacement)) return joinLines(lines);
    lines.splice(child.start, child.end - child.start, ...replacement);
    return joinLines(lines);
  }

  lines.splice(parent.end, 0, ...replacement);
  return joinLines(lines);
}

function removeCartographMcpServer(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'mcp_servers');
  const child = parent ? childRange(lines, parent, 'cartograph') : null;
  if (!child) return content;
  lines.splice(child.start, child.end - child.start);
  return joinLines(lines);
}

function upsertCartographToolset(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'platform_toolsets');
  // listChildBlock handles BOTH PyYAML's same-indent style AND the
  // 4-space-nested form via the indent-detection heuristic.
  const cli = parent ? listChildBlock(lines, parent, 'cli') : null;

  if (!parent) {
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push('platform_toolsets:', '  cli:', '    - hermes-cli', '    - mcp-cartograph');
    return joinLines(lines);
  }

  if (!cli) {
    lines.splice(parent.end, 0, '  cli:', '    - hermes-cli', '    - mcp-cartograph');
    return joinLines(lines);
  }

  const hasEntry = lines.slice(cli.start + 1, cli.end).some((line) => line.trim() === '- mcp-cartograph');
  if (hasEntry) return joinLines(lines);

  lines.splice(cli.end, 0, `${cli.itemIndent}- mcp-cartograph`);
  return joinLines(lines);
}

function removeCartographToolset(content: string): string {
  const lines = splitLines(content);
  const parent = topLevelRange(lines, 'platform_toolsets');
  const cli = parent ? listChildBlock(lines, parent, 'cli') : null;
  if (!cli) return content;

  const hasEntry = lines.slice(cli.start + 1, cli.end).some((line) => line.trim() === '- mcp-cartograph');
  if (!hasEntry) return content;

  const next = lines.filter((line, idx) => {
    if (idx <= cli.start || idx >= cli.end) return true;
    return line.trim() !== '- mcp-cartograph';
  });
  return joinLines(next);
}

function arrayEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, idx) => value === b[idx]);
}

export const hermesTarget: AgentTarget = new HermesTarget();
