use std::collections::{BTreeMap, BTreeSet};

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind, Visibility};
use cartograph_extract::{
    ExtractError, ExtractedFile, ExtractedSymbol, ImportBindingKind, NativeExtractor, SourceLimits,
    SourceSnapshot,
};

const SOURCE_LIMIT: usize = 1024 * 1024;
const KOTLIN_ORACLE: &str = include_str!("fixtures/v1_1_33/repository.kt");
const SCALA_ORACLE: &str = include_str!("fixtures/v1_1_33/container.scala");
const GROOVY_ORACLE: &str = include_str!("fixtures/v1_1_33/greeter.groovy");

#[test]
fn kotlin_preserves_the_v1_oracle_and_adds_jvm_reference_semantics() {
    let extracted = extract("src/main/kotlin/com/example/Repo.kt", KOTLIN_ORACLE);
    assert_eq!(extracted.language, SourceLanguage::Kotlin);

    let package = symbol(
        &extracted,
        SymbolKind::Namespace,
        "com.example",
        "com.example",
    );
    let runner = symbol(
        &extracted,
        SymbolKind::Interface,
        "Runner",
        "com.example::Runner",
    );
    assert_containment(&extracted, package, runner);
    assert_reference_owned_by(&extracted, runner, "Closeable", ReferenceKind::Extends);
    assert_eq!(runner.docstring.as_deref(), Some("Runs repository work."));

    let state = symbol(&extracted, SymbolKind::Enum, "State", "com.example::State");
    let ready = symbol(
        &extracted,
        SymbolKind::EnumMember,
        "READY",
        "com.example::State::READY",
    );
    assert_containment(&extracted, state, ready);

    symbol(
        &extracted,
        SymbolKind::Class,
        "Helper",
        "com.example::Helper",
    );
    let repo = symbol(&extracted, SymbolKind::Class, "Repo", "com.example::Repo");
    assert_eq!(
        repo.docstring.as_deref(),
        Some("Stores repository collaborators.")
    );
    assert_reference_owned_by(&extracted, repo, "Base", ReferenceKind::Extends);
    assert_reference_owned_by(&extracted, repo, "Runner", ReferenceKind::Implements);

    symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "com.example::Repo::Repo",
        "(userbo: UserBO, service: Service, plain: String)",
    );
    let userbo = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "com.example::Repo::userbo",
        "val userbo: UserBO",
    );
    assert_eq!(userbo.visibility, Some(Visibility::Private));
    assert_reference_owned_by(&extracted, userbo, "UserBO", ReferenceKind::TypeOf);
    let service = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "com.example::Repo::service",
        "var service: Service",
    );
    assert_eq!(service.visibility, Some(Visibility::Public));
    assert!(
        extracted
            .symbols
            .iter()
            .all(|candidate| candidate.qualified_name != "com.example::Repo::plain")
    );
    let maybe = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "com.example::Repo::maybe",
        "val maybe: UserBO?",
    );
    assert_eq!(maybe.visibility, Some(Visibility::Private));
    let computed = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "com.example::Repo::computed",
        "val computed: Result",
    );
    assert_reference_owned_by(&extracted, computed, "load", ReferenceKind::Calls);
    symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "com.example::Repo::Repo",
        "(userbo: UserBO)",
    );

    let run = symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "com.example::Repo::run",
        "(value: String): Result",
    );
    assert!(run.async_symbol);
    assert_reference_owned_by(&extracted, run, "Result", ReferenceKind::Returns);
    assert_reference_owned_by(&extracted, run, "userbo.toLogin2", ReferenceKind::Calls);
    assert_reference_owned_by(&extracted, run, "service.go", ReferenceKind::Calls);
    assert_reference_owned_by(&extracted, run, "maybe.toLogin2", ReferenceKind::Calls);
    assert_reference_owned_by(&extracted, run, "name", ReferenceKind::FieldAccess);
    let made = symbol(
        &extracted,
        SymbolKind::Constant,
        "made",
        "com.example::Repo::run::made",
    );
    assert_reference_owned_by(&extracted, made, "Widget", ReferenceKind::Instantiates);
    assert_reference_owned_by(&extracted, run, "Result", ReferenceKind::Instantiates);

    symbol(
        &extracted,
        SymbolKind::TypeAlias,
        "UserName",
        "com.example::UserName",
    );
    symbol_with_signature(
        &extracted,
        SymbolKind::Constant,
        "com.example::topLevel",
        "val topLevel: Repo?",
    );
    symbol_with_signature(
        &extracted,
        SymbolKind::Function,
        "com.example::build",
        "(repo: Repo): Repo",
    );

    assert_binding(
        &extracted,
        ImportBindingKind::Named,
        "java.time",
        "Instant",
        "Moment",
    );
    assert_binding(
        &extracted,
        ImportBindingKind::Namespace,
        "java.util",
        "*",
        "*",
    );
    assert_exact_symbol_spans(&extracted, KOTLIN_ORACLE);
    assert!(!format!("{extracted:?}").contains("sk_live_kotlin_default"));
}

