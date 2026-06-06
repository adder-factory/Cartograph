export interface InstallModelResult {
  downloaded: Array<{ filename: string; description: string }>;
  skipped: Array<{ filename: string }>;
}

export interface InstallModelRenderDeps {
  success: (message: string) => void;
  info: (message: string) => void;
}

export interface RecommendedConfigWriteOptions {
  projectRoot: string;
  dir?: string;
  includeAsk?: boolean;
  includeReranker?: boolean;
}

const BYTES_PER_MIB = 1024 * 1024;
const PROGRESS_PERCENT_SCALE = 100;

export function bytesToMiBText(bytes: number): string {
  return (bytes / BYTES_PER_MIB).toFixed(0);
}

export function formatInstallModelProgress(progress: {
  model: { filename: string };
  downloaded: number;
  total: number;
}): string {
  const { model, downloaded, total } = progress;
  const pct = total > 0 ? ((downloaded / total) * PROGRESS_PERCENT_SCALE).toFixed(0) : '?';
  return `\r${model.filename}: ${bytesToMiBText(downloaded)}/${total > 0 ? bytesToMiBText(total) : '?'} MB (${pct}%)   `;
}

export function buildRecommendedConfigWriteOptions(options: {
  projectRoot: string;
  dir?: string;
  minimal?: boolean;
}): RecommendedConfigWriteOptions {
  const writeOpts: RecommendedConfigWriteOptions = { projectRoot: options.projectRoot };
  if (options.dir) writeOpts.dir = options.dir;
  if (options.minimal) {
    writeOpts.includeAsk = false;
    writeOpts.includeReranker = false;
  }
  return writeOpts;
}

export function printInstallModelResults(result: InstallModelResult, deps: InstallModelRenderDeps): void {
  const { success, info } = deps;
  if (result.downloaded.length > 0) {
    success(`Downloaded ${result.downloaded.length} model${result.downloaded.length === 1 ? '' : 's'}:`);
    for (const m of result.downloaded) info(`  ${m.filename} — ${m.description}`);
  }
  if (result.skipped.length > 0) {
    info(`Already present (skipped): ${result.skipped.map((m) => m.filename).join(', ')}`);
  }
  info('');
}
