-- Cartograph SQLite Schema
-- Version 1

-- Schema version tracking. Populated by DatabaseConnection.initialize
-- with a single row at CURRENT_SCHEMA_VERSION after schema.sql runs;
-- migrations record their own rows when they apply on existing DBs.
CREATE TABLE IF NOT EXISTS schema_versions (
    version INTEGER PRIMARY KEY,
    applied_at INTEGER NOT NULL,
    description TEXT
) STRICT;

-- =============================================================================
-- Core Tables
-- =============================================================================

-- Nodes: Code symbols (functions, classes, variables, etc.)
CREATE TABLE IF NOT EXISTS nodes (
    id TEXT PRIMARY KEY,
    -- Closed enum mirroring src/types.ts NodeKind. CHECK rejects
    -- typo'd or stale-extractor values at write time instead of
    -- letting them silently corrupt downstream kind-histogram queries.
    kind TEXT NOT NULL CHECK (kind IN (
        'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
        'function', 'method', 'property', 'field', 'variable', 'constant',
        'enum', 'enum_member', 'type_alias', 'namespace', 'parameter',
        'import', 'export', 'route', 'component', 'table', 'resource'
    )),
    name TEXT NOT NULL,
    qualified_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    language TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    start_column INTEGER NOT NULL,
    end_column INTEGER NOT NULL,
    docstring TEXT,
    signature TEXT,
    visibility TEXT,
    is_exported INTEGER DEFAULT 0,
    is_async INTEGER DEFAULT 0,
    is_static INTEGER DEFAULT 0,
    decorators TEXT, -- JSON array of bare decorator names
    decorator_args TEXT, -- B9 migration 070: JSON Array<{name, argStrings, argIdents}>; NAME-KEYED (find via name, NOT by index — bare/empty-arg decorators are omitted so this array can be shorter than `decorators`); NULL when no call-form decorators
    updated_at INTEGER NOT NULL,
    centrality REAL DEFAULT NULL, -- PageRank over calls+references; NULL until first compute
    betweenness REAL DEFAULT NULL, -- Sampled Brandes betweenness over the same subgraph; NULL until first compute (migration 068)
    -- Camel/snake-split tokens of `name`, joined by spaces. The default
    -- FTS5 tokenizer indexes each as a separate term, so a query for
    -- `parser` finds `getParser` etc. Populated by buildNameSubwords()
    -- in src/utils.ts on every insert/update.
    name_subwords TEXT,
    -- LLM-derived coarse role label. Populated by the cascade-input
    -- classifier (summary if present, else docstring) — see migration
    -- 040 + the role-classifier eval memory note for empirical justification.
    -- Closed enum mirroring ROLE_LABELS in src/llm/classifier.ts; NULL
    -- when the classifier hasn't run on this node yet.
    role TEXT CHECK (role IS NULL OR role IN (
        'api_endpoint', 'business_logic', 'data_model', 'util',
        'framework_glue', 'test_helper', 'unknown'
    )),
    role_model TEXT,
    -- Per-symbol sha256(signature + body_text), 32-hex-char prefix
    -- (matches symbolBodyHash in src/extraction/symbol-body-hash.ts;
    -- same hash the summarizer writes to symbol_summaries.content_hash).
    -- Populated by the tree-sitter extractor on createNode. Joined by
    -- getStaleArtifactsCount to flag stale summaries — Phase 2 / Design A
    -- of the staleness redesign (migration 048).
    body_hash TEXT NOT NULL DEFAULT '',
    -- Migration 056: explicit FK to files(path). When a file is removed
    -- the cascade drops its nodes (and via the existing edges/refs FKs
    -- on nodes.id, those too). The extractor's eoPersistFileExtraction
    -- runs upsertFile FIRST inside the same transaction (per the
    -- write-order fix in migration 055's commit) so this FK never
    -- trips on the happy path.
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role);

-- role_assignments: Phase 5 of staleness redesign (migration 052).
-- nodes.role is denormalized as a read-cache; role_assignments is the
-- source of truth that survives clearStructural's DELETE FROM nodes.
-- The role-restore index hook copies values back to nodes.role after
-- re-extraction, gated on body_hash equality (Design A staleness).
CREATE TABLE IF NOT EXISTS role_assignments (
    node_id      TEXT NOT NULL PRIMARY KEY,
    role         TEXT NOT NULL,
    role_model   TEXT NOT NULL DEFAULT '',
    body_hash    TEXT NOT NULL DEFAULT '',
    generated_at INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_role_assignments_body_hash
    ON role_assignments(body_hash);

-- Edges: Relationships between nodes
CREATE TABLE IF NOT EXISTS edges (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    target TEXT NOT NULL,
    -- Closed enum mirroring src/types.ts EdgeKind.
    kind TEXT NOT NULL CHECK (kind IN (
        'contains', 'calls', 'imports', 'exports', 'extends', 'implements',
        'references', 'type_of', 'returns', 'instantiates', 'overrides',
        'decorates', 'tests', 'field_access', 'similar_to', 'def_use'
    )),
    metadata TEXT, -- JSON object
    line INTEGER,
    col INTEGER,
    -- Resolver's correctness guess (#8). EXTRACTED / INFERRED / AMBIGUOUS.
    -- Nullable: structural / extractor-direct edges leave it NULL,
    -- which the read-side cast in EDGE_SCHEMA collapses to 'EXTRACTED'.
    -- See src/db/migrations/032-edge-confidence.ts for the categorical mapping.
    confidence TEXT CHECK (confidence IS NULL OR confidence IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS')),
    FOREIGN KEY (source) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (target) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;

-- Files: Tracked source files
CREATE TABLE IF NOT EXISTS files (
    path TEXT PRIMARY KEY,
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    size INTEGER NOT NULL,
    modified_at INTEGER NOT NULL,
    indexed_at INTEGER NOT NULL,
    node_count INTEGER DEFAULT 0,
    errors TEXT, -- JSON array
    -- Churn signals (mined from git log)
    commit_count INTEGER NOT NULL DEFAULT 0,
    loc INTEGER NOT NULL DEFAULT 0,
    first_seen_ts INTEGER DEFAULT NULL, -- unix seconds
    last_touched_ts INTEGER DEFAULT NULL, -- unix seconds
    -- True (1) when the path matches a known test-file convention;
    -- populated at index time from src/test-detection.ts. Used as a
    -- substrate by downstream tools (dead-code, biomarker rollups,
    -- co-change weighting). See migration 023.
    is_test INTEGER NOT NULL DEFAULT 0,
    -- Force-re-extract flag (migration 047, staleness-redesign Phase 1).
    -- Set to 1 by applyExtractionLogicVersionHeal; sync re-extracts
    -- when this is 1 regardless of content_hash match. Cleared back to
    -- 0 by upsertFile after re-extraction completes. Replaces the prior
    -- "zero content_hash" heal pattern that corrupted stale-artifact
    -- counts.
    needs_reextract INTEGER NOT NULL DEFAULT 0
) STRICT, WITHOUT ROWID;

-- Co-Changes: pairs of files that have changed together in git history.
-- Symmetric — stored canonically with file_a < file_b.
CREATE TABLE IF NOT EXISTS co_changes (
    file_a TEXT NOT NULL,
    file_b TEXT NOT NULL,
    count INTEGER NOT NULL,
    PRIMARY KEY (file_a, file_b),
    CHECK (file_a < file_b)
) STRICT, WITHOUT ROWID;
-- Co-change indexes are declared together below in the indexes section.

-- Unresolved References: References that need resolution after full indexing
CREATE TABLE IF NOT EXISTS unresolved_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_node_id TEXT NOT NULL,
    reference_name TEXT NOT NULL,
    reference_kind TEXT NOT NULL,
    line INTEGER NOT NULL,
    col INTEGER NOT NULL,
    candidates TEXT, -- JSON array
    file_path TEXT NOT NULL DEFAULT '',
    language TEXT NOT NULL DEFAULT 'unknown',
    -- Call-site multiplicity from extraction-time dedup. Default 1 so
    -- legacy rows behave like single-site refs.
    site_count INTEGER NOT NULL DEFAULT 1,
    extra_lines TEXT, -- JSON array of additional 1-based line numbers
    FOREIGN KEY (from_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;

-- =============================================================================
-- Indexes for Query Performance
-- =============================================================================

-- Node indexes
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
-- F#76 (2026-05-28) — case-insensitive name lookup index. Lets the
-- `WHERE name = @v COLLATE NOCASE` path in `queries-search.ts` use
-- an index instead of falling back to a full nodes scan. The
-- BINARY-collated `idx_nodes_name` above can't serve NOCASE
-- comparisons, and `idx_nodes_lower_name` (expression index on
-- `lower(name)`) only matches queries that wrap the column in
-- `lower(...)` — three hot read paths use COLLATE NOCASE instead.
CREATE INDEX IF NOT EXISTS idx_nodes_name_nocase ON nodes(name COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_centrality ON nodes(centrality DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_betweenness ON nodes(betweenness DESC);

-- Full-text search index on node names, docstrings, and signatures
-- The Porter stemmer collapses morphological variants so a query for
-- `parsing` matches a docstring or subword containing `parser`/`parse`.
-- This is the largest single quality lift for natural-language queries
-- (verified empirically: targets that ranked #18-#19 or weren't in the
-- top 20 jump to the top 5 — see __tests__/search-quality.test.ts).
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
    id,
    name,
    qualified_name,
    docstring,
    signature,
    name_subwords,
    content='nodes',
    content_rowid='rowid',
    tokenize="porter unicode61"
);

-- Triggers to keep FTS index in sync
CREATE TRIGGER IF NOT EXISTS nodes_ai AFTER INSERT ON nodes BEGIN
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, name_subwords)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.name_subwords);
END;

CREATE TRIGGER IF NOT EXISTS nodes_ad AFTER DELETE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, name_subwords)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.name_subwords);
END;

CREATE TRIGGER IF NOT EXISTS nodes_au AFTER UPDATE ON nodes BEGIN
    INSERT INTO nodes_fts(nodes_fts, rowid, id, name, qualified_name, docstring, signature, name_subwords)
    VALUES ('delete', OLD.rowid, OLD.id, OLD.name, OLD.qualified_name, OLD.docstring, OLD.signature, OLD.name_subwords);
    INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature, name_subwords)
    VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature, NEW.name_subwords);
