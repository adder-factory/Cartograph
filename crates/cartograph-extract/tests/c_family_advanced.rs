use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind};
use cartograph_extract::{
    ExtractError, ExtractedFile, ExtractedSymbol, NativeExtractor, SourceLimits, SourceSnapshot,
};

const SOURCE_LIMIT: usize = 1024 * 1024;

#[test]
fn namespace_qualified_free_function_definitions_remain_functions() {
    let extracted = extract(
        "src/api.cpp",
        r#"namespace api {
int ping();
}

int api::ping() { return dispatch(); }
"#,
    );

    let namespace = symbol(&extracted, SymbolKind::Namespace, "api", "api");
    let pings = extracted
        .symbols
        .iter()
        .filter(|candidate| candidate.qualified_name == "api::ping")
        .collect::<Vec<_>>();
    assert!(
        !pings.is_empty()
            && pings
                .iter()
                .filter(|candidate| !candidate.declaration_only)
                .count()
                == 1
            && pings
                .iter()
                .all(|candidate| candidate.kind == SymbolKind::Function),
        "a namespace qualifier must produce one implemented free function, never a method: {:?}",
        symbol_facts(&extracted),
    );
    let definition = pings
        .into_iter()
        .find(|candidate| !candidate.declaration_only)
        .unwrap_or_else(|| {
            panic!(
                "missing api::ping definition: {:?}",
                symbol_facts(&extracted)
            )
        });
    assert_containment(&extracted, namespace, definition);
    assert_reference_owned_by(&extracted, definition, "dispatch", ReferenceKind::Calls);
}

#[test]
fn same_bare_type_names_in_namespaces_keep_out_of_class_methods_scoped() {
    let extracted = extract(
        "src/workers.cpp",
        r#"namespace left {
struct Worker { void run(); };
}
namespace right {
struct Worker { void run(); };
}

void left::Worker::run() { left_hook(); }
void right::Worker::run() { right_hook(); }
"#,
    );

    let left_namespace = symbol(&extracted, SymbolKind::Namespace, "left", "left");
    let right_namespace = symbol(&extracted, SymbolKind::Namespace, "right", "right");
    let left_type = symbol(&extracted, SymbolKind::Struct, "Worker", "left::Worker");
    let right_type = symbol(&extracted, SymbolKind::Struct, "Worker", "right::Worker");
    let left_method =
        implemented_symbol(&extracted, SymbolKind::Method, "run", "left::Worker::run");
    let right_method =
        implemented_symbol(&extracted, SymbolKind::Method, "run", "right::Worker::run");

    assert_containment(&extracted, left_namespace, left_type);
    assert_containment(&extracted, right_namespace, right_type);
    assert_containment(&extracted, left_type, left_method);
    assert_containment(&extracted, right_type, right_method);
    assert_no_containment(&extracted, left_type, right_method);
    assert_no_containment(&extracted, right_type, left_method);
    assert_reference_owned_by(&extracted, left_method, "left_hook", ReferenceKind::Calls);
    assert_reference_owned_by(&extracted, right_method, "right_hook", ReferenceKind::Calls);
}

#[test]
fn c_and_cpp_unions_are_real_type_containers() {
    let c = extract(
        "src/payload.c",
        r#"union Payload {
  int code;
  float ratio;
};
"#,
    );
    let payload = symbol(&c, SymbolKind::Union, "Payload", "Payload");
    let code = symbol(&c, SymbolKind::Field, "code", "Payload::code");
    let ratio = symbol(&c, SymbolKind::Field, "ratio", "Payload::ratio");
    assert!(!payload.declaration_only);
    assert_containment(&c, payload, code);
    assert_containment(&c, payload, ratio);

    let cpp = extract(
        "src/result.cpp",
        r#"namespace wire {
union Result { int ok; int error; };
}
"#,
    );
    let namespace = symbol(&cpp, SymbolKind::Namespace, "wire", "wire");
    let result = symbol(&cpp, SymbolKind::Union, "Result", "wire::Result");
    let ok = symbol(&cpp, SymbolKind::Field, "ok", "wire::Result::ok");
    assert_containment(&cpp, namespace, result);
    assert_containment(&cpp, result, ok);
}

#[test]
fn c_family_aliases_emit_qualified_type_of_targets() {
    let extracted = extract(
        "src/aliases.cpp",
        r#"namespace wire { struct Payload {}; }
using PayloadAlias = wire::Payload;
typedef wire::Payload LegacyPayload;
"#,
    );

    let modern = symbol(
        &extracted,
        SymbolKind::TypeAlias,
        "PayloadAlias",
        "PayloadAlias",
    );
    let legacy = symbol(
        &extracted,
        SymbolKind::TypeAlias,
        "LegacyPayload",
        "LegacyPayload",
    );
    assert_reference_owned_by(&extracted, modern, "wire::Payload", ReferenceKind::TypeOf);
    assert_reference_owned_by(&extracted, legacy, "wire::Payload", ReferenceKind::TypeOf);
}

