-- Cartograph PostgreSQL schema.
-- Mirrors the current SQLite schema with PostgreSQL-native tables and
-- indexes. SQLite-only virtual indexes (FTS5, RTree, sqlite-vec) are
-- intentionally omitted; callers use backend-specific fallbacks.

CREATE TABLE IF NOT EXISTS schema_versions (
  version INTEGER PRIMARY KEY,
  applied_at DOUBLE PRECISION NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS files (
  rowid SERIAL UNIQUE,
  path TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  size INTEGER NOT NULL,
  modified_at DOUBLE PRECISION NOT NULL,
  indexed_at DOUBLE PRECISION NOT NULL,
  node_count INTEGER DEFAULT 0,
  errors TEXT,
  commit_count INTEGER NOT NULL DEFAULT 0,
  loc INTEGER NOT NULL DEFAULT 0,
  first_seen_ts DOUBLE PRECISION DEFAULT NULL,
  last_touched_ts DOUBLE PRECISION DEFAULT NULL,
  is_test INTEGER NOT NULL DEFAULT 0,
  needs_reextract INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS nodes (
  rowid SERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (
    'file', 'module', 'class', 'struct', 'interface', 'trait', 'protocol',
    'function', 'method', 'property', 'field', 'variable', 'constant',
    'enum', 'enum_member', 'type_alias', 'namespace', 'parameter',
    'import', 'export', 'route', 'component', 'table', 'resource'
  )),
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
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
  decorators TEXT,
  decorator_args TEXT,
  updated_at DOUBLE PRECISION NOT NULL,
  centrality REAL DEFAULT NULL,
  betweenness REAL DEFAULT NULL,
  name_subwords TEXT,
  role TEXT CHECK (role IS NULL OR role IN (
    'api_endpoint', 'business_logic', 'data_model', 'util',
    'framework_glue', 'test_helper', 'unknown'
  )),
  role_model TEXT,
  body_hash TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_nodes_role ON nodes(role);
CREATE INDEX IF NOT EXISTS idx_nodes_kind ON nodes(kind);
CREATE INDEX IF NOT EXISTS idx_nodes_name ON nodes(name);
CREATE INDEX IF NOT EXISTS idx_nodes_name_nocase ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_qualified_name ON nodes(qualified_name);
CREATE INDEX IF NOT EXISTS idx_nodes_file_path ON nodes(file_path);
CREATE INDEX IF NOT EXISTS idx_nodes_language ON nodes(language);
CREATE INDEX IF NOT EXISTS idx_nodes_file_line ON nodes(file_path, start_line);
CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
CREATE INDEX IF NOT EXISTS idx_nodes_centrality ON nodes(centrality DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_betweenness ON nodes(betweenness DESC);
CREATE INDEX IF NOT EXISTS idx_nodes_search_fts ON nodes USING GIN (
  to_tsvector(
    'simple',
    COALESCE(name, '') || ' ' ||
    COALESCE(qualified_name, '') || ' ' ||
    COALESCE(signature, '') || ' ' ||
    COALESCE(docstring, '')
  )
);
CREATE INDEX IF NOT EXISTS idx_nodes_signature_fts ON nodes USING GIN (
  to_tsvector('simple', COALESCE(signature, ''))
);

CREATE TABLE IF NOT EXISTS role_assignments (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  role_model TEXT NOT NULL DEFAULT '',
  body_hash TEXT NOT NULL DEFAULT '',
  generated_at DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_role_assignments_body_hash ON role_assignments(body_hash);

CREATE TABLE IF NOT EXISTS edges (
  id SERIAL PRIMARY KEY,
  source TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  target TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN (
    'contains', 'calls', 'imports', 'exports', 'extends', 'implements',
    'references', 'type_of', 'returns', 'instantiates', 'overrides',
    'decorates', 'tests', 'field_access', 'similar_to', 'def_use'
  )),
  metadata TEXT,
  line INTEGER,
  col INTEGER,
  confidence TEXT CHECK (confidence IS NULL OR confidence IN ('EXTRACTED', 'INFERRED', 'AMBIGUOUS'))
);
CREATE INDEX IF NOT EXISTS idx_edges_kind ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind ON edges(source, kind);
CREATE INDEX IF NOT EXISTS idx_edges_source_kind_similar_to ON edges(source, kind) WHERE kind = 'similar_to';
CREATE INDEX IF NOT EXISTS idx_edges_target_kind ON edges(target, kind);
CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_unique
  ON edges(source, target, kind, COALESCE(line, -1), COALESCE(col, -1));
CREATE INDEX IF NOT EXISTS idx_edges_confidence ON edges(confidence);

CREATE INDEX IF NOT EXISTS idx_files_language ON files(language);
CREATE INDEX IF NOT EXISTS idx_files_modified_at ON files(modified_at);
CREATE INDEX IF NOT EXISTS idx_files_commit_count ON files(commit_count DESC);
CREATE INDEX IF NOT EXISTS idx_files_last_touched ON files(last_touched_ts DESC);

CREATE TABLE IF NOT EXISTS co_changes (
  rowid SERIAL UNIQUE,
  file_a TEXT NOT NULL,
  file_b TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (file_a, file_b),
  CHECK (file_a COLLATE "C" < file_b COLLATE "C")
);
CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_b);

CREATE TABLE IF NOT EXISTS unresolved_refs (
  id SERIAL PRIMARY KEY,
  from_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  reference_name TEXT NOT NULL,
  reference_kind TEXT NOT NULL,
  line INTEGER NOT NULL,
  col INTEGER NOT NULL,
  candidates TEXT,
  file_path TEXT NOT NULL DEFAULT '' REFERENCES files(path) ON DELETE CASCADE,
  language TEXT NOT NULL DEFAULT 'unknown',
  site_count INTEGER NOT NULL DEFAULT 1,
  extra_lines TEXT
);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_node ON unresolved_refs(from_node_id);
CREATE INDEX IF NOT EXISTS idx_unresolved_name ON unresolved_refs(reference_name);
CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
CREATE INDEX IF NOT EXISTS idx_unresolved_from_name ON unresolved_refs(from_node_id, reference_name);

CREATE TABLE IF NOT EXISTS project_metadata (
  rowid SERIAL UNIQUE,
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS symbol_issues (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  issue_number INTEGER NOT NULL,
  commit_sha TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('modified','added','removed')),
  PRIMARY KEY (node_id, issue_number, commit_sha, kind)
);
CREATE INDEX IF NOT EXISTS idx_symbol_issues_node ON symbol_issues(node_id);
CREATE INDEX IF NOT EXISTS idx_symbol_issues_issue ON symbol_issues(issue_number);

CREATE TABLE IF NOT EXISTS config_refs (
  id SERIAL PRIMARY KEY,
  config_kind TEXT NOT NULL,
  config_key TEXT NOT NULL,
  source_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_config_refs_key ON config_refs(config_kind, config_key);
CREATE INDEX IF NOT EXISTS idx_config_refs_node ON config_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_config_refs_file ON config_refs(file_path);

CREATE TABLE IF NOT EXISTS sql_refs (
  id SERIAL PRIMARY KEY,
  table_name TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('read','write','ddl')),
  source_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sql_refs_table ON sql_refs(lower(table_name));
CREATE INDEX IF NOT EXISTS idx_sql_refs_node ON sql_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_sql_refs_file ON sql_refs(file_path);

CREATE TABLE IF NOT EXISTS build_context_refs (
  id SERIAL PRIMARY KEY,
  ref_kind TEXT NOT NULL,
  source_node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_build_context_refs_kind ON build_context_refs(ref_kind);
CREATE INDEX IF NOT EXISTS idx_build_context_refs_node ON build_context_refs(source_node_id);
CREATE INDEX IF NOT EXISTS idx_build_context_refs_file ON build_context_refs(file_path);

CREATE TABLE IF NOT EXISTS string_imports (
  id SERIAL PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  module_name TEXT NOT NULL,
  raw TEXT NOT NULL,
  container_kind TEXT NOT NULL CHECK (container_kind IN ('template_string','string_literal'))
);
CREATE INDEX IF NOT EXISTS idx_string_imports_module ON string_imports(module_name);
CREATE INDEX IF NOT EXISTS idx_string_imports_file ON string_imports(file_path);
CREATE INDEX IF NOT EXISTS idx_string_imports_kind ON string_imports(container_kind);

CREATE TABLE IF NOT EXISTS summary_store (
  rowid SERIAL UNIQUE,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  summary TEXT NOT NULL,
  generated_at DOUBLE PRECISION NOT NULL,
  last_ref_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (body_hash, model)
);

CREATE TABLE IF NOT EXISTS summary_refs (
  rowid SERIAL UNIQUE,
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_summary_refs_body_hash ON summary_refs(body_hash, model);

CREATE OR REPLACE VIEW symbol_summaries AS
SELECT
  r.node_id AS node_id,
  r.body_hash AS content_hash,
  s.summary AS summary,
  r.model AS model,
  s.generated_at AS generated_at
FROM summary_refs r
JOIN summary_store s ON s.body_hash = r.body_hash AND s.model = r.model;

CREATE TABLE IF NOT EXISTS test_names (
  id SERIAL PRIMARY KEY,
  file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
  line INTEGER NOT NULL,
  description TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_test_names_file ON test_names(file_path);

CREATE TABLE IF NOT EXISTS nested_function_names (
  id SERIAL PRIMARY KEY,
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
  last_hit_at DOUBLE PRECISION,
  promoted_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
  promoted_at DOUBLE PRECISION,
  UNIQUE(file_path, name, start_line)
);
CREATE INDEX IF NOT EXISTS idx_nested_function_names_name ON nested_function_names(name);
CREATE INDEX IF NOT EXISTS idx_nested_function_names_file ON nested_function_names(file_path);
CREATE INDEX IF NOT EXISTS idx_nested_function_names_parent ON nested_function_names(parent_node_id);

CREATE TABLE IF NOT EXISTS nested_function_popularity (
  rowid SERIAL UNIQUE,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0,
  last_hit_at DOUBLE PRECISION,
  PRIMARY KEY (file_path, name)
);

CREATE TABLE IF NOT EXISTS embedding_store (
  rowid SERIAL UNIQUE,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  grain TEXT NOT NULL DEFAULT 'symbol',
  embedding BYTEA NOT NULL,
  generated_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_ref_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  PRIMARY KEY (body_hash, model, grain)
);

CREATE TABLE IF NOT EXISTS embedding_refs (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  body_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  grain TEXT NOT NULL DEFAULT 'symbol' CHECK (grain IN ('symbol', 'file')),
  summary_hash_at_embed TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (node_id, model, grain)
);
CREATE INDEX IF NOT EXISTS idx_embedding_refs_body_hash ON embedding_refs(body_hash, model, grain);
CREATE INDEX IF NOT EXISTS idx_embedding_refs_model ON embedding_refs(model);
CREATE INDEX IF NOT EXISTS idx_embedding_store_model ON embedding_store(model);

CREATE OR REPLACE VIEW symbol_embeddings AS
SELECT
  r.rowid AS rowid,
  r.node_id AS node_id,
  s.embedding AS embedding,
  r.model AS embedding_model,
  r.body_hash AS source_content_hash,
  r.summary_hash_at_embed AS summary_hash_at_embed,
  r.grain AS grain,
  0 AS chunk_idx
FROM embedding_refs r
JOIN embedding_store s
  ON s.body_hash = r.body_hash AND s.model = r.model AND s.grain = r.grain;

CREATE TABLE IF NOT EXISTS directory_summaries (
  rowid SERIAL UNIQUE,
  dir_path TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_dir_summaries_model ON directory_summaries(model);

CREATE TABLE IF NOT EXISTS file_summaries (
  rowid SERIAL UNIQUE,
  file_path TEXT PRIMARY KEY REFERENCES files(path) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  model TEXT NOT NULL,
  generated_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_file_summaries_model ON file_summaries(model);

CREATE TABLE IF NOT EXISTS node_coverage (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  covered_lines INTEGER NOT NULL,
  total_lines INTEGER NOT NULL,
  covered_branches INTEGER,
  total_branches INTEGER,
  ingested_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (node_id, source)
);
CREATE INDEX IF NOT EXISTS idx_node_coverage_source ON node_coverage(source);
CREATE INDEX IF NOT EXISTS idx_node_coverage_pct
  ON node_coverage(source, ((covered_lines::REAL) / NULLIF(total_lines, 0)));

CREATE TABLE IF NOT EXISTS code_health_findings (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  biomarker TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error')),
  metric REAL NOT NULL,
  detail TEXT,
  detected_at DOUBLE PRECISION NOT NULL,
  source_content_hash TEXT NOT NULL DEFAULT '',
  pass_kind TEXT NOT NULL DEFAULT 'cached',
  PRIMARY KEY (node_id, biomarker)
);
CREATE INDEX IF NOT EXISTS idx_findings_biomarker ON code_health_findings(biomarker);
CREATE INDEX IF NOT EXISTS idx_findings_severity ON code_health_findings(severity);

CREATE TABLE IF NOT EXISTS parse_cache (
  rowid SERIAL UNIQUE,
  content_hash TEXT NOT NULL,
  language TEXT NOT NULL,
  file_path TEXT NOT NULL,
  payload TEXT NOT NULL,
  generated_at DOUBLE PRECISION NOT NULL,
  struct_hash TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (content_hash, language, file_path)
);
CREATE INDEX IF NOT EXISTS idx_parse_cache_generated_at ON parse_cache(generated_at);

CREATE TABLE IF NOT EXISTS node_loc_history (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  indexed_ts DOUBLE PRECISION NOT NULL,
  loc INTEGER NOT NULL,
  PRIMARY KEY (node_id, indexed_ts)
);
CREATE INDEX IF NOT EXISTS idx_node_loc_history_node_ts ON node_loc_history(node_id, indexed_ts DESC);

CREATE TABLE IF NOT EXISTS mcp_sessions (
  rowid SERIAL UNIQUE,
  id TEXT PRIMARY KEY,
  started_ts DOUBLE PRECISION NOT NULL,
  last_activity_ts DOUBLE PRECISION NOT NULL,
  tool_count INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  -- Session identity (migration 073): the MCP client's self-reported
  -- name/version from the initialize handshake, and the server's
  -- resolved default project root at session start.
  client_name TEXT,
  client_version TEXT,
  project_root TEXT
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_started_ts ON mcp_sessions(started_ts DESC);

CREATE TABLE IF NOT EXISTS mcp_tool_calls (
  rowid SERIAL UNIQUE,
  session_id TEXT NOT NULL REFERENCES mcp_sessions(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  ts DOUBLE PRECISION NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  result_summary TEXT NOT NULL,
  duration_ms INTEGER NOT NULL,
  PRIMARY KEY (session_id, step)
);
CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_ts ON mcp_tool_calls(ts);

CREATE TABLE IF NOT EXISTS mcp_macros (
  rowid SERIAL UNIQUE,
  name TEXT PRIMARY KEY,
  steps_json TEXT NOT NULL,
  created_ts DOUBLE PRECISION NOT NULL,
  last_run_ts DOUBLE PRECISION
);

CREATE TABLE IF NOT EXISTS agent_notes (
  id SERIAL PRIMARY KEY,
  node_id TEXT REFERENCES nodes(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  ts DOUBLE PRECISION NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'note'
);
CREATE INDEX IF NOT EXISTS idx_agent_notes_node ON agent_notes(node_id, ts DESC);
CREATE INDEX IF NOT EXISTS idx_agent_notes_kind_ts ON agent_notes(kind, ts DESC);

CREATE TABLE IF NOT EXISTS node_metrics (
  rowid SERIAL UNIQUE,
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  loc INTEGER NOT NULL,
  cyclomatic INTEGER NOT NULL,
  max_nesting INTEGER NOT NULL,
  max_conditional_operands INTEGER NOT NULL,
  param_count INTEGER NOT NULL,
  magic_number_count INTEGER NOT NULL,
  hardcoded_url_count INTEGER NOT NULL,
  updated_ts DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS summary_priority_queue (
  rowid SERIAL UNIQUE,
  node_id TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  enqueued_at DOUBLE PRECISION NOT NULL,
  requested_count INTEGER NOT NULL DEFAULT 1,
  attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_summary_priority_enqueued ON summary_priority_queue(enqueued_at DESC);

CREATE TABLE IF NOT EXISTS commit_intents (
  rowid SERIAL UNIQUE,
  sha TEXT PRIMARY KEY,
  intent TEXT NOT NULL,
  score REAL NOT NULL,
  seen_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_commit_intents_intent ON commit_intents(intent);

CREATE TABLE IF NOT EXISTS symbol_chunk_embeddings (
  rowid SERIAL UNIQUE,
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  chunk_idx INTEGER NOT NULL,
  embedding BYTEA NOT NULL,
  embedding_model TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  summary_hash_at_embed TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (node_id, chunk_idx)
);
CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON symbol_chunk_embeddings(embedding_model);

CREATE TABLE IF NOT EXISTS hnsw_meta (
  rowid SERIAL UNIQUE,
  dim INTEGER PRIMARY KEY,
  row_count INTEGER NOT NULL,
  max_rowid INTEGER NOT NULL,
  built_at DOUBLE PRECISION NOT NULL,
  file_path TEXT NOT NULL
);

CREATE OR REPLACE VIEW sqlite_master AS
SELECT table_name AS name, 'table'::TEXT AS type, table_name AS tbl_name, NULL::TEXT AS sql
  FROM information_schema.tables
 WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
UNION ALL
SELECT table_name AS name, 'view'::TEXT AS type, table_name AS tbl_name, NULL::TEXT AS sql
  FROM information_schema.views
 WHERE table_schema = current_schema();
