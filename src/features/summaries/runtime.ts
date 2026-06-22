import { z } from 'zod';

import { errMsg } from '../../errors.js';

export type SummariesAction = 'pending' | 'save';

export type SummariesMcpArgs = Record<string, unknown> & { action: SummariesAction };

export type SummariesArgResult = { ok: true; args: SummariesMcpArgs } | { ok: false; error: string };

export type SummariesInputResult = { ok: true; raw: string } | { ok: false; error: string };

const requiredSummarySaveString = z.string().trim().min(1);

export const summarySaveItemSchema = z.object({
  nodeId: requiredSummarySaveString,
  contentHash: requiredSummarySaveString,
  summary: requiredSummarySaveString.describe('One line, max 200 chars. Action verb. No "This function..." preamble.'),
});
export const summarySaveItemsSchema = z.array(summarySaveItemSchema);

export type SummarySaveItem = z.infer<typeof summarySaveItemSchema>;

export interface PendingSummariesOptions {
  limit?: number;
  modelHint?: string;
}

export interface SaveSummariesOptions {
  model?: string;
}

export interface SummariesInputDeps {
  readFile: (filePath: string) => string;
  readStdin: () => Promise<string>;
}

export function buildPendingSummariesArgs(options: PendingSummariesOptions): SummariesArgResult {
  const args: SummariesMcpArgs = { action: 'pending' };
  if (options.limit !== undefined) args['limit'] = options.limit;
  args['modelHint'] = options.modelHint ?? 'agent-cli';
  return { ok: true, args };
}

export async function readSummariesSaveInput(
  jsonFile: string | undefined,
  deps: SummariesInputDeps,
): Promise<SummariesInputResult> {
  if (!jsonFile) {
    try {
      return { ok: true, raw: await deps.readStdin() };
    } catch (err) {
      return { ok: false, error: `summaries save: could not read stdin: ${errMsg(err)}` };
    }
  }

  try {
    return { ok: true, raw: deps.readFile(jsonFile) };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: `summaries save: file not found: ${jsonFile}` };
    }
    return { ok: false, error: `summaries save: could not read file ${jsonFile}: ${errMsg(err)}` };
  }
}

export function buildSaveSummariesArgs(raw: string, options: SaveSummariesOptions): SummariesArgResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Could not parse summaries JSON: ${errMsg(err)}` };
  }

  let items: unknown;
  if (Array.isArray(parsed)) {
    items = parsed;
  } else if (isRecord(parsed)) {
    items = parsed['items'];
  }
  if (!Array.isArray(items)) {
    const error = 'Expected a JSON array of {nodeId, contentHash, summary} or {"items":[...]}.';
    return { ok: false, error };
  }
  const itemResult = summarySaveItemsSchema.safeParse(items);
  if (!itemResult.success) {
    return {
      ok: false,
      error: 'Expected each summary item to include non-empty string nodeId, contentHash, and summary.',
    };
  }
  const saveItems: SummarySaveItem[] = itemResult.data;

  return { ok: true, args: { action: 'save', items: saveItems, model: options.model ?? 'agent-cli' } };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
