export type ViewerSmokeFeaturesWorkflow<TPage> = {
  page: TPage;
  url: string;
  assertDetailGrouping: (page: TPage) => Promise<void>;
  assertEdgeInspector: (page: TPage) => Promise<void>;
  assertEscapeClearsSelection: (page: TPage) => Promise<void>;
  assertFindingsInteraction: (page: TPage) => Promise<void>;
  assertGraphSnapshotReplay: (page: TPage) => Promise<void>;
  assertGraphToolStates: (page: TPage) => Promise<void>;
  assertGroupCollapse: (page: TPage) => Promise<void>;
  assertHealthFilters: (page: TPage) => Promise<void>;
  assertInteractionRaceStability: (page: TPage) => Promise<void>;
  assertHealthView: (page: TPage) => Promise<void>;
  assertLiveView: (page: TPage) => Promise<void>;
  assertTraceView: (page: TPage) => Promise<void>;
  assertKindFilters: (page: TPage) => Promise<void>;
  assertLocalStateCorruptionRecovery: (page: TPage, url: string) => Promise<void>;
  assertNavigationHistoryRefocusesGraph: (page: TPage) => Promise<void>;
  assertResetView: (page: TPage) => Promise<void>;
  assertResetViewerLocalState: (page: TPage) => Promise<void>;
  assertSelectedNeighborhood: (page: TPage) => Promise<void>;
  assertSubpanelSymbolNavigation: (page: TPage) => Promise<void>;
  assertTooltips: (page: TPage) => Promise<void>;
  captureViewerScreenshot: (
    page: TPage,
    name: string,
    opts?: { baseline?: boolean; selector?: string },
  ) => Promise<void>;
  exposeAdvancedViewerControls: (page: TPage) => Promise<void>;
  focusSymbolViaSearch: (page: TPage, symbol: string) => Promise<void>;
  setSimpleViewerChrome: (page: TPage) => Promise<void>;
};

export async function runViewerSmokeFeaturesWorkflow<TPage>(ctx: ViewerSmokeFeaturesWorkflow<TPage>): Promise<void> {
  const { page, url } = ctx;
  await ctx.exposeAdvancedViewerControls(page);
  await ctx.assertGroupCollapse(page);
  await ctx.assertEdgeInspector(page);
  await ctx.assertKindFilters(page);
  await ctx.assertHealthFilters(page);
  await ctx.assertDetailGrouping(page);
  await ctx.assertResetView(page);
  await ctx.assertResetViewerLocalState(page);
  await ctx.assertLocalStateCorruptionRecovery(page, url);
  await ctx.exposeAdvancedViewerControls(page);
  await ctx.assertGraphToolStates(page);
  await ctx.assertGraphSnapshotReplay(page);
  await ctx.assertHealthView(page);
  await ctx.assertLiveView(page);
  await ctx.assertTraceView(page);
  await ctx.assertSubpanelSymbolNavigation(page);
  await ctx.assertNavigationHistoryRefocusesGraph(page);
  await ctx.assertTooltips(page);
  await ctx.assertInteractionRaceStability(page);
  await ctx.assertFindingsInteraction(page);
  await ctx.focusSymbolViaSearch(page, 'compute');
  await ctx.assertSelectedNeighborhood(page);
  await ctx.setSimpleViewerChrome(page);
  await ctx.captureViewerScreenshot(page, 'desktop-selected-node', { baseline: true, selector: '#stage' });
  await ctx.assertEscapeClearsSelection(page);
  await ctx.focusSymbolViaSearch(page, 'compute');
}