#[test]
fn scala_preserves_the_v1_oracle_and_models_traits_objects_enums_and_construction() {
    let extracted = extract("src/main/scala/testbed/Container.scala", SCALA_ORACLE);
    assert_eq!(extracted.language, SourceLanguage::Scala);

    let package = symbol(&extracted, SymbolKind::Namespace, "testbed", "testbed");
    let runner = symbol(&extracted, SymbolKind::Trait, "Runner", "testbed::Runner");
    assert_containment(&extracted, package, runner);
    assert_eq!(runner.docstring.as_deref(), Some("Runs container work."));
    assert_reference_owned_by(&extracted, runner, "AutoCloseable", ReferenceKind::Extends);

    let box_type = symbol(&extracted, SymbolKind::Class, "Box", "testbed::Box");
    let box_value = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "testbed::Box::value",
        "val value: T",
    );
    assert_containment(&extracted, box_type, box_value);

    let container = symbol(
        &extracted,
        SymbolKind::Class,
        "Container",
        "testbed::Container",
    );
    assert_eq!(container.docstring.as_deref(), Some("Stores typed boxes."));
    assert_reference_owned_by(&extracted, container, "Base", ReferenceKind::Extends);
    assert_reference_owned_by(&extracted, container, "Runner", ReferenceKind::Implements);
    symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "testbed::Container::Container",
        "(seed: Box[T])",
    );
    let items = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "testbed::Container::items",
        "val items: ListBuffer[Box[T]]",
    );
    assert_reference_owned_by(&extracted, items, "ListBuffer", ReferenceKind::TypeOf);
    assert_reference_owned_by(&extracted, items, "Box", ReferenceKind::TypeOf);
    assert_reference_owned_by(&extracted, items, "ListBuffer", ReferenceKind::Instantiates);

    let add = symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "testbed::Container::add",
        "(item: Box[T]): Unit",
    );
    assert_reference_owned_by(&extracted, add, "items.addOne", ReferenceKind::Calls);
    let size = symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "testbed::Container::size",
        ": Int",
    );
    assert_reference_owned_by(&extracted, size, "length", ReferenceKind::FieldAccess);

    let state = symbol(&extracted, SymbolKind::Enum, "State", "testbed::State");
    let ready = symbol(
        &extracted,
        SymbolKind::EnumMember,
        "Ready",
        "testbed::State::Ready",
    );
    assert_containment(&extracted, state, ready);
    symbol(&extracted, SymbolKind::Class, "Helper", "testbed::Helper");
    symbol(&extracted, SymbolKind::TypeAlias, "Name", "testbed::Name");

    let build = symbol_with_signature(
        &extracted,
        SymbolKind::Function,
        "testbed::build",
        "(input: Box[String]): Container[String]",
    );
    let local_container = symbol(
        &extracted,
        SymbolKind::Constant,
        "container",
        "testbed::build::container",
    );
    assert_reference_owned_by(
        &extracted,
        local_container,
        "Container",
        ReferenceKind::Instantiates,
    );
    assert_reference_owned_by(&extracted, build, "container.add", ReferenceKind::Calls);
    assert_reference_owned_by(&extracted, build, "Helper.log", ReferenceKind::Calls);

    assert_binding(
        &extracted,
        ImportBindingKind::Named,
        "scala.collection.mutable",
        "ListBuffer",
        "ListBuffer",
    );
    assert_exact_symbol_spans(&extracted, SCALA_ORACLE);
}