#[test]
fn function_prototypes_are_declarations_but_function_pointers_are_variables() {
    let extracted = extract(
        "include/callbacks.h",
        r#"int send_value(int value);
static int local_probe(int value);
int (*callback)(int value);
extern int (*external_callback)(int value);
"#,
    );

    let send = symbol(&extracted, SymbolKind::Function, "send_value", "send_value");
    let local = symbol(
        &extracted,
        SymbolKind::Function,
        "local_probe",
        "local_probe",
    );
    assert!(send.declaration_only);
    assert!(local.declaration_only);
    assert_eq!(send.signature.as_deref(), Some("int (int value)"));
    assert_eq!(local.signature.as_deref(), Some("int (int value)"));

    let callback = symbol(&extracted, SymbolKind::Variable, "callback", "callback");
    let external_callback = symbol(
        &extracted,
        SymbolKind::Variable,
        "external_callback",
        "external_callback",
    );
    assert!(!callback.declaration_only);
    assert!(!external_callback.declaration_only);
    assert!(
        extracted.symbols.iter().all(|candidate| {
            candidate.kind != SymbolKind::Function
                || !matches!(candidate.name.as_str(), "callback" | "external_callback")
        }),
        "function-pointer variables were misclassified: {:?}",
        symbol_facts(&extracted),
    );
}

#[test]
fn forward_class_struct_and_union_declarations_are_declaration_only() {
    let cpp = extract(
        "include/forward.hpp",
        r#"class Widget;
struct Record;
union Packet;
namespace api { class Client; }
"#,
    );
    for forward in [
        symbol(&cpp, SymbolKind::Class, "Widget", "Widget"),
        symbol(&cpp, SymbolKind::Struct, "Record", "Record"),
        symbol(&cpp, SymbolKind::Union, "Packet", "Packet"),
        symbol(&cpp, SymbolKind::Class, "Client", "api::Client"),
    ] {
        assert!(
            forward.declaration_only,
            "forward type was treated as a definition: {:?}",
            symbol_facts(&cpp),
        );
    }

    let c = extract("include/forward.h", "struct CRecord;\nunion CPacket;\n");
    assert!(symbol(&c, SymbolKind::Struct, "CRecord", "CRecord").declaration_only);
    assert!(symbol(&c, SymbolKind::Union, "CPacket", "CPacket").declaration_only);
}

#[test]
fn external_and_file_static_linkage_are_exposed_through_export_metadata() {
    let extracted = extract(
        "src/linkage.c",
        r#"int external_definition(void) { return 1; }
static int internal_definition(void) { return 2; }
int external_value;
extern int declared_external_value;
static int internal_value;
"#,
    );

    for qualified_name in [
        "external_definition",
        "external_value",
        "declared_external_value",
    ] {
        assert!(
            symbol_named(&extracted, qualified_name).exported,
            "external-linkage symbol was not marked exported: {qualified_name}; facts={:?}",
            symbol_facts(&extracted),
        );
    }
    for qualified_name in ["internal_definition", "internal_value"] {
        let candidate = symbol_named(&extracted, qualified_name);
        assert!(
            !candidate.exported,
            "file-static symbol was marked externally visible: {qualified_name}; facts={:?}",
            symbol_facts(&extracted),
        );
        assert!(
            !candidate.static_member,
            "file linkage must not overload class static-member metadata: {qualified_name}",
        );
    }
}

#[test]
fn cpp_and_cuda_new_expressions_emit_safe_instantiation_targets() {
    let cpp = extract(
        "src/build.cpp",
        r#"namespace arena { template<typename T> class Box {}; }
void build() {
  auto *box = new ::arena::Box<arena::Widget>();
  auto *bytes = new unsigned char[8];
  auto *count = new long;
}
"#,
    );
    assert_eq!(
        owned_reference_names(&cpp, "build", ReferenceKind::Instantiates),
        vec!["arena::Box"],
        "qualified template targets must be normalized without template arguments or builtins",
    );

    let cuda = extract(
        "kernels/allocate.cu",
        r#"namespace device { template<typename T> struct Buffer {}; }
__device__ void allocate() {
  auto *buffer = new device::Buffer<float>();
  auto *scalar = new int;
}
"#,
    );
    assert_eq!(cuda.language, SourceLanguage::Cuda);
    assert_eq!(
        owned_reference_names(&cuda, "allocate", ReferenceKind::Instantiates),
        vec!["device::Buffer"],
        "CUDA must share C++ new-expression normalization and builtin exclusion",
    );
}

