/**
 * MyBatis Java↔XML linkage hook (B11/F#64b, 2026-05-26).
 *
 * Third consumer of the graph-walk pattern (after `nestjs-routes` /
 * `spring-value-binding`). Bridges Java/Kotlin Mapper-interface
 * methods to the MyBatis XML statements that implement them.
 *
 * Source side: the `xml` extractor (`languages/xml.ts`) emits
 * one `kind:'method'` node per `<select|insert|update|delete|sql
 * id="X">` inside a `<mapper namespace="com.example.UserMapper">`
 * file. The XML node's `qualifiedName` is `UserMapper::<id>` —
 * matching the JVM (Java/Kotlin) extractor's `<Interface>::<method>`
 * convention.
 *
 * What this hook does: for every XML mapper-statement method node,
 * find the JVM (Java/Kotlin) method node with the same `qualifiedName`
 * and emit a `references` edge from the JVM method to the XML
 * statement. After this, `cartograph_graph direction:callees
 * start=UserMapper.findById` surfaces the actual SQL statement
 * as a child of the JVM method.
 *
 * **XML-internal `<include refid>` references are NOT handled here.**
 * The xml extractor emits them as `UnresolvedReference`s with
 * `referenceName` already shaped as `<Class>::<id>`; the standard
 * resolver's qualifiedName-match path resolves them automatically
 * (with `resolvedBy: 'qualified-name'`, confidence 0.95). A
 * duplicate sub-pass in this hook would race the resolver and lose,
 * so it's intentionally absent.
 *
 * Match strategy v1:
 *
 *   - Equal `qualifiedName` (`UserMapper::findById` on both sides).
 *   - When multiple JVM methods share that name across packages
 *     (`com.example.UserMapper` AND `com.other.UserMapper`), all of
 *     them get the edge — MyBatis itself doesn't disambiguate by
 *     package in the cross-XML-to-JVM direction. A `same-file-first`
 *     tiebreaker isn't applicable (JVM source + XML always live in
 *     different files). This matches the existing JVM resolver's
 *     name-only behavior elsewhere.
 *
 * Self-heal via `MYBATIS_BINDING_ALGO_VERSION` +
 * `last_mined_mybatis_binding_algo_version` metadata key — same
 * pattern as `spring-value-binding` / `nestjs-routes`.
 *
 * Cross-language paths handled WITHOUT new hook code (the standard
 * resolver's qualifiedName-match path resolves these via the
 * pre-qualified `referenceName`s the xml extractor emits — same
 * hands-off strategy across v1.1 + v2 + v3):
 *   - `<include refid="X"/>` → `<sql id="X">` fragment (v1.1).
 *   - `resultMap="X"` / `parameterMap="X"` statement attributes →
 *     the matching `<resultMap>` / `<parameterMap>` type_alias (v2).
 *   - `#{paramName}` SQL placeholders → Java/Kotlin parameter nodes
 *     emitted by `tsEmitAnnotatedParameters` (v3 shipped Java,
 *     v3.1 added Kotlin via a state-machine that pairs Kotlin's
 *     sibling-split `parameter_modifiers` with the next `parameter`).
 *
 * Deferred (documented; uncomment when surfaced):
 *   - Spring `mybatis-config.xml` `<package name="..."/>` scans for
 *     Mapper auto-discovery.
 *   - Generic non-MyBatis XML support — needs `tree-sitter-xml.wasm`
 *     built (no pre-built `.wasm` on the npm grammar package).
 *   - Package-qualified disambiguation when the XML namespace's full
 *     package path could distinguish ambiguous JVM targets — needs
 *     the Java/Kotlin extractor to surface the package in qualifiedName
 *     first (it currently doesn't).
 */

import type { IndexHook, IndexHookContext } from './types.js';
import { computeAlgoHash } from '../algo-hash.js';
import { getMetadata, setMetadata } from '../db/queries-metadata.js';
import { logDebug, errMsg } from '../errors.js';
import { insertEdges } from '../db/queries-edges.js';
import type { SyncResult } from '../extraction/index.js';
import type { Edge } from '../types.js';

/** Algo-version SHA. Mismatch on `afterSync` triggers re-mine. */
export const MYBATIS_BINDING_ALGO_VERSION = computeAlgoHash(import.meta.url, ['./mybatis-binding']);
const LAST_MINED_KEY = 'last_mined_mybatis_binding_algo_version';

