/**
 * Glob matching, backed by `Bun.Glob`.
 *
 * Two exports cover the two usage shapes the codebase needs:
 *
 *   - `compileGlob(p)` — returns a reusable matcher closure. Closure
 *     captures one `Bun.Glob` instance so a hot loop never re-builds
 *     it. Use this when the same pattern is matched against many
 *     paths (per-row scans, layering checks).
 *   - `matchesGlob(path, p)` — one-shot check. Constructs a fresh
 *     `Bun.Glob` per call; fine for cold paths (config validation),
 *     avoid in tight loops.
 *
 * Dotfile matching is ALWAYS on. `Bun.Glob.match()` matches paths
 * like `.cartograph/foo.ts` against `**\/*.ts` by default — every
 * caller that previously needed an explicit "match dotfiles" flag
 * gets that behaviour for free here.
 */
export function compileGlob(pattern: string): (path: string) => boolean {
  const glob = new Bun.Glob(pattern);
  return (path: string): boolean => glob.match(path);
}

export function matchesGlob(filePath: string, pattern: string): boolean {
  return new Bun.Glob(pattern).match(filePath);
}
