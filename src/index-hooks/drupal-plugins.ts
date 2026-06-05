/**
 * Drupal plugin discovery (Drupal v3, 2026-05-29).
 *
 * Walks indexed PHP CLASS nodes whose docstring carries a Drupal plugin
 * annotation — `@Block(id = "…")`, `@FieldType(id = "…")`,
 * `@FieldFormatter`, `@EntityType`, `@Action`, `@Constraint`, etc. — and
 * emits one `resource` node per plugin (named by its plugin id) + a
 * `references` edge from that node to the implementing class. This makes
 * Drupal plugins discoverable by id ("where is the block `my_block`?")
 * the same way services.yml services and routing.yml routes already are.
 *
 * Zero source re-parsing: the plugin id + type are read off the class
 * node's `docstring` (populated by the universal extractor), exactly the
 * AST-derived input `drupal-hooks` uses — no regex-against-source pairing.
 *
 * ## Covered
 *
 *   - **Docblock-annotation plugins** (v1 — Drupal 8/9/10 + annotation-based
 *     plugins on 10): `@PluginType(id = "the_id", …)` in the class
 *     docblock. Plugin type = the annotation name; id = the `id = "…"`
 *     value (single- or double-quoted).
 *   - **PHP-8-attribute plugins** (v4 — `#[Block(id: 'the_id')]`, the Drupal
 *     11 direction): the attribute's named args are now captured into
 *     `Node.decorator_args` (each entry's `namedArgs`, populated by the B9
 *     decorator-arg extractor's PHP path). An entry whose name is a
 *     capitalized attribute carrying a `namedArgs.id` is treated as a
 *     plugin — same shape as the docblock pass. Inline-FQCN attributes
 *     (`#[\Drupal\…\Block(…)]`) collapse to the bare attr name.
 *
 * ## Deferred
 *
 *   - Non-string-valued plugin ids and ids built from constants
 *     (`#[Block(id: self::ID)]`) — only string-literal `id:` values are
 *     captured (the extractor records string-valued named args only).
 *
 * ## Self-heal
 *
 * `DRUPAL_PLUGINS_ALGO_VERSION` is the SHA of this file. `afterSync`
 * compares it against the stored value; a mismatch triggers a one-shot
 * full re-mine, so existing projects pick up logic changes without a
 * manual `admin index`. Same pattern as `nestjs-routes` / `drupal-hooks`.
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { generateNodeId } from '../extraction/tree-sitter-helpers.js';
import { insertEdges } from '../db/queries-edges.js';
import { parseDecoratorArgsJson } from './_decorator-args.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge, Node, NodeKind } from '../types.js';

/** Algo-version SHA. Mismatch on `afterSync` triggers a full re-mine. */
export const DRUPAL_PLUGINS_ALGO_VERSION = computeAlgoHash('src/index-hooks/drupal-plugins.ts', ['./drupal-plugins']);
const LAST_MINED_KEY = 'last_mined_drupal_plugins_algo_version';

/**
 * First plugin annotation in a class docblock: `@TypeName( … id = "id" … )`.
 * `[A-Z]\w+` excludes lowercase docblock tags (`@param`/`@return`/`@var`).
 * The lazy `[\s\S]*?` reaches the first `id = "…"` inside the annotation —
 * which is the plugin id (nested annotations like `@Translation("…")` carry
 * no `id =`, so they don't match). Single- or double-quoted. Static literal
 * regex over a small docstring → no ReDoS exposure.
 */
