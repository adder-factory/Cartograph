import { beforeAll, describe, expect, it } from 'vitest';
import { extractFromSource } from '../src/extraction/index.js';
import { detectLanguage, initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars.js';

beforeAll(async () => {
  await initGrammars();
  await loadGrammarsForLanguages(['luau']);
});

describe('Luau extraction', () => {
  it('detects .luau files and extracts Luau type aliases plus Lua-style functions', () => {
    const code = `
export type User = {
  name: string,
}

local M = {}

function M:greet(user: User): string
  return user.name
end

local function helper(value: number)
  return value
end
`;

    expect(detectLanguage('service.luau')).toBe('luau');
    const result = extractFromSource('service.luau', code);

    const typeAliases = result.nodes.filter((n) => n.kind === 'type_alias').map((n) => n.name);
    expect(typeAliases).toContain('User');

    const method = result.nodes.find((n) => n.kind === 'method' && n.name === 'M:greet');
    expect(method?.signature).toBe('function M:greet(user: User): string');

    const helper = result.nodes.find((n) => n.kind === 'function' && n.name === 'helper');
    expect(helper?.signature).toBe('function helper(value: number)');
  });
});