#[test]
fn groovy_preserves_the_v1_oracle_for_classes_fields_functions_imports_and_calls() {
    let extracted = extract("src/main/groovy/demo/Greeter.groovy", GROOVY_ORACLE);
    assert_eq!(extracted.language, SourceLanguage::Groovy);

    let package = symbol(&extracted, SymbolKind::Namespace, "demo", "demo");
    let mood = symbol(&extracted, SymbolKind::Enum, "Mood", "demo::Mood");
    let happy = symbol(
        &extracted,
        SymbolKind::EnumMember,
        "HAPPY",
        "demo::Mood::HAPPY",
    );
    assert_containment(&extracted, mood, happy);
    let salutation = symbol(
        &extracted,
        SymbolKind::Interface,
        "Salutation",
        "demo::Salutation",
    );
    let declared_greet = symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "demo::Salutation::greet",
        "String (String other)",
    );
    assert!(declared_greet.declaration_only);
    assert_containment(&extracted, package, salutation);
    let greeter = symbol(&extracted, SymbolKind::Class, "Greeter", "demo::Greeter");
    assert_containment(&extracted, package, greeter);
    assert_eq!(greeter.docstring.as_deref(), Some("Greets callers."));
    assert_reference_owned_by(&extracted, greeter, "Base", ReferenceKind::Extends);
    assert_reference_owned_by(&extracted, greeter, "Salutation", ReferenceKind::Implements);

    let name = symbol_with_signature(
        &extracted,
        SymbolKind::Field,
        "demo::Greeter::name",
        "String name",
    );
    assert_eq!(name.visibility, Some(Visibility::Public));
    symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "demo::Greeter::Greeter",
        "(String name)",
    );

    let greet = symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "demo::Greeter::greet",
        "String (String other)",
    );
    assert_reference_owned_by(&extracted, greet, "helper", ReferenceKind::Calls);
    assert_reference_owned_by(
        &extracted,
        greet,
        "this.name.toString",
        ReferenceKind::Calls,
    );

    let helper = symbol_with_signature(
        &extracted,
        SymbolKind::Method,
        "demo::Greeter::helper",
        "String (String value)",
    );
    assert_eq!(helper.visibility, Some(Visibility::Private));
    assert_reference_owned_by(&extracted, helper, "value.toString", ReferenceKind::Calls);

    let top_level = symbol_with_signature(
        &extracted,
        SymbolKind::Function,
        "demo::topLevel",
        "def (value)",
    );
    let widget = symbol(
        &extracted,
        SymbolKind::Variable,
        "widget",
        "demo::topLevel::widget",
    );
    assert_reference_owned_by(&extracted, widget, "Widget", ReferenceKind::Instantiates);
    assert_reference_owned_by(
        &extracted,
        top_level,
        "value.toString",
        ReferenceKind::Calls,
    );

    assert_binding(
        &extracted,
        ImportBindingKind::Named,
        "java.time",
        "Instant",
        "Instant",
    );
    assert_exact_symbol_spans(&extracted, GROOVY_ORACLE);
}

