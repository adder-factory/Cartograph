use std::{
    env,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    process, thread,
    time::{Duration, SystemTime},
};

use cartograph_agent::{
    DeadCodeJudgeOptions, DeadCodeVerdict, DiffReviewOptions, EmbeddingClientRequest,
    EmbeddingOptions, FileDriftOptions, FileSourceOptions, FileSourceRequest,
    GenerationRetentionStatus, HistoryIndexOptions, ImportAuditError, ImportAuditOptions,
    ImportAuditSource, ImportAuditTarget, IndexOptions, LcovLoadOptions, ProjectCancellation,
    ProjectError, ProjectRuntime, RenamePlanError, RenamePlanOptions, RetrievalClientRequest,
    RetrievalOptions, RetrievalRequest, ReviewOptions, ScipExportRequest, ScipImportRequest,
    SourceContextOptions, SourceContextRequest, SourceSearchOptions, TestEvidenceOptions,
    WorkingTreeOverlayRequest, judge_dead_code_candidates,
};
use cartograph_config::DatabaseSettings;
use cartograph_db::{
    DeadCodeQuery, ExactTextLookup, FileDependencyDirection, FileDependencyQuery, FileSurfaceQuery,
    GroupedPathInput, GroupedSymbolQuery, IssueAttributionKind, LeaseOwner, LeaseRequest,
    LeaseTarget, NativeParseCacheKey, SearchQuery, SemanticStorageError,
    StructuralFindingGroupQuery, StructuralFindingQuery, StructuralFindingSeverity,
    StructuralHotspotCategory, StructuralHotspotQuery, StructuralHotspotSort, SymbolCoverageQuery,
};
use cartograph_domain::{
    ContentDigest, EdgeKind, NormalizedPath, ProjectOperation, SourceLanguage,
};
use cartograph_extract::native_extractor_contract_digest;
use cartograph_llm::{ChatSettings, EmbeddingSettings, OpenAiChatClient, OpenAiEmbeddingClient};
use cartograph_scip::{decode_scip_index, encode_scip_index};
use cartograph_search::{
    DeterministicRetriever, EntryPointBucket, EntryPointsQuery, GraphPathRequest, IndexFreshness,
    RetrievalConfidence, RetrievalError, RetrievalExecution, ReviewAbstention, SearchMode,
    SemanticReadiness, SimilarRequest, TraversalBudget, WorkingTreeOverlayStatus,
};
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn independent_runtimes_terminalize_pre_lease_losers_and_bound_retention() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("12"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("multi-runtime settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::write(
        project.path().join("service.ts"),
        "export function boundedWatcher(): number { return 73; }\n",
    )
    .unwrap_or_else(|error| panic!("multi-runtime source fixture failed: {error}"));

    let result = async {
        let coordinator = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("coordinator runtime connect failed: {error}"));
        let project_id = coordinator
            .register_agent_state_project()
            .await
            .unwrap_or_else(|error| panic!("multi-runtime project registration failed: {error}"));
        let blocker = coordinator
            .database()
            .acquire_lease(LeaseRequest::new(
                LeaseTarget::new(project_id.clone(), ProjectOperation::Migration, None),
                LeaseOwner::new(process::id(), "multi-runtime-index-blocker"),
                Duration::from_secs(60),
            ))
            .await
            .unwrap_or_else(|error| panic!("multi-runtime blocker lease failed: {error}"));

        let options = IndexOptions::default()
            .with_force(true)
            .with_history_refresh(false);
        let mut tasks = Vec::new();
        for _ in 0..4 {
            let runtime = ProjectRuntime::connect(project.path(), &settings)
                .await
                .unwrap_or_else(|error| panic!("contending runtime connect failed: {error}"));
            tasks.push(tokio::spawn(async move {
                let indexed = runtime.index(options).await;
                (runtime, indexed)
            }));
        }
        let mut contenders = Vec::new();
        for task in tasks {
            let (runtime, indexed) = task
                .await
                .unwrap_or_else(|error| panic!("contending runtime task failed: {error}"));
            assert_eq!(indexed, Err(ProjectError::IndexFailed));
            contenders.push(runtime);
        }
        let counts_sql = format!(
            r#"SELECT
                    count(*) FILTER (WHERE state = 'staging')::bigint AS staging,
                    count(*) FILTER (WHERE state = 'failed')::bigint AS failed
                FROM "{schema}"."index_generations"
                WHERE project_id = CAST($1 AS uuid)"#
        );
        let pool = cartograph_db::connect(&settings)
            .await
            .unwrap_or_else(|error| panic!("multi-runtime count connection failed: {error}"));
        let counts = query(AssertSqlSafe(counts_sql.clone()))
            .bind(project_id.as_str())
            .fetch_one(&pool)
            .await
            .unwrap_or_else(|error| panic!("multi-runtime generation count failed: {error}"));
        assert_eq!(counts.try_get::<i64, _>("staging").ok(), Some(0));
        assert_eq!(counts.try_get::<i64, _>("failed").ok(), Some(4));

        coordinator
            .database()
            .release_lease(&blocker)
            .await
            .unwrap_or_else(|error| panic!("multi-runtime blocker lease did not release: {error}"));
        let published = coordinator
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("multi-runtime recovery index failed: {error}"));
        assert!(published.published);
        assert!(matches!(
            published.retention,
            GenerationRetentionStatus::Completed { report }
                if report.failed_removed == 4 && report.staging_remaining == 0
        ));
        let status = coordinator
            .status()
            .await
            .unwrap_or_else(|error| panic!("multi-runtime status failed: {error}"));
        let storage = status
            .snapshot
            .as_ref()
            .map(|snapshot| snapshot.generation_storage)
            .unwrap_or_else(|| panic!("multi-runtime storage summary was missing"));
        assert_eq!(storage.staging, 0);
        assert_eq!(storage.failed, 0);
        assert_eq!(storage.current, 1);
        assert!(storage.estimated_retained_bytes > 0);

        for runtime in contenders {
            runtime.close().await;
        }
        coordinator.close().await;
        pool.close().await;
    }
    .await;

    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn incremental_sync_reparses_only_changed_or_corrupt_files_and_keeps_complete_graph() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("incremental settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let source = project.path().join("src");
    std::fs::create_dir(&source)
        .unwrap_or_else(|error| panic!("incremental source directory failed: {error}"));
    std::fs::write(
        source.join("service.ts"),
        "export function calculateTotal(value: number): number { return value + 1; }\n",
    )
    .unwrap_or_else(|error| panic!("incremental service fixture failed: {error}"));
    std::fs::write(
        source.join("caller.ts"),
        "import { calculateTotal } from './service.js';\nexport function checkout(): number { return calculateTotal(2); }\n",
    )
    .unwrap_or_else(|error| panic!("incremental caller fixture failed: {error}"));
    std::fs::write(
        source.join("extra.ts"),
        "export function untouched(): boolean { return true; }\n",
    )
    .unwrap_or_else(|error| panic!("incremental extra fixture failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("incremental runtime connect failed: {error}"));
        let options = IndexOptions::default()
            .with_max_workers(4)
            .unwrap_or_else(|error| panic!("incremental worker options failed: {error}"))
            .with_history_refresh(false);
        let first = runtime
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("initial incremental index failed: {error}"));
        let first_metrics = first
            .native
            .as_ref()
            .unwrap_or_else(|| panic!("initial native metrics were missing"));
        assert_eq!(first_metrics.parse_cache.hits, 0);
        assert_eq!(first_metrics.parse_cache.misses, 3);
        assert_eq!(first_metrics.parse_cache.parsed_files, 3);
        assert_eq!(first_metrics.parse_cache.writes, 3);
        assert_complete_checkout_call(&runtime, &first.project_id).await;

        let service_bytes = std::fs::read(source.join("service.ts"))
            .unwrap_or_else(|error| panic!("service cache fixture read failed: {error}"));
        let service_path = NormalizedPath::parse("src/service.ts")
            .unwrap_or_else(|error| panic!("service cache path failed: {error}"));
        let service_hash = ContentDigest::from_bytes(*blake3::hash(&service_bytes).as_bytes());
        let exact_key = NativeParseCacheKey::new(
            first.project_id.clone(),
            native_extractor_contract_digest(),
            service_path.clone(),
            SourceLanguage::TypeScript,
            service_hash.clone(),
            u64::try_from(service_bytes.len()).unwrap_or(u64::MAX),
        );
        assert!(
            runtime
                .database()
                .load_native_parse_cache(&exact_key)
                .await
                .unwrap_or_else(|error| panic!("exact cache lookup failed: {error}"))
                .is_some()
        );
        let changed_contract_key = NativeParseCacheKey::new(
            first.project_id.clone(),
            ContentDigest::from_bytes(*blake3::hash(b"changed-extractor-contract").as_bytes()),
            service_path,
            SourceLanguage::TypeScript,
            service_hash,
            u64::try_from(service_bytes.len()).unwrap_or(u64::MAX),
        );
        assert!(
            runtime
                .database()
                .load_native_parse_cache(&changed_contract_key)
                .await
                .unwrap_or_else(|error| panic!("changed contract lookup failed: {error}"))
                .is_none()
        );

        let unchanged = runtime
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("incremental no-op failed: {error}"));
        assert!(!unchanged.published);
        assert!(unchanged.native.is_none());

        std::fs::write(
            source.join("service.ts"),
            "export function calculateTotal(value: number): number { return value + 2; }\nexport function taxRate(): number { return 13; }\n",
        )
        .unwrap_or_else(|error| panic!("incremental service edit failed: {error}"));
        let one_changed = runtime
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("one-file incremental index failed: {error}"));
        let changed_metrics = one_changed
            .native
            .as_ref()
            .unwrap_or_else(|| panic!("one-file native metrics were missing"));
        assert_eq!(changed_metrics.parse_cache.hits, 2);
        assert_eq!(changed_metrics.parse_cache.misses, 1);
        assert_eq!(changed_metrics.parse_cache.parsed_files, 1);
        assert_eq!(changed_metrics.parse_cache.writes, 1);
        assert_complete_checkout_call(&runtime, &one_changed.project_id).await;

        let corrupt_payload = b"{";
        let corrupt_digest = ContentDigest::from_bytes(*blake3::hash(corrupt_payload).as_bytes());
        let corrupt_sql = format!(
            r#"UPDATE "{schema}"."native_parse_cache"
               SET payload = $1, payload_digest = $2
               WHERE project_id = $3::uuid AND normalized_path = 'src/caller.ts'"#
        );
        let corruption_pool = cartograph_db::connect(&settings)
            .await
            .unwrap_or_else(|error| panic!("cache corruption connection failed: {error}"));
        let corrupted = query(AssertSqlSafe(corrupt_sql))
            .bind(corrupt_payload.as_slice())
            .bind(corrupt_digest.as_str())
            .bind(one_changed.project_id.as_str())
            .execute(&corruption_pool)
            .await
            .unwrap_or_else(|_| panic!("cache corruption fixture failed"));
        assert_eq!(corrupted.rows_affected(), 1);
        corruption_pool.close().await;
        std::fs::write(
            source.join("extra.ts"),
            "export function untouched(): boolean { return false; }\n",
        )
        .unwrap_or_else(|error| panic!("incremental extra edit failed: {error}"));
        let recovered = runtime
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("corrupt-cache recovery index failed: {error}"));
        let recovered_metrics = recovered
            .native
            .as_ref()
            .unwrap_or_else(|| panic!("recovery native metrics were missing"));
        assert_eq!(recovered_metrics.parse_cache.hits, 1);
        assert_eq!(recovered_metrics.parse_cache.misses, 2);
        assert_eq!(recovered_metrics.parse_cache.parsed_files, 2);
        assert_eq!(recovered_metrics.parse_cache.corruptions, 1);
        assert_eq!(recovered_metrics.parse_cache.writes, 2);
        assert_eq!(recovered_metrics.parse_cache.read_errors, 0);
        assert_eq!(recovered_metrics.parse_cache.write_errors, 0);
        assert_complete_checkout_call(&runtime, &recovered.project_id).await;

        let forced = runtime
            .index(options.with_force(true))
            .await
            .unwrap_or_else(|error| panic!("forced deterministic rebuild failed: {error}"));
        let forced_metrics = forced
            .native
            .as_ref()
            .unwrap_or_else(|| panic!("forced native metrics were missing"));
        assert_eq!(forced_metrics.parse_cache.hits, 0);
        assert_eq!(forced_metrics.parse_cache.misses, 0);
        assert_eq!(forced_metrics.parse_cache.bypassed, 3);
        assert_eq!(forced_metrics.parse_cache.parsed_files, 3);
        assert_eq!(forced.content_digest, recovered.content_digest);
        runtime.close().await;
    }
    .await;

    drop_schema(&settings, &schema).await;
    result
}

