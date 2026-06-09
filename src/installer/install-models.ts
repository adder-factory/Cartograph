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
import * as crypto from 'node:crypto';
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
    if (skipExisting && (await fileExists(target))) {
      const verification = await verifyModelFile(target, model);
      if (verification.ok) {
        skipped.push(model);
        return true;
      }
      await fsp.rm(target, { force: true });
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

/** Socket idle timeout. Large active downloads keep resetting this timer. */
const DOWNLOAD_SOCKET_TIMEOUT_MS = 60_000;

interface DownloadState {
  downloaded: number;
  total: number;
}

interface DownloadResponseArgs {
  res: IncomingMessage;
  model: RecommendedModel;
  currentUrl: string;
  state: DownloadState;
  out: fs.WriteStream;
  emit: (downloaded: number, total: number) => void;
  request: (url: string, hops: number) => void;
  hops: number;
  reject: (reason?: unknown) => void;
}

function handleDownloadResponse(args: DownloadResponseArgs): void {
  const { res, model, currentUrl, state, out, emit, request, hops, reject } = args;
  // HF serves a redirect to a CDN; follow up to MAX_REDIRECT_HOPS hops.
  if (
    res.statusCode &&
    res.statusCode >= HTTP_REDIRECT_MIN &&
    res.statusCode < HTTP_REDIRECT_MAX &&
    res.headers.location
  ) {
    res.resume();
    request(resolveRedirectUrl(currentUrl, res.headers.location), hops + 1);
    return;
  }
  if (res.statusCode !== HTTP_OK) {
    const err = new Error(`HTTP ${res.statusCode} fetching ${model.filename}`);
    reject(err);
    out.destroy(err);
    res.resume();
    return;
  }
  const total = parseContentLength(res.headers['content-length']);
  if (total !== null && total !== model.sizeBytes) {
    const err = new Error(
      `unexpected size for ${model.filename}: server reported ${total} bytes, expected ${model.sizeBytes}`,
    );
    reject(err);
    out.destroy(err);
    res.resume();
    return;
  }
  state.total = total ?? 0;
  res.on('data', (chunk: Buffer) => {
    state.downloaded += chunk.length;
    if (state.downloaded > model.sizeBytes) {
      reject(new Error(`download for ${model.filename} exceeded expected size ${model.sizeBytes} bytes`));
      res.destroy();
      out.destroy();
      return;
    }
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

  const initialUrl = assertHttpsDownloadUrl(model.hfUrl);

  try {
    await new Promise<void>((resolve, reject) => {
      const out = fs.createWriteStream(tmp, { mode: 0o600 });
      const state: DownloadState = { downloaded: 0, total: 0 };

      const request = (url: string, hops: number): void => {
        if (hops > MAX_REDIRECT_HOPS) {
          const err = new Error(`too many redirects fetching ${model.filename}`);
          reject(err);
          out.destroy(err);
          return;
        }
        let parsedUrl: string;
        try {
          parsedUrl = assertHttpsDownloadUrl(url);
        } catch (err) {
          reject(err);
          out.destroy(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const req = https.get(parsedUrl, (res) =>
          handleDownloadResponse({ res, model, currentUrl: parsedUrl, state, out, emit, request, hops, reject }),
        );
        req.setTimeout(DOWNLOAD_SOCKET_TIMEOUT_MS, () => {
          req.destroy(new Error(`timed out fetching ${model.filename} after ${DOWNLOAD_SOCKET_TIMEOUT_MS}ms idle`));
        });
        req.on('error', (err) => {
          out.destroy(err);
          reject(err);
        });
      };
      out.once('finish', () => resolve());
      out.once('error', reject);
      request(initialUrl, INITIAL_HOP);
    });
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {
      /* best-effort cleanup */
    });
    throw err;
  }

  await verifyModelFile(tmp, model).then((verification) => {
    if (!verification.ok) throw new Error(verification.reason);
  });
  await fsp.rename(tmp, target);
}

async function fileExists(filePath: string): Promise<boolean> {
  return fsp
    .access(filePath)
    .then(() => true)
    .catch(() => false);
}

async function verifyModelFile(
  filePath: string,
  model: RecommendedModel,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const stat = await fsp.stat(filePath).catch((err) => ({ error: err instanceof Error ? err.message : String(err) }));
  if ('error' in stat) return { ok: false, reason: `${model.filename} is not readable: ${stat.error}` };
  if (stat.size !== model.sizeBytes) {
    return {
      ok: false,
      reason: `${model.filename} has ${stat.size} bytes, expected ${model.sizeBytes}`,
    };
  }
  const digest = await sha256File(filePath);
  if (digest !== model.sha256) {
    return {
      ok: false,
      reason: `${model.filename} sha256 ${digest} did not match expected ${model.sha256}`,
    };
  }
  return { ok: true };
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', () => resolve(hash.digest('hex')));
  });
}

function parseContentLength(value: string | string[] | undefined): number | null {
  if (Array.isArray(value)) return parseContentLength(value[0]);
  if (value === undefined) return null;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function assertHttpsDownloadUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error(`refusing non-HTTPS model download URL: ${url}`);
  return parsed.toString();
}

function resolveRedirectUrl(baseUrl: string, location: string): string {
  return new URL(location, baseUrl).toString();
}
