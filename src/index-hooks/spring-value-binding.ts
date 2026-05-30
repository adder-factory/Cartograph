/**
 * Spring `@Value` config-key linkage hook (B11/F#64c, 2026-05-26).
 *
 * Second consumer of B9 (`Node.decoratorArgs`) — generalises the
 * B10/NestJS pattern beyond routing. Walks JVM (java/kotlin) field +
 * property nodes whose `decorators` array contains `Value`, reads the
 * placeholder string from `decoratorArgs.find(a => a.name === 'Value')
 * ?.argStrings[0]`, and emits a `references` edge from the field to
 * the matching `constant` node mined by the `.properties` extractor.
 *
 * Example:
 *
 *   `application.properties`:
 *     app.cache.ttl=60
 *
 *   `CacheConfig.java`:
 *     @Value("${app.cache.ttl}")
 *     private int cacheTtl;
 *
 *   → references edge: cacheTtl (field) → app.cache.ttl (constant)
 *
 * Placeholder shapes supported in v1:
 *   - `${key}`               — bare reference
 *   - `${key:default}`       — default-value suffix stripped before lookup
 *   - `prefix-${key}-suffix` — embedded placeholder (every `\${…}` in the
 *                              argString is scanned)
 *   - Multiple placeholders in one `@Value` — each gets its own edge
 *
 * Deferred (documented; uncomment + extend when a corpus surfaces):
 *   - YAML config-key extraction (`application.yml`) — needs a separate
 *     extractor walking tree-sitter-yaml; ~80 LOC follow-up.
 *   - Relaxed binding (Spring matches `app.cache-list` ↔ `app.cacheList`
 *     ↔ `app.cache_list` via canonical form).
 *   - `@ConfigurationProperties(prefix="X")` prefix-match — bind every
 *     key under `X.` to the annotated class.
 *
 * Self-heal via `SPRING_VALUE_BINDING_ALGO_VERSION`. Same pattern as
 * `nestjs-routes` / `go-implements` / `value-ref-edges`: a substantive
 * edit to this file changes the hash, next `afterSync` sees the
 * stored algo-version mismatch, triggers a one-shot full re-mine.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { insertEdges } from '../db/queries-edges.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge } from '../types.js';
import { parseDecoratorArgsJson } from './_decorator-args.js';

/** Algo-version SHA. Mismatch on `afterSync` triggers re-mine. */
export const SPRING_VALUE_BINDING_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./spring-value-binding']);
const LAST_MINED_KEY = 'last_mined_spring_value_binding_algo_version';

/** JVM languages whose field/property nodes carry `@Value` decorators. */
const JVM_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin']);

/** Match every `${key}` (with optional `:default` suffix) in a string.
 *  The inner `[^}]+` is greedy-bounded by `}` so nested `${...}` won't
 *  produce overlapping matches — Spring's own resolver doesn't support
 *  nested placeholders either. */
const PLACEHOLDER_RE = /\$\{([^}]+)\}/g;

/** Pull each `${key}` (or `${key:default}`) out of a `@Value` argument
 *  string, returning the lookup key with any `:default` suffix
 *  stripped. The default value is discarded — it doesn't correspond to
 *  any indexed constant. */
function extractConfigKeys(argString: string): string[] {
  const keys: string[] = [];
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(argString)) !== null) {
    const inner = m[1];
    if (!inner) continue;
    const colonIdx = inner.indexOf(':');
    const key = colonIdx === -1 ? inner : inner.substring(0, colonIdx);
    if (key.length > 0) keys.push(key);
  }
  return keys;
}

interface ValueAnnotatedNode {
  fieldId: string;
  fieldFilePath: string;
  fieldStartLine: number;
  argString: string;
}

/**
 * Walk the graph: find every JVM field or property node whose
 * `decorators` contains `Value` and whose `decorator_args` has a
 * `Value` entry with at least one argString. One SQL — no per-node
 * queries.
 */
