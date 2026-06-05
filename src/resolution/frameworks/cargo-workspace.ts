import type { ResolutionContext } from '../types.js';

const GLOB_CHARS = /[*?[\]{}]/;

const cache = new WeakMap<ResolutionContext, Map<string, string>>();

export function clearCargoWorkspaceCache(context: ResolutionContext): void {
  cache.delete(context);
}

/**
 * Map Rust crate-name aliases to workspace member directories.
 *
 * Cargo packages named `cartograph-core` are imported as
 * `cartograph_core`, so both spellings are accepted. Workspace member
 * globs are expanded from the already-indexed file list rather than by
 * walking the filesystem from the resolver.
 */
export function getCargoWorkspaceCrateMap(context: ResolutionContext): Map<string, string> {
  const cached = cache.get(context);
  if (cached) return cached;

  const out = new Map<string, string>();
  const rootCargo = context.readFile('Cargo.toml');
  if (!rootCargo) {
    cache.set(context, out);
    return out;
  }

  for (const memberPath of expandMembers(parseWorkspaceMembers(rootCargo), context)) {
    const manifest = context.readFile(`${memberPath}/Cargo.toml`);
    if (!manifest) continue;
    const packageName = parsePackageName(manifest);
    if (!packageName) continue;
    addCrateAlias(out, packageName, memberPath);
  }

  cache.set(context, out);
  return out;
}

function addCrateAlias(map: Map<string, string>, crateName: string, memberPath: string): void {
  map.set(crateName, memberPath);
  const normalized = crateName.replaceAll('-', '_');
  if (normalized !== crateName) map.set(normalized, memberPath);
}

function parseWorkspaceMembers(cargoToml: string): string[] {
  const section = getTomlSection(cargoToml, 'workspace');
  if (!section) return [];
  const rawMembers = getTomlArrayValue(section, 'members');
  if (!rawMembers) return [];
  return extractQuotedStrings(rawMembers).map(cleanMemberPath).filter(Boolean);
}

function parsePackageName(cargoToml: string): string | null {
  const section = getTomlSection(cargoToml, 'package');
  const match = section?.match(/(?:^|\n)\s*name\s*=\s*["']([^"'\n]+)["']/);
  return match?.[1]?.trim() ?? null;
}

function getTomlSection(content: string, sectionName: string): string | null {
  const lines = content.split(/\r?\n/);
  const out: string[] = [];
  let inSection = false;
  const sectionHeader = `[${sectionName}]`;

  for (const line of lines) {
    const trimmed = stripTomlLineComment(line).trim();
    if (!inSection) {
      if (trimmed === sectionHeader) inSection = true;
      continue;
    }
    if (/^\[[^\]]+\]$/.test(trimmed)) break;
    out.push(line);
  }

  return inSection ? out.join('\n') : null;
}

function getTomlArrayValue(section: string, key: string): string | null {
  const match = new RegExp(`(?:^|\\n)\\s*${escapeRegExp(key)}\\s*=`).exec(section);
  if (!match) return null;

  let pos = match.index + match[0].length;
  while (pos < section.length && /\s/.test(section[pos]!)) pos++;
  if (section[pos] !== '[') return null;

  let quote: '"' | "'" | null = null;
  let escaped = false;
  let depth = 0;
  const start = pos;

  for (; pos < section.length; pos++) {
    const ch = section[pos]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return section.slice(start, pos + 1);
    }
  }

  return null;
}

function extractQuotedStrings(text: string): string[] {
  const out: string[] = [];
  const re = /["']([^"'\n]+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) out.push(match[1]!.trim());
  return out;
}

function expandMembers(members: string[], context: ResolutionContext): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const cargoDirs = context
    .getAllFiles()
    .filter((file) => file.endsWith('/Cargo.toml'))
    .map((file) => file.slice(0, -'/Cargo.toml'.length));

  for (const member of members) {
    const candidates = GLOB_CHARS.test(member) ? cargoDirs.filter((dir) => globMatches(member, dir)) : [member];
    for (const candidate of candidates) {
      const cleaned = cleanMemberPath(candidate);
      if (!cleaned || seen.has(cleaned)) continue;
      seen.add(cleaned);
      out.push(cleaned);
    }
  }
  return out;
}

function globMatches(pattern: string, value: string): boolean {
  const regex = new RegExp(`^${globToRegex(pattern)}$`);
  return regex.test(value);
}

function globToRegex(pattern: string): string {
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExp(ch);
    }
  }
  return out;
}

function stripTomlLineComment(line: string): string {
  let quote: '"' | "'" | null = null;
  let escaped = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quote) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '#') return line.slice(0, i);
  }
  return line;
}

function cleanMemberPath(memberPath: string): string {
  return memberPath.replaceAll('\\', '/').replace(/\/+$/, '').replace(/^\.\//, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
