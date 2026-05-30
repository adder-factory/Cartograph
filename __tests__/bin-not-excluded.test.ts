// Regression test for the over-broad recursive bin glob in the default
// exclude list.
//
// Before: the default exclude list had a recursive `bin` glob (intended
// for Java/.NET compiled output). On npm/Node projects where the CLI
// lives at `src/bin/<name>.ts` (the canonical layout for the `bin`
// field in package.json), this silently dropped the entire CLI surface
// from the index — breaking cross-file caller discovery for anything
// called from a CLI subcommand.
//
// After: the bin pattern is anchored to project root only, so top-level
// `bin/` (Java/.NET layout) is still excluded but `src/bin/`,
// `packages/x/bin/`, etc. are indexed.

import { describe, it, expect } from 'vitest';
import { createDefaultConfig, shouldIncludeFile } from '../src/config.js';
// The extractor has its own copy of shouldIncludeFile — co-verify so
// future drift between the two implementations is caught.
import { shouldIncludeFile as shouldIncludeFileExtractor } from '../src/extraction/index.js';

describe('default exclude — bin/ pattern is anchored', () => {
  const cfg = createDefaultConfig('/test/project');

  it('does NOT exclude src/bin/<name>.ts (npm CLI source convention)', () => {
    expect(shouldIncludeFile('src/bin/cartograph.ts', cfg)).toBe(true);
  });

  it('does NOT exclude packages/<x>/bin/cli.ts (monorepo CLI convention)', () => {
    expect(shouldIncludeFile('packages/cli/bin/main.ts', cfg)).toBe(true);
  });

  it('still excludes top-level bin/ (Java/.NET compiled output convention)', () => {
    expect(shouldIncludeFile('bin/Foo.class', cfg)).toBe(false);
    expect(shouldIncludeFile('bin/something.dll', cfg)).toBe(false);
  });

  it('does not have the over-broad **/bin/** pattern in defaults', () => {
    expect(cfg.exclude).not.toContain('**/bin/**');
    expect(cfg.exclude).toContain('bin/**');
  });

  // Indexer hot path uses its own shouldIncludeFile copy. Reviewer
  // flagged the drift risk; this test pins both implementations to
  // the same answer for the cases that matter.
  it('indexer-side shouldIncludeFile matches the config-side answer for src/bin/*', () => {
    expect(shouldIncludeFileExtractor('src/bin/cartograph.ts', cfg)).toBe(true);
    expect(shouldIncludeFileExtractor('packages/cli/bin/main.ts', cfg)).toBe(true);
    expect(shouldIncludeFileExtractor('bin/Foo.class', cfg)).toBe(false);
  });
});
