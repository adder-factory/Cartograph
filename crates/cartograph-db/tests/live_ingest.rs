//! Live PostgreSQL integration coverage for Cartograph storage contracts.

mod dependency_ownership;

use std::{
    env, process,
    sync::atomic::{AtomicU32, Ordering},
    time::Duration,
};

use cartograph_config::DatabaseSettings;
use cartograph_db::{
    CanonicalGenerationFacts, CartographDatabase, EdgeInput, FileInput, GenerationContents,
    GenerationFacts, GenerationRecoveryRequest, GenerationValidationLimits, LeaseOwner,
    LeaseRequest, LeaseTarget, NewGeneration, NewProject, NumericalSiteInput,
    PrepareGenerationMetrics, ProjectLease, ReadyGeneration, RecoverableGeneration, ReferenceInput,
    SearchDocumentInput, StorageError, SymbolInput, validate_generation_facts,
};
use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, EdgeKind, FileId, FileParseStatus,
    GenerationDigestVersion, GenerationId, NumericalSiteId, ProjectId, ProjectOperation, SymbolId,
};
use cartograph_test_support::TestSchemaGuard;
use sqlx_core::{query::query, row::Row, sql_str::AssertSqlSafe};

const TEST_DATABASE_URL_ENV: &str = "CARTOGRAPH_TEST_DATABASE_URL";
const PROJECT_FINGERPRINT: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const REVISION: &str = "1111111111111111111111111111111111111111";
const FILE_ONE: &str = "11111111-1111-4111-8111-111111111111";
const FILE_TWO: &str = "22222222-2222-4222-8222-222222222222";
const FILE_REJECTED: &str = "33333333-3333-4333-8333-333333333333";
const SYMBOL_ONE: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SYMBOL_TWO: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const NUMERICAL_SITE_ONE: &str = "99999999-9999-4999-8999-999999999999";
const DOCUMENT_ONE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const DOCUMENT_TWO: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const DOCUMENT_REJECTED: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const DOCUMENT_CHUNK_ONE: &str = "11111111-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_CHUNK_TWO: &str = "22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOCUMENT_OVERSIZED_ROW: &str = "33333333-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CORRUPT_SOURCE_SYMBOL: &str = "44444444-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CORRUPT_TARGET_SYMBOL: &str = "55555555-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTENT_HASH_ONE: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const CONTENT_HASH_TWO: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const CONTENT_HASH_REJECTED: &str =
    "3333333333333333333333333333333333333333333333333333333333333333";
const STRUCTURAL_HASH_ONE: &str =
    "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const STRUCTURAL_HASH_TWO: &str =
    "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const EXPECTED_LOGICAL_DIGEST: &str =
    "0d164ca964f0962ab9108bd2da1977583f9d3c01491df6d1610c4684c06c6c5a";
const SINGLE_WORKER: u16 = 1;
const TEST_VALIDATION_OUTPUT_BYTES: u64 = 64 * 1024 * 1024;
const TEST_VALIDATION_WORKING_BYTES: u64 = 256 * 1024 * 1024;
const PARALLEL_WORKERS: u16 = 16;
const SYMBOL_TWO_START_BYTE: u64 = 8;
const SYMBOL_TWO_END_BYTE: u64 = 80;
const SYMBOL_TWO_START_LINE: u32 = 2;
const SYMBOL_TWO_END_LINE: u32 = 5;
const REFERENCE_START_BYTE: u64 = 32;
const REFERENCE_END_BYTE: u64 = 51;
const REFERENCE_CONFIDENCE: f32 = 0.875;
const CUMULATIVE_COPY_CODE_BYTES: usize = 600 * 1_024;
const INDIVIDUAL_COPY_CODE_BYTES: usize = 1_024 * 1_024 + 128;
const CHUNK_DOCUMENT_COUNT: i64 = 3;
const CUMULATIVE_COPY_ROW_COUNT: i64 = 2;
const INDIVIDUAL_COPY_ROW_COUNT: i64 = 1;
const TEST_LEASE_DURATION: Duration = Duration::from_secs(30);

static SCHEMA_COUNTER: AtomicU32 = AtomicU32::new(0);

