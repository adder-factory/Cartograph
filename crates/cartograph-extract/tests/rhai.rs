//! First-class Rhai structural extraction coverage.

mod dependency_ownership;

use cartograph_domain::{FileParseStatus, ReferenceKind, SourceLanguage, SymbolKind, Visibility};
use cartograph_extract::{
    ExtractError, ImportBindingKind, NativeExtractor, SourceLimits, SourceSnapshot,
};

const SOURCE_LIMIT: usize = 1024 * 1024;
const SECRET_SENTINEL: &str = "cartograph_rhai_literal_secret_sentinel_39f1";

#[test]
fn rhai_extracts_module_semantics_without_executing_or_retaining_literals() {
    let source = r#"
import "./crypto" as lock;
import dynamic_module as ignored;

const GLOBAL_LIMIT = 42;
export GLOBAL_LIMIT as LIMIT;
export let shared_value = 1;

private fn helper(value) {
    hidden(value);
}

fn encrypt_payload(payload, rounds,) {
    let local_value = helper(payload);
    lock::encrypt(local_value);
    payload.transform();
    let literal = "cartograph_rhai_literal_secret_sentinel_39f1 fake_call()";
    // commented_call();
    /* nested /* ignored_call(); */ comment */
    local_value
}

fn café(entrée) {
    encrypt_payload(entrée, 2)
}
"#;
    let snapshot = snapshot("scripts/policy.rhai", source);
    assert_eq!(snapshot.language(), SourceLanguage::Rhai);
    let mut extractor = NativeExtractor::new(SourceLanguage::Rhai)
        .unwrap_or_else(|error| panic!("Rhai extractor failed: {error}"));
    let first = extractor
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("Rhai extraction failed: {error}"));
    let second = extractor
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("Rhai repeat failed: {error}"));

    assert_eq!(first, second);
    assert_eq!(first.parse_status, FileParseStatus::Parsed);
    assert_function_contracts(&first);
    assert_variable_contracts(&first);
    assert_import_contracts(&first);
    assert_call_contracts(&first);
    assert!(!format!("{first:?}").contains(SECRET_SENTINEL));
}

#[test]
fn rhai_marks_malformed_input_partial_and_polls_cancellation() {
    let malformed = snapshot(
        "scripts/malformed.rhai",
        "fn unfinished(value) { let text = \"unterminated\n",
    );
    let mut extractor = NativeExtractor::new(SourceLanguage::Rhai)
        .unwrap_or_else(|error| panic!("Rhai extractor failed: {error}"));
    let extracted = extractor
        .extract(&malformed)
        .unwrap_or_else(|error| panic!("malformed Rhai extraction failed: {error}"));
    assert_eq!(extracted.parse_status, FileParseStatus::Partial);

    let cancelled = snapshot("scripts/cancelled.rhai", "fn ready() { ready(); }\n");
    assert_eq!(
        extractor.extract_with_cancellation(&cancelled, || true),
        Err(ExtractError::Cancelled)
    );
}

fn assert_function_contracts(file: &cartograph_extract::ExtractedFile) {
    let helper = file
        .symbols
        .iter()
        .find(|symbol| symbol.kind == SymbolKind::Function && symbol.name == "helper")
        .unwrap_or_else(|| panic!("private Rhai helper was missing"));
    assert!(!helper.export.exported);
    assert_eq!(helper.visibility, Some(Visibility::Private));

    let encrypt = file
        .symbols
        .iter()
        .find(|symbol| symbol.kind == SymbolKind::Function && symbol.name == "encrypt_payload")
        .unwrap_or_else(|| panic!("public Rhai function was missing"));
    assert!(encrypt.export.exported);
    assert_eq!(encrypt.visibility, Some(Visibility::Public));
    assert_eq!(
        encrypt.signature.as_deref(),
        Some("fn encrypt_payload(payload, rounds)")
    );
    assert!(file.symbols.iter().any(|symbol| {
        symbol.kind == SymbolKind::Function
            && symbol.name == "café"
            && symbol.signature.as_deref() == Some("fn café(entrée)")
    }));
    assert!(file.containments.iter().any(|containment| {
        containment.parent == encrypt.id
            && file.symbols.iter().any(|symbol| {
                symbol.id == containment.child
                    && symbol.kind == SymbolKind::Parameter
                    && symbol.name == "payload"
            })
    }));
}

fn assert_variable_contracts(file: &cartograph_extract::ExtractedFile) {
    assert!(file.symbols.iter().any(|symbol| {
        symbol.kind == SymbolKind::Constant
            && symbol.name == "GLOBAL_LIMIT"
            && symbol.export.exported
    }));
    assert!(file.symbols.iter().any(|symbol| {
        symbol.kind == SymbolKind::Variable
            && symbol.name == "shared_value"
            && symbol.export.exported
    }));
    let local = file
        .symbols
        .iter()
        .find(|symbol| symbol.kind == SymbolKind::Variable && symbol.name == "local_value")
        .unwrap_or_else(|| panic!("Rhai local variable was missing"));
    assert!(file.containments.iter().any(|edge| edge.child == local.id));
    assert!(file.references.iter().any(|reference| {
        reference.kind == ReferenceKind::Exports
            && reference.name == "GLOBAL_LIMIT"
            && reference.resolution_name.as_deref() == Some("LIMIT")
    }));
}

fn assert_import_contracts(file: &cartograph_extract::ExtractedFile) {
    assert!(file.symbols.iter().any(|symbol| {
        symbol.kind == SymbolKind::Import && symbol.name == "lock" && symbol.export.exported
    }));
    assert!(file.import_bindings.iter().any(|binding| {
        binding.kind == ImportBindingKind::Namespace
            && binding.module_specifier == "./crypto"
            && binding.imported_name == "*"
            && binding.local_name == "lock"
    }));
    assert!(file.references.iter().any(|reference| {
        reference.kind == ReferenceKind::Imports && reference.name == "./crypto"
    }));
    assert!(
        file.import_bindings
            .iter()
            .all(|binding| binding.local_name != "ignored")
    );
}

fn assert_call_contracts(file: &cartograph_extract::ExtractedFile) {
    for expected in [
        "hidden",
        "helper",
        "lock::encrypt",
        "transform",
        "encrypt_payload",
    ] {
        assert!(
            file.references.iter().any(|reference| {
                reference.kind == ReferenceKind::Calls && reference.name == expected
            }),
            "missing Rhai call {expected}"
        );
    }
    for excluded in ["fake_call", "commented_call", "ignored_call"] {
        assert!(
            file.references
                .iter()
                .all(|reference| reference.name != excluded),
            "retained masked Rhai call {excluded}"
        );
    }
}

fn snapshot(path: &str, source: &str) -> SourceSnapshot {
    SourceSnapshot::from_bytes(path, source.as_bytes(), limits())
        .unwrap_or_else(|error| panic!("Rhai snapshot failed: {error}"))
}

fn limits() -> SourceLimits {
    SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("Rhai source limit failed: {error}"))
}
