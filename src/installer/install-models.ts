/**
 * Downloads the curated GGUF set into `~/.cartograph/models/`.
 *
 * Surfaced two ways:
 *   1. `cartograph admin install-models` — CLI command, used by the
 *      installer's "recommended-stack" branch and by operators
 *      re-running setup later.
 *   2. Importable from the installer wizard so the prompt-flow can
 *      kick off the download after the user confirms.
 *
 * Wraps a plain HTTPS download with content-length progress reporting.
 * No third-party download library — Node's https + fs.createWriteStream
 * is enough here.
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import * as https from 'node:https';
import type { IncomingMessage } from 'node:http';
import { RECOMMENDED_MODELS, MODELS_DIR_DEFAULT, type RecommendedModel } from '../llm/recommended-models.js';
import { runSequential } from '../utils/async-iteration.js';

export interface InstallModelsOptions {
  /** Target directory. Defaults to `MODELS_DIR_DEFAULT`. */
  dir?: string;
  /** Skip any model whose target file already exists. Default true. */
  skipExisting?: boolean;
  /** Progress callback fired periodically per file. `total` may be
   *  unknown (0) when the server doesn't send content-length. */
  onProgress?: (status: { model: RecommendedModel; downloaded: number; total: number }) => void;
  /** Subset of recommended models to install. Defaults to all. */
  models?: readonly RecommendedModel[];
}

export interface InstallModelsResult {
  /** Models that were downloaded fresh in this run. */
  downloaded: RecommendedModel[];
  /** Models that were already present and skipped. */
  skipped: RecommendedModel[];
  /** Absolute path to each model's on-disk location after the run. */
  paths: Map<RecommendedModel, string>;
}

/** Download all (or a subset of) the recommended GGUFs. Idempotent —
 *  files that already exist are skipped unless `skipExisting: false`.
 *  Returns the absolute path of every model so the caller can write
 *  a config block. */
export async function installRecommendedModels(options: InstallModelsOptions = {}): Promise<InstallModelsResult> {
  const dir = options.dir ?? MODELS_DIR_DEFAULT;
  const skipExisting = options.skipExisting ?? true;
  const onProgress = options.onProgress;
  const models = options.models ?? RECOMMENDED_MODELS;

  await fsp.mkdir(dir, { recursive: true });

  const downloaded: RecommendedModel[] = [];
  const skipped: RecommendedModel[] = [];
  const paths = new Map<RecommendedModel, string>();

  await runSequential(models, async (model) => {
    const target = path.join(dir, model.filename);
    paths.set(model, target);
    if (
      skipExisting &&
      (await fsp
        .access(target)
        .then(() => true)
        .catch(() => false))
    ) {
      skipped.push(model);
      return true;
    }
    await downloadOne(model, target, onProgress);
    downloaded.push(model);
    return true;
  });

  return { downloaded, skipped, paths };
}

/** Minimum interval (ms) between progress emits when percent hasn't
 *  advanced by a whole point. At 500 ms this caps the chunky
 *  `res.on('data', ...)` firing rate (TCP packets land every few ms
 *  on a fast link), which is plenty for a human or piped log. */
const PROGRESS_MIN_INTERVAL_MS = 500;

/** HTTP status code that signals a successful response body. */
const HTTP_OK = 200;

/** Inclusive lower bound of the 3xx redirect status-code range. */
const HTTP_REDIRECT_MIN = 300;

/** Exclusive upper bound of the 3xx redirect status-code range. */
const HTTP_REDIRECT_MAX = 400;

/** Maximum number of redirects we follow before aborting with an error.
 *  HuggingFace typically issues one hop (HTTPS → CDN); 5 is a safe
 *  ceiling that blocks runaway redirect loops. */
const MAX_REDIRECT_HOPS = 5;

/** Initial hop counter passed to the recursive `request` helper. */
const INITIAL_HOP = 0;

interface DownloadState {
  downloaded: number;
  total: number;
}

interface DownloadResponseArgs {
  res: IncomingMessage;
  model: RecommendedModel;
  state: DownloadState;
  out: fs.WriteStream;
  emit: (downloaded: number, total: number) => void;
  request: (url: string, hops: number) => void;
  hops: number;
  reject: (reason?: unknown) => void;
}

function handleDownloadResponse(args: DownloadResponseArgs): void {
  const { res, model, state, out, emit, request, hops, reject } = args;
  // HF serves a redirect to a CDN; follow up to MAX_REDIRECT_HOPS hops.
  if (
    res.statusCode &&
    res.statusCode >= HTTP_REDIRECT_MIN &&
    res.statusCode < HTTP_REDIRECT_MAX &&
    res.headers.location
  ) {
    res.resume();
    request(res.headers.location, hops + 1);
    return;
  }
  if (res.statusCode !== HTTP_OK) {
    reject(new Error(`HTTP ${res.statusCode} fetching ${model.filename}`));
    res.resume();
    return;
  }
  state.total = Number(res.headers['content-length'] ?? 0);
  res.on('data', (chunk: Buffer) => {
    state.downloaded += chunk.length;
    emit(state.downloaded, state.total);
  });
  res.pipe(out);
}

async function downloadOne(
  model: RecommendedModel,
  target: string,
  onProgress?: InstallModelsOptions['onProgress'],
): Promise<void> {
  // Write to a `.partial` sibling and rename on success — that way an
  // aborted download (Ctrl-C, network drop) leaves no half-file that a
  // later run would mistake for complete. On promise rejection we also
  // unlink the partial so operators inspecting the dir mid-failure
  // don't see a dangling artefact (and we don't depend on the next
  // run's defensive rm at the top of the function).
  const tmp = `${target}.partial`;
  await fsp.rm(tmp, { force: true });

  // Rate-limit the per-chunk callback. Without this gate, a ~100 MB
  // download emits thousands of `onProgress` calls (one per TCP chunk),
  // which the CLI translates into ~3 MB of stdout in the first few
  // seconds. We forward an emit only when the integer percent has
  // advanced OR ≥ PROGRESS_MIN_INTERVAL_MS have elapsed since the last
  // forward. A terminal emit at `downloaded === total` is always
  // forwarded so piped logs see the final "100%" line.
  let lastPercent = -1;
  let lastEmitMs = 0;
  const emit = (downloaded: number, total: number): void => {
    if (!onProgress) return;
    const isFinal = total > 0 && downloaded >= total;
    const percent = total > 0 ? Math.floor((downloaded / total) * 100) : -1;
    const now = Date.now();
    if (isFinal || (percent >= 0 && percent !== lastPercent) || now - lastEmitMs >= PROGRESS_MIN_INTERVAL_MS) {
      lastPercent = percent;
      lastEmitMs = now;
      onProgress({ model, downloaded, total });
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp);
      const state: DownloadState = { downloaded: 0, total: 0 };

      const request = (url: string, hops: number): void => {
        if (hops > MAX_REDIRECT_HOPS) {
          reject(new Error(`too many redirects fetching ${model.filename}`));
          return;
        }
        const req = https.get(url, (res) =>
          handleDownloadResponse({ res, model, state, out, emit, request, hops, reject }),
        );
        req.on('error', reject);
        out.on('finish', () => resolve());
        out.on('error', reject);
      };
      request(model.hfUrl, INITIAL_HOP);
    });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {
      /* best-effort cleanup */
    });
    throw err;
  }

  await fsp.rename(tmp, target);
}