async fn assert_complete_checkout_call(
    runtime: &ProjectRuntime,
    project_id: &cartograph_domain::ProjectId,
) {
    let snapshot = runtime
        .database()
        .current_interchange_snapshot(project_id, 10_000, Duration::from_secs(30))
        .await
        .unwrap_or_else(|error| panic!("incremental graph snapshot failed: {error}"));
    let caller = snapshot
        .symbols
        .iter()
        .find(|symbol| symbol.qualified_name == "checkout")
        .unwrap_or_else(|| panic!("checkout symbol was missing"));
    let callee = snapshot
        .symbols
        .iter()
        .find(|symbol| symbol.qualified_name == "calculateTotal")
        .unwrap_or_else(|| panic!("calculateTotal symbol was missing"));
    assert!(snapshot.edges.iter().any(|edge| {
        edge.source_symbol_id == caller.symbol_id
            && edge.target_symbol_id == callee.symbol_id
            && edge.edge_kind == "calls"
    }));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn fuzzy_name_and_parallel_source_search_use_live_paradedb_generation() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live find settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::write(
        project.path().join("auth.ts"),
        r#"/** Verify an incoming JWT signature before authorization. */
export function verifyJwtSignature(token: string): boolean {
  const issuer = process.env.JWT_ISSUER;
  const query = "SELECT id FROM auth_sessions WHERE issuer = $1";
  return issuer !== undefined && query.length > 0 && token.length > 0;
}
"#,
    )
    .unwrap_or_else(|error| panic!("find fixture write failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("find runtime connect failed: {error}"));
        let indexed = runtime
            .index(
                IndexOptions::default()
                    .with_max_workers(4)
                    .unwrap_or_else(|error| panic!("find worker options failed: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("find index failed: {error}"));
        let fuzzy = runtime
            .database()
            .search_current_names_fuzzy(
                SearchQuery::new(
                    indexed.project_id.clone(),
                    indexed.generation_id.clone(),
                    "verfyJwtSignatre",
                    10,
                ),
                2,
            )
            .await
            .unwrap_or_else(|error| panic!("ParadeDB fuzzy name search failed: {error}"));
        assert!(
            fuzzy
                .iter()
                .any(|hit| hit.qualified_name() == "verifyJwtSignature")
        );
        assert!(
            fuzzy
                .iter()
                .all(|hit| hit.components() == [cartograph_db::SearchComponent::QualifiedName])
        );
        let source = runtime
            .search_source(
                &indexed.project_id,
                SourceSearchOptions::new(r#"process\.env\.JWT_ISSUER|FROM\s+auth_sessions"#, 10)
                    .unwrap_or_else(|error| panic!("source search options failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("parallel source search failed: {error}"));
        assert_eq!(source.hits().len(), 2);
        let source_json = serde_json::to_value(&source)
            .unwrap_or_else(|error| panic!("source search serialization failed: {error}"));
        assert_eq!(source_json["regexEngine"], "rust_regex_linear_time");
        assert!(source_json["hits"].as_array().is_some_and(|hits| {
            hits.iter()
                .all(|hit| hit["enclosingSymbol"]["qualifiedName"] == "verifyJwtSignature")
        }));
        runtime.close().await;
    }
    .await;

    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn scip_export_and_persistent_partial_import_preserve_exact_graph_and_uncovered_files() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live SCIP settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::create_dir(project.path().join("src"))
        .unwrap_or_else(|error| panic!("source directory failed: {error}"));
    std::fs::write(
        project.path().join("src/main.rs"),
        "pub fn caller() { callee(); }\npub fn callee() {}\n",
    )
    .unwrap_or_else(|error| panic!("main source failed: {error}"));
    std::fs::write(
        project.path().join("src/keep.rs"),
        "pub fn uncovered_file_symbol() {}\n",
    )
    .unwrap_or_else(|error| panic!("keep source failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("SCIP runtime connect failed: {error}"));
        let first = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("SCIP initial index failed: {error}"));
        let exported = runtime
            .export_scip_with_cancellation(
                ScipExportRequest::new("full.scip", 10_000)
                    .unwrap_or_else(|error| panic!("SCIP export request failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("SCIP export failed: {error}"));
        assert_eq!(exported.generation_id, first.generation_id);
        assert!(exported.stats.exact_typed_edges() > 0);
        let full_bytes = std::fs::read(project.path().join("full.scip"))
            .unwrap_or_else(|error| panic!("SCIP artifact read failed: {error}"));
        let mut partial = decode_scip_index(&full_bytes)
            .unwrap_or_else(|error| panic!("SCIP artifact decode failed: {error}"));
        partial
            .documents
            .retain(|document| document.relative_path == "src/main.rs");
        assert_eq!(partial.documents.len(), 1);
        let partial_bytes = encode_scip_index(&partial)
            .unwrap_or_else(|error| panic!("partial SCIP encode failed: {error}"));
        std::fs::write(project.path().join("partial.scip"), partial_bytes)
            .unwrap_or_else(|error| panic!("partial SCIP write failed: {error}"));

        let imported = runtime
            .import_scip_with_cancellation(
                ScipImportRequest::new("partial.scip", 1024 * 1024, 10_000, 4)
                    .unwrap_or_else(|error| panic!("SCIP import request failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("SCIP import failed: {error}"));
        assert!(imported.index.published);
        assert_ne!(imported.index.generation_id, first.generation_id);
        let overlay = imported
            .index
            .native
            .as_ref()
            .and_then(|native| native.scip_overlay)
            .unwrap_or_else(|| panic!("SCIP overlay metrics were missing"));
        assert_eq!(overlay.covered_documents, 1);
        assert!(overlay.exact_typed_edges > 0);
        let snapshot = runtime
            .database()
            .current_interchange_snapshot(
                &imported.index.project_id,
                10_000,
                Duration::from_secs(30),
            )
            .await
            .unwrap_or_else(|error| panic!("SCIP current snapshot failed: {error}"));
        assert_eq!(snapshot.files.len(), 2);
        assert!(
            snapshot
                .symbols
                .iter()
                .any(|symbol| symbol.qualified_name == "uncovered_file_symbol")
        );
        assert!(
            snapshot
                .edges
                .iter()
                .any(|edge| { edge.edge_kind == "calls" && edge.site_count == 1 })
        );
        let status = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("SCIP status failed: {error}"));
        assert!(status.fresh);
        runtime.close().await;
    }
    .await;

    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn fresh_checkout_indexes_searches_noops_and_atomically_refreshes() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live project settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let source = project.path().join("auth.ts");
    std::fs::write(
        &source,
        "export function parseToken(token: string): boolean { return token.length > 0; }\n\
         export function verifyJwtSignature(token: string): boolean { return parseToken(token); }\n\
         export function authorizeRequest(token: string): boolean { return verifyJwtSignature(token); }\n",
    )
    .unwrap_or_else(|error| panic!("fixture write failed: {error}"));
    git(project.path(), &["init", "--initial-branch=main"]);
    git(
        project.path(),
        &["config", "user.email", "review@example.invalid"],
    );
    git(project.path(), &["config", "user.name", "Review Fixture"]);
    git(project.path(), &["add", "auth.ts"]);
    git(project.path(), &["commit", "-m", "base"]);

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("runtime connect failed: {error}"));
        let first = runtime
            .index(IndexOptions::default().with_max_workers(4).unwrap_or_else(|error| {
                panic!("worker options failed: {error}")
            }))
            .await
            .unwrap_or_else(|error| panic!("first index failed: {error}"));
        assert!(first.published);
        assert_eq!(first.native.as_ref().map(|native| native.files), Some(1));
        let status = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("status failed: {error}"));
        assert!(status.fresh);
        assert_eq!(
            status
                .snapshot
                .as_ref()
                .and_then(|snapshot| snapshot.current.as_ref())
                .map(|current| current.generation_id.clone()),
            Some(first.generation_id.clone())
        );

        let hits = runtime
            .database()
            .search_current_code(SearchQuery::new(
                first.project_id.clone(),
                first.generation_id.clone(),
                "verify jwt signature",
                5,
            ))
            .await
            .unwrap_or_else(|error| panic!("BM25 search failed: {error}"));
        assert_eq!(hits.first().map(|hit| hit.path()), Some("auth.ts"));
        let symbol_id = hits
            .first()
            .and_then(|hit| hit.symbol_id())
            .cloned()
            .unwrap_or_else(|| panic!("BM25 fixture hit did not retain its symbol identity"));
        let source_context = runtime
            .source_context(SourceContextRequest::new(
                symbol_id.clone(),
                SourceContextOptions::default(),
            ))
            .await
            .unwrap_or_else(|error| panic!("fresh source context failed: {error}"));
        assert!(source_context.fresh());
        assert!(
            source_context
                .excerpt()
                .is_some_and(|excerpt| excerpt.text().contains("verifyJwtSignature"))
        );
        let file_source = runtime
            .file_source_with_cancellation(
                FileSourceRequest::new(
                    NormalizedPath::parse("auth.ts")
                        .unwrap_or_else(|error| panic!("file source path failed: {error}")),
                    FileSourceOptions::new(1, 1)
                        .unwrap_or_else(|error| panic!("file source options failed: {error}")),
                ),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("fresh file source failed: {error}"));
        let file_source = serde_json::to_value(file_source)
            .unwrap_or_else(|error| panic!("file source serialization failed: {error}"));
        assert_eq!(file_source["fresh"], true);
        assert_eq!(file_source["excerpt"]["startLine"], 2);
        assert!(
            file_source["excerpt"]["text"]
                .as_str()
                .is_some_and(|text| text.contains("verifyJwtSignature"))
        );

        let coverage_directory = project.path().join("coverage");
        std::fs::create_dir(&coverage_directory)
            .unwrap_or_else(|error| panic!("coverage directory failed: {error}"));
        std::fs::write(
            coverage_directory.join("lcov.info"),
            "SF:auth.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n",
        )
        .unwrap_or_else(|error| panic!("coverage fixture write failed: {error}"));
        let coverage_report = runtime
            .load_lcov(
                LcovLoadOptions::new(
                    vec![Path::new("coverage/lcov.info").to_path_buf()],
                    "unit",
                )
                .unwrap_or_else(|error| panic!("coverage options failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("LCOV ingest failed: {error}"));
        let coverage_json = serde_json::to_value(&coverage_report)
            .unwrap_or_else(|error| panic!("coverage report serialization failed: {error}"));
        assert_eq!(coverage_json["reports"], 1);
        assert_eq!(coverage_json["reportFiles"], 1);
        assert_eq!(coverage_json["matchedSymbols"], 3);
        let coverage_query = SymbolCoverageQuery::new(10)
            .and_then(|query| query.with_source(Some("unit")))
            .unwrap_or_else(|error| panic!("coverage query failed: {error}"));
        let coverage_rows = runtime
            .database()
            .current_symbol_coverage(&first.project_id, &coverage_query)
            .await
            .unwrap_or_else(|error| panic!("coverage ranking failed: {error}"));
        assert_eq!(coverage_rows.len(), 3);
        let ranked_json = serde_json::to_value(&coverage_rows)
            .unwrap_or_else(|error| panic!("coverage rows serialization failed: {error}"));
        assert_eq!(ranked_json[0]["coverageFraction"], 0.0);
        assert_eq!(ranked_json[0]["qualifiedName"], "authorizeRequest");
        assert!(ranked_json[0]["degreeCentrality"].is_number());
        let coverage_stats = runtime
            .database()
            .current_coverage_stats(&first.project_id, Some("unit"))
            .await
            .unwrap_or_else(|error| panic!("coverage stats failed: {error}"));
        let stats_json = serde_json::to_value(coverage_stats)
            .unwrap_or_else(|error| panic!("coverage stats serialization failed: {error}"));
        assert_eq!(stats_json["symbols"], 3);
        assert_eq!(stats_json["linesFound"], 3);
        assert_eq!(stats_json["linesHit"], 2);
        assert_eq!(
            runtime
                .database()
                .coverage_sources(&first.project_id)
                .await
                .unwrap_or_else(|error| panic!("coverage sources failed: {error}"))
                .len(),
            1
        );
        std::fs::remove_dir_all(&coverage_directory)
            .unwrap_or_else(|error| panic!("coverage fixture cleanup failed: {error}"));

        let authorize = exact_symbol_id(
            &runtime,
            &first.project_id,
            &first.generation_id,
            "authorizeRequest",
        )
        .await;
        let parse = exact_symbol_id(
            &runtime,
            &first.project_id,
            &first.generation_id,
            "parseToken",
        )
        .await;
        let verify = exact_symbol_id(
            &runtime,
            &first.project_id,
            &first.generation_id,
            "verifyJwtSignature",
        )
        .await;
        let page_rank_scores = runtime
            .database()
            .current_symbol_pagerank(
                &first.project_id,
                &first.generation_id,
                &[authorize.clone(), verify.clone(), parse.clone()],
            )
            .await
            .unwrap_or_else(|error| panic!("PageRank read failed: {error}"));
        let page_rank = |symbol| {
            page_rank_scores
                .iter()
                .find(|score| &score.symbol_id == symbol)
                .and_then(|score| score.score)
                .unwrap_or_else(|| panic!("symbol did not retain a PageRank score"))
        };
        assert!(page_rank(&parse) > page_rank(&verify));
        assert!(page_rank(&verify) > page_rank(&authorize));
        let bridge_scores = runtime
            .database()
            .current_symbol_betweenness(
                &first.project_id,
                &first.generation_id,
                &[authorize.clone(), verify.clone(), parse.clone()],
            )
            .await
            .unwrap_or_else(|error| panic!("betweenness read failed: {error}"));
        let verify_score = bridge_scores
            .iter()
            .find(|score| score.symbol_id == verify)
            .and_then(|score| score.score)
            .unwrap_or_else(|| panic!("bridge symbol did not retain a score"));
        assert!(verify_score > 0.0);
        assert!(
            bridge_scores
                .iter()
                .filter(|score| score.symbol_id != verify)
                .all(|score| score.score == Some(0.0))
        );
        let retriever = DeterministicRetriever::new(runtime.database().clone());
        let entry_points = retriever
            .entry_points(
                &first.project_id,
                EntryPointsQuery::new(20)
                    .unwrap_or_else(|error| panic!("entry-point query failed: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("entry-point discovery failed: {error}"));
        assert_eq!(entry_points.generation_id(), Some(&first.generation_id));
        assert_eq!(entry_points.buckets().len(), EntryPointBucket::ALL.len());
        let public = entry_points
            .buckets()
            .iter()
            .find(|page| page.bucket() == EntryPointBucket::PublicExports)
            .unwrap_or_else(|| panic!("public-export entry-point page was missing"));
        assert_eq!(public.total(), 1);
        assert!(!public.truncated());
        assert_eq!(
            public.symbols().first().map(|symbol| symbol.qualified_name()),
            Some("authorizeRequest")
        );
        assert!(entry_points.buckets()[..4].iter().all(|page| page.total() == 0));
        let path_budget = TraversalBudget::new(4, 20)
            .unwrap_or_else(|error| panic!("graph path budget failed: {error}"));
        let calls_path = retriever
            .path(
                &GraphPathRequest::new(
                    first.project_id.clone(),
                    authorize.clone(),
                    parse.clone(),
                    path_budget,
                )
                .with_edge_kind(EdgeKind::Calls),
            )
            .await
            .unwrap_or_else(|error| panic!("calls path failed: {error}"));
        let steps = calls_path
            .path()
            .unwrap_or_else(|| panic!("calls path did not find the fixture chain"));
        assert_eq!(steps.len(), 3);
        assert_eq!(
            steps
                .iter()
                .map(|step| step.symbol().qualified_name())
                .collect::<Vec<_>>(),
            vec!["authorizeRequest", "verifyJwtSignature", "parseToken"]
        );
        assert!(steps[0].via().is_none());
        assert!(
            steps[1..]
                .iter()
                .all(|step| step.via().is_some_and(|hop| hop.edge_kind() == "calls"))
        );
        assert!(!calls_path.truncated());

        let filtered_out = retriever
            .path(
                &GraphPathRequest::new(
                    first.project_id.clone(),
                    authorize.clone(),
                    parse.clone(),
                    path_budget,
                )
                .with_edge_kind(EdgeKind::Imports),
            )
            .await
            .unwrap_or_else(|error| panic!("filtered path failed: {error}"));
        assert!(filtered_out.path().is_none());
        assert!(!filtered_out.truncated());

        let depth_limited = retriever
            .path(
                &GraphPathRequest::new(
                    first.project_id.clone(),
                    authorize.clone(),
                    parse.clone(),
                    TraversalBudget::new(1, 20)
                        .unwrap_or_else(|error| panic!("depth path budget failed: {error}")),
                )
                .with_edge_kind(EdgeKind::Calls),
            )
            .await
            .unwrap_or_else(|error| panic!("depth-limited path failed: {error}"));
        assert!(depth_limited.path().is_none());
        assert!(depth_limited.truncated());

        let node_limited = retriever
            .path(
                &GraphPathRequest::new(
                    first.project_id.clone(),
                    authorize,
                    parse,
                    TraversalBudget::new(4, 1)
                        .unwrap_or_else(|error| panic!("node path budget failed: {error}")),
                )
                .with_edge_kind(EdgeKind::Calls),
            )
            .await
            .unwrap_or_else(|error| panic!("node-limited path failed: {error}"));
        assert!(node_limited.path().is_none());
        assert!(node_limited.truncated());

        let (embedding_endpoint, embedding_server) = embedding_fixture_server(3);
        let embedding_settings =
            EmbeddingSettings::new(&embedding_endpoint, "fixture-code-model", None)
                .unwrap_or_else(|error| panic!("embedding settings failed: {error}"));
        let embedding_client = OpenAiEmbeddingClient::new(embedding_settings)
            .unwrap_or_else(|error| panic!("embedding client failed: {error}"));
        let query_client = embedding_client.clone();
        let embedded = runtime
            .embed_current_with_client(EmbeddingClientRequest::new(
                embedding_client,
                EmbeddingOptions::default()
                    .with_max_workers(4)
                    .unwrap_or_else(|error| panic!("embedding options failed: {error}")),
                ProjectCancellation::new(),
            ))
            .await
            .unwrap_or_else(|error| panic!("embedding sweep failed: {error}"));
        assert!(embedded.readiness().ready());
        assert_eq!(embedded.readiness().documents(), 4);
        assert_eq!(embedded.readiness().embedded(), 4);
        let similar = retriever
            .similar(
                &SimilarRequest::new(first.project_id.clone(), symbol_id.clone(), 2)
                    .and_then(|request| request.with_minimum_score(0.9))
                    .unwrap_or_else(|error| panic!("similar request failed: {error}"))
                    .with_same_language(true),
            )
            .await
            .unwrap_or_else(|error| panic!("stored-vector similar query failed: {error}"));
        assert_eq!(similar.source_symbol_id(), &symbol_id);
        assert_eq!(similar.hits().len(), 2);
        assert!(
            similar
                .hits()
                .iter()
                .all(|hit| hit.score() == 1.0 && hit.symbol().language() == "typescript")
        );
        assert!(
            similar
                .hits()
                .iter()
                .all(|hit| hit.symbol().symbol_id() != Some(&symbol_id))
        );
        assert!(!similar.truncated());
        let model_a_id = similar.model().model_id().clone();
        let hybrid = runtime
            .search_with_client(RetrievalClientRequest::new(
                RetrievalRequest::new(
                    first.project_id.clone(),
                    "verify jwt signature",
                    RetrievalOptions::new(SearchMode::Auto, 5)
                        .unwrap_or_else(|error| panic!("retrieval options failed: {error}")),
                ),
                query_client,
                ProjectCancellation::new(),
            ))
            .await
            .unwrap_or_else(|error| panic!("hybrid search failed: {error}"));
        assert_eq!(hybrid.semantic_readiness(), SemanticReadiness::Ready);
        assert_eq!(hybrid.execution(), RetrievalExecution::Hybrid);
        assert!(!hybrid.items().is_empty());
        assert!(
            hybrid
                .items()
                .iter()
                .any(|item| item.contributions().len() == 2)
        );
        embedding_server
            .join()
            .unwrap_or_else(|_| panic!("embedding fixture server panicked"));

        let (second_endpoint, second_server) = embedding_fixture_server(2);
        let second_settings =
            EmbeddingSettings::new(&second_endpoint, "fixture-code-model-2", None)
                .unwrap_or_else(|error| panic!("second embedding settings failed: {error}"));
        let second_client = OpenAiEmbeddingClient::new(second_settings)
            .unwrap_or_else(|error| panic!("second embedding client failed: {error}"));
        let second_embedded = runtime
            .embed_current_with_client(EmbeddingClientRequest::new(
                second_client,
                EmbeddingOptions::default(),
                ProjectCancellation::new(),
            ))
            .await
            .unwrap_or_else(|error| panic!("second embedding sweep failed: {error}"));
        assert!(second_embedded.readiness().ready());
        second_server
            .join()
            .unwrap_or_else(|_| panic!("second embedding fixture server panicked"));
        let ambiguous = retriever
            .similar(
                &SimilarRequest::new(first.project_id.clone(), symbol_id.clone(), 2)
                    .unwrap_or_else(|error| panic!("ambiguous similar request failed: {error}")),
            )
            .await;
        assert!(matches!(
            ambiguous,
            Err(RetrievalError::Semantic(
                SemanticStorageError::AmbiguousActiveModels
            ))
        ));
        let selected = retriever
            .similar(
                &SimilarRequest::new(first.project_id.clone(), symbol_id.clone(), 2)
                    .unwrap_or_else(|error| panic!("selected similar request failed: {error}"))
                    .with_model_id(model_a_id),
            )
            .await
            .unwrap_or_else(|error| panic!("model-selected similar query failed: {error}"));
        assert_eq!(selected.hits().len(), 2);

        let unchanged = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("unchanged index failed: {error}"));
        assert!(!unchanged.published);
        assert_eq!(unchanged.generation_id, first.generation_id);

        std::fs::write(
            &source,
            "export function rejectExpiredJwt(token: string): boolean { return token.length === 0; }\n",
        )
        .unwrap_or_else(|error| panic!("fixture update failed: {error}"));
        let stale = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("stale status failed: {error}"));
        assert!(!stale.fresh);
        let stale_source = runtime
            .source_context(SourceContextRequest::new(
                symbol_id.clone(),
                SourceContextOptions::default(),
            ))
            .await
            .unwrap_or_else(|error| panic!("stale source context failed: {error}"));
        assert!(!stale_source.fresh());
        assert!(stale_source.excerpt().is_none());
        let explicit_live_source = runtime
            .source_context(SourceContextRequest::new(
                symbol_id.clone(),
                SourceContextOptions::default().with_stale_live_source(true),
            ))
            .await
            .unwrap_or_else(|error| panic!("explicit live source context failed: {error}"));
        assert!(!explicit_live_source.fresh());
        assert!(explicit_live_source.live_source());
        assert!(
            explicit_live_source
                .excerpt()
                .is_some_and(|excerpt| excerpt.text().contains("rejectExpiredJwt"))
        );
        let overlay = runtime
            .working_tree_overlay(WorkingTreeOverlayRequest::new(
                "diagnose rejectExpiredJwt behavior",
                ProjectCancellation::new(),
            ))
            .await
            .unwrap_or_else(|error| panic!("working-tree overlay failed: {error}"));
        assert_eq!(overlay.status(), WorkingTreeOverlayStatus::Used);
        assert_eq!(
            overlay.files().first().map(|file| file.path().as_str()),
            Some("auth.ts")
        );
        let review_options = ReviewOptions::new("HEAD")
            .unwrap_or_else(|error| panic!("review options failed: {error}"));
        let stale_review = runtime
            .review(&review_options)
            .await
            .unwrap_or_else(|error| panic!("stale review failed: {error}"));
        assert!(stale_review.comparison().worktree_dirty());
        assert_eq!(stale_review.comparison().files().len(), 1);
        assert_eq!(stale_review.packet().freshness(), IndexFreshness::Stale);
        assert_eq!(
            stale_review.packet().abstention(),
            Some(ReviewAbstention::StaleIndex)
        );
        let supplied_diff = "diff --git a/auth.ts b/auth.ts\n--- a/auth.ts\n+++ b/auth.ts\n@@ -1,3 +1 @@\n-export function parseToken(token: string): boolean { return token.length > 0; }\n-export function verifyJwtSignature(token: string): boolean { return parseToken(token); }\n-export function authorizeRequest(token: string): boolean { return verifyJwtSignature(token); }\n+export function rejectExpiredJwt(token: string): boolean { return token.length === 0; }\n";
        let diff_review = runtime
            .review_diff_with_cancellation(
                supplied_diff,
                DiffReviewOptions::default(),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("supplied-diff review failed: {error}"));
        let diff_review = serde_json::to_value(diff_review)
            .unwrap_or_else(|error| panic!("supplied-diff review serialization failed: {error}"));
        assert_eq!(diff_review["comparison"]["files"][0]["path"], "auth.ts");
        assert_eq!(diff_review["comparison"]["addedLines"], 1);
        assert_eq!(diff_review["comparison"]["removedLines"], 3);
        assert_eq!(diff_review["packet"]["freshness"], "stale");
        assert!(
            diff_review["hunks"][0]["symbolIds"]
                .as_array()
                .is_some_and(|symbols| !symbols.is_empty())
        );
        assert!(
            diff_review["symbols"]
                .as_array()
                .is_some_and(|symbols| !symbols.is_empty())
        );
        let refreshed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("refresh index failed: {error}"));
        assert!(refreshed.published);
        assert_ne!(refreshed.generation_id, first.generation_id);
        assert_ne!(refreshed.content_digest, first.content_digest);
        let fresh = runtime
            .status()
            .await
            .unwrap_or_else(|error| panic!("fresh status failed: {error}"));
        assert!(fresh.fresh);
        let current_review = runtime
            .review(&review_options)
            .await
            .unwrap_or_else(|error| panic!("current review failed: {error}"));
        assert_eq!(
            current_review.packet().freshness(),
            IndexFreshness::Current
        );
        assert_eq!(
            current_review.packet().confidence(),
            RetrievalConfidence::High
        );
        assert_eq!(current_review.packet().abstention(), None);
        runtime.close().await;
    }
    .await;

    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn graph_analysis_and_evidence_flags_reindex_without_weakening_traversal() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("graph policy settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::create_dir(project.path().join(".cartograph"))
        .unwrap_or_else(|error| panic!("graph policy config directory failed: {error}"));
    let config = project.path().join(".cartograph/config.json");
    std::fs::write(
        &config,
        r#"{"enableCentrality":false,"enableBetweenness":false,"extractDocstrings":false,"trackCallSites":false,"enableChurn":false,"enableCoChange":false,"enableIssueHistory":false}"#,
    )
    .unwrap_or_else(|error| panic!("disabled graph policy failed: {error}"));
    std::fs::write(
        project.path().join("policy.rs"),
        "/// Sensitive implementation notes.\npub fn target() {}\npub fn caller() { target(); }\n",
    )
    .unwrap_or_else(|error| panic!("graph policy fixture failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("graph policy runtime failed: {error}"));
        let disabled = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("disabled graph policy index failed: {error}"));
        assert!(disabled.published);
        let caller = exact_symbol_id(
            &runtime,
            &disabled.project_id,
            &disabled.generation_id,
            "caller",
        )
        .await;
        let target = exact_symbol_id(
            &runtime,
            &disabled.project_id,
            &disabled.generation_id,
            "target",
        )
        .await;
        let scores = runtime
            .database()
            .current_symbol_pagerank(
                &disabled.project_id,
                &disabled.generation_id,
                &[caller.clone(), target.clone()],
            )
            .await
            .unwrap_or_else(|error| panic!("disabled PageRank read failed: {error}"));
        assert!(scores.iter().all(|score| score.score.is_none()));
        let bridge_scores = runtime
            .database()
            .current_symbol_betweenness(
                &disabled.project_id,
                &disabled.generation_id,
                &[caller.clone(), target.clone()],
            )
            .await
            .unwrap_or_else(|error| panic!("disabled betweenness read failed: {error}"));
        assert!(bridge_scores.iter().all(|score| score.score.is_none()));
        assert!(
            runtime
                .database()
                .exact_current_references_by_name(ExactTextLookup::new(
                    &disabled.project_id,
                    &disabled.generation_id,
                    "target",
                    10,
                ))
                .await
                .unwrap_or_else(|error| panic!("disabled call-site read failed: {error}"))
                .is_empty()
        );
        assert!(
            runtime
                .database()
                .search_current_intent(SearchQuery::new(
                    disabled.project_id.clone(),
                    disabled.generation_id.clone(),
                    "sensitive implementation notes",
                    10,
                ))
                .await
                .unwrap_or_else(|error| panic!("disabled docstring search failed: {error}"))
                .is_empty()
        );
        let retriever = DeterministicRetriever::new(runtime.database().clone());
        let path = retriever
            .path(
                &GraphPathRequest::new(
                    disabled.project_id.clone(),
                    caller,
                    target,
                    TraversalBudget::new(2, 10)
                        .unwrap_or_else(|error| panic!("graph policy budget failed: {error}")),
                )
                .with_edge_kind(EdgeKind::Calls),
            )
            .await
            .unwrap_or_else(|error| panic!("disabled-policy traversal failed: {error}"));
        assert_eq!(path.path().map(|steps| steps.len()), Some(2));

        std::fs::write(
            &config,
            r#"{"enableCentrality":true,"enableBetweenness":true,"extractDocstrings":true,"trackCallSites":true,"enableChurn":false,"enableCoChange":false,"enableIssueHistory":false}"#,
        )
        .unwrap_or_else(|error| panic!("enabled graph policy failed: {error}"));
        let enabled = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("enabled graph policy index failed: {error}"));
        assert!(enabled.published);
        assert_ne!(enabled.generation_id, disabled.generation_id);
        let caller = exact_symbol_id(
            &runtime,
            &enabled.project_id,
            &enabled.generation_id,
            "caller",
        )
        .await;
        let target = exact_symbol_id(
            &runtime,
            &enabled.project_id,
            &enabled.generation_id,
            "target",
        )
        .await;
        assert!(
            runtime
                .database()
                .current_symbol_pagerank(
                    &enabled.project_id,
                    &enabled.generation_id,
                    &[caller, target],
                )
                .await
                .unwrap_or_else(|error| panic!("enabled PageRank read failed: {error}"))
                .iter()
                .all(|score| score.score.is_some())
        );
        assert!(
            !runtime
                .database()
                .exact_current_references_by_name(ExactTextLookup::new(
                    &enabled.project_id,
                    &enabled.generation_id,
                    "target",
                    10,
                ))
                .await
                .unwrap_or_else(|error| panic!("enabled call-site read failed: {error}"))
                .is_empty()
        );
        assert!(
            !runtime
                .database()
                .search_current_intent(SearchQuery::new(
                    enabled.project_id.clone(),
                    enabled.generation_id.clone(),
                    "sensitive implementation notes",
                    10,
                ))
                .await
                .unwrap_or_else(|error| panic!("enabled docstring search failed: {error}"))
                .is_empty()
        );
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn workspace_dependency_audit_combines_manifests_graph_scripts_and_dynamic_imports() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live dependency settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::create_dir_all(project.path().join("packages/app"))
        .unwrap_or_else(|error| panic!("workspace directory failed: {error}"));
    std::fs::create_dir_all(project.path().join("packages/forbidden"))
        .unwrap_or_else(|error| panic!("forbidden package directory failed: {error}"));
    std::fs::create_dir_all(project.path().join("generated"))
        .unwrap_or_else(|error| panic!("generated fixture directory failed: {error}"));
    std::fs::create_dir_all(project.path().join(".cartograph"))
        .unwrap_or_else(|error| panic!("Cartograph config directory failed: {error}"));
    std::fs::create_dir_all(project.path().join("node_modules/typescript"))
        .unwrap_or_else(|error| panic!("node_modules fixture failed: {error}"));
    std::fs::write(
        project.path().join("package.json"),
        r#"{
          "name": "fixture-root",
          "private": true,
          "workspaces": ["packages/*"],
          "dependencies": {"zod": "1", "unused-runtime": "1"},
          "devDependencies": {"typescript": "1", "@types/node": "1", "unused-dev": "1"},
          "optionalDependencies": {"optional-pkg": "1"},
          "peerDependencies": {"react": "1"},
          "scripts": {"build": "tsc --noEmit", "test": "bun test"}
        }"#,
    )
    .unwrap_or_else(|error| panic!("root manifest write failed: {error}"));
    std::fs::write(
        project.path().join("packages/app/package.json"),
        r#"{
          "name": "@fixture/app",
          "dependencies": {"left-pad": "1"}
        }"#,
    )
    .unwrap_or_else(|error| panic!("workspace manifest write failed: {error}"));
    std::fs::write(
        project.path().join(".cartograph/config.json"),
        r#"{
          "duplicateCodeAllowlist": ["generated/**"],
          "layers": [
            {
              "name": "app",
              "paths": ["packages/app/**"],
              "cannotImport": ["forbidden"]
            },
            {
              "name": "forbidden",
              "paths": ["packages/forbidden/**"]
            }
          ]
        }"#,
    )
    .unwrap_or_else(|error| panic!("layer config write failed: {error}"));
    std::fs::write(
        project.path().join("packages/forbidden/secret.ts"),
        "export const forbidden = 'internal';\n",
    )
    .unwrap_or_else(|error| panic!("forbidden source write failed: {error}"));
    std::fs::write(
        project.path().join("node_modules/typescript/package.json"),
        r#"{"name":"typescript","bin":{"tsc":"bin/tsc"}}"#,
    )
    .unwrap_or_else(|error| panic!("bin manifest write failed: {error}"));
    std::fs::write(
        project.path().join("packages/app/index.ts"),
        "import { z } from 'zod';\n\
         import leftPad from 'left-pad';\n\
         import { describe } from 'vitest';\n\
         import missing from 'undeclared-pkg';\n\
         import { forbidden } from '../forbidden/secret';\n\
         export async function run(input: string) {\n\
           const optional = await import('optional-pkg');\n\
           describe(input, () => undefined);\n\
           return [z.string().parse(input), leftPad(input, 2), missing, optional, forbidden];\n\
         }\n\
         export function risky(a: string, b: string, c: string, d: string, e: string) {\n\
           const first = eval(a);\n\
           const second = b + c;\n\
           const third = d + e;\n\
           return first + second + third;\n\
         }\n\
         /** Default retry count is 3. */\n\
         export const RETRY_COUNT = 5;\n\
         export function authenticate(apiKey: string, password: string) {\n\
           const endpoint = 'https://api.example.com/v1';\n\
           const weights = [3, 4, 5, 6, 8];\n\
           const signingKey = process.env.SECRET_KEY;\n\
           return sign(endpoint, signingKey, apiKey, password, weights);\n\
         }\n\
         export function firstClone(input: number) {\n\
           const offset = input + 2;\n\
           const doubled = offset * 3;\n\
           const bounded = Math.max(doubled, 1);\n\
           const normalized = bounded / 2;\n\
           if (normalized > 9) {\n\
             const adjusted = normalized - 4;\n\
             return adjusted * 2;\n\
           }\n\
           const fallback = normalized + 5;\n\
           return fallback * 3;\n\
         }\n\
         export function secondClone(value: number) {\n\
           const delta = value + 6;\n\
           const scaled = delta * 7;\n\
           const clamped = Math.max(scaled, 5);\n\
           const ratio = clamped / 4;\n\
           if (ratio > 21) {\n\
             const reduced = ratio - 8;\n\
             return reduced * 6;\n\
           }\n\
           const alternative = ratio + 11;\n\
           return alternative * 7;\n\
         }\n\
         function abandonedTask() { return 'do-not-send-secret'; }\n",
    )
    .unwrap_or_else(|error| panic!("dependency source write failed: {error}"));
    std::fs::write(
        project.path().join("partial.ts"),
        r#"export function partialAlpha(input: number, limit: number): number {
  log(input);
  const total = input + 1;
  if (total > limit) {
    save(total);
  }





  return total;
}
export function partialBeta(input: number, limit: number): number {
  const total = input + 1;
  if (total > limit) {
    save(total);
  }
  log(input);





  return total;
}
"#,
    )
    .unwrap_or_else(|error| panic!("partial clone source write failed: {error}"));
    let deliberate_copy = r#"export function deliberateCopy(value: number): number {
  const first = value + 1;
  const second = first * 2;
  const third = second - 3;
  const fourth = third / 4;
  return fourth + 5;
}
"#;
    std::fs::write(project.path().join("deliberate.ts"), deliberate_copy)
        .unwrap_or_else(|error| panic!("deliberate clone source write failed: {error}"));
    std::fs::write(project.path().join("generated/copy.ts"), deliberate_copy)
        .unwrap_or_else(|error| panic!("allowlisted clone source write failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("dependency runtime connect failed: {error}"));
        let indexed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("dependency fixture index failed: {error}"));
        let misleading_document_sql = format!(
            r#"INSERT INTO "{schema}"."search_documents" (
                    id, project_id, generation_id, document_id, file_id, symbol_id,
                    path, language, document_kind, qualified_name, code, natural_text, metadata
                ) OVERRIDING SYSTEM VALUE
                SELECT -1, symbols.project_id, symbols.generation_id,
                       '00000000-0000-4000-8000-000000000001'::uuid,
                       symbols.file_id, symbols.symbol_id, files.normalized_path,
                       files.language, 'file', 'misleading-file-document', '',
                       'non-symbol metadata must not override symbol health',
                       '{{"health":{{"dynamic_eval":0}},"duplicate_detection_enabled":false}}'::jsonb
                FROM "{schema}"."symbols" AS symbols
                JOIN "{schema}"."files" AS files
                  ON files.project_id = symbols.project_id
                 AND files.generation_id = symbols.generation_id
                 AND files.file_id = symbols.file_id
                WHERE symbols.project_id = CAST($1 AS uuid)
                  AND symbols.generation_id = CAST($2 AS uuid)
                  AND symbols.qualified_name = 'risky'"#,
        );
        let fixture_pool = cartograph_db::connect(&settings)
            .await
            .unwrap_or_else(|error| panic!("metadata fixture connection failed: {error}"));
        let inserted = query(AssertSqlSafe(misleading_document_sql))
            .bind(indexed.project_id.as_str())
            .bind(indexed.generation_id.as_str())
            .execute(&fixture_pool)
            .await
            .unwrap_or_else(|error| panic!("misleading metadata fixture failed: {error}"));
        assert_eq!(inserted.rows_affected(), 1);
        fixture_pool.close().await;
        let report = runtime
            .audit_javascript_dependencies(&indexed.project_id, ProjectCancellation::new())
            .await
            .unwrap_or_else(|error| panic!("dependency audit failed: {error}"));
        let report = serde_json::to_value(report)
            .unwrap_or_else(|error| panic!("dependency audit serialization failed: {error}"));
        assert_eq!(report["rootManifest"], "package.json");
        assert_eq!(
            report["workspaceManifests"].as_array().map(Vec::len),
            Some(2)
        );
        assert!(json_strings(&report["unusedRuntimeCandidates"]).contains(&"unused-runtime"));
        assert!(json_strings(&report["unusedDevelopmentCandidates"]).contains(&"unused-dev"));
        assert!(json_strings(&report["unusedPeerCandidates"]).contains(&"react"));
        assert!(!json_strings(&report["unusedOptionalCandidates"]).contains(&"optional-pkg"));
        let used = report["used"]
            .as_array()
            .unwrap_or_else(|| panic!("used dependency evidence was not an array"));
        for package in [
            "zod",
            "left-pad",
            "optional-pkg",
            "typescript",
            "@types/node",
        ] {
            assert!(
                used.iter().any(|entry| entry["package"] == package),
                "expected used package {package} in {used:?}"
            );
        }
        let undeclared = report["undeclared"]
            .as_array()
            .unwrap_or_else(|| panic!("undeclared dependency evidence was not an array"));
        assert!(
            undeclared
                .iter()
                .any(|entry| entry["package"] == "undeclared-pkg")
        );
        assert!(!undeclared.iter().any(|entry| entry["package"] == "vitest"));
        assert_eq!(report["evidenceComplete"], true);
        let layers = runtime
            .analyze_layers(&indexed.project_id, ProjectCancellation::new())
            .await
            .unwrap_or_else(|error| panic!("layer analysis failed: {error}"));
        let layers = serde_json::to_value(layers)
            .unwrap_or_else(|error| panic!("layer analysis serialization failed: {error}"));
        assert_eq!(layers["configured"], true);
        assert_eq!(layers["importsEvaluated"], 6);
        assert_eq!(
            layers["violations"].as_array().map(Vec::len),
            Some(1),
            "{layers}"
        );
        assert_eq!(layers["violations"][0]["finding"], "illegal_import");
        assert_eq!(layers["violations"][0]["detail"]["fromLayer"], "app");
        assert_eq!(layers["violations"][0]["detail"]["toLayer"], "forbidden");
        assert_eq!(
            layers["violations"][0]["detail"]["confidenceBasis"],
            "fresh_source_resolved_current_generation_import"
        );
        let file_surface = runtime
            .database()
            .current_file_surface(
                &indexed.project_id,
                &FileSurfaceQuery::new(10)
                    .map(|query| {
                        query.within_directory(
                            NormalizedPath::parse("packages/app").unwrap_or_else(|error| {
                                panic!("surface directory failed: {error}")
                            }),
                        )
                    })
                    .and_then(|query| query.with_path_regex(Some("^packages/app/.*\\.ts$")))
                    .unwrap_or_else(|error| panic!("file surface options failed: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("file surface query failed: {error}"));
        assert_eq!(file_surface.total_files(), 1);
        assert_eq!(file_surface.files()[0].path(), "packages/app/index.ts");
        assert!(file_surface.total_symbols() >= 1);
        let file_aggregates = runtime
            .database()
            .current_file_aggregates(
                &indexed.project_id,
                &FileSurfaceQuery::new(10)
                    .map(|query| {
                        query.within_directory(
                            NormalizedPath::parse("packages/app").unwrap_or_else(|error| {
                                panic!("aggregate directory failed: {error}")
                            }),
                        )
                    })
                    .and_then(|query| query.with_path_regex(Some("^packages/app/.*\\.ts$")))
                    .unwrap_or_else(|error| panic!("file aggregate options failed: {error}")),
                10,
            )
            .await
            .unwrap_or_else(|error| panic!("file aggregate query failed: {error}"));
        let file_aggregates = serde_json::to_value(file_aggregates)
            .unwrap_or_else(|error| panic!("file aggregate serialization failed: {error}"));
        assert!(file_aggregates["languages"].as_array().is_some_and(|rows| {
            rows.iter()
                .any(|row| row["language"] == "typescript" && row["files"] == 1)
        }));
        assert!(
            file_aggregates["directories"]
                .as_array()
                .is_some_and(|rows| {
                    rows.iter()
                        .any(|row| row["path"] == "packages/app" && row["files"] == 1)
                })
        );
        let file_dependencies = runtime
            .database()
            .current_file_dependencies(
                &indexed.project_id,
                &FileDependencyQuery::new(
                    NormalizedPath::parse("packages/app/index.ts")
                        .unwrap_or_else(|error| panic!("dependency path failed: {error}")),
                    10,
                )
                .map(|query| query.with_direction(FileDependencyDirection::Dependencies))
                .unwrap_or_else(|error| panic!("file dependency options failed: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("file dependency query failed: {error}"));
        let file_dependencies = serde_json::to_value(file_dependencies)
            .unwrap_or_else(|error| panic!("file dependency serialization failed: {error}"));
        assert!(
            file_dependencies["rows"]
                .as_array()
                .is_some_and(|rows| rows.iter().any(|row| {
                    row["path"] == "packages/forbidden/secret.ts"
                        && row["direction"] == "dependencies"
                }))
        );
        let dead_candidates = runtime
            .database()
            .query_current_dead_code(
                &indexed.project_id,
                &DeadCodeQuery::new(10)
                    .unwrap_or_else(|error| panic!("dead-code options failed: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("dead-code candidate query failed: {error}"));
        let abandoned = dead_candidates
            .iter()
            .find(|candidate| candidate.qualified_name().ends_with("abandonedTask"))
            .cloned()
            .unwrap_or_else(|| panic!("private orphan was not selected: {dead_candidates:?}"));
        assert!(!abandoned.safe_code().contains("do-not-send-secret"));
        let (chat_endpoint, chat_server) = dead_code_chat_fixture_server();
        let chat = OpenAiChatClient::new(
            ChatSettings::new(&chat_endpoint, "fixture-judge", None)
                .unwrap_or_else(|error| panic!("chat settings failed: {error}")),
        )
        .unwrap_or_else(|error| panic!("chat client failed: {error}"));
        let judged = judge_dead_code_candidates(
            &chat,
            vec![abandoned],
            DeadCodeJudgeOptions::new(1)
                .unwrap_or_else(|error| panic!("judge options failed: {error}")),
            ProjectCancellation::new(),
        )
        .await
        .unwrap_or_else(|error| panic!("dead-code judge failed: {error}"));
        assert_eq!(judged.results().len(), 1);
        assert_eq!(judged.results()[0].verdict(), DeadCodeVerdict::Dead);
        assert_eq!(judged.results()[0].confidence(), 0.8);
        chat_server
            .join()
            .unwrap_or_else(|_| panic!("chat fixture server panicked"));
        let findings = runtime
            .database()
            .current_structural_findings(&indexed.project_id, 100)
            .await
            .unwrap_or_else(|error| panic!("expanded biomarker query failed: {error}"));
        let findings = serde_json::to_value(findings)
            .unwrap_or_else(|error| panic!("biomarker serialization failed: {error}"));
        let findings = findings
            .as_array()
            .unwrap_or_else(|| panic!("biomarker result was not an array"));
        for expected in ["long_parameter_list", "dynamic_eval"] {
            assert!(
                findings.iter().any(|finding| {
                    finding["qualifiedName"] == "risky" && finding["finding"] == expected
                }),
                "missing {expected} finding in {findings:?}"
            );
        }
        for expected in ["magic_number", "hardcoded_url", "secrets_handling"] {
            assert!(
                findings.iter().any(|finding| {
                    finding["qualifiedName"] == "authenticate" && finding["finding"] == expected
                }),
                "missing {expected} finding in {findings:?}"
            );
        }
        assert!(findings.iter().any(|finding| {
            finding["qualifiedName"] == "RETRY_COUNT" && finding["finding"] == "stale_doc"
        }));
        for clone in ["firstClone", "secondClone"] {
            assert!(findings.iter().any(|finding| {
                finding["qualifiedName"] == clone
                    && finding["finding"] == "duplicate_code"
                    && finding["metricName"] == "normalized_shape_copies"
            }));
        }
        for clone in ["partialAlpha", "partialBeta"] {
            assert!(findings.iter().any(|finding| {
                finding["qualifiedName"] == clone
                    && finding["finding"] == "duplicate_code"
                    && finding["metricName"] == "partial_clone_peers"
            }));
        }
        let partial_detail = findings
            .iter()
            .find(|finding| {
                finding["qualifiedName"] == "partialAlpha" && finding["finding"] == "duplicate_code"
            })
            .unwrap_or_else(|| panic!("partial clone detail was missing"));
        assert_eq!(partial_detail["detail"]["cloneType"], "partial");
        assert_eq!(partial_detail["detail"]["classSize"], 2);
        assert_eq!(
            partial_detail["detail"]["members"].as_array().map(Vec::len),
            Some(1)
        );
        assert!(
            partial_detail["detail"]["maximumOverlap"]
                .as_f64()
                .is_some_and(|overlap| (0.95..=1.0).contains(&overlap))
        );
        assert!(!findings.iter().any(|finding| {
            finding["qualifiedName"] == "deliberateCopy" && finding["finding"] == "duplicate_code"
        }));
        let filtered_query = StructuralFindingQuery::new(10)
            .and_then(|query| query.with_finding(Some("dynamic_eval")))
            .map(|query| query.with_minimum_severity(StructuralFindingSeverity::Warning))
            .and_then(|query| query.with_metric_bounds(Some(1.0), Some(1.0)))
            .and_then(|query| query.with_minimum_centrality(Some(0.0)))
            .and_then(|query| query.with_excluded_path_prefix(Some("packages/legacy/")))
            .unwrap_or_else(|error| panic!("filtered biomarker options failed: {error}"));
        let filtered = runtime
            .database()
            .query_current_structural_findings(&indexed.project_id, &filtered_query)
            .await
            .unwrap_or_else(|error| panic!("filtered biomarker query failed: {error}"));
        assert_eq!(filtered.len(), 1);
        assert!((0.0..=1.0).contains(&filtered[0].degree_centrality()));
        assert_eq!(
            runtime
                .database()
                .count_current_structural_findings(&indexed.project_id, &filtered_query)
                .await
                .unwrap_or_else(|error| panic!("filtered biomarker count failed: {error}")),
            1
        );
        let grouped_query = StructuralFindingGroupQuery::new(
            vec!["dynamic_eval".to_owned(), "magic_number".to_owned()],
            1,
        )
        .map(|query| query.with_minimum_severity(StructuralFindingSeverity::Info))
        .map(|query| query.with_exclude_fixtures(true))
        .unwrap_or_else(|error| panic!("grouped biomarker options failed: {error}"));
        let grouped = runtime
            .database()
            .query_current_structural_findings_per_detector(&indexed.project_id, &grouped_query)
            .await
            .unwrap_or_else(|error| panic!("grouped biomarker query failed: {error}"));
        assert_eq!(grouped.counts().get("dynamic_eval"), Some(&1));
        assert!(
            grouped
                .counts()
                .get("magic_number")
                .is_some_and(|count| *count >= 1)
        );
        assert_eq!(grouped.into_findings().len(), 2);
        let stats = runtime
            .database()
            .current_structural_finding_stats(&indexed.project_id)
            .await
            .unwrap_or_else(|error| panic!("expanded biomarker stats failed: {error}"));
        let stats = serde_json::to_value(stats)
            .unwrap_or_else(|error| panic!("biomarker stats serialization failed: {error}"));
        assert!(stats["totalFindings"].as_u64().unwrap_or_default() >= 2);
        assert_eq!(stats["byFinding"]["dynamic_eval"], 1);
        runtime.database().clone()
    }
    .await;
    drop(result);
    drop_schema(&settings, &schema).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn git_history_refresh_persists_churn_and_symmetric_cochange_confidence() {
    const ANCHOR_PATH: &str = ".github/workflows/check.ts";
    const PARTNER_PATH: &str = "ACKNOWLEDGEMENTS.ts";
    const THIRD_PATH: &str = "src/c.ts";

    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live history settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::create_dir_all(project.path().join("src"))
        .unwrap_or_else(|error| panic!("history source directory failed: {error}"));
    std::fs::create_dir_all(project.path().join(".github/workflows"))
        .unwrap_or_else(|error| panic!("history workflow directory failed: {error}"));
    git(project.path(), &["init", "--initial-branch=main"]);
    git(
        project.path(),
        &["config", "user.email", "history@example.invalid"],
    );
    git(project.path(), &["config", "user.name", "History Fixture"]);
    std::fs::write(
        project.path().join(ANCHOR_PATH),
        "export function workflowCheck() { return 1; }\n",
    )
    .unwrap_or_else(|error| panic!("history a write failed: {error}"));
    std::fs::write(
        project.path().join(PARTNER_PATH),
        "export function acknowledgements() { return 1; }\n",
    )
    .unwrap_or_else(|error| panic!("history b write failed: {error}"));
    git(project.path(), &["add", ANCHOR_PATH, PARTNER_PATH]);
    git(project.path(), &["commit", "-m", "add a and b"]);
    std::fs::write(
        project.path().join(ANCHOR_PATH),
        "export function workflowCheck() { return 2; }\n",
    )
    .unwrap_or_else(|error| panic!("history a update failed: {error}"));
    std::fs::write(
        project.path().join(PARTNER_PATH),
        "export function acknowledgements() { return 2; }\n",
    )
    .unwrap_or_else(|error| panic!("history b update failed: {error}"));
    git(project.path(), &["add", ANCHOR_PATH, PARTNER_PATH]);
    git(project.path(), &["commit", "-m", "change a and b"]);
    std::fs::write(
        project.path().join(ANCHOR_PATH),
        "export function workflowCheck() { return 3; }\n",
    )
    .unwrap_or_else(|error| panic!("history a second update failed: {error}"));
    std::fs::write(
        project.path().join(THIRD_PATH),
        "export function c() { return 1; }\n",
    )
    .unwrap_or_else(|error| panic!("history c write failed: {error}"));
    git(project.path(), &["add", ANCHOR_PATH, THIRD_PATH]);
    git(project.path(), &["commit", "-m", "change a and add c"]);

    let database = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("history runtime connect failed: {error}"));
        let indexed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("history fixture index failed: {error}"));
        let indexed_json = serde_json::to_value(&indexed)
            .unwrap_or_else(|error| panic!("index history serialization failed: {error}"));
        assert_eq!(indexed_json["history"]["state"], "indexed");
        assert_eq!(indexed_json["history"]["report"]["commitsScanned"], 3);
        let options = HistoryIndexOptions::default()
            .with_max_commits(100)
            .unwrap_or_else(|error| panic!("history options failed: {error}"));
        let report = runtime
            .refresh_git_history(
                indexed.project_id.clone(),
                options,
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("history refresh failed: {error}"));
        let report = serde_json::to_value(report)
            .unwrap_or_else(|error| panic!("history report serialization failed: {error}"));
        assert_eq!(report["commitsScanned"], 3);
        assert_eq!(report["filesWritten"], 3);
        assert_eq!(report["cochangesWritten"], 2);
        assert_eq!(report["shallowHistory"], false);
        assert_eq!(report["truncated"], false);
        let a = cartograph_domain::NormalizedPath::parse(ANCHOR_PATH)
            .unwrap_or_else(|error| panic!("history anchor path failed: {error}"));
        let history = runtime
            .database()
            .current_file_history(&indexed.project_id, Some(&a), 0, 10)
            .await
            .unwrap_or_else(|error| panic!("history rows failed: {error}"));
        let history = serde_json::to_value(history)
            .unwrap_or_else(|error| panic!("history rows serialization failed: {error}"));
        assert_eq!(history[0]["commitCount"], 3);
        assert_eq!(history[0]["authorCount"], 1);
        let partners = runtime
            .database()
            .current_file_cochanges(&indexed.project_id, &a, 2, 10)
            .await
            .unwrap_or_else(|error| panic!("cochange rows failed: {error}"));
        let partners = serde_json::to_value(partners)
            .unwrap_or_else(|error| panic!("cochange serialization failed: {error}"));
        assert_eq!(partners.as_array().map(Vec::len), Some(1));
        assert_eq!(partners[0]["path"], PARTNER_PATH);
        assert_eq!(partners[0]["sharedCommits"], 2);
        assert_eq!(partners[0]["anchorCommits"], 3);
        assert_eq!(partners[0]["partnerCommits"], 2);
        assert!((partners[0]["jaccard"].as_f64().unwrap_or_default() - (2.0 / 3.0)).abs() < 0.001);
        let hotspots = runtime
            .database()
            .current_structural_hotspots(&indexed.project_id, 10)
            .await
            .unwrap_or_else(|error| panic!("history-composed hotspots failed: {error}"));
        let hotspots = serde_json::to_value(hotspots)
            .unwrap_or_else(|error| panic!("hotspot serialization failed: {error}"));
        let hotspot_a = hotspots
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["path"] == ANCHOR_PATH)
            .unwrap_or_else(|| panic!("history-composed hotspot for a was missing"));
        assert_eq!(hotspot_a["historyAvailable"], true);
        assert_eq!(hotspot_a["commitCount"], 3);
        assert!(hotspot_a["compositeRisk"].as_u64().unwrap_or_default() > 0);
        assert!(hotspot_a["centrality"].as_f64().is_some());
        assert!(hotspot_a["churnScore"].as_f64().is_some());
        let maintenance = runtime
            .database()
            .query_structural_hotspots(
                &indexed.project_id,
                StructuralHotspotQuery::new(10)
                    .and_then(|query| query.with_minimum_commits(2))
                    .unwrap_or_else(|error| panic!("maintenance hotspot query failed: {error}"))
                    .with_category(StructuralHotspotCategory::Maintenance)
                    .with_sort(StructuralHotspotSort::Churn),
            )
            .await
            .unwrap_or_else(|error| panic!("maintenance hotspots failed: {error}"));
        assert_eq!(maintenance.len(), 2);
        assert_eq!(maintenance[0].path(), ANCHOR_PATH);
        assert!(maintenance.iter().all(|row| row.commit_count() >= 2));
        let grouped_peers = runtime
            .database()
            .current_grouped_path_symbols(
                &indexed.project_id,
                GroupedSymbolQuery::new(
                    vec![
                        GroupedPathInput::new(
                            "commit-wide",
                            [ANCHOR_PATH, PARTNER_PATH, THIRD_PATH]
                                .into_iter()
                                .map(|path| {
                                    NormalizedPath::parse(path).unwrap_or_else(|error| {
                                        panic!("grouped path failed: {error}")
                                    })
                                })
                                .collect(),
                        )
                        .unwrap_or_else(|error| panic!("wide peer group failed: {error}")),
                        GroupedPathInput::new(
                            "commit-small",
                            vec![NormalizedPath::parse(PARTNER_PATH).unwrap_or_else(|error| {
                                panic!("small grouped path failed: {error}")
                            })],
                        )
                        .unwrap_or_else(|error| panic!("small peer group failed: {error}")),
                    ],
                    1,
                )
                .unwrap_or_else(|error| panic!("grouped peer query failed: {error}")),
            )
            .await
            .unwrap_or_else(|error| panic!("grouped peer lookup failed: {error}"));
        let grouped_peers = serde_json::to_value(grouped_peers)
            .unwrap_or_else(|error| panic!("grouped peer serialization failed: {error}"));
        assert_eq!(grouped_peers[0]["key"], "commit-wide");
        assert_eq!(grouped_peers[0]["total"], 3);
        assert_eq!(grouped_peers[0]["peers"].as_array().map(Vec::len), Some(1));
        assert_eq!(grouped_peers[0]["truncated"], true);
        assert_eq!(grouped_peers[1]["key"], "commit-small");
        assert_eq!(grouped_peers[1]["total"], 1);
        assert_eq!(grouped_peers[1]["truncated"], false);
        std::fs::create_dir_all(project.path().join(".cartograph"))
            .unwrap_or_else(|error| panic!("history config directory failed: {error}"));
        std::fs::write(
            project.path().join(".cartograph/config.json"),
            r#"{"enableChurn":false,"enableCoChange":false,"enableIssueHistory":false}"#,
        )
        .unwrap_or_else(|error| panic!("history disable config failed: {error}"));
        let disabled = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("history disable index failed: {error}"));
        assert!(!disabled.published);
        let disabled_json = serde_json::to_value(&disabled)
            .unwrap_or_else(|error| panic!("history disable report failed: {error}"));
        assert_eq!(
            disabled_json["history"]["reason"],
            "disabled_by_project_config"
        );
        assert!(
            runtime
                .database()
                .current_file_history(&indexed.project_id, None, 0, 10)
                .await
                .unwrap_or_else(|error| panic!("disabled history query failed: {error}"))
                .is_empty()
        );
        assert!(
            runtime
                .database()
                .current_file_cochanges(&indexed.project_id, &a, 1, 10)
                .await
                .unwrap_or_else(|error| panic!("disabled cochange query failed: {error}"))
                .is_empty()
        );
        runtime.database().clone()
    }
    .await;
    drop(database);
    drop_schema(&settings, &schema).await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn issue_history_is_structural_generation_fenced_coupled_and_disableable() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live issue-history settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::create_dir_all(project.path().join("src"))
        .unwrap_or_else(|error| panic!("issue-history source directory failed: {error}"));
    git(project.path(), &["init", "--initial-branch=main"]);
    git(
        project.path(),
        &["config", "user.email", "issues@example.invalid"],
    );
    git(project.path(), &["config", "user.name", "Issue Fixture"]);
    write_issue_functions(project.path(), 1, 1);
    git(project.path(), &["add", "src/a.ts", "src/b.ts"]);
    git(project.path(), &["commit", "-m", "initial symbols"]);
    write_issue_functions(project.path(), 2, 2);
    git(project.path(), &["add", "src/a.ts", "src/b.ts"]);
    git(
        project.path(),
        &["commit", "-m", "change pair\n\nFixes #12, closes #13"],
    );
    write_issue_functions(project.path(), 3, 3);
    git(project.path(), &["add", "src/a.ts", "src/b.ts"]);
    git(
        project.path(),
        &["commit", "-m", "change pair again\n\nResolves #14"],
    );
    std::fs::write(
        project.path().join("src/new.ts"),
        "export function brandNew(): number { return 15; }\n",
    )
    .unwrap_or_else(|error| panic!("new issue symbol write failed: {error}"));
    git(project.path(), &["add", "src/new.ts"]);
    git(project.path(), &["commit", "-m", "add symbol\n\nFixes #15"]);

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("issue-history runtime connect failed: {error}"));
        let indexed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("issue-history index failed: {error}"));
        let indexed_json = serde_json::to_value(&indexed)
            .unwrap_or_else(|error| panic!("issue-history report serialization failed: {error}"));
        assert_eq!(
            indexed_json["issue_history"]["state"], "indexed",
            "{indexed_json}"
        );
        assert_eq!(indexed_json["issue_history"]["report"]["taggedCommits"], 3);
        assert_eq!(
            indexed_json["issue_history"]["report"]["oversizedCommitsSkipped"],
            0
        );
        assert_eq!(
            indexed_json["issue_history"]["report"]["comparisonFailuresSkipped"],
            0
        );

        let alpha = exact_symbol_id(
            &runtime,
            &indexed.project_id,
            &indexed.generation_id,
            "alpha",
        )
        .await;
        let beta = exact_symbol_id(
            &runtime,
            &indexed.project_id,
            &indexed.generation_id,
            "beta",
        )
        .await;
        let brand_new = exact_symbol_id(
            &runtime,
            &indexed.project_id,
            &indexed.generation_id,
            "brandNew",
        )
        .await;
        let alpha_issues = runtime
            .database()
            .current_symbol_issues(&indexed.project_id, &alpha, 50)
            .await
            .unwrap_or_else(|error| panic!("alpha issue read failed: {error}"));
        assert_eq!(
            alpha_issues
                .iter()
                .map(|issue| issue.issue_number)
                .collect::<std::collections::BTreeSet<_>>(),
            [12, 13, 14].into_iter().collect()
        );
        assert!(
            alpha_issues
                .iter()
                .all(|issue| issue.kind == IssueAttributionKind::Modified)
        );
        let added = runtime
            .database()
            .current_symbol_issues(&indexed.project_id, &brand_new, 50)
            .await
            .unwrap_or_else(|error| panic!("added issue read failed: {error}"));
        assert!(added.iter().any(|issue| {
            issue.issue_number == 15 && issue.kind == IssueAttributionKind::Added
        }));
        let peers = runtime
            .database()
            .current_symbol_issue_peers(&indexed.project_id, &alpha, 2, 10)
            .await
            .unwrap_or_else(|error| panic!("issue peer read failed: {error}"));
        assert_eq!(peers.len(), 1);
        assert_eq!(peers[0].symbol_id, beta);
        assert_eq!(peers[0].co_occurrences, 2);
        assert_eq!(peers[0].shared_commits.len(), 2);
        let commit_groups = runtime
            .database()
            .current_issue_commit_symbol_peers(
                &indexed.project_id,
                &alpha,
                &peers[0].shared_commits,
                10,
            )
            .await
            .unwrap_or_else(|error| panic!("issue commit peer read failed: {error}"));
        assert_eq!(commit_groups.len(), 2);
        assert!(commit_groups.iter().all(|group| {
            group.total == 1
                && !group.truncated
                && group.peers.iter().any(|peer| peer.symbol_id == beta)
        }));

        std::fs::remove_file(project.path().join("src/new.ts"))
            .unwrap_or_else(|error| panic!("removed symbol fixture failed: {error}"));
        std::fs::write(
            project.path().join("src/a.ts"),
            "export function alpha(): number { return 4; }\n",
        )
        .unwrap_or_else(|error| panic!("generation-fence alpha write failed: {error}"));
        git(project.path(), &["add", "-A"]);
        git(
            project.path(),
            &["commit", "-m", "remove and change\n\nFixes #16"],
        );
        let refreshed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("issue-history reindex failed: {error}"));
        assert_ne!(refreshed.generation_id, indexed.generation_id);
        let current_alpha_issues = runtime
            .database()
            .current_symbol_issues(&refreshed.project_id, &alpha, 50)
            .await
            .unwrap_or_else(|error| panic!("refreshed alpha issue read failed: {error}"));
        assert!(
            current_alpha_issues
                .iter()
                .any(|issue| issue.issue_number == 16)
        );
        assert!(
            runtime
                .database()
                .current_symbol_issues(&refreshed.project_id, &brand_new, 50)
                .await
                .unwrap_or_else(|error| panic!("removed symbol issue read failed: {error}"))
                .is_empty()
        );

        std::fs::create_dir_all(project.path().join(".cartograph"))
            .unwrap_or_else(|error| panic!("disabled issue config directory failed: {error}"));
        std::fs::write(
            project.path().join(".cartograph/config.json"),
            r#"{"enableIssueHistory":false}"#,
        )
        .unwrap_or_else(|error| panic!("disabled issue config write failed: {error}"));
        let disabled = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("disabled issue-history index failed: {error}"));
        let disabled_json = serde_json::to_value(disabled)
            .unwrap_or_else(|error| panic!("disabled issue report serialization failed: {error}"));
        assert_eq!(disabled_json["issue_history"]["state"], "unavailable");
        assert_eq!(
            disabled_json["issue_history"]["reason"],
            "disabled_by_project_config"
        );
        assert_eq!(
            runtime
                .database()
                .current_issue_history_attribution_count(&refreshed.project_id)
                .await
                .unwrap_or_else(|error| panic!("disabled issue count failed: {error}")),
            0
        );
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

fn write_issue_functions(root: &Path, alpha: u32, beta: u32) {
    std::fs::write(
        root.join("src/a.ts"),
        format!("export function alpha(): number {{ return {alpha}; }}\n"),
    )
    .unwrap_or_else(|error| panic!("alpha issue fixture failed: {error}"));
    std::fs::write(
        root.join("src/b.ts"),
        format!("export function beta(): number {{ return {beta}; }}\n"),
    )
    .unwrap_or_else(|error| panic!("beta issue fixture failed: {error}"));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn import_audit_classifies_and_filters_complete_fresh_evidence() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live import settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    for directory in ["src/dir", "src/fixtures"] {
        std::fs::create_dir_all(project.path().join(directory))
            .unwrap_or_else(|error| panic!("import fixture directory failed: {error}"));
    }
    std::fs::write(
        project.path().join("tsconfig.json"),
        r#"{
          "compilerOptions": {
            "baseUrl": ".",
            "paths": {"@/*": ["src/*"]}
          }
        }"#,
    )
    .unwrap_or_else(|error| panic!("tsconfig fixture failed: {error}"));
    for path in [
        "src/direct.ts",
        "src/dir/index.ts",
        "src/alias.ts",
        "src/lazy.ts",
    ] {
        std::fs::write(project.path().join(path), "export default 1;\n")
            .unwrap_or_else(|error| panic!("import target fixture failed: {error}"));
    }
    std::fs::write(
        project.path().join("src/main.ts"),
        "import direct from './direct';\n\
         import directory from './dir';\n\
         import alias from '@/alias';\n\
         import React from 'react';\n\
         export async function load() {\n\
           const lazy = await import ('./lazy');\n\
           const missing = require('./missing');\n\
           return [direct, directory, alias, React, lazy, missing];\n\
         }\n\
         export const generated = `import embedded from './literal-only';`;\n",
    )
    .unwrap_or_else(|error| panic!("import source fixture failed: {error}"));
    std::fs::write(
        project.path().join("src/fixtures/example.ts"),
        "import missing from './fixture-missing';\nexport { missing };\n",
    )
    .unwrap_or_else(|error| panic!("fixture import source failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("import runtime connect failed: {error}"));
        let indexed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("import fixture index failed: {error}"));
        let report = runtime
            .audit_imports(
                indexed.project_id.clone(),
                ImportAuditOptions::default().with_source(ImportAuditSource::All),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("import audit failed: {error}"));
        let report = serde_json::to_value(report)
            .unwrap_or_else(|error| panic!("import audit serialization failed: {error}"));
        assert_eq!(report["fixtureHitsExcluded"], 1);
        assert_eq!(report["total"], 8, "unexpected import report: {report:?}");
        assert_eq!(report["matched"], 7, "unexpected import report: {report:?}");
        let hits = report["hits"]
            .as_array()
            .unwrap_or_else(|| panic!("import hits were not an array"));
        for (specifier, target) in [
            ("./direct", "file"),
            ("./dir", "directory"),
            ("@/alias", "file"),
            ("react", "bare"),
            ("./missing", "unresolvable"),
            ("./literal-only", "literal"),
        ] {
            assert!(
                hits.iter()
                    .any(|hit| { hit["specifier"] == specifier && hit["target"] == target }),
                "missing {specifier} => {target} in {hits:?}"
            );
        }
        assert!(
            hits.iter()
                .any(|hit| { hit["specifier"] == "./lazy" && hit["dynamic"] == true })
        );
        assert!(hits.iter().any(|hit| {
            hit["specifier"] == "./literal-only"
                && hit["origin"] == "literal"
                && hit["language"] == "typescript"
        }));

        let filtered_options = ImportAuditOptions::new(10)
            .unwrap_or_else(|error| panic!("import options failed: {error}"))
            .with_source(ImportAuditSource::Static)
            .with_target(Some(ImportAuditTarget::File))
            .with_extension_missing(Some(true))
            .with_dynamic(Some(false))
            .with_path_filter(Some("src/"))
            .and_then(|options| options.with_language(Some("TypeScript")))
            .unwrap_or_else(|error| panic!("import filters failed: {error}"));
        let filtered = runtime
            .audit_imports(
                indexed.project_id.clone(),
                filtered_options,
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("filtered import audit failed: {error}"));
        let filtered = serde_json::to_value(filtered)
            .unwrap_or_else(|error| panic!("filtered import serialization failed: {error}"));
        assert_eq!(filtered["matched"], 1);
        assert_eq!(filtered["truncated"], false);

        std::fs::write(project.path().join("src/direct.ts"), "export default 2;\n")
            .unwrap_or_else(|error| panic!("stale import fixture failed: {error}"));
        let stale = runtime
            .audit_imports(
                indexed.project_id,
                ImportAuditOptions::default(),
                ProjectCancellation::new(),
            )
            .await;
        assert_eq!(stale, Err(ImportAuditError::SourceChanged));
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn rename_plan_combines_exact_references_and_attributed_textual_mentions() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live rename settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let source = project.path().join("service.ts");
    std::fs::write(
        &source,
        "export function parseToken(value: string): boolean { return value.length > 0; }\n\
         export function caller(value: string): boolean { return parseToken(value); }\n\
         export function documentation(): string {\n\
           // parseToken is part of the public authentication example.\n\
           return 'Call parseToken before authorizing a request';\n\
         }\n\
         export const parseTokenValue = 1;\n",
    )
    .unwrap_or_else(|error| panic!("rename fixture write failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("rename runtime connect failed: {error}"));
        let indexed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("rename fixture index failed: {error}"));
        let symbol_id = exact_symbol_id(
            &runtime,
            &indexed.project_id,
            &indexed.generation_id,
            "parseToken",
        )
        .await;
        let mut definitions = runtime
            .database()
            .current_symbols_by_ids(cartograph_db::CurrentSymbolSetLookup::new(
                &indexed.project_id,
                &indexed.generation_id,
                std::slice::from_ref(&symbol_id),
            ))
            .await
            .unwrap_or_else(|error| panic!("rename definition lookup failed: {error}"));
        let definition = definitions
            .pop()
            .unwrap_or_else(|| panic!("rename definition was missing"));
        let plan = runtime
            .plan_rename(
                indexed.project_id.clone(),
                definition,
                RenamePlanOptions::new(500, 30)
                    .unwrap_or_else(|error| panic!("rename options failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("rename plan failed: {error}"));
        let plan = serde_json::to_value(plan)
            .unwrap_or_else(|error| panic!("rename plan serialization failed: {error}"));
        assert_eq!(plan["definition"]["qualified_name"], "parseToken");
        assert!(plan["exactReferenceCount"].as_u64().unwrap_or_default() >= 1);
        assert!(
            plan["exactReferences"]
                .as_array()
                .is_some_and(|references| {
                    references.iter().any(|reference| {
                        reference["path"] == "service.ts"
                            && reference["line"] == 2
                            && reference["representedSite"] == "parseToken"
                    })
                })
        );
        assert_eq!(plan["textualMentionCount"], 2);
        let mentions = plan["textualMentions"]
            .as_array()
            .unwrap_or_else(|| panic!("textual mentions were not an array"));
        assert!(mentions.iter().all(|mention| {
            mention["enclosingQualifiedName"] == "documentation"
                && mention["confidence"] == "textual_review_required"
        }));
        assert!(!mentions.iter().any(|mention| {
            mention["text"]
                .as_str()
                .is_some_and(|text| text.contains("parseTokenValue"))
        }));
        assert_eq!(plan["editsApplied"], false);

        std::fs::write(
            &source,
            "export function parseToken(): boolean { return false; }\n",
        )
        .unwrap_or_else(|error| panic!("stale rename fixture failed: {error}"));
        let stale_definition = runtime
            .database()
            .current_symbols_by_ids(cartograph_db::CurrentSymbolSetLookup::new(
                &indexed.project_id,
                &indexed.generation_id,
                std::slice::from_ref(&symbol_id),
            ))
            .await
            .unwrap_or_else(|error| panic!("stale definition lookup failed: {error}"))
            .pop()
            .unwrap_or_else(|| panic!("stale definition was missing"));
        let stale = runtime
            .plan_rename(
                indexed.project_id,
                stale_definition,
                RenamePlanOptions::new(500, 30)
                    .unwrap_or_else(|error| panic!("stale rename options failed: {error}")),
                ProjectCancellation::new(),
            )
            .await;
        assert_eq!(stale, Err(RenamePlanError::SourceChanged));
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn changed_file_test_impact_traverses_named_imports_and_reports_barrels() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live test-impact settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    let source = project.path().join("src");
    std::fs::create_dir(&source)
        .unwrap_or_else(|error| panic!("test-impact source directory failed: {error}"));
    std::fs::write(
        source.join("leaf.ts"),
        "export function leaf(): number { return 1; }\n",
    )
    .unwrap_or_else(|error| panic!("test-impact leaf fixture failed: {error}"));
    std::fs::write(
        source.join("index.ts"),
        "export { leaf } from './leaf.js';\n",
    )
    .unwrap_or_else(|error| panic!("test-impact barrel fixture failed: {error}"));
    std::fs::write(
        source.join("leaf.test.ts"),
        "import { describe, it } from 'vitest';\n\
         import { leaf } from './index.js';\n\
         describe('leaf API', () => {\n\
           it('returns the leaf value', () => { leaf(); });\n\
         });\n",
    )
    .unwrap_or_else(|error| panic!("test-impact test fixture failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("test-impact runtime connect failed: {error}"));
        let indexed = runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("test-impact fixture index failed: {error}"));
        let title_hits = runtime
            .database()
            .search_current_code(SearchQuery::new(
                indexed.project_id.clone(),
                indexed.generation_id.clone(),
                "returns leaf value",
                10,
            ))
            .await
            .unwrap_or_else(|error| panic!("test-title BM25 query failed: {error}"));
        assert!(title_hits.iter().any(|hit| {
            hit.path() == "src/leaf.test.ts"
                && hit.document_kind() == "test"
                && hit
                    .components()
                    .contains(&cartograph_db::SearchComponent::NaturalText)
        }));
        let leaf = NormalizedPath::parse("src/leaf.ts")
            .unwrap_or_else(|error| panic!("test-impact path failed: {error}"));
        let missing = NormalizedPath::parse("src/missing.ts")
            .unwrap_or_else(|error| panic!("missing path fixture failed: {error}"));
        let impact = runtime
            .database()
            .current_file_test_impact(&indexed.project_id, &[leaf.clone(), missing], 5, 40, None)
            .await
            .unwrap_or_else(|error| panic!("test-impact query failed: {error}"))
            .unwrap_or_else(|| panic!("test-impact generation was missing"));
        assert_eq!(impact.generation_id(), &indexed.generation_id);
        assert_eq!(impact.matched_inputs(), ["src/leaf.ts"]);
        assert!(impact.dependent_file_count() >= 2);
        assert_eq!(impact.affected_test_file_count(), 1);
        assert_eq!(impact.tests().len(), 1);
        assert_eq!(impact.tests()[0].path(), "src/leaf.test.ts");
        assert!(impact.tests()[0].distance() >= 1);
        assert_eq!(impact.reached_barrel_count(), 1);
        assert_eq!(impact.reached_barrels(), ["src/index.ts"]);
        let names = runtime
            .test_evidence(
                indexed.project_id.clone(),
                indexed.generation_id.clone(),
                vec![
                    NormalizedPath::parse("src/leaf.test.ts")
                        .unwrap_or_else(|error| panic!("test evidence path failed: {error}")),
                ],
                TestEvidenceOptions::new(20)
                    .unwrap_or_else(|error| panic!("test evidence options failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("test evidence query failed: {error}"));
        let names = serde_json::to_value(names)
            .unwrap_or_else(|error| panic!("test evidence serialization failed: {error}"));
        let cases = names["files"][0]["cases"]
            .as_array()
            .unwrap_or_else(|| panic!("test cases were not an array"));
        assert!(cases.iter().any(|case| case["name"] == "leaf API"));
        assert!(
            cases
                .iter()
                .any(|case| case["name"] == "returns the leaf value")
        );

        let filtered = runtime
            .database()
            .current_file_test_impact(&indexed.project_id, &[leaf], 5, 40, Some(".*\\.spec\\.ts"))
            .await
            .unwrap_or_else(|error| panic!("filtered test-impact query failed: {error}"))
            .unwrap_or_else(|| panic!("filtered test-impact generation was missing"));
        assert_eq!(filtered.affected_test_file_count(), 0);
        assert!(filtered.tests().is_empty());
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn file_drift_distinguishes_content_hash_from_mtime_threshold_semantics() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live file-drift settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::write(project.path().join("a.ts"), "export const a = 1;\n")
        .unwrap_or_else(|error| panic!("file-drift a fixture failed: {error}"));
    std::fs::write(project.path().join("b.ts"), "export const b = 2;\n")
        .unwrap_or_else(|error| panic!("file-drift b fixture failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("file-drift runtime connect failed: {error}"));
        runtime
            .index(IndexOptions::default())
            .await
            .unwrap_or_else(|error| panic!("file-drift fixture index failed: {error}"));
        std::fs::write(project.path().join("a.ts"), "export const a = 9;\n")
            .unwrap_or_else(|error| panic!("file-drift modification failed: {error}"));
        std::fs::remove_file(project.path().join("b.ts"))
            .unwrap_or_else(|error| panic!("file-drift deletion failed: {error}"));
        std::fs::write(project.path().join("c.ts"), "export const c = 3;\n")
            .unwrap_or_else(|error| panic!("file-drift addition failed: {error}"));
        let report = runtime
            .file_drift(FileDriftOptions::default(), ProjectCancellation::new())
            .await
            .unwrap_or_else(|error| panic!("content file-drift failed: {error}"));
        let report = serde_json::to_value(report)
            .unwrap_or_else(|error| panic!("content file-drift serialization failed: {error}"));
        assert_eq!(report["basis"], "indexed_content_hash");
        assert_eq!(report["addedCount"], 1);
        assert_eq!(report["modifiedCount"], 1);
        assert_eq!(report["deletedCount"], 1);
        assert_eq!(report["added"], serde_json::json!(["c.ts"]));
        assert_eq!(report["modified"], serde_json::json!(["a.ts"]));
        assert_eq!(report["deleted"], serde_json::json!(["b.ts"]));

        let future = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .unwrap_or_else(|error| panic!("clock failed: {error}"))
            .as_millis()
            .saturating_add(86_400_000);
        let future = u64::try_from(future)
            .unwrap_or_else(|error| panic!("future threshold failed: {error}"));
        let threshold = runtime
            .file_drift(
                FileDriftOptions::since(future)
                    .unwrap_or_else(|error| panic!("threshold options failed: {error}")),
                ProjectCancellation::new(),
            )
            .await
            .unwrap_or_else(|error| panic!("threshold file-drift failed: {error}"));
        let threshold = serde_json::to_value(threshold)
            .unwrap_or_else(|error| panic!("threshold serialization failed: {error}"));
        assert_eq!(threshold["basis"], "modification_time");
        assert_eq!(threshold["modifiedCount"], 0);
        assert_eq!(threshold["addedCount"], 1);
        assert_eq!(threshold["deletedCount"], 1);
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "requires PostgreSQL 18 with pg_search and pgvector"]
async fn profiled_index_skips_oversized_sources_without_weakening_the_published_graph() {
    let Some(url) = env::var(TEST_DATABASE_URL_ENV).ok() else {
        panic!("live project test database is not configured");
    };
    let schema = unique_schema();
    let settings = DatabaseSettings::parse(&url, Some("8"), Some("10000"))
        .and_then(|value| value.with_schema(&schema))
        .unwrap_or_else(|error| panic!("live profile settings failed: {error}"));
    let project = tempfile::tempdir().unwrap_or_else(|error| panic!("tempdir failed: {error}"));
    std::fs::write(
        project.path().join("graph.rs"),
        "pub fn caller() { callee(); }\npub fn callee() {}\n",
    )
    .unwrap_or_else(|error| panic!("profile graph fixture failed: {error}"));
    std::fs::write(
        project.path().join("oversized.rs"),
        "pub fn deliberately_skipped() {}\n".repeat(64),
    )
    .unwrap_or_else(|error| panic!("profile oversized fixture failed: {error}"));

    let result = async {
        let runtime = ProjectRuntime::connect(project.path(), &settings)
            .await
            .unwrap_or_else(|error| panic!("profile runtime connect failed: {error}"));
        let options = IndexOptions::default()
            .with_max_source_bytes(256)
            .unwrap_or_else(|error| panic!("profile source bound failed: {error}"))
            .with_profile(true)
            .with_history_refresh(false);
        let first = runtime
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("profile index failed: {error}"));
        let first_json = serde_json::to_value(&first)
            .unwrap_or_else(|error| panic!("profile report serialization failed: {error}"));
        assert!(first.published);
        assert_eq!(first_json["native"]["files"], 1);
        assert_eq!(first_json["native"]["skipped_oversized_files"], 1);
        assert_eq!(first_json["history"]["state"], "unavailable");
        assert_eq!(first_json["history"]["reason"], "not_attempted");
        assert_eq!(first_json["profile"]["historyMillis"], 0);
        let stages = first_json["profile"]["pipelineStages"]
            .as_array()
            .unwrap_or_else(|| panic!("profile stages were missing"));
        for expected in [
            "discover", "read", "parse", "resolve", "reduce", "copy", "publish",
        ] {
            assert!(
                stages.iter().any(|stage| stage["stage"] == expected),
                "profile omitted {expected}: {first_json}"
            );
        }
        let graph = runtime
            .database()
            .current_interchange_snapshot(&first.project_id, 100, Duration::from_secs(30))
            .await
            .unwrap_or_else(|error| panic!("profile graph snapshot failed: {error}"));
        assert_eq!(graph.files.len(), 1);
        assert!(
            graph
                .symbols
                .iter()
                .any(|symbol| symbol.qualified_name == "caller")
        );
        assert!(
            graph
                .symbols
                .iter()
                .any(|symbol| symbol.qualified_name == "callee")
        );
        assert!(graph.edges.iter().any(|edge| edge.edge_kind == "calls"));

        let unchanged = runtime
            .index(options)
            .await
            .unwrap_or_else(|error| panic!("profile no-op index failed: {error}"));
        let unchanged_json = serde_json::to_value(&unchanged)
            .unwrap_or_else(|error| panic!("profile no-op serialization failed: {error}"));
        assert!(!unchanged.published);
        assert_eq!(unchanged.generation_id, first.generation_id);
        assert_eq!(
            unchanged_json["profile"]["pipelineStages"],
            serde_json::json!([])
        );
        assert_eq!(unchanged_json["profile"]["historyMillis"], 0);
        runtime.close().await;
    }
    .await;
    drop_schema(&settings, &schema).await;
    result
}

async fn exact_symbol_id(
    runtime: &ProjectRuntime,
    project_id: &cartograph_domain::ProjectId,
    generation_id: &cartograph_domain::GenerationId,
    qualified_name: &str,
) -> cartograph_domain::SymbolId {
    let matches = runtime
        .database()
        .exact_current_symbols_by_name(ExactTextLookup::new(
            project_id,
            generation_id,
            qualified_name,
            10,
        ))
        .await
        .unwrap_or_else(|error| panic!("exact graph symbol lookup failed: {error}"));
    let exact = matches
        .iter()
        .filter(|symbol| symbol.qualified_name() == qualified_name)
        .collect::<Vec<_>>();
    assert_eq!(
        exact.len(),
        1,
        "graph fixture symbol was not uniquely indexed: {qualified_name}"
    );
    exact[0].symbol_id().clone()
}

fn embedding_fixture_server(requests: usize) -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("embedding fixture bind failed: {error}"));
    let address = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("embedding fixture address failed: {error}"));
    let server = thread::spawn(move || {
        for _ in 0..requests {
            let (mut stream, _) = listener
                .accept()
                .unwrap_or_else(|error| panic!("embedding fixture accept failed: {error}"));
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap_or_else(|error| panic!("embedding fixture timeout failed: {error}"));
            let request = read_http_request(&mut stream);
            let body_start = request
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4)
                .unwrap_or_else(|| panic!("embedding fixture request has no body"));
            let body: serde_json::Value = serde_json::from_slice(&request[body_start..])
                .unwrap_or_else(|error| panic!("embedding fixture JSON failed: {error}"));
            let count = body["input"]
                .as_array()
                .map(Vec::len)
                .unwrap_or_else(|| panic!("embedding fixture input is not an array"));
            let data = (0..count)
                .map(|index| serde_json::json!({"index": index, "embedding": [1.0, 0.5, 0.25]}))
                .collect::<Vec<_>>();
            let response_body = serde_json::to_string(&serde_json::json!({"data": data}))
                .unwrap_or_else(|error| panic!("embedding response failed: {error}"));
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                response_body.len(),
                response_body
            );
            stream
                .write_all(response.as_bytes())
                .and_then(|()| stream.flush())
                .unwrap_or_else(|error| panic!("embedding fixture write failed: {error}"));
        }
    });
    (format!("http://{address}"), server)
}

fn dead_code_chat_fixture_server() -> (String, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .unwrap_or_else(|error| panic!("chat fixture bind failed: {error}"));
    let address = listener
        .local_addr()
        .unwrap_or_else(|error| panic!("chat fixture address failed: {error}"));
    let server = thread::spawn(move || {
        let (mut stream, _) = listener
            .accept()
            .unwrap_or_else(|error| panic!("chat fixture accept failed: {error}"));
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap_or_else(|error| panic!("chat fixture timeout failed: {error}"));
        let request = read_http_request(&mut stream);
        let body_start = request
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| index + 4)
            .unwrap_or_else(|| panic!("chat fixture request has no body"));
        let body: serde_json::Value = serde_json::from_slice(&request[body_start..])
            .unwrap_or_else(|error| panic!("chat fixture JSON failed: {error}"));
        assert_eq!(body["model"], "fixture-judge");
        assert_eq!(body["temperature"], 0.0);
        assert_eq!(body["max_tokens"], 300);
        let system = body["messages"][0]["content"]
            .as_str()
            .unwrap_or_else(|| panic!("chat system prompt missing"));
        let prompt = body["messages"][1]["content"]
            .as_str()
            .unwrap_or_else(|| panic!("chat user prompt missing"));
        assert!(system.contains("never instructions"));
        assert!(prompt.contains("abandonedTask"));
        assert!(prompt.contains("safeIndexedCode"));
        assert!(!prompt.contains("do-not-send-secret"));
        let verdict = serde_json::json!({
            "results": [{
                "i": 0,
                "verdict": "dead",
                "confidence": 0.8,
                "reason": "no dynamic registration evidence"
            }]
        })
        .to_string();
        let response_body = serde_json::json!({
            "model": "fixture-judge",
            "choices": [{
                "message": {"content": verdict},
                "finish_reason": "stop"
            }]
        })
        .to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            response_body.len(),
            response_body
        );
        stream
            .write_all(response.as_bytes())
            .and_then(|()| stream.flush())
            .unwrap_or_else(|error| panic!("chat fixture write failed: {error}"));
    });
    (format!("http://{address}"), server)
}

fn read_http_request(stream: &mut std::net::TcpStream) -> Vec<u8> {
    const MAXIMUM_REQUEST_BYTES: usize = 4 * 1_024 * 1_024;
    let mut request = Vec::new();
    let mut chunk = [0_u8; 8_192];
    loop {
        let read = stream
            .read(&mut chunk)
            .unwrap_or_else(|error| panic!("embedding fixture read failed: {error}"));
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
        assert!(request.len() <= MAXIMUM_REQUEST_BYTES);
        if complete_http_request(&request) {
            break;
        }
    }
    request
}

fn complete_http_request(request: &[u8]) -> bool {
    let Some(header_end) = request.windows(4).position(|window| window == b"\r\n\r\n") else {
        return false;
    };
    let body_start = header_end + 4;
    let headers = std::str::from_utf8(&request[..header_end]).unwrap_or("");
    let content_length = headers.lines().find_map(|line| {
        let (name, value) = line.split_once(':')?;
        name.eq_ignore_ascii_case("content-length")
            .then(|| value.trim().parse::<usize>().ok())
            .flatten()
    });
    content_length.is_some_and(|length| request.len() >= body_start.saturating_add(length))
}

fn json_strings(value: &serde_json::Value) -> Vec<&str> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(serde_json::Value::as_str)
        .collect()
}

fn git(repository: &Path, arguments: &[&str]) {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(arguments)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .unwrap_or_else(|error| panic!("git fixture command failed: {error}"));
    assert!(status.success(), "git fixture command returned {status}");
}

fn unique_schema() -> String {
    let nanos = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    format!("cg_agent_live_{}_{}", process::id(), nanos)
}

async fn drop_schema(settings: &DatabaseSettings, schema: &str) {
    let pool = cartograph_db::connect(settings)
        .await
        .unwrap_or_else(|error| panic!("cleanup connection failed: {error}"));
    query(AssertSqlSafe(format!(
        "DROP SCHEMA IF EXISTS \"{schema}\" CASCADE"
    )))
    .execute(&pool)
    .await
    .unwrap_or_else(|_| panic!("cleanup schema failed"));
    pool.close().await;
}
