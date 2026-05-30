/**
 * CLI argument-parser framework resolver.
 *
 * Surfaces individual CLI subcommands as `route` nodes so they appear
 * in `cartograph_entry_points` alongside HTTP routes — which closes the
 * gap where "where does this CLI start?" required reading bin/.
 *
 * Supports the chain-style API common to commander, yargs, caporal,
 * cac, and similar. The pattern that matters is `<obj>.command('NAME ...')`
 * — `<obj>` can be `program` or any chained sub-command holder.
 *
 * Class-based oclif and the yargs `command([cmd, alias], ...)` array
 * form are out of scope for this pass.
 */

import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext } from '../types.js';
import { stripCommentsForRegex, makeLineIndex } from '../../utils.js';
import { detectTsOrJs } from './detect-language.js';

const DEPENDENCY_NAMES = new Set(['commander', 'yargs', 'caporal', '@caporal/core', 'cac']);

// Match `<obj>.command('NAME ...')` where the receiver may be on a
// previous line (chained builder API): `program\n  .command('init')`.
// We don't capture the receiver because chained sub-builders use
// arbitrary local variable names (`adminCmd`, `summariesCmd`, etc.) —
// requiring same-line receiver missed 90%+ of commands in calibration
// against this repo's own bin/cartograph.ts.
const COMMAND_PATTERN = /\.command\(\s*['"]([^'"\n]+?)['"]/g;

export const cliCommanderResolver: FrameworkResolver = {
  name: 'cli-commander',

  detect(context: ResolutionContext): boolean {
    const packageJson = context.readFile('package.json');
    if (!packageJson) return false;
    try {
      const pkg = JSON.parse(packageJson);
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      for (const dep of Object.keys(deps)) {
        if (DEPENDENCY_NAMES.has(dep)) return true;
      }
    } catch {
      // Invalid JSON
    }
    return false;
  },

  // Resolver is extract-only; ref resolution stays with the language
  // resolvers (commander chains return `this`, so imports + name match
  // already cover them).
  resolve(): null {
    return null;
  },

  languages: ['typescript', 'javascript', 'tsx', 'jsx'],

  extractNodes(filePath: string, content: string, getStripped?: () => string): Node[] {
    const nodes: Node[] = [];
    const now = Date.now();
    const safe = getStripped ? getStripped() : stripCommentsForRegex(content, 'javascript');
    const lineOf = makeLineIndex(safe);

    const seen = new Set<string>();
    COMMAND_PATTERN.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = COMMAND_PATTERN.exec(safe)) !== null) {
      const [, spec] = match;

      // Spec like `'init [path]'` / `'admin'` / `'at-range <file> <a> <b>'`.
      // Take the first token as the command name.
      const name = spec!.trim().split(/\s+/)[0];
      if (!name) continue;
      // Skip clearly-not-a-command tokens (paths / URLs / option strings).
      if (name.startsWith('-') || name.startsWith('/') || name.includes('.')) continue;
      // Skip names that aren't CLI-shaped (kebab-case / lowercase
      // identifiers). Filters out e.g. `.command('SELECT * FROM …')`
      // SQL strings or other quoted literals that happen to contain
      // spaces/punctuation.
      if (!/^[a-z][a-zA-Z0-9-_]*$/.test(name)) continue;

      const line = lineOf(match.index);
      const id = `cli:${filePath}:${name}:${line}`;
      if (seen.has(id)) continue;
      seen.add(id);
      nodes.push({
        id,
        kind: 'route',
        name: `cmd ${name}`,
        qualifiedName: `${filePath}::cmd:${name}`,
        filePath,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: match[0].length,
        language: detectTsOrJs(filePath),
        signature: spec!.trim(),
        updatedAt: now,
      });
    }

    return nodes;
  },
};
