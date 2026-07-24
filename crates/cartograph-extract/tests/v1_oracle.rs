use std::collections::{BTreeMap, BTreeSet};

use cartograph_domain::{FileParseStatus, ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{
    ExtractError, ExtractedFile, ImportBindingKind, NativeExtractor, SnapshotError, SourceLimits,
    SourceSnapshot,
};
use serde::Deserialize;

const TYPESCRIPT_SOURCE: &str = include_str!("fixtures/v1_1_33/greeter.ts");
const JAVASCRIPT_SOURCE: &str = include_str!("fixtures/v1_1_33/worker.js");
const TSX_SOURCE: &str = include_str!("fixtures/v1_1_33/view.tsx");
const JSX_SOURCE: &str = include_str!("fixtures/v1_1_33/card.jsx");
const EXPECTED: &str = include_str!("fixtures/v1_1_33/expected.json");
const BODY_SEARCH_CALL_COUNT: usize = 1_200;
const BODY_SEARCH_MAX_BYTES: usize = 16 * 1024;

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct Oracle {
    baseline: String,
    cases: Vec<OracleCase>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct OracleCase {
    path: String,
    language: String,
    symbols: Vec<OracleSymbol>,
    containments: Vec<OracleContainment>,
    references: Vec<OracleReference>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct OracleSymbol {
    kind: String,
    name: String,
    qualified_name: String,
    start_line: u32,
    end_line: u32,
    start_column: u32,
    end_column: u32,
    signature: Option<String>,
    docstring: Option<String>,
    exported: bool,
    default_export: bool,
    async_symbol: bool,
    static_member: bool,
    visibility: Option<String>,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct OracleContainment {
    parent: String,
    child: String,
}

#[derive(Debug, Deserialize, PartialEq, Eq)]
struct OracleReference {
    owner: Option<String>,
    name: String,
    kind: String,
    line: u32,
    column: u32,
}

#[test]
fn source_snapshot_enforces_path_language_size_utf8_and_exact_blake3() {
    let limits = limits(64);
    let source_snapshot = snapshot("src\\feature\\answer.MTS", b"abc", limits);
    assert_eq!(source_snapshot.path().as_str(), "src/feature/answer.MTS");
    assert_eq!(source_snapshot.language(), SourceLanguage::TypeScript);
    assert_eq!(source_snapshot.byte_size(), 3);
    assert_eq!(
        source_snapshot.content_hash().as_str(),
        "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
    );

    assert!(matches!(
        SourceSnapshot::from_bytes("../escape.ts", b"abc", limits),
        Err(SnapshotError::InvalidPath)
    ));
    assert!(matches!(
        SourceSnapshot::from_bytes("src/image.png", b"abc", limits),
        Err(SnapshotError::UnsupportedLanguage)
    ));
    assert!(matches!(
        SourceSnapshot::from_bytes("src/large.ts", &[0; 65], limits),
        Err(SnapshotError::SourceTooLarge)
    ));
    assert!(matches!(
        SourceSnapshot::from_bytes("src/bad.ts", &[0xff], limits),
        Err(SnapshotError::InvalidUtf8)
    ));
    assert_eq!(
        snapshot(
            "src/view.tsx",
            b"export const View = () => <div />;",
            limits
        )
        .language(),
        SourceLanguage::Tsx
    );
    assert_eq!(
        snapshot(
            "src/view.jsx",
            b"export const View = () => <div />;",
            limits
        )
        .language(),
        SourceLanguage::Jsx
    );
}

#[test]
fn native_extractor_matches_the_locked_v1_1_33_projection() {
    let oracle = parse_oracle();
    assert_eq!(oracle.baseline, "v1.1.33");

    let actual = [
        extract("src/greeter.ts", TYPESCRIPT_SOURCE),
        extract("src/worker.js", JAVASCRIPT_SOURCE),
        extract("src/view.tsx", TSX_SOURCE),
        extract("src/card.jsx", JSX_SOURCE),
    ];
    let projected = actual.iter().map(project_v1_compatible).collect::<Vec<_>>();
    assert_eq!(projected, oracle.cases);
}

#[test]
fn formatting_changes_preserve_symbol_identity_and_structural_digest() {
    let compact = extract(
        "src/stable.ts",
        "export function greet(name: string): string { return name; }\n",
    );
    let formatted = extract(
        "src/stable.ts",
        "/** unrelated documentation */\nexport function greet( name: string ): string {\n  return name;\n}\n",
    );
    let compact_symbol = symbol(&compact, "greet");
    let formatted_symbol = symbol(&formatted, "greet");
    assert_eq!(compact_symbol.id, formatted_symbol.id);
    assert_eq!(
        compact_symbol.structural_digest,
        formatted_symbol.structural_digest
    );
    assert_ne!(compact.content_hash, formatted.content_hash);
}

#[test]
fn same_name_ordinals_are_distinct_and_line_independent() {
    let first = extract(
        "src/overloads.ts",
        "function parse(value: string): string { return value; }\nfunction parse(value: unknown): string { return String(value); }\n",
    );
    let second = extract(
        "src/overloads.ts",
        "\n\nfunction parse(value: string): string { return value; }\n\nfunction parse(value: unknown): string { return String(value); }\n",
    );
    let first_ids = first
        .symbols
        .iter()
        .filter(|entry| entry.name == "parse")
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    let second_ids = second
        .symbols
        .iter()
        .filter(|entry| entry.name == "parse")
        .map(|entry| entry.id.clone())
        .collect::<Vec<_>>();
    assert_eq!(first_ids.len(), 2);
    assert_ne!(first_ids[0], first_ids[1]);
    assert_eq!(first_ids, second_ids);
}

#[test]
fn inserting_a_same_named_symbol_in_another_scope_preserves_existing_identity() {
    let before = extract("src/scoped.ts", "class Existing { run(): void {} }\n");
    let after = extract(
        "src/scoped.ts",
        "class Inserted { run(): void {} }\nclass Existing { run(): void {} }\n",
    );

    assert_eq!(
        qualified_symbol(&before, "Existing::run").id,
        qualified_symbol(&after, "Existing::run").id
    );
}

#[test]
fn enum_members_do_not_include_property_names_from_initializer_expressions() {
    let file = extract(
        "src/state.ts",
        "enum State { /** state docs */ Ready = config.value, Waiting }\n",
    );
    let members = file
        .symbols
        .iter()
        .filter(|symbol| symbol.kind == cartograph_domain::SymbolKind::EnumMember)
        .map(|symbol| symbol.name.as_str())
        .collect::<Vec<_>>();

    assert_eq!(members, vec!["Ready", "Waiting"]);
}

#[test]
fn type_aliases_capture_bare_and_nested_type_references() {
    let file = extract(
        "src/types.ts",
        "export type Direct = User;\nexport type Result = Promise<User>;\n",
    );

    assert_eq!(
        owned_reference_names(&file, "Direct", ReferenceKind::TypeOf),
        vec!["User"]
    );
    assert_eq!(
        owned_reference_names(&file, "Result", ReferenceKind::TypeOf),
        vec!["Promise", "User"]
    );
}

#[test]
fn typed_function_and_arrow_components_keep_parameter_and_return_types() {
    let file = extract(
        "src/typed-components.tsx",
        "export function Panel(props: PanelProps): PanelView { return <Card />; }\nexport const Tile = (props: TileProps): TileView => <Card />;\n",
    );

    for (owner, parameter, returned) in [
        ("Panel", "PanelProps", "PanelView"),
        ("Tile", "TileProps", "TileView"),
    ] {
        assert_eq!(
            owned_reference_names(&file, owner, ReferenceKind::TypeOf),
            vec![parameter, returned]
        );
        assert_eq!(
            owned_reference_names(&file, owner, ReferenceKind::Returns),
            vec![returned]
        );
    }
}

#[test]
fn import_bindings_preserve_module_imported_and_local_names() {
    let file = extract(
        "src/consumer.ts",
        "import DefaultThing, { Service as S, other } from './service';\n\
         import * as tools from './tools';\n\
         import './side-effect';\n",
    );
    let bindings = file
        .import_bindings
        .iter()
        .map(|binding| {
            (
                binding.kind,
                binding.module_specifier.as_str(),
                binding.imported_name.as_str(),
                binding.local_name.as_str(),
            )
        })
        .collect::<Vec<_>>();

    assert_eq!(
        bindings,
        vec![
            (
                ImportBindingKind::Default,
                "./service",
                "default",
                "DefaultThing",
            ),
            (ImportBindingKind::Named, "./service", "Service", "S",),
            (ImportBindingKind::Named, "./service", "other", "other",),
            (ImportBindingKind::Namespace, "./tools", "*", "tools",),
        ]
    );
}

#[test]
fn body_search_text_is_bounded_identifier_only_and_literal_safe() {
    const SECRET: &str = "sk-live-body-secret-should-never-be-indexed";
    let calls = (0..BODY_SEARCH_CALL_COUNT)
        .map(|index| format!("client.operation_{index}(value);"))
        .collect::<String>();
    let source = format!(
        "export function execute(client: Client, value: Value): void {{ {calls} throw new Error('{SECRET}'); }}\n"
    );
    let file = extract("src/body.ts", &source);
    let execute = symbol(&file, "execute");

    assert!(execute.body_search_text.contains("client"));
    assert!(execute.body_search_text.contains("operation_0"));
    assert!(execute.body_search_text.contains("Error"));
    assert!(!execute.body_search_text.contains(SECRET));
    assert!(execute.body_search_text.len() <= BODY_SEARCH_MAX_BYTES);
    assert!(execute.body_search_truncated);
}

#[test]
fn declaration_only_overloads_are_explicit_and_keep_one_implementation() {
    let file = extract(
        "src/overloads.ts",
        "export function parse(value: string): string;\n\
         export function parse(value: number): string;\n\
         export function parse(value: unknown): string { return String(value); }\n\
         export interface Runner { run(value: string): void; }\n",
    );
    let parse = file
        .symbols
        .iter()
        .filter(|symbol| symbol.name == "parse")
        .collect::<Vec<_>>();

    assert_eq!(parse.len(), 3);
    assert_eq!(
        parse
            .iter()
            .filter(|symbol| symbol.declaration_only)
            .count(),
        2
    );
    let implementations = parse
        .iter()
        .filter(|symbol| !symbol.declaration_only)
        .collect::<Vec<_>>();
    assert_eq!(implementations.len(), 1);
    assert!(implementations[0].body_search_text.contains("String"));
    assert!(
        file.symbols
            .iter()
            .any(|symbol| symbol.qualified_name == "Runner::run" && symbol.declaration_only)
    );
}

#[test]
fn structural_digest_preserves_semantic_template_and_jsx_whitespace() {
    let template_compact = extract("src/template.ts", "const label = `hello`;\n");
    let template_spaced = extract("src/template.ts", "const label = ` hello `;\n");
    assert_ne!(
        symbol(&template_compact, "label").structural_digest,
        symbol(&template_spaced, "label").structural_digest
    );

    let jsx_compact = extract(
        "src/message.tsx",
        "export const Message = () => <div>hello</div>;\n",
    );
    let jsx_spaced = extract(
        "src/message.tsx",
        "export const Message = () => <div> hello </div>;\n",
    );
    assert_ne!(
        symbol(&jsx_compact, "Message").structural_digest,
        symbol(&jsx_spaced, "Message").structural_digest
    );
}

#[test]
fn oversized_non_doc_comment_and_doc_gap_do_not_abort_extraction() {
    let ordinary = format!("/*{}*/\nfunction ordinary() {{}}\n", "x".repeat(300 * 1024));
    let ordinary_file = extract("src/ordinary.ts", &ordinary);
    assert!(symbol(&ordinary_file, "ordinary").docstring.is_none());

    let separated = format!(
        "/** small docs */{}function separated() {{}}\n",
        " ".repeat(300 * 1024)
    );
    let separated_file = extract("src/separated.ts", &separated);
    assert!(symbol(&separated_file, "separated").docstring.is_none());
}

#[test]
fn adversarial_qualified_names_stop_at_the_modeled_output_limit() {
    let mut source = String::new();
    for index in 0..80 {
        source.push_str("function scope_");
        source.push_str(&index.to_string());
        source.push('_');
        source.push_str(&"n".repeat(240));
        source.push_str("() {");
    }
    source.push_str("return;");
    source.push_str(&"}".repeat(80));
    let snapshot = snapshot("src/adversarial.ts", source.as_bytes(), limits(1024 * 1024));
    let mut extractor = native(SourceLanguage::TypeScript);

    assert!(matches!(
        extractor.extract(&snapshot),
        Err(ExtractError::OutputLimit)
    ));
}

#[test]
fn one_oversized_fact_string_stops_before_copying_the_reference() {
    let source = format!("const value = {};\n", "identifier".repeat(32 * 1024));
    let snapshot = snapshot(
        "src/oversized-reference.ts",
        source.as_bytes(),
        limits(1024 * 1024),
    );
    let mut extractor = native(SourceLanguage::TypeScript);

    assert!(matches!(
        extractor.extract(&snapshot),
        Err(ExtractError::OutputLimit)
    ));
}

#[test]
fn cancellation_and_recoverable_syntax_damage_are_explicit() {
    let snapshot = snapshot(
        "src/cancel.ts",
        TYPESCRIPT_SOURCE.as_bytes(),
        limits(1024 * 1024),
    );
    let mut extractor = native(SourceLanguage::TypeScript);
    assert!(matches!(
        extractor.extract_with_cancellation(&snapshot, || true),
        Err(ExtractError::Cancelled)
    ));

    let damaged = extract(
        "src/damaged.ts",
        "export function useful(): number { return 1; }\nfunction broken( {\n",
    );
    assert_eq!(damaged.parse_status, FileParseStatus::Partial);
    assert!(!damaged.diagnostics.is_empty());
    assert!(damaged.symbols.iter().any(|entry| entry.name == "useful"));
}

fn project_v1_compatible(file: &ExtractedFile) -> OracleCase {
    let projected_ids = file
        .symbols
        .iter()
        .filter(|symbol| !symbol.declaration_only)
        .map(|symbol| symbol.id.as_str())
        .collect::<BTreeSet<_>>();
    let names = file
        .symbols
        .iter()
        .map(|symbol| (symbol.id.as_str(), symbol.name.as_str()))
        .collect::<BTreeMap<_, _>>();
    let kinds = file
        .symbols
        .iter()
        .map(|symbol| (symbol.id.as_str(), symbol.kind))
        .collect::<BTreeMap<_, _>>();
    OracleCase {
        path: file.path.as_str().to_owned(),
        language: file.language.as_str().to_owned(),
        symbols: file
            .symbols
            .iter()
            .filter(|symbol| projected_ids.contains(symbol.id.as_str()))
            .map(|symbol| OracleSymbol {
                kind: symbol.kind.as_str().to_owned(),
                name: symbol.name.clone(),
                qualified_name: symbol.qualified_name.clone(),
                start_line: symbol.span.start_line(),
                end_line: symbol.span.end_line(),
                start_column: symbol.span.start_column(),
                end_column: symbol.span.end_column(),
                signature: symbol.signature.clone(),
                docstring: symbol.docstring.clone(),
                exported: symbol.exported,
                default_export: symbol.default_export,
                async_symbol: symbol.async_symbol,
                static_member: symbol.static_member,
                visibility: symbol.visibility.map(|value| value.as_str().to_owned()),
            })
            .collect(),
        containments: file
            .containments
            .iter()
            .filter(|edge| {
                projected_ids.contains(edge.parent.as_str())
                    && projected_ids.contains(edge.child.as_str())
            })
            .map(|edge| OracleContainment {
                parent: name_for(&names, edge.parent.as_str()),
                child: name_for(&names, edge.child.as_str()),
            })
            .collect(),
        references: file
            .references
            .iter()
            .filter(|reference| {
                if reference
                    .owner
                    .as_ref()
                    .is_some_and(|owner| !projected_ids.contains(owner.as_str()))
                {
                    return false;
                }
                let owner_kind = reference
                    .owner
                    .as_ref()
                    .and_then(|owner| kinds.get(owner.as_str()))
                    .copied();
                owner_kind != Some(SymbolKind::Component)
                    || !matches!(
                        reference.kind,
                        ReferenceKind::TypeOf | ReferenceKind::Returns
                    )
            })
            .map(|reference| OracleReference {
                owner: reference
                    .owner
                    .as_ref()
                    .map(|owner| name_for(&names, owner.as_str())),
                name: reference.name.clone(),
                kind: reference.kind.as_str().to_owned(),
                line: reference.span.start_line(),
                column: reference.span.start_column(),
            })
            .collect(),
    }
}

fn name_for(names: &BTreeMap<&str, &str>, id: &str) -> String {
    match names.get(id) {
        Some(name) => (*name).to_owned(),
        None => panic!("oracle projection referenced an unknown symbol"),
    }
}

fn parse_oracle() -> Oracle {
    match serde_json::from_str(EXPECTED) {
        Ok(oracle) => oracle,
        Err(error) => panic!("locked v1.1.33 oracle is invalid: {error}"),
    }
}

fn limits(max_source_bytes: usize) -> SourceLimits {
    match SourceLimits::new(max_source_bytes) {
        Ok(limits) => limits,
        Err(error) => panic!("test source limit is invalid: {error}"),
    }
}

fn snapshot(path: &str, bytes: &[u8], limits: SourceLimits) -> SourceSnapshot {
    match SourceSnapshot::from_bytes(path, bytes, limits) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("test source snapshot failed: {error}"),
    }
}

fn native(language: SourceLanguage) -> NativeExtractor {
    match NativeExtractor::new(language) {
        Ok(extractor) => extractor,
        Err(error) => panic!("test parser initialization failed: {error}"),
    }
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let snapshot = snapshot(path, source.as_bytes(), limits(1024 * 1024));
    let mut extractor = native(snapshot.language());
    match extractor.extract(&snapshot) {
        Ok(result) => result,
        Err(error) => panic!("test extraction failed: {error}"),
    }
}

fn symbol<'a>(file: &'a ExtractedFile, name: &str) -> &'a cartograph_extract::ExtractedSymbol {
    match file.symbols.iter().find(|entry| entry.name == name) {
        Some(symbol) => symbol,
        None => panic!("expected test symbol was not extracted"),
    }
}

fn qualified_symbol<'a>(
    file: &'a ExtractedFile,
    qualified_name: &str,
) -> &'a cartograph_extract::ExtractedSymbol {
    match file
        .symbols
        .iter()
        .find(|entry| entry.qualified_name == qualified_name)
    {
        Some(symbol) => symbol,
        None => panic!("expected qualified test symbol was not extracted"),
    }
}

fn owned_reference_names<'a>(
    file: &'a ExtractedFile,
    owner_name: &str,
    kind: ReferenceKind,
) -> Vec<&'a str> {
    let owner = symbol(file, owner_name);
    file.references
        .iter()
        .filter(|reference| reference.owner.as_ref() == Some(&owner.id) && reference.kind == kind)
        .map(|reference| reference.name.as_str())
        .collect()
}