#[tokio::test]
#[ignore = "requires an explicit PostgreSQL 18 + pinned ParadeDB test database"]
async fn copy_ingestion_is_atomic_and_logically_deterministic() {
    let fixture = open_fixture().await;

    let reused_metrics = PrepareGenerationMetrics::new();
    let first = prepare_generation_with_metrics(
        &fixture,
        ObservedGenerationInput {
            workers: SINGLE_WORKER,
            facts: generation_facts(false),
            metrics: reused_metrics.clone(),
        },
    )
    .await;
    let second = prepare_generation(&fixture, PARALLEL_WORKERS, generation_facts(true)).await;
    assert_eq!(first.content_digest(), second.content_digest());
    assert_eq!(first.digest_version(), GenerationDigestVersion::CURRENT);
    assert_eq!(second.digest_version(), GenerationDigestVersion::CURRENT);
    assert_eq!(first.content_digest().as_str(), EXPECTED_LOGICAL_DIGEST);
    assert_persisted_generation(&fixture, &first).await;
    assert_persisted_generation(&fixture, &second).await;
    assert_copy_text_round_trip(&fixture, &second).await;
    assert_reference_evidence_round_trip(&fixture, &second).await;
    assert_numerical_evidence_round_trip(&fixture, &second).await;
    assert_ready_digest_recovery(&fixture, &first).await;
    assert_copy_chunk_and_null_boundaries(&fixture).await;

    install_relation_corruption_trigger(&fixture).await;
    assert_relation_validation_rolls_back(&fixture).await;
    remove_relation_corruption_trigger(&fixture).await;

    install_rejecting_trigger(&fixture).await;
    assert_copy_failure_rolls_back(&fixture, reused_metrics).await;

    drop(fixture.database);
    drop_schema(&fixture.pool, &fixture.schema).await;
    fixture.pool.close().await;
}

async fn assert_numerical_evidence_round_trip(fixture: &DatabaseFixture, ready: &ReadyGeneration) {
    let statement = format!(
        r#"SELECT numerical_site_id::text, owner_symbol_id::text, operation, hazard,
                  precision, confidence_ppm, provenance, evidence_level, unknowns
            FROM "{}"."numerical_sites"
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)"#,
        fixture.schema,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(fixture.project.as_str())
        .bind(ready.generation_id().as_str())
        .fetch_one(&fixture.pool)
        .await
        .unwrap_or_else(|error| panic!("could not inspect numerical evidence: {error}"));
    assert_eq!(
        row.try_get::<String, _>(0).ok().as_deref(),
        Some(NUMERICAL_SITE_ONE)
    );
    assert_eq!(
        row.try_get::<String, _>(1).ok().as_deref(),
        Some(SYMBOL_ONE)
    );
    assert_eq!(
        row.try_get::<String, _>(2).ok().as_deref(),
        Some("tolerance_comparison")
    );
    assert_eq!(
        row.try_get::<String, _>(3).ok().as_deref(),
        Some("absolute_only_tolerance")
    );
    assert_eq!(row.try_get::<String, _>(4).ok().as_deref(), Some("f32"));
    assert!(matches!(row.try_get::<i32, _>(5), Ok(900_000)));
    assert_eq!(
        row.try_get::<String, _>(6).ok().as_deref(),
        Some("rust_ast_v1")
    );
    assert_eq!(
        row.try_get::<String, _>(7).ok().as_deref(),
        Some("heuristic")
    );
    assert_eq!(
        row.try_get::<String, _>(8).ok().as_deref(),
        Some("relative_scale,input_range")
    );
}

async fn assert_reference_evidence_round_trip(fixture: &DatabaseFixture, ready: &ReadyGeneration) {
    let statement = format!(
        r#"SELECT owner_symbol_id::text, target_symbol_id::text, reference_name,
                  resolution_provenance
            FROM "{}"."references"
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)"#,
        fixture.schema,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(fixture.project.as_str())
        .bind(ready.generation_id().as_str())
        .fetch_one(&fixture.pool)
        .await
        .unwrap_or_else(|error| panic!("could not inspect reference evidence: {error}"));
    assert!(matches!(
        row.try_get::<String, _>(0),
        Ok(value) if value == SYMBOL_TWO
    ));
    assert!(matches!(
        row.try_get::<String, _>(1),
        Ok(value) if value == SYMBOL_ONE
    ));
    assert!(matches!(
        row.try_get::<String, _>(2),
        Ok(value) if value == "fixture_call"
    ));
    assert!(matches!(
        row.try_get::<String, _>(3),
        Ok(value) if value == "test-exact"
    ));
}

