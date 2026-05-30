/**
 * Calculate the recommended number of cartograph_explore calls based
 * on project size. Larger codebases need more exploration calls to
 * cover their surface area; smaller ones should use fewer to avoid
 * unnecessary overhead.
 *
 * Lives in its own module so both `tools.ts` (which uses it inside
 * `getTools()` to inject a budget hint into the explore tool's
 * description) AND `tools/explore.ts` (which uses it inside the
 * handler body) can import without forming a runtime cycle.
 */

/**
 * (file-count threshold, recommended explore-call budget) pairs. The
 * first row whose threshold the project exceeds wins. Last row is
 * the catch-all. Tiers chosen so `<500` (typical app), `<5k`
 * (medium repo), `<15k` (large monorepo), `<25k` (enterprise) get
 * progressively more budget; everything bigger still caps at 5.
 */
const EXPLORE_BUDGET_TIERS: ReadonlyArray<readonly [maxFiles: number, budget: number]> = [
  [500, 1],
  [5000, 2],
  [15000, 3],
  [25000, 4],
];
const EXPLORE_BUDGET_CEILING = 5;

export function getExploreBudget(fileCount: number): number {
  for (const [maxFiles, budget] of EXPLORE_BUDGET_TIERS) {
    if (fileCount < maxFiles) return budget;
  }
  return EXPLORE_BUDGET_CEILING;
}
