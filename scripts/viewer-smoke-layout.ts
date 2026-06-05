export type ViewerSmokeLayoutWorkflow<TPage> = {
  page: TPage;
  url: string;
  assertBugReportCopy: (page: TPage) => Promise<void>;
  assertCalmerDefaultUi: (page: TPage) => Promise<void>;
  assertDenseGraphFixtureSpreads: (page: TPage, url: string) => Promise<void>;
  assertDensityControls: (page: TPage) => Promise<void>;
  assertEdgeKindFilters: (page: TPage) => Promise<void>;
  assertEdgeLensControl: (page: TPage) => Promise<void>;
  assertGraphExports: (page: TPage) => Promise<void>;
  assertGraphLayoutNotLinear: (page: TPage, label: string) => Promise<void>;
  assertGraphLayoutStableAcrossReload: (page: TPage, url: string) => Promise<void>;
  assertLayoutQualityAndDiagnostics: (page: TPage) => Promise<void>;
  assertPinnedLayoutControls: (page: TPage, url: string) => Promise<void>;
  assertSearchDisambiguation: (page: TPage) => Promise<void>;
  assertSyntheticForceLayoutDoesNotCollapse: (page: TPage, url: string) => Promise<void>;
  assertViewerStateStore: (page: TPage) => Promise<void>;
  assertZoomControls: (page: TPage) => Promise<void>;
  captureViewerScreenshot: (
    page: TPage,
    name: string,
    opts?: { baseline?: boolean; selector?: string },
  ) => Promise<void>;
  exposeAdvancedViewerControls: (page: TPage) => Promise<void>;
  waitForGraph: (page: TPage) => Promise<void>;
  waitForSelector: (selector: string) => Promise<unknown>;
};

export async function runViewerSmokeLayoutWorkflow<TPage>(ctx: ViewerSmokeLayoutWorkflow<TPage>): Promise<void> {
  const { page, url } = ctx;
  await ctx.waitForGraph(page);
  await ctx.assertViewerStateStore(page);
  await ctx.assertCalmerDefaultUi(page);
  await ctx.captureViewerScreenshot(page, 'desktop-default-graph', { baseline: true, selector: '#stage' });
  await ctx.assertGraphLayoutNotLinear(page, 'initial graph');
  await ctx.assertGraphLayoutStableAcrossReload(page, url);
  await ctx.assertSyntheticForceLayoutDoesNotCollapse(page, url);
  await ctx.assertDenseGraphFixtureSpreads(page, url);
  await ctx.exposeAdvancedViewerControls(page);
  await ctx.waitForSelector('[data-filter-edge]');
  await ctx.waitForSelector('#btn-open-editor');
  await ctx.waitForSelector('#btn-graph-png');
  await ctx.waitForSelector('#btn-graph-svg');
  await ctx.waitForSelector('#btn-graph-json');
  await ctx.assertZoomControls(page);
  await ctx.assertSearchDisambiguation(page);
  await ctx.assertDensityControls(page);
  await ctx.assertLayoutQualityAndDiagnostics(page);
  await ctx.assertBugReportCopy(page);
  await ctx.assertEdgeKindFilters(page);
  await ctx.assertEdgeLensControl(page);
  await ctx.assertGraphExports(page);
  await ctx.assertPinnedLayoutControls(page, url);
}