function collectValueAnnotatedNodes(ctx: IndexHookContext): ValueAnnotatedNode[] {
  const langsJson = JSON.stringify([...JVM_LANGUAGES]);
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, file_path AS filePath, start_line AS startLine,
              decorator_args AS decoratorArgs
       FROM nodes
       WHERE kind IN ('field', 'property')
         AND language IN (SELECT value FROM json_each(@langsJson))
         AND decorators IS NOT NULL
         AND decorator_args IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM json_each(decorators)
           WHERE json_each.value = 'Value'
         )`,
    )
    .all({ langsJson }) as Array<{
    id: string;
    filePath: string;
    startLine: number;
    decoratorArgs: string | null;
  }>;

  const out: ValueAnnotatedNode[] = [];
  for (const row of rows) {
    const args = parseDecoratorArgsJson(row.decoratorArgs);
    const valueEntry = args.find((a) => a.name === 'Value');
    const argString = valueEntry?.argStrings[0];
    if (!argString) continue;
    out.push({
      fieldId: row.id,
      fieldFilePath: row.filePath,
      fieldStartLine: row.startLine,
      argString,
    });
  }
  return out;
}

/** Look up `constant` nodes by `qualified_name`. Returns a Map keyed
 *  by qualifiedName so the caller can batch the lookup with a single
 *  IN-list rather than one query per key. */
function lookupConstantNodes(ctx: IndexHookContext, keys: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (keys.length === 0) return map;
  const keysJson = JSON.stringify([...new Set(keys)]);
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, qualified_name AS qualifiedName
       FROM nodes
       WHERE kind = 'constant'
         AND language = 'properties'
         AND qualified_name IN (SELECT value FROM json_each(@keysJson))`,
    )
    .all({ keysJson }) as Array<{ id: string; qualifiedName: string }>;
  for (const row of rows) {
    const list = map.get(row.qualifiedName) ?? [];
    list.push(row.id);
    map.set(row.qualifiedName, list);
  }
  return map;
}

function refresh(ctx: IndexHookContext): void {
  try {
    const fields = collectValueAnnotatedNodes(ctx);
    if (fields.length === 0) {
      stamp(ctx);
      return;
    }

    // Collect every distinct key referenced across all @Value fields,
    // batch the constant-node lookup, then build edges field-by-field.
    const allKeys: string[] = [];
    const perField: Array<{ field: ValueAnnotatedNode; keys: string[] }> = [];
    for (const field of fields) {
      const keys = extractConfigKeys(field.argString);
      perField.push({ field, keys });
      for (const k of keys) allKeys.push(k);
    }
    const lookup = lookupConstantNodes(ctx, allKeys);

    const newEdges: Edge[] = [];
    for (const { field, keys } of perField) {
      for (const key of keys) {
        const targets = lookup.get(key);
        if (!targets) continue;
        for (const targetId of targets) {
          newEdges.push({
            source: field.fieldId,
            target: targetId,
            kind: 'references',
            line: field.fieldStartLine,
            metadata: { synthesizedBy: 'spring-value-binding', configKey: key },
          });
        }
      }
    }
    if (newEdges.length > 0) insertEdges(ctx.queries, newEdges);
  } catch (err) {
    logDebug(`spring-value-binding refresh failed: ${errMsg(err)}`);
  }
  stamp(ctx);
}

function stamp(ctx: IndexHookContext): void {
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, SPRING_VALUE_BINDING_ALGO_VERSION);
  } catch (err) {
    logDebug(`spring-value-binding stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'spring-value-binding',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== SPRING_VALUE_BINDING_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Sync trigger: any JVM source OR .properties file change → re-run.
    // The lookup is cross-file (field in .java, constant in .properties)
    // so a project-wide pass is the simple v1.
    const changed = result.changedFilePaths ?? [];
    const anyJvmOrPropsChange =
      changed.some(
        (p) => p.endsWith('.java') || p.endsWith('.kt') || p.endsWith('.kts') || p.endsWith('.properties'),
      ) || result.filesRemoved > 0;
    if (anyJvmOrPropsChange) refresh(ctx);
  },
};