/** JVM languages whose Mapper-interface method nodes the bridge
 *  targets. (Scala has MyBatis bindings in the wild too but is rarer;
 *  add when a corpus surfaces it.) */
const JVM_LANGUAGES: ReadonlySet<string> = new Set(['java', 'kotlin']);

interface XmlStatement {
  xmlNodeId: string;
  qualifiedName: string;
  xmlFilePath: string;
  xmlStartLine: number;
}

function collectXmlStatements(ctx: IndexHookContext): XmlStatement[] {
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, qualified_name AS qualifiedName, file_path AS filePath, start_line AS startLine
       FROM nodes
       WHERE kind = 'method' AND language = 'xml'`,
    )
    .all() as Array<{ id: string; qualifiedName: string; filePath: string; startLine: number }>;
  return rows.map((r) => ({
    xmlNodeId: r.id,
    qualifiedName: r.qualifiedName,
    xmlFilePath: r.filePath,
    xmlStartLine: r.startLine,
  }));
}

/** Look up Java/Kotlin method nodes by qualifiedName. Returns a Map
 *  keyed by qualifiedName so the caller can batch the lookup with one
 *  IN-list rather than one query per statement. */
function lookupJvmMethods(ctx: IndexHookContext, qns: readonly string[]): Map<string, string[]> {
  const map = new Map<string, string[]>();
  if (qns.length === 0) return map;
  const qnsJson = JSON.stringify([...new Set(qns)]);
  const langsJson = JSON.stringify([...JVM_LANGUAGES]);
  const rows = ctx.queries.db
    .prepare(
      `SELECT id, qualified_name AS qualifiedName
       FROM nodes
       WHERE kind = 'method'
         AND language IN (SELECT value FROM json_each(@langsJson))
         AND qualified_name IN (SELECT value FROM json_each(@qnsJson))`,
    )
    .all({ qnsJson, langsJson }) as Array<{ id: string; qualifiedName: string }>;
  for (const row of rows) {
    const list = map.get(row.qualifiedName) ?? [];
    list.push(row.id);
    map.set(row.qualifiedName, list);
  }
  return map;
}

function refresh(ctx: IndexHookContext): void {
  try {
    const statements = collectXmlStatements(ctx);
    if (statements.length === 0) {
      stamp(ctx);
      return;
    }
    const lookup = lookupJvmMethods(
      ctx,
      statements.map((s) => s.qualifiedName),
    );
    const newEdges: Edge[] = [];
    for (const stmt of statements) {
      const targets = lookup.get(stmt.qualifiedName);
      if (!targets) continue;
      for (const javaMethodId of targets) {
        newEdges.push({
          source: javaMethodId,
          target: stmt.xmlNodeId,
          kind: 'references',
          metadata: { synthesizedBy: 'mybatis-binding' },
        });
      }
    }
    if (newEdges.length > 0) insertEdges(ctx.queries, newEdges);
  } catch (err) {
    logDebug(`mybatis-binding refresh failed: ${errMsg(err)}`);
  }
  stamp(ctx);
}

function stamp(ctx: IndexHookContext): void {
  try {
    setMetadata(ctx.queries, LAST_MINED_KEY, MYBATIS_BINDING_ALGO_VERSION);
  } catch (err) {
    logDebug(`mybatis-binding stamp failed: ${errMsg(err)}`);
  }
}

export const HOOK: IndexHook = {
  name: 'mybatis-binding',
  afterIndexAll(ctx) {
    refresh(ctx);
  },
  afterSync(ctx, result: SyncResult) {
    const storedAlgo = getMetadata(ctx.queries, LAST_MINED_KEY);
    if (storedAlgo !== MYBATIS_BINDING_ALGO_VERSION) {
      refresh(ctx);
      return;
    }
    // Sync trigger: any JVM or XML file changed → re-run. The lookup
    // is cross-file (JVM source in .java / .kt / .kts, statement in
    // .xml) so a project-wide pass is the simple v1; per-file scoping
    // is a perf follow-up.
    const changed = result.changedFilePaths ?? [];
    const anyJvmOrXmlChange =
      changed.some((p) => p.endsWith('.java') || p.endsWith('.kt') || p.endsWith('.kts') || p.endsWith('.xml')) ||
      result.filesRemoved > 0;
    if (anyJvmOrXmlChange) refresh(ctx);
  },
};