END;

-- R*Tree on (start_line, end_line) supports range-overlap lookups in O(log n) —
-- used by `cartograph_at_range` for PR-review and diff-overlay workflows where
-- "what symbols overlap this hunk?" is more useful than "what's in this file?".
-- `rtree_i32` uses 32-bit signed integers; correct for line numbers (never >2^31).
-- The `id` column mirrors `nodes.rowid` so R*Tree entries JOIN back to full rows.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_rtree USING rtree_i32(
    id,           -- rowid (mirrors nodes.rowid)
    start_line,
    end_line
);

-- Triggers to keep R*Tree index in sync with the nodes table
CREATE TRIGGER IF NOT EXISTS nodes_rtree_ai AFTER INSERT ON nodes
BEGIN
    INSERT OR REPLACE INTO nodes_rtree (id, start_line, end_line)
        VALUES (NEW.rowid, NEW.start_line, NEW.end_line);
END;

CREATE TRIGGER IF NOT EXISTS nodes_rtree_ad AFTER DELETE ON nodes
BEGIN
    DELETE FROM nodes_rtree WHERE id = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS nodes_rtree_au AFTER UPDATE OF start_line, end_line ON nodes
BEGIN
    INSERT OR REPLACE INTO nodes_rtree (id, start_line, end_line)
        VALUES (NEW.rowid, NEW.start_line, NEW.end_line);
