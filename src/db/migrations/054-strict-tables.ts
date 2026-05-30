import type { MigrationModule } from './types.js';

/**
 * Convert every base table to SQLite STRICT mode.
 *
 * SQLite's default "type affinity" lets a column declared as INTEGER
 * silently accept TEXT (and vice-versa). On a code-intelligence DB
 * with 32 tables and dozens of contributors over time, that's a
 * latent class of bugs — a stringified row id ('123' instead of 123)
 * compares unequal in JOINs, breaks INTEGER-PK lookups, and corrupts
 * downstream aggregates. STRICT tables enforce the declared type at
 * INSERT / UPDATE time, surfacing those violations immediately.
 *
 * Schema survey before the change found:
 *   112 TEXT, 86 INTEGER, 3 REAL, 2 BLOB columns
 *   0 VARCHAR / NUMERIC / DOUBLE / FLOAT (would need rewriting)
 *   0 type-elided columns (where STRICT would refuse)
 * — i.e. the column DECLARATIONS are STRICT-ready out of the box; this
 * migration flips the keyword + rebuilds the tables to apply it, and
 * coerces any loose pre-STRICT data affinities to the declared type on
 * copy (step 2) so legacy rows — e.g. a fractional REAL in the INTEGER
 * `files.modified_at` — don't fail the STRICT INSERT.
 *
 * Approach. SQLite has no `ALTER TABLE foo SET STRICT` — STRICT is a
 * parse-time table option and changing it requires the standard
 * "table rebuild" dance:
 *
 *   1. CREATE TABLE foo_strict_tmp ( ...same defs... ) STRICT
 *   2. INSERT INTO foo_strict_tmp SELECT <cols CAST to their strict
 *      type> FROM foo  — the CAST coerces loose pre-STRICT affinities
 *      (e.g. a REAL fractional epoch-ms in files.modified_at) that a
 *      blind copy would reject; it is a no-op for already-correct values
 *   3. capture indexes + triggers attached to `foo`
 *   4. DROP TABLE foo (cascades indexes + triggers)
 *   5. ALTER TABLE foo_strict_tmp RENAME TO foo
 *   6. recreate indexes + triggers (their SQL still references `foo`)
 *
 * Doing this 32 times by hand is fragile (someone forgets a DEFAULT
 * or a CHECK), so the migration drives it from `sqlite_master`:
 * read the existing CREATE statement, swap the table name for a
 * temp, append `) STRICT`, then rebuild via the same six steps.
 * Requires `requiresFkDisable: true` so dropping a table that's the
 * FK target of another doesn't throw mid-migration.
 *
 * Excluded: virtual tables (FTS5 / RTree — they have their own type
 * system and reject STRICT), system `sqlite_*` tables, and the vec0
 * mirror `vec_symbol_embeddings_<dim>` tables (sqlite-vec virtual,
 * not declared in our schema).
 *
 * Idempotent: tables already declared STRICT are skipped, so a
 * fresh DB whose schema.sql already has STRICT (this same change
 * adds it there) replays as a no-op.
 */

interface ObjectRow {
  name: string;
  sql: string | null;
}

const VEC_PREFIX = 'vec_';
const SYSTEM_PREFIX = 'sqlite_';
const TEMP_SUFFIX = '__strict_tmp';

// Allowed values for the enum-shaped columns CHECK constraints below
// reference. These mirror the TypeScript types in src/types.ts and
// the ROLE_LABELS list in src/llm/classifier.ts. Update both sides
// when extending.
const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
  'table',
  'resource',
];
const EDGE_KINDS = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
  'decorates',
  'tests',
  'field_access',
  'similar_to',
  'def_use',
];
const ROLE_LABELS = [
  'api_endpoint',
  'business_logic',
  'data_model',
  'util',
  'framework_glue',
  'test_helper',
  'unknown',
];
const EDGE_CONFIDENCE = ['EXTRACTED', 'INFERRED', 'AMBIGUOUS'];
const EMBEDDING_GRAINS = ['symbol', 'file'];

