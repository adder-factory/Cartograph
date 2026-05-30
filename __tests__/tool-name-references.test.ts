/**
 * Static-scan companion to the write-time `validateToolNameReferences`
 * guard in `src/mcp/tools/registry.ts`.
 *
 * The registry guard catches stale `cartograph_X` references in tool
 * SCHEMAS (top-level description + per-field description) at module
 * load. This test catches them in handler BODIES — error hint strings,
 * footer messages, error messages, etc. — by walking every
 * `src/mcp/tools/*.ts` file and grepping for `` `cartograph_X` ``
 * patterns. Each referenced name must resolve in either
 * `KNOWN_TOOL_NAMES` (a live registered tool) or `RETIRED_TOOL_NAMES`
 * (a documented merge / fold-in).
 *
 * Caught case (Friction #10, 2026-05-19): `_callees.ts` had
 * `Try \`cartograph_callees symbol=<methodName>\`` baked into a
 * container-method hint AFTER the pre-merge `cartograph_callees` was
 * retired. The string never reaches the registry's schema scan
 * because it's hand-rendered in `buildContainerMethodHint` — only a
 * source-file scan covers it.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { KNOWN_TOOL_NAMES, RETIRED_TOOL_NAMES } from '../src/mcp/tools/registry.js';

const TOOLS_DIR = path.join(__dirname, '..', 'src', 'mcp', 'tools');
const NAME_RE = /`(cartograph_[a-z_]+)`/g;

describe('tool-name references in handler bodies', () => {
  it('every `cartograph_X` reference in src/mcp/tools/*.ts resolves to a registered or retired tool', () => {
    const files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
    const stale: Array<{ file: string; ref: string; line: number; snippet: string }> = [];
    for (const file of files) {
      const fullPath = path.join(TOOLS_DIR, file);
      const text = fs.readFileSync(fullPath, 'utf-8');
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        for (const match of line.matchAll(NAME_RE)) {
          const ref = match[1]!;
          if (KNOWN_TOOL_NAMES.has(ref)) continue;
          if (RETIRED_TOOL_NAMES.has(ref)) continue;
          stale.push({
            file,
            ref,
            line: i + 1,
            snippet: line.trim().slice(0, 100),
          });
        }
      }
    }
    if (stale.length > 0) {
      const list = stale
        .map(({ file, ref, line, snippet }) => `  ${file}:${line} → \`${ref}\` in: ${snippet}`)
        .join('\n');
      throw new Error(
        `Stale \`cartograph_X\` references found in handler bodies:\n${list}\n\nEither rename to the current tool, add to RETIRED_TOOL_NAMES in registry.ts (and document the migration), or delete.`,
      );
    }
    expect(stale).toEqual([]);
  });
});