#[test]
fn contiguous_ordinary_and_doxygen_comments_form_exact_docs() {
    let extracted = extract(
        "src/docs.cpp",
        r#"/* Ordinary block.
 * Second line.
 */
int block_doc() { return 0; }

/**
 * Doxygen block.
 * More details.
 */
int doxygen_block() { return 0; }

/// Doxygen line one.
/// Doxygen line two.
int doxygen_line() { return 0; }

// Ordinary line one.
// Ordinary line two.
int ordinary_line() { return 0; }

// Mixed ordinary.
/** Mixed Doxygen block. */
//! Mixed Doxygen line.
int mixed() { return 0; }
"#,
    );

    assert_doc(&extracted, "block_doc", "Ordinary block.\nSecond line.");
    assert_doc(&extracted, "doxygen_block", "Doxygen block.\nMore details.");
    assert_doc(
        &extracted,
        "doxygen_line",
        "Doxygen line one.\nDoxygen line two.",
    );
    assert_doc(
        &extracted,
        "ordinary_line",
        "Ordinary line one.\nOrdinary line two.",
    );
    assert_doc(
        &extracted,
        "mixed",
        "Mixed ordinary.\nMixed Doxygen block.\nMixed Doxygen line.",
    );
}

#[test]
fn blank_lines_detach_docs_and_decorative_rules_are_not_retained() {
    let extracted = extract(
        "src/doc-boundaries.c",
        r#"/* Stale paragraph. */

/// Current heading.
/// =================
/// Current details.
int documented(void) { return 0; }

// Detached text.

int detached(void) { return 0; }

// -----------------
int decorative_only(void) { return 0; }
"#,
    );

    assert_doc(
        &extracted,
        "documented",
        "Current heading.\n\nCurrent details.",
    );
    assert!(
        symbol_named(&extracted, "documented")
            .docstring
            .as_deref()
            .is_some_and(
                |docstring| !docstring.contains("Stale paragraph") && !docstring.contains("====")
            )
    );
    assert!(symbol_named(&extracted, "detached").docstring.is_none());
    assert!(
        symbol_named(&extracted, "decorative_only")
            .docstring
            .is_none()
    );
}

#[test]
fn doc_collection_is_bounded_and_large_docs_remain_cancellable() {
    let mut bounded = String::new();
    for index in 0..1_030 {
        bounded.push_str("// entry-");
        let digits = index.to_string();
        for _ in digits.len()..4 {
            bounded.push('0');
        }
        bounded.push_str(&digits);
        bounded.push('\n');
    }
    bounded.push_str("int bounded(void) { return 0; }\n");
    let extracted = extract("src/bounded-docs.c", &bounded);
    let docstring = symbol_named(&extracted, "bounded")
        .docstring
        .as_deref()
        .unwrap_or_else(|| panic!("bounded contiguous docs were not retained"));
    let lines = docstring.lines().collect::<Vec<_>>();
    assert_eq!(lines.len(), 1_024);
    assert_eq!(lines.first().copied(), Some("entry-0006"));
    assert_eq!(lines.last().copied(), Some("entry-1029"));

    let oversized = format!(
        "/* {} */\nint oversized(void) {{ return 0; }}\n",
        "x".repeat(300 * 1024),
    );
    let oversized_file = extract("src/oversized-doc.c", &oversized);
    assert!(
        symbol_named(&oversized_file, "oversized")
            .docstring
            .is_none()
    );

    let cancellable = format!(
        "/** {} */\nint cancellable(void) {{ return 0; }}\n",
        "documented ".repeat(12_000),
    );
    let snapshot = capability_snapshot("src/cancellable-doc.c", &cancellable);
    let mut extractor = capability_extractor(snapshot.language());
    let mut polls = 0_usize;
    let result = extractor.extract_with_cancellation(&snapshot, || {
        polls = polls.saturating_add(1);
        polls > 16
    });
    assert_eq!(result, Err(ExtractError::Cancelled));
    assert!(polls > 16);
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let snapshot = capability_snapshot(path, source);
    capability_extractor(snapshot.language())
        .extract(&snapshot)
        .unwrap_or_else(|error| panic!("extraction failed for {path}: {error}"))
}

