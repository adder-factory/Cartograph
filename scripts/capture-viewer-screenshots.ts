/**
 * Capture the README / docs screenshots from the live viewer.
 *
 * Boots the viewer server against the current repo's index, drives it
 * with Playwright at a retina scale factor, and writes the gallery
 * images into docs/assets/. Re-run after intentional viewer UI changes
 * so the README pictures never drift from the product:
 *
 *   bun scripts/capture-viewer-screenshots.ts [outDir]
 *
 * Env knobs:
 *   SHOT_FOCUS  — symbol searched for the hero shot (default below).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { startViewerServer } from '../src/features/viewer/server/index.js';

const VIEWPORT = { width: 1600, height: 1000 } as const;
const DEVICE_SCALE_FACTOR = 2;
const GRAPH_RENDER_TIMEOUT_MS = 20_000;
const LAYOUT_SETTLE_MS = 1_500;
const VIEW_SWITCH_SETTLE_MS = 1_200;
const DEFAULT_FOCUS = 'resolveLlmProviders';

const outDir = path.resolve(process.argv[2] ?? 'docs/assets');
const focusSymbol = process.env['SHOT_FOCUS'] ?? DEFAULT_FOCUS;

type Page = {
  goto: (url: string) => Promise<unknown>;
  screenshot: (opts: { path: string }) => Promise<unknown>;
  waitForSelector: (sel: string, opts: { state: 'visible'; timeout: number }) => Promise<unknown>;
  waitForFunction: (fn: () => boolean, arg: undefined, opts: { timeout: number }) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<void>;
  locator: (sel: string) => {
    fill: (v: string) => Promise<void>;
    click: () => Promise<void>;
    count: () => Promise<number>;
    first: () => { click: () => Promise<void> };
  };
  keyboard: { press: (key: string) => Promise<void> };
  mouse: { move: (x: number, y: number) => Promise<void> };
};

async function waitForGraph(page: Page): Promise<void> {
  await page.waitForSelector('#cy canvas', { state: 'visible', timeout: GRAPH_RENDER_TIMEOUT_MS });
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('#canvas-counter')?.textContent?.includes('Showing')) &&
      Boolean((document.querySelector('#graph-state') as HTMLElement | null)?.hidden),
    undefined,
    { timeout: GRAPH_RENDER_TIMEOUT_MS },
  );
  await page.waitForTimeout(LAYOUT_SETTLE_MS);
}

async function shoot(page: Page, name: string): Promise<void> {
  const file = path.join(outDir, name);
  await page.screenshot({ path: file });
  const { size } = fs.statSync(file);
  process.stdout.write(`captured ${file} (${Math.round(size / 1024)} KB)\n`);
}

fs.mkdirSync(outDir, { recursive: true });

const handle = await startViewerServer(process.cwd(), { port: 0 });
const playwright = await import('playwright');
const browser = await playwright.chromium.launch({ headless: true });

try {
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: DEVICE_SCALE_FACTOR });
  const page = (await context.newPage()) as unknown as Page;

  // 1. Project overview — the default core-density graph.
  await page.goto(handle.url);
  await waitForGraph(page);
  await shoot(page, 'viewer-graph.png');

  // 2. Hero — a focused symbol with the detail pane + source populated.
  await page.locator('#search-input').fill(focusSymbol);
  await page.keyboard.press('Enter');
  await waitForGraph(page);
  // Escape dismisses the autocomplete dropdown without clearing the
  // selection (the viewer keeps selection on Escape by design).
  await page.keyboard.press('Escape');
  await page.waitForTimeout(VIEW_SWITCH_SETTLE_MS);
  await shoot(page, 'viewer.png');

  // 3. Project health — findings, hotspots, coverage. Park the mouse
  // mid-canvas after every tab click so the tab tooltip isn't baked
  // into the shot.
  await page.locator('.tab[data-view="health"]').click();
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(VIEW_SWITCH_SETTLE_MS);
  await shoot(page, 'viewer-health.png');

  // 4. Agent trace — full-page timeline over a recorded session, with
  // a step selected so the detail card (args + graph-link chips) is
  // populated. Needs recorded MCP sessions in the index; skipped with
  // a notice when the project has none.
  await page.locator('.tab[data-view="trace"]').click();
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(VIEW_SWITCH_SETTLE_MS);
  const traceRows = await page.locator('.trace-row').count();
  if (traceRows > 0) {
    await page.locator('.trace-row').first().click();
    await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
    await page.waitForTimeout(VIEW_SWITCH_SETTLE_MS);
    await shoot(page, 'viewer-trace.png');
  } else {
    process.stdout.write('skipped viewer-trace.png — no recorded MCP sessions in this index\n');
  }

  // 5. Live — the streaming feed renders its backlog snapshot of the
  // newest session immediately, so a still shows real content.
  await page.locator('.tab[data-view="live"]').click();
  await page.mouse.move(VIEWPORT.width / 2, VIEWPORT.height / 2);
  await page.waitForTimeout(VIEW_SWITCH_SETTLE_MS);
  const liveRows = await page.locator('#lf-feed > *').count();
  if (liveRows > 0) {
    await shoot(page, 'viewer-live.png');
  } else {
    process.stdout.write('skipped viewer-live.png — no tool-call backlog in this index\n');
  }
} finally {
  await browser.close();
  await handle.close();
}
