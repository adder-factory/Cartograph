import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export const VIEWER_SMOKE_SCREENSHOT_DIR_ENV = 'VIEWER_SMOKE_SCREENSHOT_DIR';
export const VIEWER_SMOKE_BASELINE_DIR_ENV = 'VIEWER_SMOKE_BASELINE_DIR';
export const VIEWER_SMOKE_UPDATE_BASELINES_ENV = 'VIEWER_SMOKE_UPDATE_BASELINES';
export const VIEWER_SMOKE_ARTIFACT_DIR_ENV = 'VIEWER_SMOKE_ARTIFACT_DIR';

const MIN_SCREENSHOT_BYTES = 6_000;
const SCREENSHOT_BASELINE_PIXEL_THRESHOLD = 64;
const SCREENSHOT_BASELINE_MAX_DIFF_RATIO = 0.018;

export type ScreenshotPage = {
  locator: (selector: string) => {
    screenshot: (opts: { path: string }) => Promise<Buffer>;
  };
  evaluate: {
    <T>(fn: () => T | Promise<T>): Promise<T>;
    <T, A>(fn: (arg: A) => T | Promise<T>, arg: A): Promise<T>;
  };
  screenshot: (opts: { fullPage?: boolean; path: string }) => Promise<Buffer>;
  url?: () => string;
};

function envFlag(name: string): boolean {
  const value = process.env[name];
  return value === '1' || value === 'true' || value === 'yes';
}

function screenshotDir(): string {
  return process.env[VIEWER_SMOKE_SCREENSHOT_DIR_ENV] || path.join(os.tmpdir(), 'cartograph-viewer-smoke-screenshots');
}

function screenshotBaselineDir(): string {
  return (
    process.env[VIEWER_SMOKE_BASELINE_DIR_ENV] ||
    path.join(process.cwd(), '__tests__', 'fixtures', 'viewer-screenshots')
  );
}

function artifactDir(): string {
  return process.env[VIEWER_SMOKE_ARTIFACT_DIR_ENV] || screenshotDir();
}

function screenshotName(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'viewer'
  );
}

async function screenshotDataUrl(file: string): Promise<string> {
  return `data:image/png;base64,${(await fs.readFile(file)).toString('base64')}`;
}

async function compareScreenshotBaseline(
  page: ScreenshotPage,
  current: string,
  baseline: string,
  name: string,
): Promise<void> {
  const [baselineUrl, currentUrl] = await Promise.all([screenshotDataUrl(baseline), screenshotDataUrl(current)]);
  const diff = await page.evaluate(
    async ({ baselineUrl, currentUrl, threshold }) => {
      const load = (src: string): Promise<HTMLImageElement> =>
        new Promise((resolve, reject) => {
          const image = new Image();
          image.onload = () => resolve(image);
          image.onerror = reject;
          image.src = src;
        });
      const [baseImage, currentImage] = await Promise.all([load(baselineUrl), load(currentUrl)]);
      if (baseImage.width !== currentImage.width || baseImage.height !== currentImage.height) {
        return {
          dimensionsMatch: false,
          diffPixels: Number.POSITIVE_INFINITY,
          height: currentImage.height,
          maxDelta: Number.POSITIVE_INFINITY,
          pixelCount: 0,
          ratio: 1,
          width: currentImage.width,
          baseline: { height: baseImage.height, width: baseImage.width },
        };
      }
      const canvas = document.createElement('canvas');
      canvas.width = currentImage.width;
      canvas.height = currentImage.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) throw new Error('2D canvas unavailable');
      ctx.drawImage(baseImage, 0, 0);
      const base = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(currentImage, 0, 0);
      const next = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let diffPixels = 0;
      let maxDelta = 0;
      for (let i = 0; i < base.length; i += 4) {
        const delta =
          Math.abs(base[i] - next[i]) +
          Math.abs(base[i + 1] - next[i + 1]) +
          Math.abs(base[i + 2] - next[i + 2]) +
          Math.abs(base[i + 3] - next[i + 3]);
        maxDelta = Math.max(maxDelta, delta);
        if (delta > Number(threshold)) diffPixels++;
      }
      const pixelCount = canvas.width * canvas.height;
      return {
        dimensionsMatch: true,
        diffPixels,
        height: canvas.height,
        maxDelta,
        pixelCount,
        ratio: diffPixels / Math.max(1, pixelCount),
        width: canvas.width,
      };
    },
    {
      baselineUrl,
      currentUrl,
      threshold: SCREENSHOT_BASELINE_PIXEL_THRESHOLD,
    },
  );
  if (!diff.dimensionsMatch || diff.ratio > SCREENSHOT_BASELINE_MAX_DIFF_RATIO) {
    throw new Error(`viewer screenshot baseline drift for ${name}: ${JSON.stringify(diff)}`);
  }
}

