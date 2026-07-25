use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{ExtractedFile, NativeExtractor, SourceLimits, SourceSnapshot};

const SOURCE_LIMIT: usize = 1024 * 1024;

#[test]
fn sql_ddl_emits_schema_objects_columns_and_cross_object_relations() {
    let source = r#"
CREATE SCHEMA reporting;
CREATE TYPE order_status AS ENUM ('pending', 'shipped', 'sk_live_must_not_escape');
CREATE TYPE point AS (x FLOAT, y FLOAT);

CREATE TABLE "public"."users" (
  id BIGINT PRIMARY KEY,
  status order_status NOT NULL
);
CREATE TABLE reporting.orders (
  id BIGINT PRIMARY KEY,
  user_id BIGINT REFERENCES "public"."users"(id)
);
CREATE VIEW reporting.active_orders AS
  SELECT o.id FROM reporting.orders o
  JOIN "public"."users" u ON u.id = o.user_id;

CREATE FUNCTION reporting.find_orders(user_id BIGINT) RETURNS BIGINT AS 'SELECT user_id' LANGUAGE SQL;
CREATE TRIGGER orders_audit AFTER INSERT ON reporting.orders
  FOR EACH ROW EXECUTE FUNCTION reporting.audit_orders();

SELECT * FROM reporting.orders;
CREATE INDEX idx_orders_user ON reporting.orders(user_id);
"#;
    let first = extract("db/schema.sql", source);
    let second = extract("db/schema.sql", source);
    assert_eq!(first, second);

    for (kind, qualified_name, signature) in [
        (
            SymbolKind::Namespace,
            "reporting",
            "CREATE SCHEMA reporting",
        ),
        (SymbolKind::Enum, "order_status", "CREATE TYPE order_status"),
        (SymbolKind::TypeAlias, "point", "CREATE TYPE point"),
        (
            SymbolKind::Table,
            "public.users",
            "CREATE TABLE public.users",
        ),
        (
            SymbolKind::Table,
            "reporting.orders",
            "CREATE TABLE reporting.orders",
        ),
        (
            SymbolKind::Table,
            "reporting.active_orders",
            "CREATE VIEW reporting.active_orders",
        ),
        (
            SymbolKind::Function,
            "reporting.find_orders",
            "CREATE FUNCTION reporting.find_orders(user_id BIGINT)",
        ),
        (
            SymbolKind::Function,
            "orders_audit",
            "CREATE TRIGGER orders_audit",
        ),
    ] {
        assert_symbol(&first, kind, qualified_name, signature);
    }

    for (qualified_name, signature) in [
        ("public.users::id", "BIGINT"),
        ("public.users::status", "order_status"),
        ("reporting.orders::id", "BIGINT"),
        ("reporting.orders::user_id", "BIGINT"),
    ] {
        assert_symbol(&first, SymbolKind::Field, qualified_name, signature);
    }

    let orders = symbol(&first, SymbolKind::Table, "reporting.orders");
    assert_reference(
        &first,
        &orders.id,
        "public.users",
        ReferenceKind::References,
    );
    let view = symbol(&first, SymbolKind::Table, "reporting.active_orders");
    assert_reference(
        &first,
        &view.id,
        "reporting.orders",
        ReferenceKind::References,
    );
    assert_reference(&first, &view.id, "public.users", ReferenceKind::References);
    let trigger = symbol(&first, SymbolKind::Function, "orders_audit");
    assert_reference(
        &first,
        &trigger.id,
        "reporting.orders",
        ReferenceKind::References,
    );
    assert_reference(
        &first,
        &trigger.id,
        "reporting.audit_orders",
        ReferenceKind::Calls,
    );

    assert!(first.symbols.iter().all(|symbol| {
        symbol.name != "idx_orders_user"
            && !symbol.name.contains("sk_live")
            && !symbol.qualified_name.contains("sk_live")
            && !symbol
                .signature
                .as_deref()
                .is_some_and(|signature| signature.contains("sk_live"))
    }));
}

#[test]
fn plain_sql_dml_and_malformed_create_statements_do_not_invent_declarations() {
    let extracted = extract(
        "db/queries.sql",
        "SELECT * FROM users; INSERT INTO orders(id) VALUES (1); UPDATE users SET id = 2; CREATE TABLE;",
    );
    assert!(
        extracted.symbols.is_empty(),
        "unexpected symbols: {:?}",
        extracted.symbols
    );
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let snapshot = SourceSnapshot::from_bytes(path, source.as_bytes(), limits())
        .unwrap_or_else(|error| panic!("SQL snapshot failed: {error}"));
    assert_eq!(snapshot.language(), SourceLanguage::Sql);
    let mut extractor = NativeExtractor::new(snapshot.language())
        .unwrap_or_else(|error| panic!("SQL extractor failed: {error}"));
    extractor
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("SQL extraction failed: {error}"))
}

fn assert_symbol(file: &ExtractedFile, kind: SymbolKind, qualified_name: &str, signature: &str) {
    let symbol = symbol(file, kind, qualified_name);
    assert_eq!(symbol.signature.as_deref(), Some(signature));
}

fn symbol<'file>(
    file: &'file ExtractedFile,
    kind: SymbolKind,
    qualified_name: &str,
) -> &'file cartograph_extract::ExtractedSymbol {
    let matches = file
        .symbols
        .iter()
        .filter(|symbol| symbol.kind == kind && symbol.qualified_name == qualified_name)
        .collect::<Vec<_>>();
    assert_eq!(
        matches.len(),
        1,
        "expected one {kind:?} {qualified_name}: {:?}",
        file.symbols
    );
    matches[0]
}

fn assert_reference(
    file: &ExtractedFile,
    owner: &cartograph_domain::SymbolId,
    target: &str,
    kind: ReferenceKind,
) {
    assert!(
        file.references.iter().any(|reference| {
            reference.owner.as_ref() == Some(owner)
                && reference.name == target
                && reference.kind == kind
        }),
        "missing {kind:?} reference to {target}: {:?}",
        file.references
    );
}

fn limits() -> SourceLimits {
    SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("SQL source limit failed: {error}"))
}