const inList = (vals: string[]): string => `(${vals.map((v) => `'${v}'`).join(', ')})`;

// The three SQLite scalar storage classes the copy step CASTs through
// to coerce loose pre-STRICT affinities (step 2). BLOB / ANY / a
// missing declared type fall outside this set and are copied verbatim
// (no meaningful CAST target). Used to decide each column's SELECT-list
// expression in strictifyTable.
const CASTABLE_STRICT_TYPES: ReadonlySet<string> = new Set(['INTEGER', 'REAL', 'TEXT']);

/** True when a declared column type is one CAST coerces during the copy. */
const isCastableStrictType = (declaredType: string | undefined): boolean =>
  declaredType !== undefined && CASTABLE_STRICT_TYPES.has(declaredType);

// Per-table CREATE-statement fixups to apply BEFORE strictifying. The
// fixup runs against the SQL pulled from sqlite_master so the rebuild
// produces a STRICT table with the corrected types from schema.sql.
//
// Fixups we apply:
//   - `code_health_findings.metric` was INTEGER but brain_method emits
//     a fractional score (~12.3); promote to REAL.
//   - Enum-shaped columns get CHECK constraints so the same philosophy
//     STRICT applies to types extends to values: a typo'd kind like
//     `function ` (trailing space) or `funtion` is rejected at write
//     time instead of silently corrupting downstream queries.
/** @internal Exported for `__tests__/schema-invariants.test.ts`. */
export const PER_TABLE_FIXUPS: Record<string, (sql: string) => string> = {
  code_health_findings: (sql) => sql.replace(/\bmetric\s+INTEGER\b/i, 'metric REAL'),
  nodes: (sql) =>
    sql
      .replace(/\bkind\s+TEXT\s+NOT\s+NULL\b/i, `kind TEXT NOT NULL CHECK (kind IN ${inList(NODE_KINDS)})`)
      .replace(/(^\s+)role\s+TEXT,/im, `$1role TEXT CHECK (role IS NULL OR role IN ${inList(ROLE_LABELS)}),`),
  edges: (sql) =>
    sql
      .replace(/\bkind\s+TEXT\s+NOT\s+NULL\b/i, `kind TEXT NOT NULL CHECK (kind IN ${inList(EDGE_KINDS)})`)
      .replace(
        /\bconfidence\s+TEXT,/i,
        `confidence TEXT CHECK (confidence IS NULL OR confidence IN ${inList(EDGE_CONFIDENCE)}),`,
      ),
  embedding_refs: (sql) =>
    sql.replace(
      /\bgrain\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'symbol'/i,
      `grain TEXT NOT NULL DEFAULT 'symbol' CHECK (grain IN ${inList(EMBEDDING_GRAINS)})`,
    ),
};

// Tables to convert to WITHOUT ROWID alongside the STRICT rebuild.
// Each is a natural-PK table (TEXT PK or composite PK) with no
// external code referencing its `rowid`. WITHOUT ROWID skips the
// implicit rowid B-tree, saving ~30% storage on small rows and
// making PK lookups one B-tree fewer.
//
// Excluded from this list (must keep ROWID):
//   - nodes                    — FTS5 content backing + nodes_rtree triggers using NEW.rowid
//   - summary_store            — FTS5 content backing for summary_fts
//   - test_names               — FTS5 content backing for test_names_fts
//   - embedding_store          — vec0 mirror keyed by rowid (migration 050)
//   - embedding_refs           — HNSW index reads `r.rowid` via the symbol_embeddings view
//   - symbol_chunk_embeddings  — separate chunk-grain vec mirror keyed by rowid
//   - parse_cache              — eviction logic deletes by oldest rowid
//   - mcp_tool_calls           — trace-logger pruneToolCalls deletes by rowid
//
// Other AUTOINCREMENT-PK tables (edges, unresolved_refs, ...) keep
// rowid by definition (INTEGER PRIMARY KEY AUTOINCREMENT === alias
// for the rowid).
const WITHOUT_ROWID_TABLES = new Set<string>([
  'role_assignments',
  'files',
  'co_changes',
  'project_metadata',
  'symbol_issues',
  'summary_refs',
  'directory_summaries',
  'node_coverage',
  'code_health_findings',
  'node_loc_history',
  'mcp_sessions',
  'mcp_macros',
  'node_metrics',
  'summary_priority_queue',
  'commit_intents',
]);