fn capability_snapshot(path: &str, source: &str) -> SourceSnapshot {
    let limits = SourceLimits::new(SOURCE_LIMIT)
        .unwrap_or_else(|error| panic!("source limits failed: {error}"));
    SourceSnapshot::from_bytes_for_capability_validation(path, source.as_bytes(), limits)
        .unwrap_or_else(|error| panic!("snapshot failed for {path}: {error}"))
}

fn capability_extractor(language: SourceLanguage) -> NativeExtractor {
    NativeExtractor::new_for_capability_validation(language)
        .unwrap_or_else(|error| panic!("{language:?} capability extractor failed: {error}"))
}

fn symbol<'file>(
    extracted: &'file ExtractedFile,
    kind: SymbolKind,
    name: &str,
    qualified_name: &str,
) -> &'file ExtractedSymbol {
    extracted
        .symbols
        .iter()
        .find(|candidate| {
            candidate.kind == kind
                && candidate.name == name
                && candidate.qualified_name == qualified_name
        })
        .unwrap_or_else(|| {
            panic!(
                "missing {kind:?} {qualified_name}; facts={:?}",
                symbol_facts(extracted),
            )
        })
}

fn implemented_symbol<'file>(
    extracted: &'file ExtractedFile,
    kind: SymbolKind,
    name: &str,
    qualified_name: &str,
) -> &'file ExtractedSymbol {
    extracted
        .symbols
        .iter()
        .find(|candidate| {
            candidate.kind == kind
                && candidate.name == name
                && candidate.qualified_name == qualified_name
                && !candidate.declaration_only
        })
        .unwrap_or_else(|| {
            panic!(
                "missing implemented {kind:?} {qualified_name}; facts={:?}",
                symbol_facts(extracted),
            )
        })
}

fn symbol_named<'file>(
    extracted: &'file ExtractedFile,
    qualified_name: &str,
) -> &'file ExtractedSymbol {
    extracted
        .symbols
        .iter()
        .find(|candidate| candidate.qualified_name == qualified_name)
        .unwrap_or_else(|| {
            panic!(
                "missing symbol {qualified_name}; facts={:?}",
                symbol_facts(extracted),
            )
        })
}

fn assert_containment(
    extracted: &ExtractedFile,
    parent: &ExtractedSymbol,
    child: &ExtractedSymbol,
) {
    assert!(
        extracted
            .containments
            .iter()
            .any(|edge| edge.parent == parent.id && edge.child == child.id),
        "missing containment {} -> {}; facts={:?}",
        parent.qualified_name,
        child.qualified_name,
        symbol_facts(extracted),
    );
}

fn assert_no_containment(
    extracted: &ExtractedFile,
    parent: &ExtractedSymbol,
    child: &ExtractedSymbol,
) {
    assert!(
        extracted
            .containments
            .iter()
            .all(|edge| edge.parent != parent.id || edge.child != child.id),
        "unexpected containment {} -> {}",
        parent.qualified_name,
        child.qualified_name,
    );
}

fn assert_reference_owned_by(
    extracted: &ExtractedFile,
    owner: &ExtractedSymbol,
    name: &str,
    kind: ReferenceKind,
) {
    assert!(
        extracted.references.iter().any(|reference| {
            reference.owner.as_ref() == Some(&owner.id)
                && reference.name == name
                && reference.kind == kind
        }),
        "missing {kind:?} reference {name} owned by {}; references={:?}",
        owner.qualified_name,
        extracted.references,
    );
}

fn owned_reference_names<'file>(
    extracted: &'file ExtractedFile,
    owner_name: &str,
    kind: ReferenceKind,
) -> Vec<&'file str> {
    let owner = symbol_named(extracted, owner_name);
    extracted
        .references
        .iter()
        .filter(|reference| reference.owner.as_ref() == Some(&owner.id) && reference.kind == kind)
        .map(|reference| reference.name.as_str())
        .collect()
}

fn assert_doc(extracted: &ExtractedFile, qualified_name: &str, expected: &str) {
    assert_eq!(
        symbol_named(extracted, qualified_name).docstring.as_deref(),
        Some(expected),
        "wrong docs for {qualified_name}; facts={:?}",
        symbol_facts(extracted),
    );
}

fn symbol_facts(extracted: &ExtractedFile) -> Vec<String> {
    extracted
        .symbols
        .iter()
        .map(|candidate| {
            format!(
                "{}|{}|{}|decl={}|export={}|static={}|doc={:?}",
                candidate.kind.as_str(),
                candidate.name,
                candidate.qualified_name,
                candidate.declaration_only,
                candidate.exported,
                candidate.static_member,
                candidate.docstring,
            )
        })
        .collect()
}