export async function captureViewerScreenshot(
  page: ScreenshotPage,
  name: string,
  opts: { baseline?: boolean; selector?: string } = {},
): Promise<void> {
  const dir = screenshotDir();
  await fs.mkdir(dir, { recursive: true });
  const out = path.join(dir, `${screenshotName(name)}.png`);
  if (opts.selector) await page.locator(opts.selector).screenshot({ path: out });
  else await page.screenshot({ path: out, fullPage: false });
  const stat = await fs.stat(out);
  if (stat.size < MIN_SCREENSHOT_BYTES) {
    throw new Error(`viewer screenshot ${out} was suspiciously small: ${stat.size} bytes`);
  }
  if (!opts.baseline) return;
  const baselineDir = screenshotBaselineDir();
  const baseline = path.join(baselineDir, `${screenshotName(name)}.png`);
  if (envFlag(VIEWER_SMOKE_UPDATE_BASELINES_ENV)) {
    await fs.mkdir(baselineDir, { recursive: true });
    await fs.copyFile(out, baseline);
    return;
  }
  try {
    await fs.access(baseline);
  } catch {
    throw new Error(`viewer screenshot baseline missing for ${name}: ${baseline}`);
  }
  await compareScreenshotBaseline(page, out, baseline, name);
}

function errorSummary(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) return { message: error.message, stack: error.stack };
  return { message: String(error) };
}

export async function writeViewerSmokeFailureArtifacts(
  page: ScreenshotPage,
  name: string,
  error: unknown,
): Promise<string[]> {
  const dir = artifactDir();
  await fs.mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const base = screenshotName(`failure-${name}-${stamp}`);
  const files: string[] = [];
  const warnings: string[] = [];

  const fullPage = path.join(dir, `${base}.png`);
  try {
    await page.screenshot({ path: fullPage, fullPage: true });
    files.push(fullPage);
  } catch (err) {
    warnings.push(`full-page screenshot failed: ${String(err)}`);
  }

  const stage = path.join(dir, `${base}-stage.png`);
  try {
    await page.locator('#stage').screenshot({ path: stage });
    files.push(stage);
  } catch (err) {
    warnings.push(`stage screenshot failed: ${String(err)}`);
  }

  const payload = await page
    .evaluate(() => {
      const hook = (
        globalThis as {
          __cartographViewerSmoke?: {
            bugReportPayload?: () => unknown;
            diagnostics?: (label: string) => unknown;
            graphJsonPayload?: () => unknown;
            state?: () => unknown;
          };
          validateGraphState?: (label: string) => unknown;
        }
      ).__cartographViewerSmoke;
      const localStorageSnapshot: Record<string, string> = {};
      let localStorageError = '';
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('cartograph-viewer-')) localStorageSnapshot[key] = localStorage.getItem(key) || '';
        }
      } catch (err) {
        localStorageError = String(err);
      }
      return {
        bugReport: hook?.bugReportPayload?.() || null,
        diagnostics: hook?.diagnostics?.('smoke-failure') || null,
        graph: hook?.graphJsonPayload?.() || null,
        hash: location.hash || '',
        href: location.href,
        invariants: globalThis.validateGraphState?.('smoke-failure') || null,
        localStorage: localStorageSnapshot,
        localStorageError,
        state: hook?.state?.() || null,
        viewport: {
          devicePixelRatio: window.devicePixelRatio || 1,
          height: window.innerHeight,
          width: window.innerWidth,
        },
      };
    })
    .catch((err) => ({ artifactError: String(err) }));

  const json = path.join(dir, `${base}.json`);
  await fs.writeFile(
    json,
    JSON.stringify(
      {
        capturedAt: new Date().toISOString(),
        error: errorSummary(error),
        pageUrl: typeof page.url === 'function' ? page.url() : null,
        payload,
        warnings,
      },
      null,
      2,
    ),
  );
  files.push(json);
  return files;
}