END;

-- Edge indexes
-- Note: narrow source/target indexes are intentionally omitted — the
-- (source, kind) and (target, kind) composite indexes below cover
-- source-only and target-only lookups via SQLite's left-prefix scan.
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind_similar_to
    ON edges(source, kind)
    WHERE kind = 'similar_to';
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);

-- Uniqueness for (source, target, kind, line, col). The id column is an
-- AUTOINCREMENT primary key, so without this index `INSERT OR IGNORE`
-- would never see a conflict — duplicate edges would silently accumulate
-- on every re-resolution / re-emission. COALESCE keeps two NULL line/col
-- values comparable as equal (SQLite treats raw NULLs in a UNIQUE index
-- as distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));

-- File indexes
CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
CREATE INDEX IF NOT EXISTS idx_files_commit_count ON files(commit_count DESC);
CREATE INDEX IF NOT EXISTS idx_files_last_touched ON files(last_touched_ts DESC);

-- Co-change index for file_b lookups (file_a is covered by the
-- (file_a, file_b) PK above).
CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_b);

-- Unresolved refs indexes
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);
CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(confidence);

-- Project metadata for version/provenance tracking
CREATE TABLE IF NOT EXISTS project_metadata (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;

-- Issue → symbol attribution mined from git history.
-- One row per (node, issue, commit, kind) tuple; kind is 'modified'
-- (enclosing function changed by hunk), 'added' (declaration on a +
-- line), or 'removed' (declaration on a - line, dropped at lookup
-- time when no current node matches).
CREATE TABLE IF NOT EXISTS symbol_issues (
    node_id TEXT NOT NULL,
    issue_number INTEGER NOT NULL,
    commit_sha TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('modified','added','removed')),
    PRIMARY KEY (node_id, issue_number, commit_sha, kind),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_symbol_issues_node ON symbol_issues(node_id);
CREATE INDEX IF NOT EXISTS idx_symbol_issues_issue ON symbol_issues(issue_number);

-- Config references: read sites for env vars / feature flags / etc.
-- One row per syntactic occurrence in source. config_kind narrows to
-- 'env' (process.env, os.getenv, ...) for v1; future kinds add YAML
-- keys, LaunchDarkly flags, etc. source_node_id may be NULL for
-- top-level reads that aren't inside a function/method.
CREATE TABLE IF NOT EXISTS config_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_kind TEXT NOT NULL,
    config_key TEXT NOT NULL,
    source_node_id TEXT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_config_refs_key
    ON config_refs(config_kind, config_key);
CREATE INDEX IF NOT EXISTS idx_config_refs_node
    ON config_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_config_refs_file
    ON config_refs(file_path);

-- SQL references: per-call-site links from app code to a table name.
-- One row per syntactic occurrence in source. op is 'read' (SELECT,
-- FROM in non-DDL), 'write' (INSERT/UPDATE/DELETE), or 'ddl'
-- (CREATE TABLE / ALTER TABLE / DROP TABLE -- rare in app code but
-- catches migration scripts).
CREATE TABLE IF NOT EXISTS sql_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    op TEXT NOT NULL CHECK (op IN ('read','write','ddl')),
    source_node_id TEXT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_sql_refs_table
    ON sql_refs(lower(table_name));
CREATE INDEX IF NOT EXISTS idx_sql_refs_node
    ON sql_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_sql_refs_file
    ON sql_refs(file_path);

-- Build-context references: per-site occurrences of module-format-
-- sensitive identifiers (`__dirname`, `__filename`,
-- `import.meta.dirname`, `import.meta.filename`, `import.meta.url`).
-- Mirrors the shape of config_refs / sql_refs. source_node_id may be
-- NULL for top-level reads. See migration 024 + src/build-context-refs/.
CREATE TABLE IF NOT EXISTS build_context_refs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ref_kind TEXT NOT NULL,
    source_node_id TEXT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_build_context_refs_kind
    ON build_context_refs(ref_kind);
CREATE INDEX IF NOT EXISTS idx_build_context_refs_node
    ON build_context_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_build_context_refs_file
    ON build_context_refs(file_path);

-- String-literal imports: import-shaped specifiers that appear inside
-- template strings or quoted strings (test fixtures, codegen sources,
-- doc examples). NOT real imports — the static graph correctly omits
-- them. Surfacing them separately lets migration tooling answer
-- "before this sed pass, what import-like strings will it touch?"
-- without polluting the import edge set. container_kind discriminates
-- between template_string and string_literal so callers can scope
-- (template-only is the high-signal case for codegen detection).
CREATE TABLE IF NOT EXISTS string_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    module_name TEXT NOT NULL,
    raw TEXT NOT NULL,
    container_kind TEXT NOT NULL CHECK (container_kind IN ('template_string','string_literal')),
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_string_imports_module
    ON string_imports(module_name);
CREATE INDEX IF NOT EXISTS idx_string_imports_file
    ON string_imports(file_path);
CREATE INDEX IF NOT EXISTS idx_string_imports_kind
    ON string_imports(container_kind);

-- Content-addressed summary storage (migration 049, Phase 3 / Design C).
-- summary_store holds one row per (body_hash, model) — multiple nodes
-- sharing the same body share the same row. summary_refs points each
-- node at its current store row. A backward-compat VIEW named
-- `symbol_summaries` joins them so legacy readers keep working;
-- writes go directly through summary_store + summary_refs via
-- `upsertSymbolSummary`. See migration 049 for the full design notes.
CREATE TABLE IF NOT EXISTS summary_store (
    body_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    summary TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    -- Touch-tracker for `admin prune-store` (migration 053). Bumped to
    -- now() by triggers on summary_refs INSERT/UPDATE so revert/rename
    -- reuse keeps the row "warm" even when there's no live ref. The
    -- pruner evicts orphans whose last_ref_at is older than the cutoff.
    last_ref_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (body_hash, model)
) STRICT;

CREATE TABLE IF NOT EXISTS summary_refs (
    node_id TEXT PRIMARY KEY,
    body_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_summary_refs_body_hash
    ON summary_refs(body_hash, model);

-- Migration-053 refresh triggers: bump summary_store.last_ref_at on
-- any ref insert/update so the pruner sees recent reuse activity.
CREATE TRIGGER IF NOT EXISTS summary_refs_bump_last_ref_at_ai
AFTER INSERT ON summary_refs BEGIN
  UPDATE summary_store
     SET last_ref_at = (strftime('%s', 'now') * 1000)
   WHERE body_hash = NEW.body_hash AND model = NEW.model;
END;
CREATE TRIGGER IF NOT EXISTS summary_refs_bump_last_ref_at_au
AFTER UPDATE ON summary_refs BEGIN
  UPDATE summary_store
     SET last_ref_at = (strftime('%s', 'now') * 1000)
   WHERE body_hash = NEW.body_hash AND model = NEW.model;
END;

-- Backward-compat VIEW preserving the legacy symbol_summaries shape
-- so existing readers (intent search, classifier cascade, etc.) keep
-- working unchanged. Writes flow through INSTEAD OF triggers to
-- summary_store + summary_refs.
CREATE VIEW IF NOT EXISTS symbol_summaries AS
SELECT
    r.node_id      AS node_id,
    r.body_hash    AS content_hash,
    s.summary      AS summary,
    r.model        AS model,
    s.generated_at AS generated_at
FROM summary_refs r
JOIN summary_store s
  ON s.body_hash = r.body_hash AND s.model = r.model;

CREATE TRIGGER IF NOT EXISTS symbol_summaries_insteadof_insert
INSTEAD OF INSERT ON symbol_summaries BEGIN
    INSERT INTO summary_store (body_hash, model, summary, generated_at)
    VALUES (NEW.content_hash, NEW.model, NEW.summary, NEW.generated_at)
    ON CONFLICT(body_hash, model) DO UPDATE SET
      summary = excluded.summary,
      generated_at = excluded.generated_at;
    INSERT INTO summary_refs (node_id, body_hash, model)
    VALUES (NEW.node_id, NEW.content_hash, NEW.model)
    ON CONFLICT(node_id) DO UPDATE SET
      body_hash = excluded.body_hash,
      model = excluded.model;
END;

CREATE TRIGGER IF NOT EXISTS symbol_summaries_insteadof_update
INSTEAD OF UPDATE ON symbol_summaries BEGIN
    INSERT INTO summary_store (body_hash, model, summary, generated_at)
    VALUES (NEW.content_hash, NEW.model, NEW.summary, NEW.generated_at)
    ON CONFLICT(body_hash, model) DO UPDATE SET
      summary = excluded.summary,
      generated_at = excluded.generated_at;
    UPDATE summary_refs SET body_hash = NEW.content_hash, model = NEW.model
    WHERE node_id = OLD.node_id;
END;

CREATE TRIGGER IF NOT EXISTS symbol_summaries_insteadof_delete
INSTEAD OF DELETE ON symbol_summaries BEGIN
    DELETE FROM summary_refs WHERE node_id = OLD.node_id;
END;

-- FTS5 virtual table over summary_store.summary for mode=intent search.
-- Porter stemmer matches morphological variants ("verifying" ~ "verify").
-- Indexed against summary_store directly (not the VIEW) — FTS5 with
-- content= requires a real table; the intent-search query joins
-- summary_refs to recover node_id.
CREATE VIRTUAL TABLE IF NOT EXISTS summary_fts USING fts5(
    summary,
    content='summary_store',
    content_rowid='ROWID',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS summary_fts_ai AFTER INSERT ON summary_store BEGIN
    INSERT INTO summary_fts(rowid, summary) VALUES (NEW.ROWID, NEW.summary);
END;

CREATE TRIGGER IF NOT EXISTS summary_fts_ad AFTER DELETE ON summary_store BEGIN
    INSERT INTO summary_fts(summary_fts, rowid, summary) VALUES ('delete', OLD.ROWID, OLD.summary);
END;

CREATE TRIGGER IF NOT EXISTS summary_fts_au AFTER UPDATE ON summary_store BEGIN
    INSERT INTO summary_fts(summary_fts, rowid, summary) VALUES ('delete', OLD.ROWID, OLD.summary);
    INSERT INTO summary_fts(rowid, summary) VALUES (NEW.ROWID, NEW.summary);
END;

-- Second intent-search source (mode=intent, alongside summary_fts):
-- FTS5 over nodes.docstring. Free coverage — docstrings are extracted
-- at index time without an LLM pass, so this widens the intent corpus
-- beyond the ~18% of nodes that have an LLM-generated summary.
CREATE VIRTUAL TABLE IF NOT EXISTS docstring_fts USING fts5(
    docstring,
    content='nodes',
    content_rowid='ROWID',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS docstring_fts_ai AFTER INSERT ON nodes
    WHEN NEW.docstring IS NOT NULL AND NEW.docstring != ''
BEGIN
    INSERT INTO docstring_fts(rowid, docstring) VALUES (NEW.ROWID, NEW.docstring);
END;

CREATE TRIGGER IF NOT EXISTS docstring_fts_ad AFTER DELETE ON nodes
    WHEN OLD.docstring IS NOT NULL AND OLD.docstring != ''
BEGIN
    INSERT INTO docstring_fts(docstring_fts, rowid, docstring) VALUES ('delete', OLD.ROWID, OLD.docstring);
END;

CREATE TRIGGER IF NOT EXISTS docstring_fts_au AFTER UPDATE OF docstring ON nodes BEGIN
    INSERT INTO docstring_fts(docstring_fts, rowid, docstring)
        SELECT 'delete', OLD.ROWID, OLD.docstring
         WHERE OLD.docstring IS NOT NULL AND OLD.docstring != '';
    INSERT INTO docstring_fts(rowid, docstring)
        SELECT NEW.ROWID, NEW.docstring
         WHERE NEW.docstring IS NOT NULL AND NEW.docstring != '';
END;

-- Third intent-search source (mode=intent, alongside summary_fts and
-- docstring_fts): FTS5 over test description strings extracted from
-- it/test/describe(...) calls in is_test files. One row per call;
-- the description is the literal first-arg string. Lets the agent
-- find subjects by behavioral assertion ("rejects expired tokens")
-- when the function name itself is opaque. Mined by the test-names
-- index hook, not by extractFromSource.
CREATE TABLE IF NOT EXISTS test_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT NOT NULL,
    line INTEGER NOT NULL,
    description TEXT NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_test_names_file ON test_names(file_path);

CREATE VIRTUAL TABLE IF NOT EXISTS test_names_fts USING fts5(
    description,
    content='test_names',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS test_names_fts_ai AFTER INSERT ON test_names BEGIN
    INSERT INTO test_names_fts(rowid, description) VALUES (NEW.id, NEW.description);
END;

CREATE TRIGGER IF NOT EXISTS test_names_fts_ad AFTER DELETE ON test_names BEGIN
    INSERT INTO test_names_fts(test_names_fts, rowid, description) VALUES ('delete', OLD.id, OLD.description);
END;

CREATE TRIGGER IF NOT EXISTS test_names_fts_au AFTER UPDATE ON test_names BEGIN
    INSERT INTO test_names_fts(test_names_fts, rowid, description) VALUES ('delete', OLD.id, OLD.description);
    INSERT INTO test_names_fts(rowid, description) VALUES (NEW.id, NEW.description);
END;

-- F#12 slice 2 (migration 069): nested-function manifest + popularity.
-- Mega-files (any function body > `largeFunctionThreshold`, default 500
-- LOC) skip eager nested-fn extraction (slice 1's cost cap). Instead,
-- one row per nested-function declaration lands in
-- `nested_function_names` — name + position + signature + body hash.
-- `cartograph_find` joins through `nested_function_names_fts` so an
-- agent querying a name that exists only inside a mega-file gets a
-- "deep:true" hint instead of an empty result. Slice 3 will use
-- `hit_count` / `promoted_node_id` and the `nested_function_popularity`
-- survival table (keyed by file_path,name so popularity outlives the
-- position-drift of file edits).
CREATE TABLE IF NOT EXISTS nested_function_names (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parent_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    start_col INTEGER NOT NULL,
    end_line INTEGER NOT NULL,
    end_col INTEGER NOT NULL,
    signature TEXT,
    body_hash TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER,
    promoted_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
    promoted_at INTEGER,
    UNIQUE(file_path, name, start_line)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_nested_function_names_name ON nested_function_names(name);
CREATE INDEX IF NOT EXISTS idx_nested_function_names_file ON nested_function_names(file_path);
CREATE INDEX IF NOT EXISTS idx_nested_function_names_parent ON nested_function_names(parent_node_id);

CREATE VIRTUAL TABLE IF NOT EXISTS nested_function_names_fts USING fts5(
    name,
    content='nested_function_names',
    content_rowid='id',
    tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS nested_function_names_fts_ai AFTER INSERT ON nested_function_names BEGIN
    INSERT INTO nested_function_names_fts(rowid, name) VALUES (NEW.id, NEW.name);
END;

CREATE TRIGGER IF NOT EXISTS nested_function_names_fts_ad AFTER DELETE ON nested_function_names BEGIN
    INSERT INTO nested_function_names_fts(nested_function_names_fts, rowid, name) VALUES ('delete', OLD.id, OLD.name);
END;

CREATE TRIGGER IF NOT EXISTS nested_function_names_fts_au AFTER UPDATE ON nested_function_names BEGIN
    INSERT INTO nested_function_names_fts(nested_function_names_fts, rowid, name) VALUES ('delete', OLD.id, OLD.name);
    INSERT INTO nested_function_names_fts(rowid, name) VALUES (NEW.id, NEW.name);
END;

CREATE TABLE IF NOT EXISTS nested_function_popularity (
    file_path TEXT NOT NULL,
    name TEXT NOT NULL,
    hit_count INTEGER NOT NULL DEFAULT 0,
    last_hit_at INTEGER,
    PRIMARY KEY (file_path, name)
) STRICT, WITHOUT ROWID;

-- Content-addressed embedding storage (migration 050, Phase 4 / Design C).
-- embedding_store holds one row per (body_hash, model, grain) — multiple
-- nodes sharing the same body share the same row. embedding_refs points
-- each node at its current store row. A backward-compat VIEW named
-- `symbol_embeddings` joins them so legacy readers keep working; writes
-- flow through INSTEAD OF triggers on the view. Direct writers
-- (upsertSymbolEmbedding) write the new tables atomically with the vec0
-- mirror in one transaction. See migration 050 for the full design notes.
CREATE TABLE IF NOT EXISTS embedding_store (
    body_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    grain TEXT NOT NULL DEFAULT 'symbol',
    embedding BLOB NOT NULL,
    generated_at INTEGER NOT NULL DEFAULT 0,
    -- Touch-tracker for `admin prune-store` (migration 053). See
    -- summary_store.last_ref_at for the design rationale.
    last_ref_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (body_hash, model, grain)
) STRICT;

CREATE TABLE IF NOT EXISTS embedding_refs (
    node_id TEXT NOT NULL,
    body_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    -- Closed enum: 'symbol' (per-symbol embedding) | 'file' (file-grain).
    grain TEXT NOT NULL DEFAULT 'symbol' CHECK (grain IN ('symbol', 'file')),
    summary_hash_at_embed TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (node_id, model, grain),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;

-- Migration-053 refresh triggers (mirror of summary_refs).
CREATE TRIGGER IF NOT EXISTS embedding_refs_bump_last_ref_at_ai
AFTER INSERT ON embedding_refs BEGIN
  UPDATE embedding_store
     SET last_ref_at = (strftime('%s', 'now') * 1000)
   WHERE body_hash = NEW.body_hash AND model = NEW.model AND grain = NEW.grain;
END;
CREATE TRIGGER IF NOT EXISTS embedding_refs_bump_last_ref_at_au
AFTER UPDATE ON embedding_refs BEGIN
  UPDATE embedding_store
     SET last_ref_at = (strftime('%s', 'now') * 1000)
   WHERE body_hash = NEW.body_hash AND model = NEW.model AND grain = NEW.grain;
END;
CREATE INDEX IF NOT EXISTS idx_embedding_refs_body_hash
    ON embedding_refs(body_hash, model, grain);
CREATE INDEX IF NOT EXISTS idx_embedding_refs_model
    ON embedding_refs(model);
CREATE INDEX IF NOT EXISTS idx_embedding_store_model
    ON embedding_store(model);

-- Backward-compat VIEW preserving the legacy symbol_embeddings shape.
-- Legacy readers (vec-helpers JOIN, status counts, etc.) continue to
-- work; writes flow through INSTEAD OF triggers below to refs + store.
CREATE VIEW IF NOT EXISTS symbol_embeddings AS
SELECT
    r.node_id              AS node_id,
    s.embedding            AS embedding,
    r.model                AS embedding_model,
    r.body_hash            AS source_content_hash,
    r.summary_hash_at_embed AS summary_hash_at_embed,
    r.grain                AS grain,
    0                      AS chunk_idx
FROM embedding_refs r
JOIN embedding_store s
  ON s.body_hash = r.body_hash
 AND s.model = r.model
 AND s.grain = r.grain;

CREATE TRIGGER IF NOT EXISTS symbol_embeddings_insteadof_insert
INSTEAD OF INSERT ON symbol_embeddings BEGIN
    INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
    VALUES (NEW.source_content_hash, NEW.embedding_model, COALESCE(NEW.grain, 'symbol'), NEW.embedding, strftime('%s', 'now') * 1000)
    ON CONFLICT(body_hash, model, grain) DO UPDATE SET
      embedding = excluded.embedding,
      generated_at = excluded.generated_at;
    INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
    VALUES (NEW.node_id, NEW.source_content_hash, NEW.embedding_model, COALESCE(NEW.grain, 'symbol'), COALESCE(NEW.summary_hash_at_embed, ''))
    ON CONFLICT(node_id, model, grain) DO UPDATE SET
      body_hash = excluded.body_hash,
      summary_hash_at_embed = excluded.summary_hash_at_embed;
END;

CREATE TRIGGER IF NOT EXISTS symbol_embeddings_insteadof_update
INSTEAD OF UPDATE ON symbol_embeddings BEGIN
    INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
    VALUES (NEW.source_content_hash, NEW.embedding_model, COALESCE(NEW.grain, 'symbol'), NEW.embedding, strftime('%s', 'now') * 1000)
    ON CONFLICT(body_hash, model, grain) DO UPDATE SET
      embedding = excluded.embedding,
      generated_at = excluded.generated_at;
    UPDATE embedding_refs
       SET body_hash = NEW.source_content_hash,
           summary_hash_at_embed = COALESCE(NEW.summary_hash_at_embed, '')
     WHERE node_id = OLD.node_id
       AND model = OLD.embedding_model
       AND grain = COALESCE(OLD.grain, 'symbol');
END;

CREATE TRIGGER IF NOT EXISTS symbol_embeddings_insteadof_delete
INSTEAD OF DELETE ON symbol_embeddings BEGIN
    DELETE FROM embedding_refs
     WHERE node_id = OLD.node_id
       AND model = OLD.embedding_model
       AND grain = COALESCE(OLD.grain, 'symbol');
END;

-- Directory-level LLM summaries: one paragraph synthesised from the
-- symbol summaries inside the directory.
CREATE TABLE IF NOT EXISTS directory_summaries (
    dir_path TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_dir_summaries_model ON directory_summaries(model);

-- Per-file LLM prose summary — the tier between symbol and directory.
-- One paragraph per file, rolled up from the file's symbol summaries.
-- FK ON DELETE CASCADE to files(path) so a deleted/renamed file drops
-- its summary automatically (directory_summaries has no FK and relies
-- on an explicit prune pass instead). See migration 063.
CREATE TABLE IF NOT EXISTS file_summaries (
    file_path TEXT PRIMARY KEY,
    summary TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    model TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    FOREIGN KEY (file_path) REFERENCES files(path) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_file_summaries_model ON file_summaries(model);

-- Per-symbol code coverage from external CI artifacts (lcov, cobertura,
-- jacoco, coverage.py). Multiple sources can coexist for the same node
-- so a project running both unit and e2e suites keeps both rollups.
CREATE TABLE IF NOT EXISTS node_coverage (
    node_id TEXT NOT NULL,
    source TEXT NOT NULL,
    covered_lines INTEGER NOT NULL,
    total_lines INTEGER NOT NULL,
    covered_branches INTEGER,
    total_branches INTEGER,
    ingested_at INTEGER NOT NULL,
    PRIMARY KEY (node_id, source),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_node_coverage_source ON node_coverage(source);
CREATE INDEX IF NOT EXISTS idx_node_coverage_pct
    ON node_coverage(source, (CAST(covered_lines AS REAL) / NULLIF(total_lines, 0)));

-- Per-symbol biomarker findings produced by `src/biomarkers/`. The
-- aggregate Code Health score is computed at query time from this
-- table, so adding a new biomarker does not require a backfill.
CREATE TABLE IF NOT EXISTS code_health_findings (
    node_id TEXT NOT NULL,
    biomarker TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
    -- REAL (not INTEGER) because brain_method emits a fractional
    -- composite score (~12.3 etc); count-based biomarkers (loc,
    -- cyclomatic, magic_number) write whole numbers and round-trip
    -- losslessly through REAL.
    metric REAL NOT NULL,
    detail TEXT,
    detected_at INTEGER NOT NULL,
    -- File content_hash at the time the finding was detected. Joined
    -- against current files.content_hash to flag stale findings without
    -- re-running the biomarker pass. Empty string for rows written
    -- before migration 020.
    source_content_hash TEXT NOT NULL DEFAULT '',
    -- Surface reason the agent gets in ranked-mode output (migration 061):
    --   'full-pass'      — written by the most recent full project pass.
    --   'partial-rescan' — written by a per-file rescan triggered by an
    --                      edit since the last full pass. Cross-file
    --                      rules always re-run on partial syncs, so this
    --                      flags findings the agent's edit may have
    --                      surfaced (latent → visible) rather than the
    --                      previous full pass enumerating them.
    --   'cached'         — row hasn't been re-evaluated since the last
    --                      full pass (file content_hash unchanged, so
    --                      the per-file cache short-circuited) but is
    --                      still believed accurate.
    -- Stored at write time by `replaceFindingsForFile` /
    -- `appendFindings`; defaults to 'cached' on pre-migration rows.
    pass_kind TEXT NOT NULL DEFAULT 'cached',
    PRIMARY KEY (node_id, biomarker),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_findings_biomarker ON code_health_findings(biomarker);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON code_health_findings(severity);

-- Parse-result cache (migration 026). Skip the tree-sitter parse
-- pass when the same content+language+path has already been
-- extracted. Survives `clearStructural` / `--force` because
-- content-hash-keyed entries are still valid against any future
-- re-extract of the same content. Eviction handled by the runtime
-- via `evictParseCacheIfOversized`; payload is JSON-serialised
-- ExtractionResult.
CREATE TABLE IF NOT EXISTS parse_cache (
    content_hash TEXT NOT NULL,
    language TEXT NOT NULL,
    file_path TEXT NOT NULL,
    payload TEXT NOT NULL,
    generated_at INTEGER NOT NULL,
    -- Migration 066. Per-file structural fingerprint —
    -- sha256(sorted [kind, qualifiedName, signature, bodyHash] quads,
    -- see `computeStructHash` in src/extraction/symbol-body-hash.ts).
    -- The bodyHash inclusion is load-bearing: without it a body-only
    -- edit that leaves signatures untouched (e.g. `return 'world'` →
    -- `return 'modified'`) would falsely hash-equal the prior shape
    -- and trip the format-only fast path on a real semantic change.
    -- Two cached entries with the same struct_hash but different
    -- content_hash describe two formattings of the same code shape:
    -- the format-only fast path in `eoPersistFileExtraction` detects
    -- that match and skips the cascade-delete-and-reinsert sequence,
    -- leaving edges / role_assignments / code_health_findings in place.
    -- Default '' = "always-mismatch on first write" — the initial
    -- extract after upgrade or fresh install fills the column.
    struct_hash TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (content_hash, language, file_path)
) STRICT;
CREATE INDEX IF NOT EXISTS idx_parse_cache_generated_at
    ON parse_cache(generated_at);

-- Per-symbol LoC history (migration 027). Append-only snapshots
-- driving the recently_grew biomarker — symbols that grew sharply
-- since their previous indexed snapshot are stronger refactor
-- targets than evergreen-large symbols. The compound index makes
-- "previous snapshot for this node" a sub-millisecond ORDER BY
-- DESC LIMIT 1 lookup.
CREATE TABLE IF NOT EXISTS node_loc_history (
    node_id TEXT NOT NULL,
    indexed_ts INTEGER NOT NULL,
    loc INTEGER NOT NULL,
    PRIMARY KEY (node_id, indexed_ts),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_node_loc_history_node_ts
    ON node_loc_history(node_id, indexed_ts DESC);

-- MCP trace tables (migration 028). Capture every tool call the
-- MCP server dispatches so the viewer's Agent-trace tab can replay
-- how an agent discovered symbols. Sessions row groups calls per
-- `cartograph serve --mcp` invocation. Retention is runtime-capped
-- at 10000 calls (oldest evicted by ts).
CREATE TABLE IF NOT EXISTS mcp_sessions (
    id TEXT PRIMARY KEY,
    started_ts INTEGER NOT NULL,
    last_activity_ts INTEGER NOT NULL,
    tool_count INTEGER NOT NULL DEFAULT 0,
    -- Optional human label set by cartograph_session({action: "create", label})
    -- so resume can look up by name (#13, migration 030).
    label TEXT,
    -- Session identity (migration 073): the MCP client's self-reported
    -- name/version from the initialize handshake, and the server's
    -- resolved default project root at session start.
    client_name TEXT,
    client_version TEXT,
    project_root TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_started_ts
    ON mcp_sessions(started_ts DESC);

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
    session_id TEXT NOT NULL,
    step INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    tool_name TEXT NOT NULL,
    args_json TEXT NOT NULL,
    result_summary TEXT NOT NULL,
    duration_ms INTEGER NOT NULL,
    PRIMARY KEY (session_id, step),
    FOREIGN KEY (session_id) REFERENCES mcp_sessions(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_ts
    ON mcp_tool_calls(ts);

-- Saved query recipes (migration 030 / #13). Agent-callable via
-- cartograph_session({action: "macro_save"|"macro_run"}). Steps are
-- a JSON array of {tool, args} objects; macro_run replays each in
-- order with optional positional ${0}/${1}/... substitution from
-- the macro_run args array.
CREATE TABLE IF NOT EXISTS mcp_macros (
    name TEXT PRIMARY KEY,
    steps_json TEXT NOT NULL,
    created_ts INTEGER NOT NULL,
    last_run_ts INTEGER
) STRICT, WITHOUT ROWID;

-- Agent annotations + bookmarks (migration 031 / #14). Per-symbol
-- notes that survive across sessions. kind ∈ note|question|followup|bookmark.
-- node_id is nullable for project-scoped reminders not tied to a symbol.
CREATE TABLE IF NOT EXISTS agent_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT,
    author TEXT NOT NULL,
    ts INTEGER NOT NULL,
    text TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'note',
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_agent_notes_node
    ON agent_notes(node_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_notes_kind_ts
    ON agent_notes(kind, ts DESC);

-- Per-symbol metrics (migration 029). Current snapshot of every
-- analysable symbol's biomarker metrics — overwritten per pass.
-- The existing code_health_findings table only stores threshold-
-- exceeding values, so clean symbols had no persistent record of
-- their cyclomatic / max_nesting / etc. The viewer reads from this
-- table to populate the right-pane metrics block on any selection.
CREATE TABLE IF NOT EXISTS node_metrics (
    node_id TEXT PRIMARY KEY,
    loc INTEGER NOT NULL,
    cyclomatic INTEGER NOT NULL,
    max_nesting INTEGER NOT NULL,
    max_conditional_operands INTEGER NOT NULL,
    param_count INTEGER NOT NULL,
    magic_number_count INTEGER NOT NULL,
    hardcoded_url_count INTEGER NOT NULL,
    updated_ts INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- Summary priority queue (migration 041). Demand-driven summary
-- prioritization: when intent-search misses a query, enqueue the
-- matching unsummarised symbols for next-pass priority summarization.
-- The summariser is pull-based, consulting this queue to override
-- default updated_at ordering. Cascade-deleted with parent node.
CREATE TABLE IF NOT EXISTS summary_priority_queue (
    node_id TEXT PRIMARY KEY,
    enqueued_at INTEGER NOT NULL,
    requested_count INTEGER NOT NULL DEFAULT 1,
    attempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_summary_priority_enqueued
    ON summary_priority_queue(enqueued_at DESC);

-- Symbols whose summary prompt exceeded the chat backend's per-slot
-- context (HTTP 400). Recorded so the summariser stops re-attempting the
-- same body every pass and status reports them as "skipped — too large"
-- instead of a stuck "pending". Stamped with the failing body_hash so a
-- body change re-qualifies the symbol; `summarize --all` clears the table
-- to retry everything. Cascade-deleted with parent node. See issue #27.
CREATE TABLE IF NOT EXISTS summary_skips (
    node_id TEXT PRIMARY KEY,
    body_hash TEXT NOT NULL,
    reason TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;

-- Stage 7 #2 — classified intent for each commit SHA. Looked up by
-- SHA when the cochange / history paths want to filter / break down
-- co-changes by intent (feat / fix / refactor / perf / test / docs /
-- chore / unknown).
CREATE TABLE IF NOT EXISTS commit_intents (
    sha    TEXT PRIMARY KEY,
    intent TEXT NOT NULL,
    score  REAL NOT NULL,
    seen_at INTEGER NOT NULL
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_commit_intents_intent ON commit_intents(intent);

-- Stage 5 C.2 — chunk embeddings for multi-vector retrieval. Long symbols
-- (>= 500 LOC) are split into overlapping ~200-LOC windows; each window
-- gets one row here. chunk_idx=0 is reserved for the canonical per-symbol
-- row in `symbol_embeddings`; chunks start at chunk_idx=1.
-- FK ON DELETE CASCADE keeps the table clean on node prune.
CREATE TABLE IF NOT EXISTS symbol_chunk_embeddings (
    node_id               TEXT    NOT NULL,
    chunk_idx             INTEGER NOT NULL,
    embedding             BLOB    NOT NULL,
    embedding_model       TEXT    NOT NULL,
    start_line            INTEGER NOT NULL,
    end_line              INTEGER NOT NULL,
    summary_hash_at_embed TEXT    NOT NULL DEFAULT '',
    PRIMARY KEY (node_id, chunk_idx),
    FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
) STRICT;
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON symbol_chunk_embeddings(embedding_model);

-- HNSW per-dim staleness ledger. The HNSW rebuild (run by the detached
-- background embed phase — `runEmbedPhase`) compares the current
-- embedding_store rowset against (row_count, max_rowid) to decide
-- whether to rebuild the .cartograph/hnsw_<dim>.bin file. Mirrors
-- migration 042; declared here so fresh-install schema.sql users get
-- the table without replaying migrations.
CREATE TABLE IF NOT EXISTS hnsw_meta (
    dim         INTEGER PRIMARY KEY,
    row_count   INTEGER NOT NULL,
    max_rowid   INTEGER NOT NULL,
    built_at    INTEGER NOT NULL,
    file_path   TEXT NOT NULL
) STRICT;