const PLUGIN_ANNOTATION_RE = /@([A-Z]\w+)\s*\([\s\S]*?\bid\s*=\s*["']([^"']+)["']/;

interface PluginClass {
  classId: string;
  filePath: string;
  startLine: number;
  pluginType: string;
  pluginId: string;
}

/** A capitalized attribute name (`Block`, `FieldType`, …) — mirrors the
 *  `[A-Z]\w+` that `PLUGIN_ANNOTATION_RE` accepts for docblock plugins, so
 *  the attribute pass is no more permissive than the docblock pass. */
const ATTRIBUTE_PLUGIN_NAME_RE = /^[A-Z]\w+$/;

/** Collect Drupal plugin classes from BOTH discovery sources, deduped:
 *  (1) docblock annotations — PHP class nodes whose docstring carries a
 *  `@Type(… id = "…")` (a cheap `id =` SQL pre-filter keeps the JS-regex
 *  pass off every PHP class), and (2) PHP-8 attributes — class nodes whose
 *  `decorator_args` carries a capitalized attribute with a `namedArgs.id`.
 *  A class migrated from docblock to attribute (or carrying both) yields
 *  one plugin per (type, id), not two. */
function collectPluginClasses(ctx: IndexHookContext): PluginClass[] {
  const out: PluginClass[] = [];
  const seen = new Set<string>();
  const add = (p: PluginClass): void => {
    const key = `${p.classId}|${p.pluginType}:${p.pluginId}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };

  // Pass 1 — docblock-annotation plugins (v1).
  const docblockRows = ctx.queries.db
    .prepare(
      `SELECT id, file_path AS filePath, start_line AS startLine, docstring
       FROM nodes
       WHERE kind = 'class' AND language = 'php'
         AND docstring IS NOT NULL AND docstring LIKE '%id%=%'`,
    )
    .all() as Array<{ id: string; filePath: string; startLine: number; docstring: string }>;
  for (const row of docblockRows) {
    const m = PLUGIN_ANNOTATION_RE.exec(row.docstring);
    if (!m) continue;
    add({ classId: row.id, filePath: row.filePath, startLine: row.startLine, pluginType: m[1]!, pluginId: m[2]! });
  }

  // Pass 2 — PHP-8-attribute plugins (v4). The named args (incl. the
  // plugin `id`) are captured into decorator_args by the extractor's PHP
  // attribute path; an entry whose name is a capitalized attribute with a
  // string `id` is a plugin, mirroring the docblock pass's permissiveness.
  const attrRows = ctx.queries.db
    .prepare(
      `SELECT id, file_path AS filePath, start_line AS startLine, decorator_args AS decoratorArgs
       FROM nodes
       WHERE kind = 'class' AND language = 'php' AND decorator_args IS NOT NULL`,
    )
    .all() as Array<{ id: string; filePath: string; startLine: number; decoratorArgs: string }>;
  for (const row of attrRows) {
    for (const entry of parseDecoratorArgsJson(row.decoratorArgs)) {
      const pluginId = entry.namedArgs?.['id'];
      if (!pluginId || !ATTRIBUTE_PLUGIN_NAME_RE.test(entry.name)) continue;
      add({
        classId: row.id,
        filePath: row.filePath,
        startLine: row.startLine,
        pluginType: entry.name,
        pluginId,
      });
    }
  }
  return out;
}

function buildPluginNode(p: PluginClass, now: number): Node {
  // ordinal 0; id keyed on `<type>:<id>` so two plugin types may share an
  // id without colliding. Display name is the bare id — the thing you search.
  const id = generateNodeId({
    filePath: p.filePath,
    kind: 'resource' as NodeKind,
    name: `${p.pluginType}:${p.pluginId}`,
    ordinal: 0,
  });
  return {
    id,
    kind: 'resource' as NodeKind,
    name: p.pluginId,
    qualifiedName: `${p.filePath}::${p.pluginType}:${p.pluginId}`,
    filePath: p.filePath,
    language: 'php',
    startLine: p.startLine,
    endLine: p.startLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: now,
  };
}

function refresh(ctx: IndexHookContext): void {
  try {
    const plugins = collectPluginClasses(ctx);
    if (plugins.length > 0) {
      const newNodes: Node[] = [];
      const newEdges: Edge[] = [];
      const now = Date.now();
      for (const p of plugins) {
        const node = buildPluginNode(p, now);
        newNodes.push(node);
        newEdges.push({
          source: node.id,
          target: p.classId,
          kind: 'references',
          metadata: { synthesizedBy: 'drupal-plugins', pluginType: p.pluginType },
        });
      }
      // The plugin node's file_path = the class's file; its nodes.file_path
      // FK is satisfied because this hook runs AFTER extraction has upserted
      // every files row (afterIndexAll / afterSync are post-extraction).
      ctx.queries.insertNodes(newNodes);
      insertEdges(ctx.queries, newEdges);
    }
  } catch (err) {
    logDebug(`drupal-plugins refresh failed: ${errMsg(err)}`);
  }
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, DRUPAL_PLUGINS_ALGO_VERSION);
  } catch (err) {
    logDebug(`drupal-plugins stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'drupal-plugins',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== DRUPAL_PLUGINS_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Plugin annotation + class live in the same .php file, so a re-sync of
    // any PHP file (or any removal) is the trigger. The plugin `resource`
    // node carries the class's file_path, so the file's re-extraction
    // cascade-clears the stale node before this re-creates it.
    const changed = result.changedFilePaths ?? [];
    if (changed.some((p) => p.endsWith('.php')) || result.filesRemoved > 0) refresh(ctx);
  },
};