#[test]
fn jvm_dynamic_modes_are_production_admitted_through_the_reviewed_family() {
    for (language, path, source) in [
        (SourceLanguage::Kotlin, "src/Main.kt", "class Main {}\n"),
        (
            SourceLanguage::Kotlin,
            "src/Main.kts",
            "fun main() = Unit\n",
        ),
        (SourceLanguage::Scala, "src/Main.scala", "class Main\n"),
        (
            SourceLanguage::Scala,
            "src/Main.sc",
            "def main: Unit = ()\n",
        ),
        (SourceLanguage::Groovy, "src/Main.groovy", "class Main {}\n"),
        (
            SourceLanguage::Groovy,
            "build.gradle",
            "def configure() {}\n",
        ),
    ] {
        assert!(language.is_native_indexable());
        assert!(NativeExtractor::new(language).is_ok());
        assert!(NativeExtractor::new_for_capability_validation(language).is_ok());
        let production = SourceSnapshot::from_bytes(path, source.as_bytes(), source_limits())
            .unwrap_or_else(|error| panic!("{path} production snapshot failed: {error}"));
        assert_eq!(production.language(), language);
        let snapshot = capability_snapshot(path, source);
        assert_eq!(snapshot.language(), language);
    }
}

#[test]
fn jvm_dynamic_extraction_is_cancellable_bounded_literal_safe_and_repeatable() {
    let snapshot = capability_snapshot("src/Cancel.kt", KOTLIN_ORACLE);
    let mut extractor = capability_extractor(SourceLanguage::Kotlin);
    assert_eq!(
        extractor
            .extract_with_cancellation(&snapshot, || true)
            .err(),
        Some(ExtractError::Cancelled)
    );

    let mut decorated = String::new();
    for index in 0..2_000 {
        decorated.push_str("@Marker");
        decorated.push_str(&index.to_string());
        decorated.push('\n');
    }
    decorated.push_str("class Decorated\n");
    let snapshot = capability_snapshot("src/Decorated.kt", &decorated);
    let mut extractor = capability_extractor(SourceLanguage::Kotlin);
    let mut probes = 0_usize;
    assert_eq!(
        extractor
            .extract_with_cancellation(&snapshot, || {
                probes = probes.saturating_add(1);
                probes > 512
            })
            .err(),
        Some(ExtractError::Cancelled)
    );
    assert!(probes > 512, "cancellation did not occur after progress");

    let nested = format!("fun nested() = {}Unit{}", "(".repeat(300), ")".repeat(300));
    assert_eq!(
        extract_result("src/Nested.kt", &nested).err(),
        Some(ExtractError::NestingLimit)
    );

    let mut excessive = String::new();
    for index in 0..30_000 {
        excessive.push_str("val v");
        excessive.push_str(&index.to_string());
        excessive.push_str(": T\n");
    }
    assert_eq!(
        extract_result("src/Many.kt", &excessive).err(),
        Some(ExtractError::OutputLimit)
    );

    for (path, source, expected_digest) in [
        (
            "src/Repo.kt",
            KOTLIN_ORACLE,
            "c8481f26e2a3dcf44b87c6b999380fdf134342dff4e10ce0d0eda8be3a3998ad",
        ),
        (
            "src/Container.scala",
            SCALA_ORACLE,
            "a2a2ecb44ca4c880bf52161de12fa721df6f23f8bc40d97b81920933f4d6378f",
        ),
        (
            "src/Greeter.groovy",
            GROOVY_ORACLE,
            "90eab1f8b4dd2ae3fb3145c2f43161c69879739e5fb10e1c93f702b1370adc02",
        ),
    ] {
        let first = extract(path, source);
        let second = extract(path, source);
        assert_eq!(canonical_facts(&first), canonical_facts(&second), "{path}");
        assert_unique_ids(&first);
        assert_eq!(locked_digest(&first), expected_digest, "{path}");
    }
}

#[test]
fn jvm_dynamic_signatures_drop_defaults_and_oversized_declarations() {
    let long_type = "OversizedType".repeat(48);
    let kotlin = format!(
        "fun safe(token: String = \"sk_live_kotlin_signature\"): String = token\n\
         fun huge(value: {long_type}): Unit = Unit\n"
    );
    let extracted = extract("src/Safe.kt", &kotlin);
    symbol_with_signature(
        &extracted,
        SymbolKind::Function,
        "safe",
        "(token: String): String",
    );
    assert_eq!(
        symbol(&extracted, SymbolKind::Function, "huge", "huge").signature,
        None
    );
    assert!(!format!("{extracted:?}").contains("sk_live_kotlin_signature"));

    let scala = extract(
        "src/Safe.scala",
        "def safe(token: String = \"sk_live_scala_signature\"): String = token\n",
    );
    symbol_with_signature(
        &scala,
        SymbolKind::Function,
        "safe",
        "(token: String): String",
    );
    assert!(!format!("{scala:?}").contains("sk_live_scala_signature"));

    let groovy = extract(
        "src/Safe.groovy",
        "def safe(value = \"sk_live_groovy_signature\") { value }\n",
    );
    symbol_with_signature(&groovy, SymbolKind::Function, "safe", "def (value)");
    assert!(!format!("{groovy:?}").contains("sk_live_groovy_signature"));
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    extract_result(path, source)
        .unwrap_or_else(|error| panic!("extraction failed for {path}: {error}"))
}

