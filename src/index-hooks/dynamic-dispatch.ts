/**
 * Dynamic-dispatch hook — emits inferred `calls` edges for bounded same-file
 * dispatch tables.
 *
 * Static extractors see `HANDLERS[action]()` or `ACTIONS.get(kind)?.()` as a
 * call to an unknown computed value. This hook recognizes common literal
 * dispatch tables in TS/JS and links the caller file to every local function
 * that could be invoked. Fanout is capped so broad registries do not create
 * noisy all-to-all call graphs.
 */

import type { Edge } from '../types.js';
import type { IndexHook, IndexHookContext } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import { minerFileText } from './file-text-cache.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { getSymbolNameIndexByFile } from '../db/queries-search.js';
import { insertEdges } from '../db/queries-edges.js';
import { logDebug, errMsg } from '../errors.js';
import {
  type FileTarget,
  collectTargets,
  PER_FILE_YIELD_INTERVAL,
  yieldToEventLoop,
} from './edge-resolution-helpers.js';

const SUPPORTED_LANGS: ReadonlySet<string> = new Set(['typescript', 'javascript', 'tsx', 'jsx']);
const MAX_DISPATCH_FANOUT = 10;
const DECLARATION_RE = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g;
const CLOSE_BY_OPEN: Readonly<Record<string, string>> = {
  '{': '}',
  '[': ']',
  '(': ')',
};

export const DYNAMIC_DISPATCH_ALGO_VERSION = computeAlgoHash('src/index-hooks/dynamic-dispatch.ts', [
  './dynamic-dispatch',
]);
const LAST_MINED_KEY = 'last_mined_dynamic_dispatch_algo_version';

interface DispatchTable {
  name: string;
  kind: 'object' | 'map';
  targets: string[];
}

type DispatchEdge = Edge & { kind: 'calls' };