export const MIGRATION: MigrationModule = {
  description: 'Rebuild every base table as STRICT for type enforcement',
  requiresFkDisable: true,
  up: (db) => {
    // Pre-flight: bail on partial-schema test fixtures. Migration 034
    // attaches `nodes_rtree_ai/_au` triggers to `nodes` referencing
    // `NEW.start_line` / `NEW.end_line`. A few migration-test fixtures
    // build minimal `nodes (id TEXT PRIMARY KEY)` tables without those
    // columns; the rtree triggers compile fine but error on every
    // subsequent INSERT — including any INSERT we do as part of the
    // strictify rebuild loop (the trigger appears to be evaluated for
    // ANY INSERT in the same connection once it's broken, even when
    // the inserted-into table is unrelated). Skip cleanly so test
    // fixtures stay green; on a real production DB `nodes` always has
    // these columns since v1, so the guard is a no-op there.
    const hasNodes = db.prepare("SELECT 1 AS one FROM sqlite_master WHERE type='table' AND name='nodes'").get() as
      | { one: number }
      | undefined;
    if (hasNodes) {
      const nodeCols = (db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name);
      if (!nodeCols.includes('start_line') || !nodeCols.includes('end_line')) {
        return;
      }
    }

    // Collect virtual-table names so we can also skip their backing
    // shadow tables (rtree creates `<name>_node` / `_rowid` / `_parent`,
    // FTS5 creates `<name>_data` / `_idx` / `_docsize` / `_config`,
    // etc). Those backing tables are SQLite-internal and have column
    // shapes (typeless aliased ROWIDs) that aren't STRICT-legal —
    // touching them would corrupt the virtual table.
    const virtualNames = (
      db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`)
        .all() as Array<{ name: string }>
    ).map((r) => r.name);

    const baseTables = (
      db
        .prepare(
          `SELECT name, sql FROM sqlite_master
            WHERE type = 'table'
              AND name NOT LIKE '${SYSTEM_PREFIX}%'
              AND name NOT LIKE '${VEC_PREFIX}%'
              AND sql IS NOT NULL
              AND sql NOT LIKE 'CREATE VIRTUAL TABLE%'`,
        )
        .all() as ObjectRow[]
    ).filter((row) => {
      if (!row.sql) return false;
      // Skip shadow tables backing any virtual table.
      return !virtualNames.some((v) => row.name.startsWith(`${v}_`));
    });

    // Capture every user view + every non-virtual-shadow trigger up
    // front, drop them, and restore at the end of the loop. Before
    // this guard, the rebuild's DROP TABLE step triggered SQLite's
    // whole-schema revalidation, which tried to compile dependent
    // objects referencing the just-dropped table and aborted with
    // `error in view <X>: no such table: main.<Y>` (or the same shape
    // for a trigger whose body references the dropped table — e.g.
    // the `summary_refs_bump_last_ref_at_*` triggers from 053 are
    // attached to summary_refs but reference summary_store, so they
    // crash on the summary_store rebuild a few iterations later).
    // A v49→v53 DB upgrading through 054 hit this on the first
    // dependent table. Real production upgrades from earlier versions
    // (<49) sidestepped it because no views existed yet; from-empty
    // replays sidestepped it because the catch-all swallow on line
    // 246 silently absorbed the error (since fixed in this same
    // module). Migration 057 re-creates the dropped *tables* but not
    // the views/triggers, so we must restore them here.
    //
    // strictifyTable's per-table trigger capture still runs inside
    // each loop iteration but finds nothing now that we drop them
    // pre-loop — harmless. Restoring globally post-loop handles every
    // trigger uniformly, including cross-table-body cases the per-
    // table capture couldn't see.
    //
    // Virtual-table shadow triggers (FTS5 / rtree internals) are
    // excluded — 054 itself skips virtual tables, so their shadows
    // never go dangling.
    const droppedViews = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'view' AND sql IS NOT NULL`)
      .all() as ObjectRow[];
    const droppedTriggers = (
      db
        .prepare(`SELECT name, sql, tbl_name FROM sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL`)
        .all() as Array<ObjectRow & { tbl_name: string }>
    ).filter((t) => {
      if (virtualNames.includes(t.tbl_name)) return false;
      if (virtualNames.some((v) => t.tbl_name.startsWith(`${v}_`))) return false;
      return true;
    });
    for (const trg of droppedTriggers) {
      db.exec(`DROP TRIGGER IF EXISTS "${trg.name}"`);
    }
    for (const view of droppedViews) {
      db.exec(`DROP VIEW IF EXISTS "${view.name}"`);
    }

    for (const table of baseTables) {
      try {
        strictifyTable(db, table);
      } catch (err) {
        // Mid-rebuild failure (e.g. between DROP TABLE <original> and
        // ALTER TABLE … RENAME, or a CHECK / NOT NULL violation when
        // copying existing rows into the STRICT temp) leaves an orphan
        // `<table>__strict_tmp`. Drop it before rethrowing so the
        // outer transaction's rollback log stays small.
        //
        // Then RETHROW. Previously this `catch` swallowed every error
        // unless CARTOGRAPH_DEBUG_MIGRATIONS was set — silently dropping
        // production tables and still recording migration 054 as
        // applied. The partial-schema test-fixture cases the swallow
        // was protecting (migrations-015-016 et al starting at v14
        // with a minimal `nodes` table) are already caught by the
        // pre-flight `hasNodes` / `start_line` guard at lines 164-176;
        // any remaining failure here is real and must abort the
        // migration so the runner rolls back the surrounding
        // transaction.
        const localName = table.name;
        try {
          db.exec(`DROP TABLE IF EXISTS "${localName}${TEMP_SUFFIX}"`);
        } catch {
          // Best-effort.
        }
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`[migration 054] strictify failed on "${localName}": ${msg}`);
      }
    }

    // Restore the views + triggers we dropped pre-loop. Migration
    // 057 will (idempotently) re-create the *tables* this chain
    // dropped, but not the views/triggers — those have to come from
    // here. CREATE-IF-NOT-EXISTS isn't always possible on older
    // view/trigger SQL captured from sqlite_master, so guard each
    // restore with an existence check instead. Some restored objects
    // reference base tables 057 will re-create; those still compile
    // here because 054's rebuild left the base tables in place
    // (DROP-then-RENAME inside the same transaction).
    for (const view of droppedViews) {
      const exists = db.prepare(`SELECT 1 AS one FROM sqlite_master WHERE type = 'view' AND name = ?`).get(view.name);
      if (!exists && view.sql) db.exec(view.sql);
    }
    for (const trg of droppedTriggers) {
      const exists = db.prepare(`SELECT 1 AS one FROM sqlite_master WHERE type = 'trigger' AND name = ?`).get(trg.name);
      if (!exists && trg.sql) db.exec(trg.sql);
    }

    // Reclaim space from the rebuild — every strictified table left a
    // free-page hole behind. VACUUM compacts the file. Cheap on a
    // freshly-migrated DB; skipped silently if it fails (e.g. running
    // inside a transaction where VACUUM is forbidden — the migration
    // runner wraps each migration in a transaction, so we delegate
    // VACUUM to the post-migration step instead). Caught here only
    // for forward compatibility with future runner changes.
    try {
      db.exec('VACUUM');
    } catch {
      // VACUUM cannot run inside a transaction; the migration runner
      // wraps us in one. The post-migration `PRAGMA optimize` /
      // `wal_checkpoint(PASSIVE)` calls in src/db/index.ts pick up
      // most of the benefit anyway.
    }
  },
};

