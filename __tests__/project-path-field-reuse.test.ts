/**
 * Convention test: every MCP tool that accepts a `projectPath`
 * argument must use the shared `projectPathField` schema from
 * `src/mcp/tools/_common-fields.ts`, NOT an inline `z.string()` form.
 *
 * The shared field was extracted explicitly to deduplicate the
 * `projectPath` schema (which had previously diverged into three
 * hand-maintained copies — see `_common-fields.ts`'s own JSDoc).
 * Re-divergence is a real bug class: a tool that re-declares
 * `projectPath: z.string()` inline forgets to inherit the
 * `.optional()` modifier (or any future tightening of the
 * description) and ships a contract that disagrees with every other
 * tool's projectPath arg.
 *
 * The check is a regex over each tool source file looking for the
 * inline form `projectPath: z.<anything>`. The reuse form
 * (`projectPath: projectPathField`) doesn't match. `_common-fields.ts`
 * itself is exempt — that's where the shared field's body lives.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.join(__dirname, '..');
const TOOLS_DIR = path.join(REPO_ROOT, 'src/mcp/tools');

/** Forbidden form: `projectPath: z.string()…` inline (or any other
 *  `z.<X>` start). Allowed: `projectPath: projectPathField`. */
const INLINE_PROJECT_PATH_RE = /projectPath\s*:\s*z\./;

describe('projectPath field — must use shared projectPathField', () => {
  it('no tool file re-declares projectPath as an inline z.<X> schema', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];
    const files = fs.readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      // `_common-fields.ts` is where `projectPathField` is DEFINED —
      // its body legitimately contains the `z.string()…` chain.
      if (f === '_common-fields.ts') continue;
      const full = path.join(TOOLS_DIR, f);
      const lines = fs.readFileSync(full, 'utf-8').split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (INLINE_PROJECT_PATH_RE.test(line)) {
          offenders.push({ file: f, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
