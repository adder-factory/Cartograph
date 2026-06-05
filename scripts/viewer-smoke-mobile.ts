export type ViewerSmokeMobileWorkflow<TPage> = {
  page: TPage;
  assertGraphFitsViewport: (page: TPage, label: string) => Promise<void>;
  assertMobilePanels: (page: TPage) => Promise<void>;
  assertVisibleEdgesConnect: (page: TPage, label: string, requireEdges?: boolean) => Promise<void>;
  captureViewerScreenshot: (
    page: TPage,
    name: string,
    opts?: { baseline?: boolean; selector?: string },
  ) => Promise<void>;
  detailOpenFastTimeoutMs: number;
  minCodeDrawerHeight: number;
  minDetailDrawerHeight: number;
  minDrawerTopY: number;
  mobileQueryTimeoutMs: number;
  mobileViewport: { width: number; height: number };
  waitForGraph: (page: TPage) => Promise<void>;
};

export async function runViewerSmokeMobileWorkflow<
  TPage extends {
    evaluate: <T>(fn: () => T | Promise<T>) => Promise<T>;
    locator: (selector: string) => {
      boundingBox: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
      click: () => Promise<void>;
    };
    setViewportSize: (size: { width: number; height: number }) => Promise<void>;
    waitForFunction: (
      fn: (arg?: unknown) => unknown,
      arg?: unknown,
      opts?: Record<string, unknown>,
    ) => Promise<unknown>;
  },
>(ctx: ViewerSmokeMobileWorkflow<TPage>): Promise<void> {
  const { page } = ctx;
  await page.setViewportSize(ctx.mobileViewport);
  await page.waitForFunction(() => matchMedia('(max-width: 860px)').matches, undefined, {
    timeout: ctx.mobileQueryTimeoutMs,
  });
  await ctx.assertGraphFitsViewport(page, 'mobile viewport switch');
  await ctx.assertVisibleEdgesConnect(page, 'mobile viewport switch');
  await ctx.captureViewerScreenshot(page, 'mobile-default-graph', { baseline: true, selector: '#stage' });
  let detailBox = await page.locator('#detail-pane').boundingBox();
  if (!detailBox || detailBox.height < ctx.minDetailDrawerHeight) {
    await page.locator('[data-mobile-panel="detail"]').click();
    const opened = await page
      .waitForFunction(() => document.querySelector('#stage')?.classList.contains('mobile-detail-open'), undefined, {
        timeout: ctx.detailOpenFastTimeoutMs,
      })
      .then(() => true)
      .catch(() => false);
    if (!opened) {
      await page.evaluate(() => document.querySelector<HTMLElement>('[data-mobile-panel="detail"]')?.click());
      await page.waitForFunction(
        () => document.querySelector('#stage')?.classList.contains('mobile-detail-open'),
        undefined,
        {
          timeout: ctx.mobileQueryTimeoutMs,
        },
      );
    }
    detailBox = await page.locator('#detail-pane').boundingBox();
  }
  if (!detailBox || detailBox.y < ctx.minDrawerTopY || detailBox.height < ctx.minDetailDrawerHeight) {
    throw new Error(`mobile detail drawer geometry looked wrong: ${JSON.stringify(detailBox)}`);
  }
  await page.locator('[data-mobile-panel="source"]').click();
  const codeBox = await page.locator('#codepane').boundingBox();
  if (!codeBox || codeBox.y < ctx.minDrawerTopY || codeBox.height < ctx.minCodeDrawerHeight) {
    throw new Error(`mobile source drawer geometry looked wrong: ${JSON.stringify(codeBox)}`);
  }
  await ctx.assertGraphFitsViewport(page, 'mobile source panel');
  await ctx.assertVisibleEdgesConnect(page, 'mobile source panel');
  await ctx.assertMobilePanels(page);
  await ctx.waitForGraph(page);
}