/** @internal Exported for `__tests__/schema-invariants.test.ts`. */
export function strictifyTable(
  db: import('../sqlite-adapter.js').SqliteDatabase,
  table: { name: string; sql: string | null },
): void {
  const originalSql = table.sql;
  if (!originalSql || /\bSTRICT\b/i.test(originalSql)) return;
  // Bare-identifier local for SQL interpolation. table.name flows
  // from sqlite_master row iteration; the SQL detector's bare-id
  // gate covers structural refs but not member access.
  const tableName = table.name;

  // Capture index + trigger CREATE statements BEFORE the rebuild —
  // DROP TABLE cascades them away. The `sql` column is NULL for
  // SQLite-internal indexes (e.g. PK auto-indexes); skip those.
  const indexes = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`,
    )
    .all(table.name) as ObjectRow[];
  const triggers = db
    .prepare(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?`)
    .all(table.name) as ObjectRow[];

  const cols = (db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>).map((c) => c.name);
  if (cols.length === 0) {
    throw new Error(`migration 054: table ${tableName} has zero columns — refusing to rebuild`);
  }
  const colList = cols.map((c) => `"${c}"`).join(', ');

  const tempName = `${tableName}${TEMP_SUFFIX}`;
  // `\b` belongs INSIDE the alternation, on the unquoted branch only:
  // a `\b` after `"${tableName}"` never matches (`"` is a non-word
  // char, so there is no word boundary after it). 054 normally sees
  // unquoted names, but keeping the anchor correct guards re-runs and
  // mirrors the corrected form in migration 064.
  const renameRegex = new RegExp(
    String.raw`CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?(?:"${tableName}"|${tableName}\b)`,
    'i',
  );
  if (!renameRegex.test(originalSql)) {
    throw new Error(`migration 054: could not locate CREATE TABLE for ${tableName} in stored SQL`);
  }
  const fixup = PER_TABLE_FIXUPS[table.name];
  const fixed = fixup ? fixup(originalSql) : originalSql;
  const tableOptions = WITHOUT_ROWID_TABLES.has(table.name) ? ') STRICT, WITHOUT ROWID' : ') STRICT';
  const tempCreateSql = fixed.replace(renameRegex, `CREATE TABLE ${tempName}`).replace(/\)\s*;?\s*$/, tableOptions);

  db.exec(tempCreateSql);
  // Copy with per-column coercion to the TARGET (post-fixup) STRICT
  // types. A blind `SELECT *` copy assumes the source data already
  // matches the strict types — which is exactly what fails: pre-STRICT
  // type affinity let loose values accumulate, most notably a REAL
  // fractional epoch-ms in `files.modified_at` written by cartograph
  // versions before the extractor floored `stats.mtimeMs`
  // (extraction-phases.ts), which a STRICT INTEGER column rejects with
  // "cannot store REAL value in INTEGER column". CAST each column to its
  // declared strict type so those legacy affinities coerce instead of
  // crashing the migration; CAST is a no-op for already-correct values.
  // Read the target types from the temp table itself so per-table fixups
  // (e.g. code_health_findings.metric INTEGER→REAL) are honoured.
  const targetTypes = new Map(
    (db.prepare(`PRAGMA table_info(${tempName})`).all() as Array<{ name: string; type: string }>).map((c) => [
      c.name,
      (c.type || '').toUpperCase(),
    ]),
  );
  const selectList = cols
    .map((c) => {
      const t = targetTypes.get(c);
      return isCastableStrictType(t) ? `CAST("${c}" AS ${t})` : `"${c}"`;
    })
    .join(', ');
  db.exec(`INSERT INTO ${tempName} (${colList}) SELECT ${selectList} FROM "${tableName}"`);
  db.exec(`DROP TABLE "${tableName}"`);
  db.exec(`ALTER TABLE ${tempName} RENAME TO "${tableName}"`);

  for (const idx of indexes) {
    if (idx.sql) db.exec(idx.sql);
  }
  for (const trg of triggers) {
    if (trg.sql) db.exec(trg.sql);
  }
}