async function refresh(
  ctx: IndexHookContext,
  options: { scope: 'all' } | { scope: 'files'; files: string[] },
): Promise<void> {
  try {
    const edges = await buildDynamicDispatchEdges(ctx, collectTargets(ctx, options));
    if (edges.length > 0) insertEdges(ctx.queries, edges);
  } catch (err) {
    logDebug(`dynamic-dispatch hook failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, DYNAMIC_DISPATCH_ALGO_VERSION);
  } catch (err) {
    logDebug(`dynamic-dispatch stamp failed: ${errMsg(err)}`);
  }
}

async function buildDynamicDispatchEdges(ctx: IndexHookContext, files: FileTarget[]): Promise<DispatchEdge[]> {
  const edges: DispatchEdge[] = [];
  let processed = 0;
  for (const file of files) {
    if (!SUPPORTED_LANGS.has(file.language)) continue;
    const { cleaned } = minerFileText(ctx.projectRoot, file.path);
    if (!cleaned) continue;
    if (!hasDispatchSignal(cleaned)) continue;
    collectEdgesFromFile({ ctx, filePath: file.path, cleaned, edges });
    if (++processed % PER_FILE_YIELD_INTERVAL === 0) await yieldToEventLoop();
  }
  return edges;
}

function collectEdgesFromFile(args: {
  ctx: IndexHookContext;
  filePath: string;
  cleaned: string;
  edges: DispatchEdge[];
}): void {
  const tables = collectDispatchTables(args.cleaned).filter((table) => hasDispatchCall(args.cleaned, table));
  if (tables.length === 0) return;

  const nameIndex = getSymbolNameIndexByFile(args.ctx.queries, args.filePath);
  const fileNodeId = `file:${args.filePath}`;
  const seen = new Set<string>();
  for (const table of tables) {
    if (table.targets.length === 0 || table.targets.length > MAX_DISPATCH_FANOUT) continue;
    for (const targetName of table.targets) {
      const target = nameIndex.get(targetName);
      if (!target) continue;
      const key = `${fileNodeId}:${target}:calls`;
      if (seen.has(key)) continue;
      seen.add(key);
      args.edges.push({
        source: fileNodeId,
        target,
        kind: 'calls',
        confidence: 'INFERRED',
        metadata: { hook: 'dynamic-dispatch', table: table.name, tableKind: table.kind },
      });
    }
  }
}

function hasDispatchSignal(content: string): boolean {
  return content.includes('](') || content.includes(']?.(') || content.includes('.get(');
}

function collectDispatchTables(content: string): DispatchTable[] {
  const tables: DispatchTable[] = [];
  DECLARATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION_RE.exec(content)) !== null) {
    const name = match[1]!;
    const valueStart = skipWhitespace(content, DECLARATION_RE.lastIndex);
    const table = readDispatchTable(content, name, valueStart);
    if (!table) continue;
    tables.push(table.table);
    DECLARATION_RE.lastIndex = table.end;
  }
  return tables;
}

function readDispatchTable(
  content: string,
  name: string,
  valueStart: number,
): { table: DispatchTable; end: number } | null {
  if (content[valueStart] === '{') {
    const close = findMatching(content, valueStart);
    if (close === null) return null;
    return {
      table: { name, kind: 'object', targets: collectObjectTargets(content.slice(valueStart + 1, close)) },
      end: close + 1,
    };
  }

  const mapPrefix = 'new Map';
  if (!content.startsWith(mapPrefix, valueStart)) return null;
  const arrayStart = content.indexOf('[', valueStart + mapPrefix.length);
  if (arrayStart === -1) return null;
  const arrayEnd = findMatching(content, arrayStart);
  if (arrayEnd === null) return null;
  return {
    table: { name, kind: 'map', targets: collectMapTargets(content.slice(arrayStart + 1, arrayEnd)) },
    end: arrayEnd + 1,
  };
}

function collectObjectTargets(body: string): string[] {
  const targets: string[] = [];
  for (const entry of splitTopLevelEntries(body)) {
    const target = objectEntryTarget(entry);
    if (target) targets.push(target);
  }
  return unique(targets);
}

function collectMapTargets(body: string): string[] {
  const targets: string[] = [];
  for (const entry of splitTopLevelEntries(body)) {
    const tuple = trimWrappingBrackets(entry);
    const parts = splitTopLevelEntries(tuple);
    const target = firstIdentifier(parts[1] ?? '');
    if (target) targets.push(target);
  }
  return unique(targets);
}

function hasDispatchCall(content: string, table: DispatchTable): boolean {
  return table.kind === 'map' ? hasMapDispatchCall(content, table.name) : hasObjectDispatchCall(content, table.name);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function isReservedObjectToken(token: string): boolean {
  return token === 'const' || token === 'let' || token === 'var' || token === 'return';
}

function objectEntryTarget(entry: string): string | null {
  const trimmed = entry.trim();
  if (!trimmed) return null;
  const colon = topLevelColon(trimmed);
  const candidate = colon === -1 ? trimmed : trimmed.slice(colon + 1).trim();
  const target = firstIdentifier(candidate);
  return target && !isReservedObjectToken(target) ? target : null;
}

function firstIdentifier(value: string): string | null {
  const match = /^[A-Za-z_$][\w$]*/.exec(value.trim());
  return match?.[0] ?? null;
}

function splitTopLevelEntries(body: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let depth = 0;
  let i = 0;
  while (i < body.length) {
    const skipped = skipStringOrComment(body, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = body[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      entries.push(body.slice(start, i));
      start = i + 1;
    }
    i++;
  }
  entries.push(body.slice(start));
  return entries;
}

function topLevelColon(value: string): number {
  let depth = 0;
  let i = 0;
  while (i < value.length) {
    const skipped = skipStringOrComment(value, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = value[i];
    if (ch === '{' || ch === '[' || ch === '(') depth++;
    if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ':' && depth === 0) return i;
    i++;
  }
  return -1;
}

function trimWrappingBrackets(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;
}

function hasMapDispatchCall(content: string, tableName: string): boolean {
  let index = 0;
  const needle = `${tableName}.get`;
  while ((index = content.indexOf(needle, index)) !== -1) {
    const open = skipWhitespace(content, index + needle.length);
    if (content[open] !== '(') {
      index += needle.length;
      continue;
    }
    const close = findMatching(content, open);
    if (close !== null && hasCallAfterValue(content, close + 1)) return true;
    index = index + needle.length;
  }
  return false;
}

function hasObjectDispatchCall(content: string, tableName: string): boolean {
  let index = 0;
  const needle = `${tableName}[`;
  while ((index = content.indexOf(needle, index)) !== -1) {
    const close = findMatching(content, index + tableName.length);
    if (close !== null && hasCallAfterValue(content, close + 1)) return true;
    index += needle.length;
  }
  return false;
}

function hasCallAfterValue(content: string, start: number): boolean {
  let i = skipWhitespace(content, start);
  if (content.startsWith('?.', i)) i = skipWhitespace(content, i + 2);
  return content[i] === '(';
}

function skipWhitespace(content: string, start: number): number {
  let i = start;
  while (i < content.length && /\s/.test(content[i]!)) i++;
  return i;
}

function findMatching(content: string, openIndex: number): number | null {
  const open = content[openIndex];
  const close = matchingClose(open);
  if (!close) return null;
  let depth = 0;
  let i = openIndex;
  while (i < content.length) {
    const skipped = skipStringOrComment(content, i);
    if (skipped !== i) {
      i = skipped;
      continue;
    }
    const ch = content[i];
    if (ch === open) depth++;
    if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return null;
}

function matchingClose(open: string | undefined): string | null {
  return open ? (CLOSE_BY_OPEN[open] ?? null) : null;
}

function skipStringOrComment(content: string, index: number): number {
  const ch = content[index];
  if (ch === '"' || ch === "'" || ch === '`') return skipQuoted(content, index, ch);
  if (ch === '/' && content[index + 1] === '/') return skipLineComment(content, index + 2);
  if (ch === '/' && content[index + 1] === '*') return skipBlockComment(content, index + 2);
  return index;
}

function skipQuoted(content: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < content.length) {
    if (content[i] === '\\') {
      i += 2;
      continue;
    }
    if (content[i] === quote) return i + 1;
    i++;
  }
  return content.length;
}

function skipLineComment(content: string, start: number): number {
  let i = start;
  while (i < content.length && content[i] !== '\n') i++;
  return i;
}

function skipBlockComment(content: string, start: number): number {
  let i = start;
  while (i < content.length) {
    if (content[i] === '*' && content[i + 1] === '/') return i + 2;
    i++;
  }
  return content.length;
}

export const dynamicDispatchInternalsForTest = {
  collectDispatchTables,
  hasDispatchCall,
};

export const HOOK: IndexHook = {
  name: 'dynamic-dispatch',
  async afterIndexAll(ctx) {
    await refresh(ctx, { scope: 'all' });
  },
  async afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== DYNAMIC_DISPATCH_ALGO_VERSION) {
      await refresh(ctx, { scope: 'all' });
      return;
    }
    if ((result.changedFilePaths && result.changedFilePaths.length > 0) || result.filesRemoved > 0) {
      await refresh(ctx, { scope: 'files', files: result.changedFilePaths ?? [] });
    }
  },
};