fn extract_result(path: &str, source: &str) -> Result<ExtractedFile, ExtractError> {
    let snapshot = capability_snapshot(path, source);
    capability_extractor(snapshot.language()).extract(&snapshot)
}

fn capability_snapshot(path: &str, source: &str) -> SourceSnapshot {
    SourceSnapshot::from_bytes_for_capability_validation(path, source.as_bytes(), source_limits())
        .unwrap_or_else(|error| panic!("snapshot failed for {path}: {error}"))
}

fn source_limits() -> SourceLimits {
    SourceLimits::new(SOURCE_LIMIT).unwrap_or_else(|error| panic!("source limits failed: {error}"))
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

fn symbol_with_signature<'file>(
    extracted: &'file ExtractedFile,
    kind: SymbolKind,
    qualified_name: &str,
    signature: &str,
) -> &'file ExtractedSymbol {
    extracted
        .symbols
        .iter()
        .find(|candidate| {
            candidate.kind == kind
                && candidate.qualified_name == qualified_name
                && candidate.signature.as_deref() == Some(signature)
        })
        .unwrap_or_else(|| {
            panic!(
                "missing {kind:?} {qualified_name} with {signature}; facts={:?}",
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
        "missing containment {} -> {}",
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
        "missing {kind:?} {name} owned by {}; references={:?}",
        owner.qualified_name,
        reference_facts(extracted),
    );
}

fn assert_binding(
    extracted: &ExtractedFile,
    kind: ImportBindingKind,
    module: &str,
    imported: &str,
    local: &str,
) {
    assert!(
        extracted.import_bindings.iter().any(|binding| {
            binding.kind == kind
                && binding.module_specifier == module
                && binding.imported_name == imported
                && binding.local_name == local
        }),
        "missing {kind:?} binding {module}|{imported}|{local}; bindings={:?}",
        extracted.import_bindings,
    );
}

fn assert_exact_symbol_spans(extracted: &ExtractedFile, source: &str) {
    for symbol in &extracted.symbols {
        let Ok(start) = usize::try_from(symbol.span.start_byte()) else {
            panic!("span start did not fit usize for {}", symbol.qualified_name);
        };
        let Ok(end) = usize::try_from(symbol.span.end_byte()) else {
            panic!("span end did not fit usize for {}", symbol.qualified_name);
        };
        let Some(text) = source.get(start..end) else {
            panic!("span was outside source for {}", symbol.qualified_name);
        };
        assert!(!text.is_empty(), "empty span for {}", symbol.qualified_name);
        let synthetic_constructor_span = symbol.kind == SymbolKind::Method
            && (text.trim_start().starts_with('(') || text.trim_start().starts_with("constructor"))
            && symbol
                .qualified_name
                .rsplit("::")
                .nth(1)
                .is_some_and(|owner| owner == symbol.name);
        assert!(
            synthetic_constructor_span || text.contains(&symbol.name),
            "span for {} did not retain its declaration name: {text:?}",
            symbol.qualified_name,
        );
    }
}

fn assert_unique_ids(extracted: &ExtractedFile) {
    let ids = extracted
        .symbols
        .iter()
        .map(|symbol| symbol.id.as_str())
        .collect::<BTreeSet<_>>();
    assert_eq!(ids.len(), extracted.symbols.len());
}

fn symbol_names(extracted: &ExtractedFile) -> BTreeMap<&str, &str> {
    extracted
        .symbols
        .iter()
        .map(|symbol| (symbol.id.as_str(), symbol.qualified_name.as_str()))
        .collect()
}

fn symbol_facts(extracted: &ExtractedFile) -> Vec<String> {
    extracted
        .symbols
        .iter()
        .map(|symbol| {
            format!(
                "{}|{}|{}|{:?}|decl={}|export={}|async={}|static={}|sig={:?}|doc={:?}",
                symbol.kind.as_str(),
                symbol.name,
                symbol.qualified_name,
                symbol.visibility,
                symbol.declaration_only,
                symbol.exported,
                symbol.async_symbol,
                symbol.static_member,
                symbol.signature,
                symbol.docstring,
            )
        })
        .collect()
}

fn reference_facts(extracted: &ExtractedFile) -> Vec<String> {
    let names = symbol_names(extracted);
    extracted
        .references
        .iter()
        .map(|reference| {
            format!(
                "{}|{}|{}",
                reference
                    .owner
                    .as_ref()
                    .and_then(|owner| names.get(owner.as_str()).copied())
                    .unwrap_or("<file>"),
                reference.kind.as_str(),
                reference.name,
            )
        })
        .collect()
}

fn canonical_facts(extracted: &ExtractedFile) -> Vec<String> {
    let names = symbol_names(extracted);
    let mut facts = vec![format!(
        "F|{}|{:?}|{}|{}|{}",
        extracted.language.as_str(),
        extracted.parse_status,
        extracted.symbols.len(),
        extracted.references.len(),
        extracted.import_bindings.len(),
    )];
    facts.extend(extracted.symbols.iter().map(|symbol| {
        format!(
            "S|{}|{}|{}|{}-{}|{}|{}|{}|{}|{}|{}|{}|{}|{:?}",
            symbol.kind.as_str(),
            symbol.name,
            symbol.qualified_name,
            symbol.span.start_byte(),
            symbol.span.end_byte(),
            symbol.structural_digest,
            symbol.signature.as_deref().unwrap_or_default(),
            symbol.docstring.as_deref().unwrap_or_default(),
            symbol.body_search_text,
            symbol.declaration_only,
            symbol.exported,
            symbol.async_symbol,
            symbol.static_member,
            symbol.visibility,
        )
    }));
    facts.extend(extracted.containments.iter().map(|edge| {
        format!(
            "C|{}|{}",
            names
                .get(edge.parent.as_str())
                .copied()
                .unwrap_or("<missing>"),
            names
                .get(edge.child.as_str())
                .copied()
                .unwrap_or("<missing>"),
        )
    }));
    facts.extend(extracted.references.iter().map(|reference| {
        format!(
            "R|{}|{}|{}|{}-{}",
            reference
                .owner
                .as_ref()
                .and_then(|owner| names.get(owner.as_str()).copied())
                .unwrap_or("<file>"),
            reference.kind.as_str(),
            reference.name,
            reference.span.start_byte(),
            reference.span.end_byte(),
        )
    }));
    facts.extend(extracted.import_bindings.iter().map(|binding| {
        format!(
            "I|{:?}|{}|{}|{}|{}-{}",
            binding.kind,
            binding.module_specifier,
            binding.imported_name,
            binding.local_name,
            binding.span.start_byte(),
            binding.span.end_byte(),
        )
    }));
    facts.extend(
        extracted
            .diagnostics
            .iter()
            .map(|diagnostic| format!("D|{:?}|{:?}", diagnostic.code, diagnostic.span)),
    );
    facts
}

fn locked_digest(extracted: &ExtractedFile) -> String {
    let mut hasher = blake3::Hasher::new_derive_key("cartograph.v2.jvm-dynamic-family.2026-07-24");
    for fact in canonical_facts(extracted) {
        hasher.update(&u64::try_from(fact.len()).unwrap_or(u64::MAX).to_le_bytes());
        hasher.update(fact.as_bytes());
    }
    hasher.finalize().to_hex().to_string()
}