async fn assert_copy_chunk_and_null_boundaries(fixture: &DatabaseFixture) {
    let ready = prepare_generation(
        fixture,
        PARALLEL_WORKERS,
        GenerationFacts {
            documents: vec![
                chunk_document(
                    DOCUMENT_CHUNK_ONE,
                    "docs/chunk-one.md",
                    CUMULATIVE_COPY_CODE_BYTES,
                ),
                chunk_document(
                    DOCUMENT_CHUNK_TWO,
                    "docs/chunk-two.md",
                    CUMULATIVE_COPY_CODE_BYTES,
                ),
                chunk_document(
                    DOCUMENT_OVERSIZED_ROW,
                    "docs/oversized-row.md",
                    INDIVIDUAL_COPY_CODE_BYTES,
                ),
            ],
            ..GenerationFacts::default()
        },
    )
    .await;
    let statement = format!(
        r#"SELECT
                count(*) AS documents,
                count(*) FILTER (WHERE file_id IS NULL) AS null_file_ids,
                count(*) FILTER (WHERE symbol_id IS NULL) AS null_symbol_ids,
                count(*) FILTER (
                    WHERE octet_length(code) = {cumulative_bytes}
                ) AS cumulative_rows,
                count(*) FILTER (
                    WHERE octet_length(code) = {individual_bytes}
                ) AS individual_rows
            FROM "{schema}"."search_documents"
            WHERE project_id = CAST($1 AS uuid)
              AND generation_id = CAST($2 AS uuid)"#,
        schema = fixture.schema,
        cumulative_bytes = CUMULATIVE_COPY_CODE_BYTES,
        individual_bytes = INDIVIDUAL_COPY_CODE_BYTES,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(fixture.project.as_str())
        .bind(ready.generation_id().as_str())
        .fetch_one(&fixture.pool)
        .await;
    let row = match row {
        Ok(row) => row,
        Err(error) => panic!("could not inspect COPY chunk boundaries: {error}"),
    };
    assert!(matches!(
        row.try_get::<i64, _>("documents"),
        Ok(CHUNK_DOCUMENT_COUNT)
    ));
    assert!(matches!(
        row.try_get::<i64, _>("null_file_ids"),
        Ok(CHUNK_DOCUMENT_COUNT)
    ));
    assert!(matches!(
        row.try_get::<i64, _>("null_symbol_ids"),
        Ok(CHUNK_DOCUMENT_COUNT)
    ));
    assert!(matches!(
        row.try_get::<i64, _>("cumulative_rows"),
        Ok(CUMULATIVE_COPY_ROW_COUNT)
    ));
    assert!(matches!(
        row.try_get::<i64, _>("individual_rows"),
        Ok(INDIVIDUAL_COPY_ROW_COUNT)
    ));
}

fn chunk_document(id: &str, path: &str, code_bytes: usize) -> SearchDocumentInput {
    SearchDocumentInput {
        document_id: document_id(id),
        file_id: None,
        symbol_id: None,
        path: path.to_owned(),
        language: "markdown".to_owned(),
        kind: DocumentKind::Documentation,
        qualified_name: String::new(),
        code: "x".repeat(code_bytes),
        natural_text: String::new(),
        metadata: serde_json::json!({}),
    }
}

async fn assert_ready_digest_recovery(fixture: &DatabaseFixture, ready: &ReadyGeneration) {
    let recovered = fixture
        .database
        .recover_generation(GenerationRecoveryRequest::new(
            &fixture.project,
            ready.generation_id(),
        ))
        .await;
    let recovered = match recovered {
        Ok(Some(RecoverableGeneration::Ready(recovered))) => recovered,
        Ok(_) => panic!("ready COPY generation was not recoverable"),
        Err(error) => panic!("ready COPY generation recovery failed: {error}"),
    };
    assert_eq!(recovered.content_digest(), ready.content_digest());
}

struct DatabaseFixture {
    database: CartographDatabase,
    pool: sqlx_postgres::PgPool,
    schema: String,
    project: ProjectId,
    _schema_guard: TestSchemaGuard,
}

async fn open_fixture() -> DatabaseFixture {
    let database_url = env::var(TEST_DATABASE_URL_ENV).unwrap_or_else(|error| {
        panic!("{TEST_DATABASE_URL_ENV} must be set for the ignored integration test: {error}")
    });
    let schema = format!(
        "cartograph_ingest_it_{}_{}",
        process::id(),
        SCHEMA_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let settings = DatabaseSettings::parse(&database_url, Some("4"), Some("10000"))
        .and_then(|settings| settings.with_schema(&schema));
    let settings = match settings {
        Ok(settings) => settings,
        Err(error) => panic!("ingest test database settings failed validation: {error}"),
    };
    let pool = match cartograph_db::connect(&settings).await {
        Ok(pool) => pool,
        Err(error) => panic!("ingest test database connection failed: {error}"),
    };
    let database = CartographDatabase::new(pool.clone(), settings.schema().clone());
    if let Err(error) = database.migrate().await {
        panic!("ingest test migration failed: {error}");
    }
    let project = register_project(&database).await;
    DatabaseFixture {
        database,
        pool,
        schema,
        project,
        _schema_guard: TestSchemaGuard::new(database_url, settings.schema().as_str())
            .unwrap_or_else(|error| panic!("ingest schema guard failed: {error}")),
    }
}

async fn register_project(database: &CartographDatabase) -> ProjectId {
    match database
        .register_project(NewProject::new(
            "workspace/copy-ingest",
            digest(PROJECT_FINGERPRINT),
        ))
        .await
    {
        Ok(project) => project,
        Err(error) => panic!("ingest test project registration failed: {error}"),
    }
}

async fn prepare_generation(
    fixture: &DatabaseFixture,
    workers: u16,
    facts: GenerationFacts,
) -> ReadyGeneration {
    prepare_generation_with_metrics(
        fixture,
        ObservedGenerationInput {
            workers,
            facts,
            metrics: PrepareGenerationMetrics::new(),
        },
    )
    .await
}

struct ObservedGenerationInput {
    workers: u16,
    facts: GenerationFacts,
    metrics: PrepareGenerationMetrics,
}

async fn prepare_generation_with_metrics(
    fixture: &DatabaseFixture,
    input: ObservedGenerationInput,
) -> ReadyGeneration {
    let ObservedGenerationInput {
        workers,
        facts,
        metrics,
    } = input;
    let staged = match fixture
        .database
        .begin_generation(NewGeneration::new(
            fixture.project.clone(),
            REVISION,
            workers,
        ))
        .await
    {
        Ok(staged) => staged,
        Err(error) => panic!("ingest test generation did not begin: {error}"),
    };
    let lease = acquire_generation_lease(fixture, staged.generation_id()).await;
    let result = fixture
        .database
        .prepare_generation(
            GenerationContents::new(staged, canonical(facts)).with_metrics(metrics.clone()),
            &lease.fence(),
        )
        .await;
    assert!(fixture.database.release_lease(&lease).await.is_ok());
    match result {
        Ok(ready) => {
            let snapshot = metrics.snapshot();
            assert!(!snapshot.copy_duration().is_zero());
            let table_durations = [
                snapshot.files_copy_duration(),
                snapshot.symbols_copy_duration(),
                snapshot.edges_copy_duration(),
                snapshot.references_copy_duration(),
                snapshot.numerical_sites_copy_duration(),
                snapshot.documents_copy_duration(),
            ];
            assert!(table_durations.iter().all(|duration| !duration.is_zero()));
            assert!(table_durations.into_iter().sum::<Duration>() <= snapshot.copy_duration());
            assert!(!snapshot.relation_validation_duration().is_zero());
            ready
        }
        Err(error) => panic!("COPY generation preparation failed: {error}"),
    }
}

async fn install_relation_corruption_trigger(fixture: &DatabaseFixture) {
    let function = format!(
        r#"CREATE FUNCTION "{schema}".inject_invalid_edge_fixture() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                INSERT INTO "{schema}"."edges" (
                    project_id, generation_id, source_symbol_id, target_symbol_id,
                    edge_kind, confidence, provenance
                ) VALUES (
                    NEW.project_id, NEW.generation_id,
                    '{source_symbol}'::uuid, '{target_symbol}'::uuid,
                    'calls', 1.0, 'relation-validation-fixture'
                ) ON CONFLICT DO NOTHING;
                RETURN NEW;
            END
            $$"#,
        schema = fixture.schema,
        source_symbol = CORRUPT_SOURCE_SYMBOL,
        target_symbol = CORRUPT_TARGET_SYMBOL,
    );
    let trigger = format!(
        r#"CREATE TRIGGER inject_invalid_edge_fixture
            AFTER INSERT ON "{schema}"."search_documents"
            FOR EACH ROW EXECUTE FUNCTION "{schema}".inject_invalid_edge_fixture()"#,
        schema = fixture.schema,
    );
    if let Err(error) = query(AssertSqlSafe(function)).execute(&fixture.pool).await {
        panic!("could not create relation-corruption function: {error}");
    }
    if let Err(error) = query(AssertSqlSafe(trigger)).execute(&fixture.pool).await {
        panic!("could not create relation-corruption trigger: {error}");
    }
}

async fn remove_relation_corruption_trigger(fixture: &DatabaseFixture) {
    let trigger = format!(
        r#"DROP TRIGGER inject_invalid_edge_fixture ON "{schema}"."search_documents""#,
        schema = fixture.schema,
    );
    let function = format!(
        r#"DROP FUNCTION "{schema}".inject_invalid_edge_fixture()"#,
        schema = fixture.schema,
    );
    if let Err(error) = query(AssertSqlSafe(trigger)).execute(&fixture.pool).await {
        panic!("could not remove relation-corruption trigger: {error}");
    }
    if let Err(error) = query(AssertSqlSafe(function)).execute(&fixture.pool).await {
        panic!("could not remove relation-corruption trigger: {error}");
    }
}

async fn assert_relation_validation_rolls_back(fixture: &DatabaseFixture) {
    let staged = match fixture
        .database
        .begin_generation(NewGeneration::new(
            fixture.project.clone(),
            REVISION,
            PARALLEL_WORKERS,
        ))
        .await
    {
        Ok(staged) => staged,
        Err(error) => panic!("relation fixture generation did not begin: {error}"),
    };
    let generation_id = staged.generation_id().clone();
    let lease = acquire_generation_lease(fixture, &generation_id).await;
    let fence = lease.fence();
    let failed = fixture
        .database
        .prepare_generation(
            GenerationContents::new(staged, canonical(generation_facts(false))),
            &fence,
        )
        .await;
    let staged = match failed {
        Err(error) => {
            assert!(matches!(
                error.error(),
                StorageError::DatabaseOperation {
                    operation: "verify-copied-relations"
                }
            ));
            error.into_parts().0
        }
        Ok(_) => panic!("relation-corrupted COPY unexpectedly became ready"),
    };
    assert_generation_is_empty(fixture, &generation_id).await;
    assert!(
        fixture
            .database
            .fail_generation(RecoverableGeneration::Staged(staged), &fence)
            .await
            .is_ok()
    );
    assert!(fixture.database.release_lease(&lease).await.is_ok());
}

fn generation_facts(reversed: bool) -> GenerationFacts {
    let mut files = vec![file_one(), file_two()];
    let mut symbols = vec![symbol_one(), symbol_two()];
    let edges = vec![edge()];
    let mut references = vec![reference()];
    let mut numerical_sites = vec![numerical_site()];
    let mut documents = vec![document_one(reversed), document_two()];
    if reversed {
        files.reverse();
        symbols.reverse();
        documents.reverse();
        references.push(reference());
        numerical_sites.push(numerical_site());
        documents.push(document_two());
    }
    GenerationFacts {
        files,
        symbols,
        edges,
        references,
        numerical_sites,
        documents,
    }
}

fn file_one() -> FileInput {
    FileInput {
        file_id: file_id(FILE_ONE),
        normalized_path: "src/parser.rs".to_owned(),
        language: "rust".to_owned(),
        content_hash: digest(CONTENT_HASH_ONE),
        byte_size: 128,
        parse_status: FileParseStatus::Parsed,
    }
}

fn file_two() -> FileInput {
    FileInput {
        file_id: file_id(FILE_TWO),
        normalized_path: "tests/parser_test.rs".to_owned(),
        language: "rust".to_owned(),
        content_hash: digest(CONTENT_HASH_TWO),
        byte_size: 256,
        parse_status: FileParseStatus::Partial,
    }
}

fn symbol_one() -> SymbolInput {
    SymbolInput {
        symbol_id: symbol_id(SYMBOL_ONE),
        file_id: file_id(FILE_ONE),
        symbol_kind: "function".to_owned(),
        qualified_name: "parser::parseHTTPResponse".to_owned(),
        signature: "fn parse_http_response(input:\t&str)\n -> Result<Response, Error>\\path"
            .to_owned(),
        start_byte: 0,
        end_byte: 96,
        start_line: 1,
        end_line: 4,
        structural_digest: digest(STRUCTURAL_HASH_ONE),
        visibility: None,
        export: cartograph_domain::SymbolExportFlags::named(true),
        execution: cartograph_domain::SymbolExecutionFlags::default(),
        declaration_only: false,
        betweenness_ppb: None,
        pagerank_ppb: None,
    }
}

fn symbol_two() -> SymbolInput {
    SymbolInput {
        symbol_id: symbol_id(SYMBOL_TWO),
        file_id: file_id(FILE_TWO),
        symbol_kind: "test".to_owned(),
        qualified_name: "parser_test::parses_http_response".to_owned(),
        signature: "fn parses_http_response()".to_owned(),
        start_byte: SYMBOL_TWO_START_BYTE,
        end_byte: SYMBOL_TWO_END_BYTE,
        start_line: SYMBOL_TWO_START_LINE,
        end_line: SYMBOL_TWO_END_LINE,
        structural_digest: digest(STRUCTURAL_HASH_TWO),
        visibility: None,
        export: cartograph_domain::SymbolExportFlags::default(),
        execution: cartograph_domain::SymbolExecutionFlags::default(),
        declaration_only: false,
        betweenness_ppb: None,
        pagerank_ppb: None,
    }
}

fn edge() -> EdgeInput {
    EdgeInput {
        source_symbol_id: symbol_id(SYMBOL_TWO),
        target_symbol_id: symbol_id(SYMBOL_ONE),
        kind: EdgeKind::Tests,
        confidence: 1.0,
        provenance: "tree-sitter\ttest-resolver\\v2".to_owned(),
        site_count: 1,
    }
}

fn reference() -> ReferenceInput {
    ReferenceInput {
        file_id: file_id(FILE_TWO),
        owner_symbol_id: Some(symbol_id(SYMBOL_TWO)),
        target_symbol_id: Some(symbol_id(SYMBOL_ONE)),
        reference_name: "fixture_call".to_owned(),
        reference_kind: "call".to_owned(),
        start_byte: REFERENCE_START_BYTE,
        end_byte: REFERENCE_END_BYTE,
        confidence: REFERENCE_CONFIDENCE,
        resolution_provenance: "test-exact".to_owned(),
        site_count: 1,
        span_precision: cartograph_db::ReferenceSpanPrecision::Exact,
    }
}

fn numerical_site() -> NumericalSiteInput {
    NumericalSiteInput {
        site_id: NumericalSiteId::parse(NUMERICAL_SITE_ONE)
            .unwrap_or_else(|error| panic!("fixture numerical site UUID is invalid: {error}")),
        file_id: file_id(FILE_ONE),
        owner_symbol_id: Some(symbol_id(SYMBOL_ONE)),
        start_byte: 20,
        end_byte: 32,
        start_line: 2,
        end_line: 2,
        operation: "tolerance_comparison".to_owned(),
        hazard: "absolute_only_tolerance".to_owned(),
        precision: "f32".to_owned(),
        expression_digest: digest(CONTENT_HASH_ONE),
        confidence_ppm: 900_000,
        provenance: "rust_ast_v1".to_owned(),
        evidence_level: "heuristic".to_owned(),
        unknowns: "relative_scale,input_range".to_owned(),
    }
}

fn canonical(facts: GenerationFacts) -> CanonicalGenerationFacts {
    let limits = GenerationValidationLimits::new(
        TEST_VALIDATION_OUTPUT_BYTES,
        TEST_VALIDATION_WORKING_BYTES,
    )
    .unwrap_or_else(|error| panic!("ingest validation limits were invalid: {error}"));
    validate_generation_facts(facts, limits, || false).map_or_else(
        |error| panic!("ingest fixture was invalid: {error}"),
        |(facts, _)| facts,
    )
}

fn document_one(reordered_metadata: bool) -> SearchDocumentInput {
    let metadata = if reordered_metadata {
        serde_json::json!({
            "zeta": "last",
            "sentinel": "\\N\tline\nnext",
            "alpha": "first"
        })
    } else {
        serde_json::json!({
            "alpha": "first",
            "sentinel": "\\N\tline\nnext",
            "zeta": "last"
        })
    };
    SearchDocumentInput {
        document_id: document_id(DOCUMENT_ONE),
        file_id: Some(file_id(FILE_ONE)),
        symbol_id: Some(symbol_id(SYMBOL_ONE)),
        path: "src/parser.rs".to_owned(),
        language: "rust".to_owned(),
        kind: DocumentKind::Symbol,
        qualified_name: "parser::parseHTTPResponse".to_owned(),
        code: "fn parse_http_response() {\n\tlet marker = \\\"\\\\N\\\";\n}".to_owned(),
        natural_text: "Parse an HTTP response\nwithout client-wall-clock assumptions".to_owned(),
        metadata,
    }
}

fn document_two() -> SearchDocumentInput {
    SearchDocumentInput {
        document_id: document_id(DOCUMENT_TWO),
        file_id: Some(file_id(FILE_TWO)),
        symbol_id: Some(symbol_id(SYMBOL_TWO)),
        path: "tests/parser_test.rs".to_owned(),
        language: "rust".to_owned(),
        kind: DocumentKind::Test,
        qualified_name: "parser_test::parses_http_response".to_owned(),
        code: "#[test]\nfn parses_http_response() {}".to_owned(),
        natural_text: "Regression for HTTP response parsing".to_owned(),
        metadata: serde_json::json!({"role": "regression"}),
    }
}

async fn assert_persisted_generation(fixture: &DatabaseFixture, ready: &ReadyGeneration) {
    let statement = format!(
        r#"SELECT
                (SELECT count(*) FROM "{schema}"."files"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS files,
                (SELECT count(*) FROM "{schema}"."symbols"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS symbols,
                (SELECT count(*) FROM "{schema}"."edges"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS edges,
                (SELECT count(*) FROM "{schema}"."references"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS refs,
                (SELECT count(*) FROM "{schema}"."numerical_sites"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS numerical_sites,
                (SELECT count(*) FROM "{schema}"."search_documents"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS documents,
                (SELECT content_digest FROM "{schema}"."index_generations"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS digest,
                (SELECT content_digest_version FROM "{schema}"."index_generations"
                    WHERE project_id = CAST($1 AS uuid) AND generation_id = CAST($2 AS uuid)) AS digest_version"#,
        schema = fixture.schema,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(fixture.project.as_str())
        .bind(ready.generation_id().as_str())
        .fetch_one(&fixture.pool)
        .await;
    let row = match row {
        Ok(row) => row,
        Err(error) => panic!("could not inspect copied generation: {error}"),
    };
    assert!(matches!(row.try_get::<i64, _>("files"), Ok(2)));
    assert!(matches!(row.try_get::<i64, _>("symbols"), Ok(2)));
    assert!(matches!(row.try_get::<i64, _>("edges"), Ok(1)));
    assert!(matches!(row.try_get::<i64, _>("refs"), Ok(1)));
    assert!(matches!(row.try_get::<i64, _>("numerical_sites"), Ok(1)));
    assert!(matches!(row.try_get::<i64, _>("documents"), Ok(2)));
    assert_eq!(
        row.try_get::<String, _>("digest").ok().as_deref(),
        Some(ready.content_digest().as_str())
    );
    assert!(matches!(
        row.try_get::<i16, _>("digest_version"),
        Ok(value) if value == GenerationDigestVersion::CURRENT.database_value()
    ));
}

async fn assert_copy_text_round_trip(fixture: &DatabaseFixture, ready: &ReadyGeneration) {
    let statement = format!(
        r#"SELECT symbols.signature, edges.provenance, documents.code,
                   documents.metadata ->> 'sentinel' AS sentinel
            FROM "{schema}"."symbols" AS symbols
            INNER JOIN "{schema}"."edges" AS edges
              ON edges.project_id = symbols.project_id
             AND edges.generation_id = symbols.generation_id
             AND edges.target_symbol_id = symbols.symbol_id
            INNER JOIN "{schema}"."search_documents" AS documents
              ON documents.project_id = symbols.project_id
             AND documents.generation_id = symbols.generation_id
             AND documents.symbol_id = symbols.symbol_id
            WHERE symbols.project_id = CAST($1 AS uuid)
              AND symbols.generation_id = CAST($2 AS uuid)
              AND symbols.symbol_id = CAST($3 AS uuid)"#,
        schema = fixture.schema,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(fixture.project.as_str())
        .bind(ready.generation_id().as_str())
        .bind(SYMBOL_ONE)
        .fetch_one(&fixture.pool)
        .await;
    let row = match row {
        Ok(row) => row,
        Err(error) => panic!("could not inspect COPY text round trip: {error}"),
    };
    assert_eq!(
        row.try_get::<String, _>("signature").ok().as_deref(),
        Some("fn parse_http_response(input:\t&str)\n -> Result<Response, Error>\\path")
    );
    assert_eq!(
        row.try_get::<String, _>("provenance").ok().as_deref(),
        Some("tree-sitter\ttest-resolver\\v2")
    );
    assert_eq!(
        row.try_get::<String, _>("code").ok().as_deref(),
        Some("fn parse_http_response() {\n\tlet marker = \\\"\\\\N\\\";\n}")
    );
    assert_eq!(
        row.try_get::<String, _>("sentinel").ok().as_deref(),
        Some("\\N\tline\nnext")
    );
}

async fn install_rejecting_trigger(fixture: &DatabaseFixture) {
    let function = format!(
        r#"CREATE FUNCTION "{schema}".reject_copy_fixture() RETURNS trigger
            LANGUAGE plpgsql AS $$
            BEGIN
                IF NEW.path = 'src/reject.rs' THEN
                    RAISE EXCEPTION 'intentional COPY rollback fixture';
                END IF;
                RETURN NEW;
            END
            $$"#,
        schema = fixture.schema,
    );
    let trigger = format!(
        r#"CREATE TRIGGER reject_copy_fixture
            BEFORE INSERT ON "{schema}"."search_documents"
            FOR EACH ROW EXECUTE FUNCTION "{schema}".reject_copy_fixture()"#,
        schema = fixture.schema,
    );
    if let Err(error) = query(AssertSqlSafe(function)).execute(&fixture.pool).await {
        panic!("could not create COPY rollback function: {error}");
    }
    if let Err(error) = query(AssertSqlSafe(trigger)).execute(&fixture.pool).await {
        panic!("could not create COPY rollback trigger: {error}");
    }
}

async fn assert_copy_failure_rolls_back(
    fixture: &DatabaseFixture,
    metrics: PrepareGenerationMetrics,
) {
    let staged = match fixture
        .database
        .begin_generation(NewGeneration::new(
            fixture.project.clone(),
            REVISION,
            PARALLEL_WORKERS,
        ))
        .await
    {
        Ok(staged) => staged,
        Err(error) => panic!("rollback fixture generation did not begin: {error}"),
    };
    let generation_id = staged.generation_id().clone();
    let lease = acquire_generation_lease(fixture, &generation_id).await;
    let fence = lease.fence();
    let failed = fixture
        .database
        .prepare_generation(
            GenerationContents::new(staged, canonical(rejected_facts()))
                .with_metrics(metrics.clone()),
            &fence,
        )
        .await;
    let staged = match failed {
        Err(error) => {
            assert!(matches!(
                error.error(),
                StorageError::DatabaseOperation {
                    operation: "copy-search-documents"
                }
            ));
            error.into_parts().0
        }
        Ok(_) => panic!("trigger-rejected COPY unexpectedly became ready"),
    };
    let snapshot = metrics.snapshot();
    assert!(!snapshot.copy_duration().is_zero());
    let attempted_tables = [
        snapshot.files_copy_duration(),
        snapshot.symbols_copy_duration(),
        snapshot.edges_copy_duration(),
        snapshot.references_copy_duration(),
        snapshot.numerical_sites_copy_duration(),
        snapshot.documents_copy_duration(),
    ];
    assert!(attempted_tables.iter().all(|duration| !duration.is_zero()));
    assert!(attempted_tables.into_iter().sum::<Duration>() <= snapshot.copy_duration());
    assert!(snapshot.relation_validation_duration().is_zero());
    assert_generation_is_empty(fixture, &generation_id).await;
    assert!(
        fixture
            .database
            .fail_generation(RecoverableGeneration::Staged(staged), &fence)
            .await
            .is_ok()
    );
    assert!(fixture.database.release_lease(&lease).await.is_ok());
}

async fn acquire_generation_lease(
    fixture: &DatabaseFixture,
    generation_id: &GenerationId,
) -> ProjectLease {
    let target = LeaseTarget::new(
        fixture.project.clone(),
        ProjectOperation::Index,
        Some(generation_id.clone()),
    );
    match fixture
        .database
        .acquire_lease(LeaseRequest::new(
            target,
            LeaseOwner::new(process::id(), format!("ingest-test-{generation_id}")),
            TEST_LEASE_DURATION,
        ))
        .await
    {
        Ok(lease) => lease,
        Err(error) => panic!("ingest test lease acquisition failed: {error}"),
    }
}

fn rejected_facts() -> GenerationFacts {
    GenerationFacts {
        files: vec![FileInput {
            file_id: file_id(FILE_REJECTED),
            normalized_path: "src/reject.rs".to_owned(),
            language: "rust".to_owned(),
            content_hash: digest(CONTENT_HASH_REJECTED),
            byte_size: 16,
            parse_status: FileParseStatus::Parsed,
        }],
        symbols: Vec::new(),
        edges: Vec::new(),
        references: Vec::new(),
        numerical_sites: Vec::new(),
        documents: vec![SearchDocumentInput {
            document_id: document_id(DOCUMENT_REJECTED),
            file_id: Some(file_id(FILE_REJECTED)),
            symbol_id: None,
            path: "src/reject.rs".to_owned(),
            language: "rust".to_owned(),
            kind: DocumentKind::File,
            qualified_name: String::new(),
            code: "fn rejected() {}".to_owned(),
            natural_text: String::new(),
            metadata: serde_json::json!({}),
        }],
    }
}

async fn assert_generation_is_empty(fixture: &DatabaseFixture, generation: &GenerationId) {
    let statement = format!(
        r#"SELECT
                (SELECT count(*) FROM "{schema}"."files" WHERE generation_id = CAST($1 AS uuid))
              + (SELECT count(*) FROM "{schema}"."symbols" WHERE generation_id = CAST($1 AS uuid))
              + (SELECT count(*) FROM "{schema}"."edges" WHERE generation_id = CAST($1 AS uuid))
              + (SELECT count(*) FROM "{schema}"."references" WHERE generation_id = CAST($1 AS uuid))
              + (SELECT count(*) FROM "{schema}"."numerical_sites" WHERE generation_id = CAST($1 AS uuid))
              + (SELECT count(*) FROM "{schema}"."search_documents" WHERE generation_id = CAST($1 AS uuid))
                AS fact_count"#,
        schema = fixture.schema,
    );
    let row = query(AssertSqlSafe(statement))
        .bind(generation.as_str())
        .fetch_one(&fixture.pool)
        .await;
    assert!(matches!(
        row.and_then(|row| row.try_get::<i64, _>("fact_count")),
        Ok(0)
    ));
}

async fn drop_schema(pool: &sqlx_postgres::PgPool, schema: &str) {
    let statement = format!("DROP SCHEMA IF EXISTS \"{schema}\" CASCADE");
    if let Err(error) = query(AssertSqlSafe(statement)).execute(pool).await {
        panic!("failed to drop isolated ingest-test schema: {error}");
    }
}

fn file_id(raw: &str) -> FileId {
    match FileId::parse(raw) {
        Ok(id) => id,
        Err(error) => panic!("fixture file UUID is invalid: {error}"),
    }
}

fn symbol_id(raw: &str) -> SymbolId {
    match SymbolId::parse(raw) {
        Ok(id) => id,
        Err(error) => panic!("fixture symbol UUID is invalid: {error}"),
    }
}

fn document_id(raw: &str) -> DocumentId {
    match DocumentId::parse(raw) {
        Ok(id) => id,
        Err(error) => panic!("fixture document UUID is invalid: {error}"),
    }
}

fn digest(raw: &str) -> ContentDigest {
    match ContentDigest::parse(raw) {
        Ok(digest) => digest,
        Err(error) => panic!("fixture digest is invalid: {error}"),
    }
}
