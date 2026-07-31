//! Integration coverage for Cartograph native extraction contracts.

mod dependency_ownership;

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind, Visibility};
use cartograph_extract::{
    DYNAMIC_DISPATCH_RESOLUTION_PREFIX, ExtractedFile, ImportBindingKind, NativeExtractor,
    RUST_MACRO_RESOLUTION_PREFIX, SourceLimits, SourceSnapshot,
};

const SOURCE_LIMIT_BYTES: usize = 256 * 1024;
const GROUPED_RUST_BINDINGS: &str = r"
use crate::{nested::{helpers as selected, tools}, tags};
use external_crate::{Remote, remote_tools};
use super::*;

pub fn run() {
    tags::extract();
    selected::prepare();
    let callback = selected::prepare;
    tools::scan();
    worker.finish();
    worker.try_get::<bool, _>();
    assert!(true);
}
";

#[test]
fn rust_extracts_types_methods_calls_and_containment() {
    let file = extract(
        "src/worker.rs",
        r"
pub struct Worker {
    value: u32,
}

impl Worker {
    pub fn run(&self) -> u32 {
        helper(self.value)
    }

    pub fn schedule(&self, first: u32, second: u32, third: u32, fourth: u32) {
        let _ = (first, second, third, fourth);
    }
}

pub fn helper(value: u32) -> u32 {
    value
}

pub(self) fn private_helper() {}
pub(crate) fn crate_helper() {}

pub fn sync_with_async_block() {
    let _future = async { 1 };
}

pub async fn async_helper() {}

pub trait Runnable {
    fn execute(&self);
}
",
    );

    let worker = symbol(&file, "Worker");
    let run = symbol(&file, "Worker::run");
    let helper = symbol(&file, "helper");
    assert_eq!(file.language, SourceLanguage::Rust);
    assert_eq!(worker.kind, SymbolKind::Struct);
    assert_eq!(run.kind, SymbolKind::Method);
    assert_eq!(run.health.parameter_count, 0);
    assert_eq!(symbol(&file, "Worker::schedule").health.parameter_count, 4);
    assert_eq!(helper.kind, SymbolKind::Function);
    assert!(worker.export.exported && run.export.exported && helper.export.exported);
    let private_helper = symbol(&file, "private_helper");
    let crate_helper = symbol(&file, "crate_helper");
    assert!(!private_helper.export.exported && private_helper.visibility.is_none());
    assert!(crate_helper.export.exported);
    assert_eq!(crate_helper.visibility, Some(Visibility::Internal));
    assert_eq!(helper.visibility, Some(Visibility::Public));
    assert!(
        !symbol(&file, "sync_with_async_block")
            .execution
            .async_symbol
    );
    assert!(symbol(&file, "async_helper").execution.async_symbol);
    assert!(file.symbols.iter().any(|entry| {
        entry.kind == SymbolKind::Parameter
            && entry.name == "value"
            && entry.qualified_name == "helper::value"
    }));
    assert!(
        file.containments
            .iter()
            .any(|edge| edge.parent == worker.id && edge.child == run.id)
    );
    assert_eq!(
        file.references
            .iter()
            .filter(|reference| {
                reference.owner.as_ref() == Some(&run.id)
                    && reference.name == "helper"
                    && reference.kind == ReferenceKind::Calls
            })
            .count(),
        1
    );
    let runnable = symbol(&file, "Runnable");
    let execute = symbol(&file, "Runnable::execute");
    assert_eq!(runnable.kind, SymbolKind::Trait);
    assert_eq!(execute.kind, SymbolKind::Method);
    assert!(execute.implementation.declaration_only);
    for qualified_name in ["Worker::run", "Runnable::execute"] {
        assert_eq!(
            file.symbols
                .iter()
                .filter(|entry| entry.qualified_name == qualified_name)
                .count(),
            1,
            "{qualified_name}"
        );
    }
    assert!(
        file.containments
            .iter()
            .any(|edge| edge.parent == runnable.id && edge.child == execute.id)
    );
}

#[test]
fn rust_extracts_references_from_constant_initializers() {
    let file = extract(
        "src/pending.rs",
        r"
pub(crate) struct TransactionCompletion;

impl TransactionCompletion {
    pub(crate) const fn new() -> Self { Self }
}

pub(crate) const COMPLETION: TransactionCompletion = TransactionCompletion::new();
",
    );
    let completion = symbol(&file, "COMPLETION");
    assert!(file.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&completion.id)
            && reference.name == "TransactionCompletion::new"
            && reference.kind == ReferenceKind::Calls
    }));
}

#[test]
fn rust_marks_inline_test_scopes_as_test_symbols() {
    let file = extract(
        "src/lib.rs",
        r"
fn production() {}

#[cfg(test)]
mod contract_tests {
    use super::*;

    #[test]
    fn exact_case() { production(); }

    fn fixture_helper() {}
}
",
    );
    assert!(!symbol(&file, "production").implementation.test_symbol);
    for qualified_name in [
        "contract_tests",
        "contract_tests::exact_case",
        "contract_tests::fixture_helper",
    ] {
        assert!(
            symbol(&file, qualified_name).implementation.test_symbol,
            "{qualified_name}"
        );
    }
}

#[test]
fn rust_extracts_grouped_module_bindings_with_full_paths_and_aliases() {
    let file = extract("src/native.rs", GROUPED_RUST_BINDINGS);

    for (module_specifier, local_name) in [
        ("crate::nested::helpers", "selected"),
        ("crate::nested::tools", "tools"),
        ("crate::tags", "tags"),
    ] {
        assert!(file.import_bindings.iter().any(|binding| {
            binding.kind == ImportBindingKind::Namespace
                && binding.module_specifier == module_specifier
                && binding.imported_name == "*"
                && binding.local_name == local_name
        }));
        assert!(file.references.iter().any(|reference| {
            reference.owner.is_none()
                && reference.name == local_name
                && reference.kind == ReferenceKind::References
        }));
    }
    assert!(
        file.import_bindings.iter().any(|binding| {
            binding.kind == ImportBindingKind::Namespace
                && binding.module_specifier == "super::*"
                && binding.local_name == "*"
        }),
        "{:?}",
        file.import_bindings
    );
    for (module_specifier, local_name) in [
        ("external_crate::Remote", "Remote"),
        ("external_crate::remote_tools", "remote_tools"),
    ] {
        assert!(file.import_bindings.iter().any(|binding| {
            binding.kind == ImportBindingKind::Namespace
                && binding.module_specifier == module_specifier
                && binding.local_name == local_name
        }));
        assert!(file.references.iter().any(|reference| {
            reference.owner.is_none()
                && reference.name == local_name
                && reference.kind == ReferenceKind::References
        }));
    }
    assert!(file.references.iter().any(|reference| {
        reference.name == "selected::prepare" && reference.kind == ReferenceKind::References
    }));
}

#[test]
fn rust_extracts_public_use_facades_as_named_reexports() {
    let file = extract(
        "src/lib.rs",
        r"
pub mod conv;
pub mod nn {
    pub use crate::conv::{conv2d, Conv2d as Layer};
}
",
    );

    for (module_specifier, imported_name, public_name) in [
        ("crate::conv::conv2d", "conv2d", "nn::conv2d"),
        ("crate::conv::Conv2d", "Conv2d", "nn::Layer"),
    ] {
        assert!(file.import_bindings.iter().any(|binding| {
            binding.kind == ImportBindingKind::ReExportNamed
                && binding.module_specifier == module_specifier
                && binding.imported_name == imported_name
                && binding.local_name == public_name
        }));
    }
}

#[test]
fn rust_extracts_receiver_and_macro_calls_with_resolution_hints() {
    let file = extract("src/native.rs", GROUPED_RUST_BINDINGS);
    let receiver_call = file
        .references
        .iter()
        .find(|reference| reference.name == "worker.finish")
        .unwrap_or_else(|| {
            panic!(
                "Rust receiver call was not extracted: {:?}",
                file.references
            )
        });
    let expected_resolution = format!("{DYNAMIC_DISPATCH_RESOLUTION_PREFIX}finish");
    assert_eq!(
        receiver_call.resolution_name.as_deref(),
        Some(expected_resolution.as_str())
    );
    let generic_receiver_call = file
        .references
        .iter()
        .find(|reference| reference.name == "worker.try_get::<bool, _>")
        .unwrap_or_else(|| {
            panic!(
                "generic Rust receiver call was not extracted: {:?}",
                file.references
            )
        });
    let expected_generic_resolution = format!("{DYNAMIC_DISPATCH_RESOLUTION_PREFIX}try_get");
    assert_eq!(
        generic_receiver_call.resolution_name.as_deref(),
        Some(expected_generic_resolution.as_str())
    );
    let macro_call = file
        .references
        .iter()
        .find(|reference| reference.name == "assert")
        .unwrap_or_else(|| panic!("Rust macro call was not extracted: {:?}", file.references));
    let expected_macro = format!("{RUST_MACRO_RESOLUTION_PREFIX}assert");
    assert_eq!(
        macro_call.resolution_name.as_deref(),
        Some(expected_macro.as_str())
    );

    let nested_module = extract(
        "src/walk.rs",
        "mod references;\npub fn visit() { references::capture_usage(); }\n",
    );
    assert!(nested_module.import_bindings.iter().any(|binding| {
        binding.kind == ImportBindingKind::Namespace
            && binding.module_specifier == "./walk/references"
            && binding.local_name == "references"
    }));
}

#[test]
fn rust_extracts_qualified_calls_inside_macro_token_trees() {
    let source = r#"
fn run() {
    print!("{}", upgrade::render(&report));
    println!("{}", report.location());
    tokio::select! {
        joined = worker => ToolResult :: from_error(error),
    }
    print!("fake::call(");
}
"#;
    let file = extract("src/main.rs", source);
    for name in ["upgrade::render", "ToolResult::from_error"] {
        let reference = file
            .references
            .iter()
            .find(|reference| reference.name == name && reference.kind == ReferenceKind::Calls)
            .unwrap_or_else(|| panic!("missing macro-contained call {name}"));
        let start = usize::try_from(reference.span.start_byte())
            .unwrap_or_else(|_| panic!("invalid start"));
        let end =
            usize::try_from(reference.span.end_byte()).unwrap_or_else(|_| panic!("invalid end"));
        assert_eq!(
            source
                .get(start..end)
                .unwrap_or_else(|| panic!("invalid span"))
                .split_whitespace()
                .collect::<String>(),
            name,
        );
    }
    let receiver = file
        .references
        .iter()
        .find(|reference| {
            reference.name == "report.location" && reference.kind == ReferenceKind::Calls
        })
        .unwrap_or_else(|| panic!("missing macro-contained receiver call"));
    let expected_receiver_resolution = format!("{DYNAMIC_DISPATCH_RESOLUTION_PREFIX}location");
    assert_eq!(
        receiver.resolution_name.as_deref(),
        Some(expected_receiver_resolution.as_str())
    );
    assert!(
        !file
            .references
            .iter()
            .any(|reference| reference.name == "fake::call")
    );
}

#[test]
fn javascript_chained_member_calls_keep_dynamic_dispatch_resolution() {
    let file = extract(
        "src/schema.ts",
        r#"
export function schema(z: any) {
    return z.object({}).describe("public schema").optional();
}
"#,
    );
    let owner = symbol(&file, "schema");
    for name in ["describe", "optional"] {
        let reference = file
            .references
            .iter()
            .find(|reference| {
                reference.owner.as_ref() == Some(&owner.id)
                    && reference.name == name
                    && reference.kind == ReferenceKind::Calls
            })
            .unwrap_or_else(|| panic!("missing chained call {name}: {:?}", file.references));
        let expected = format!("{DYNAMIC_DISPATCH_RESOLUTION_PREFIX}{name}");
        assert_eq!(
            reference.resolution_name.as_deref(),
            Some(expected.as_str())
        );
    }
}

#[test]
fn javascript_binding_patterns_emit_lexical_symbols() {
    let file = extract(
        "src/bindings.ts",
        r"
export function run(
    { phaseCtx, nested: { count: counter } }: Input,
    [errors]: Error[][],
    onProgress?: (value: number) => void,
) {
    const { formatOnly, newStructHash: structHash } = decide();
    onProgress?.(counter);
    return [phaseCtx, errors, formatOnly, structHash];
}
",
    );
    for parameter in ["phaseCtx", "counter", "errors", "onProgress"] {
        assert_eq!(
            symbol(&file, &format!("run::{parameter}")).kind,
            SymbolKind::Parameter,
            "{parameter}"
        );
    }
    for variable in ["formatOnly", "structHash"] {
        assert_eq!(
            symbol(&file, &format!("run::{variable}")).kind,
            SymbolKind::Constant,
            "{variable}"
        );
    }
    assert!(
        file.symbols
            .iter()
            .all(|entry| entry.qualified_name != "run::newStructHash")
    );
}

#[test]
fn python_extracts_classes_methods_local_imports_and_calls() {
    let file = extract(
        "app/greeter.py",
        r#"
from .helpers import format_name as render_name
from . import helpers as local_helpers
from .. import shared
from ..shared import shared_name

class Greeter(BaseGreeter):
    def greet(self, name: str) -> str:
        return render_name(name)

    @trace
    def decorated(self) -> str:
        return "ok"

def public_helper(value: str) -> str:
    return value
"#,
    );

    let class = symbol(&file, "Greeter");
    let method = symbol(&file, "Greeter::greet");
    let helper = symbol(&file, "public_helper");
    let decorated = symbol(&file, "Greeter::decorated");
    assert_eq!(file.language, SourceLanguage::Python);
    assert_eq!(class.kind, SymbolKind::Class);
    assert_eq!(method.kind, SymbolKind::Method);
    assert!(class.export.exported && !method.export.exported && helper.export.exported);
    assert_eq!(decorated.kind, SymbolKind::Method);
    assert!(file.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&class.id)
            && reference.name == "BaseGreeter"
            && reference.kind == ReferenceKind::Extends
    }));
    assert!(file.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&method.id)
            && reference.name == "render_name"
            && reference.kind == ReferenceKind::Calls
    }));
    assert!(file.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&method.id)
            && reference.name == "str"
            && reference.kind == ReferenceKind::Returns
    }));
    assert!(file.import_bindings.iter().any(|binding| {
        binding.module_specifier == "./helpers"
            && binding.imported_name == "format_name"
            && binding.local_name == "render_name"
    }));
    assert!(file.import_bindings.iter().any(|binding| {
        binding.module_specifier == "./helpers"
            && binding.imported_name == "*"
            && binding.local_name == "local_helpers"
    }));
    assert!(file.import_bindings.iter().any(|binding| {
        binding.module_specifier == "../shared"
            && binding.imported_name == "*"
            && binding.local_name == "shared"
    }));
    assert!(file.import_bindings.iter().any(|binding| {
        binding.module_specifier == "../shared"
            && binding.imported_name == "shared_name"
            && binding.local_name == "shared_name"
    }));
}

#[test]
fn go_extracts_named_types_receiver_methods_imports_and_calls() {
    let file = extract(
        "service/worker.go",
        r#"
package service

import "example.com/acme/helpers"

type Worker struct {
    Value int
}

type Runner interface {
    Execute() int
}

func (worker *Worker) Run() int {
    helpers.Trace()
    return GoHelper(worker.Value)
}

func GoHelper(value int) int {
    return value
}
"#,
    );

    let worker = symbol(&file, "Worker");
    let run = symbol(&file, "Worker::Run");
    let helper = symbol(&file, "GoHelper");
    assert_eq!(file.language, SourceLanguage::Go);
    assert_eq!(worker.kind, SymbolKind::Struct);
    assert_eq!(run.kind, SymbolKind::Method);
    assert!(worker.export.exported && run.export.exported && helper.export.exported);
    assert!(
        file.containments
            .iter()
            .any(|edge| edge.parent == worker.id && edge.child == run.id)
    );
    assert_eq!(
        file.references
            .iter()
            .filter(|reference| {
                reference.owner.as_ref() == Some(&run.id)
                    && reference.name == "GoHelper"
                    && reference.kind == ReferenceKind::Calls
            })
            .count(),
        1
    );
    assert!(file.import_bindings.iter().any(|binding| {
        binding.module_specifier == "example.com/acme/helpers" && binding.local_name == "helpers"
    }));
    let runner = symbol(&file, "Runner");
    let execute = symbol(&file, "Runner::Execute");
    assert_eq!(runner.kind, SymbolKind::Interface);
    assert_eq!(execute.kind, SymbolKind::Method);
    assert!(execute.implementation.declaration_only);
    for qualified_name in ["Worker::Run", "Runner::Execute"] {
        assert_eq!(
            file.symbols
                .iter()
                .filter(|entry| entry.qualified_name == qualified_name)
                .count(),
            1,
            "{qualified_name}"
        );
    }
    assert!(
        file.containments
            .iter()
            .any(|edge| edge.parent == runner.id && edge.child == execute.id)
    );
    assert_eq!(symbol(&file, "service").kind, SymbolKind::Module);
}

#[test]
fn ts_reexports_and_commonjs_require_are_explicit_resolver_evidence() {
    let local = extract(
        "src/local.ts",
        "const local = (): void => {};\nexport { local };\n",
    );
    assert!(symbol(&local, "local").export.exported);

    let local_alias = extract(
        "src/local-alias.ts",
        "const local = (): void => {};\nexport { local as publicLocal };\n",
    );
    let public_local = symbol(&local_alias, "publicLocal");
    assert_eq!(public_local.kind, SymbolKind::Export);
    assert!(public_local.export.exported);
    assert!(local_alias.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&public_local.id)
            && reference.name == "local"
            && reference.kind == ReferenceKind::Exports
    }));

    let default_local = extract(
        "src/default-local.ts",
        "const local = (): void => {};\nexport default local;\n",
    );
    let default_symbol = symbol(&default_local, "local");
    assert!(default_symbol.export.exported && default_symbol.export.default_export);

    let barrel = extract(
        "src/barrel.ts",
        "export { helper as renamed } from './helper';\n",
    );
    let renamed = symbol(&barrel, "renamed");
    assert_eq!(renamed.kind, SymbolKind::Export);
    assert!(renamed.export.exported);
    assert!(barrel.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&renamed.id)
            && reference.name == "helper"
            && reference.kind == ReferenceKind::Exports
    }));
    assert!(barrel.import_bindings.iter().any(|binding| {
        binding.module_specifier == "./helper"
            && binding.imported_name == "helper"
            && binding.local_name == "helper"
    }));
}

#[test]
fn commonjs_require_variants_are_explicit_resolver_evidence() {
    let commonjs = extract(
        "src/consumer.cjs",
        "const helper = require('./helper');\nfunction use() { helper.run(); }\nmodule.exports = { use };\n",
    );
    assert!(symbol(&commonjs, "use").export.exported);
    assert!(commonjs.import_bindings.iter().any(|binding| {
        binding.module_specifier == "./helper"
            && binding.imported_name == "*"
            && binding.local_name == "helper"
    }));

    let destructured = extract(
        "src/destructured.cjs",
        "const { run: execute, stop } = require('./helper');\nfunction use() { execute(); stop(); }\n",
    );
    for (imported, local) in [("run", "execute"), ("stop", "stop")] {
        assert!(destructured.import_bindings.iter().any(|binding| {
            binding.module_specifier == "./helper"
                && binding.imported_name == imported
                && binding.local_name == local
        }));
        assert!(destructured.references.iter().any(|reference| {
            reference.owner.is_none()
                && reference.name == imported
                && reference.kind == ReferenceKind::References
        }));
    }

    let selected = extract(
        "src/selected.cjs",
        "const execute = require('./helper').run;\nfunction use() { execute(); }\n",
    );
    assert!(selected.import_bindings.iter().any(|binding| {
        binding.module_specifier == "./helper"
            && binding.imported_name == "run"
            && binding.local_name == "execute"
    }));
    assert!(selected.references.iter().any(|reference| {
        reference.owner.is_none()
            && reference.name == "run"
            && reference.kind == ReferenceKind::References
    }));
    assert!(!selected.references.iter().any(|reference| {
        reference.owner.is_some()
            && reference.name == "run"
            && reference.kind == ReferenceKind::FieldAccess
    }));

    let typed_commonjs = extract(
        "src/typed-commonjs.ts",
        "const local = (): void => {};\nmodule.exports = { publicLocal: local };\n",
    );
    let typed_alias = symbol(&typed_commonjs, "publicLocal");
    assert_eq!(typed_alias.kind, SymbolKind::Export);
    assert!(typed_commonjs.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&typed_alias.id)
            && reference.name == "local"
            && reference.kind == ReferenceKind::Exports
    }));
}

#[test]
fn dynamic_and_shadowed_module_syntax_does_not_invent_bindings() {
    let conditional = extract(
        "src/conditional.cjs",
        "const hidden = () => {};\nif (enabled) { exports.hidden = hidden; }\n",
    );
    assert!(!symbol(&conditional, "hidden").export.exported);

    let computed = extract(
        "src/computed.cjs",
        "const hidden = () => {};\nmodule.exports = { [name]: hidden };\n",
    );
    assert!(!symbol(&computed, "hidden").export.exported);
    assert!(
        !computed
            .symbols
            .iter()
            .any(|entry| entry.kind == SymbolKind::Export)
    );

    let dynamic = extract(
        "src/dynamic.cjs",
        "function use(name) { return require(name); }\n",
    );
    let dynamic_use = symbol(&dynamic, "use");
    assert!(dynamic.import_bindings.is_empty());
    assert!(dynamic.references.iter().any(|reference| {
        reference.owner.as_ref() == Some(&dynamic_use.id)
            && reference.name == "require"
            && reference.kind == ReferenceKind::Calls
    }));

    let dynamic_import = extract(
        "src/lazy.ts",
        "async function load() {\n  const direct = await import('optional-pkg' as any);\n  const template = await import(`template-pkg`);\n  return [direct, template];\n}\n",
    );
    for package in ["optional-pkg", "template-pkg"] {
        assert!(dynamic_import.references.iter().any(|reference| {
            reference.owner.is_none()
                && reference.name == package
                && reference.kind == ReferenceKind::Imports
        }));
    }
    assert!(
        !dynamic_import.references.iter().any(|reference| {
            reference.name == "import" && reference.kind == ReferenceKind::Calls
        })
    );

    let computed_import = extract(
        "src/computed-import.ts",
        "async function load(name: string) { return import(name); }\n",
    );
    assert!(
        !computed_import.references.iter().any(|reference| {
            reference.name == "import" && reference.kind == ReferenceKind::Calls
        })
    );

    let side_effect = extract("src/side-effect.cjs", "require('./helper');\n");
    assert!(side_effect.import_bindings.is_empty());
    assert!(side_effect.references.iter().any(|reference| {
        reference.owner.is_none()
            && reference.name == "require"
            && reference.kind == ReferenceKind::Calls
    }));

    let shadowed_require = extract(
        "src/shadowed-require.cjs",
        "const require = makeRequire();\nconst helper = require('./helper');\n",
    );
    assert!(shadowed_require.import_bindings.is_empty());
    assert!(shadowed_require.references.iter().any(|reference| {
        reference.name == "require" && reference.kind == ReferenceKind::Calls
    }));

    let shadowed_parameter = extract(
        "src/shadowed-parameter.cjs",
        "function use(require) { return require('./helper'); }\n",
    );
    assert!(shadowed_parameter.import_bindings.is_empty());
    assert!(shadowed_parameter.references.iter().any(|reference| {
        reference.name == "require" && reference.kind == ReferenceKind::Calls
    }));

    for source in [
        "const module = {};\nfunction local() {}\nmodule.exports = { local };\n",
        "const exports = {};\nfunction local() {}\nexports.local = local;\n",
    ] {
        let shadowed_export = extract("src/shadowed-export.cjs", source);
        assert!(!symbol(&shadowed_export, "local").export.exported);
    }
}

#[test]
fn symbol_health_metrics_are_ast_scoped_privacy_safe_and_agent_focused() {
    let file = extract(
        "src/risky.ts",
        r"
export async function risky(a: string, b: string, c: string, d: string, e: string) {
  // TODO: replace compatibility cast
  const value = a as any;
  readFileSync(a);
  try { JSON.parse(value); } catch (error) {}
  for (const item of [a, b]) { await fetch(item); }
  if (a && b && c) { if (d) { return value; } }
}
export function network(url: string) { return fetch(url).then(JSON.parse); }
export function debugOnly() { console.log('hello'); }
export function empty() {}
",
    );
    let risky = symbol(&file, "risky");
    assert_eq!(risky.health.parameter_count, 5);
    assert!(risky.health.cyclomatic >= 5);
    assert!(risky.health.max_nesting >= 2);
    assert!(risky.health.max_conditional_operands >= 3);
    assert_eq!(risky.health.ts_any_casts, 1);
    assert_eq!(risky.health.sync_io_in_async, 1);
    assert_eq!(risky.health.empty_catches, 1);
    assert_eq!(risky.health.sequential_await_loops, 1);
    assert!(risky.health.incomplete_markers >= 1);
    assert_eq!(symbol(&file, "network").health.http_without_timeout, 1);
    assert_eq!(symbol(&file, "debugOnly").health.debug_logs, 1);
    assert_eq!(symbol(&file, "empty").health.empty_body, 1);
    assert!(!format!("{:?}", risky.health).contains("compatibility cast"));
}

#[test]
fn sequential_await_loop_health_is_limited_to_javascript_for_of_bodies() {
    let javascript = extract(
        "src/loops.ts",
        r"
export async function sequential(items: string[]) {
  for (const item of items) { await consume(item); }
}
export async function objectKeys(items: Record<string, string>) {
  for (const key in items) { await consume(key); }
}
export async function asyncStream(items: AsyncIterable<string>) {
  for await (const item of items) { consume(item); }
}
export async function callbackOnly(items: string[]) {
  for (const item of items) {
    items.map(async (value) => await consume(value));
  }
}
export async function nested(items: string[][]) {
  for (const group of items) {
    for (const item of group) { await consume(item); }
  }
}
",
    );
    assert_eq!(
        symbol(&javascript, "sequential")
            .health
            .sequential_await_loops,
        1
    );
    for name in ["objectKeys", "asyncStream", "callbackOnly"] {
        assert_eq!(
            symbol(&javascript, name).health.sequential_await_loops,
            0,
            "unexpected sequential-await signal for {name}"
        );
    }
    assert_eq!(
        symbol(&javascript, "nested").health.sequential_await_loops,
        1
    );

    let rust = extract(
        "src/loops.rs",
        r"
async fn bounded(items: Vec<Item>) {
    for item in items {
        item.consume().await;
    }
}
",
    );
    assert_eq!(symbol(&rust, "bounded").health.sequential_await_loops, 0);
}

#[test]
fn symbol_health_retains_literal_and_sensitive_signals_without_retaining_literals() {
    let file = extract(
        "src/config.ts",
        r#"
/** Default retry count is 3. */
export const RETRY_COUNT = 5;

export function authenticate(apiKey: string, password: string) {
  const endpoint = "https://api.example.com/v1";
  const weights = [3, 4, 5, 6, 8];
  return sign(endpoint, process.env.SECRET_KEY, apiKey, password, weights);
}

export function buildEndpoint(host: string) {
  return `https://${host}/v1`;
}
"#,
    );

    let authenticate = symbol(&file, "authenticate");
    assert_eq!(authenticate.health.magic_numbers, 5);
    assert_eq!(authenticate.health.hardcoded_urls, 1);
    assert!(authenticate.health.literal_bytes > 0);
    assert!(authenticate.health.secrets_score >= 70);
    assert_ne!(authenticate.health.secrets_signal_mask, 0);
    let build_endpoint = symbol(&file, "buildEndpoint");
    assert_eq!(build_endpoint.health.hardcoded_urls, 0);
    assert!(build_endpoint.health.literal_bytes > 0);

    let retry_count = symbol(&file, "RETRY_COUNT");
    assert_eq!(retry_count.health.stale_doc_numbers, 1);
    assert!(retry_count.signature.is_none());
    assert!(!format!("{:?}", retry_count.health).contains("RETRY_COUNT"));
}

#[test]
fn symbol_health_collapses_multiline_literals_for_code_line_metrics() {
    let payload = "SELECT value FROM records;\n".repeat(150);
    let source = format!("fn literal_heavy() -> &'static str {{\n    r#\"{payload}\"#\n}}\n");
    let file = extract("src/literal_heavy.rs", &source);
    let literal_heavy = symbol(&file, "literal_heavy");
    assert!(literal_heavy.span.end_line() > 100);
    assert!(literal_heavy.health.code_lines < 10);
}

#[test]
fn symbol_health_normalizes_typed_numeric_literals_before_magic_number_scoring() {
    let file = extract(
        "src/numbers.rs",
        r"
fn benign() {
    let _values = [0_u8, 1_u16, 2_u32, 0x0_u64, 0b1_usize, 0o2_i32];
}

fn meaningful() {
    let _value = 3_u8;
}
",
    );
    assert_eq!(symbol(&file, "benign").health.magic_numbers, 0);
    assert_eq!(symbol(&file, "meaningful").health.magic_numbers, 1);
}

#[test]
fn symbol_health_keeps_else_if_ladders_flat_but_counts_true_nesting() {
    let rust = extract(
        "src/branches.rs",
        r"
fn ladder(value: u8) -> u8 {
    if value == 0 { 0 }
    else if value == 1 { 1 }
    else if value == 2 { 2 }
    else { 3 }
}

fn nested(value: u8) -> u8 {
    if value == 0 {
        0
    } else {
        if value == 1 { 1 } else { 2 }
    }
}
",
    );
    assert_eq!(symbol(&rust, "ladder").health.max_nesting, 1);
    assert_eq!(symbol(&rust, "ladder").health.cyclomatic, 4);
    assert_eq!(symbol(&rust, "nested").health.max_nesting, 2);

    let python = extract(
        "src/branches.py",
        r"
def ladder(value):
    if value == 0:
        return 0
    elif value == 1:
        return 1
    elif value == 2:
        return 2
    return 3
",
    );
    assert_eq!(symbol(&python, "ladder").health.max_nesting, 1);
    assert_eq!(symbol(&python, "ladder").health.cyclomatic, 4);
}

#[test]
fn symbol_health_excludes_language_level_receiver_parameters() {
    let typescript = extract(
        "src/receivers.ts",
        r"
interface Context {}
function bound(this: Context, first: string, second: string, third: string, fourth: string) {}
",
    );
    assert_eq!(symbol(&typescript, "bound").health.parameter_count, 4);

    let python = extract(
        "src/receivers.py",
        r"
class Worker:
    def run(self, first, second, third, fourth):
        return first

    @classmethod
    def create(cls, first, second, third, fourth):
        return cls()
",
    );
    assert_eq!(symbol(&python, "Worker::run").health.parameter_count, 4);
    assert_eq!(symbol(&python, "Worker::create").health.parameter_count, 4);
}

#[test]
fn health_markers_distinguish_detector_vocabulary_from_source_evidence() {
    let file = extract(
        "src/detectors.ts",
        r#"
export function vocabulary() {
  const incomplete = ["TODO", "FIXME", "XXX", "HACK", "not implemented"];
  const sensitive = ["secret", "token", "password", "client_secret", "sign", "key"];
  return incomplete.concat(sensitive);
}

export function unfinished() {
  // TODO: replace the placeholder
  throw new Error("not implemented");
}

export function literalLeak() {
  return "AKIA1234567890ABCDEF";
}

export function classifyToken(token: string, parsed: { signature: string }) {
  const [key, value] = token.split(":");
  return key === "sig" ? parsed.signature : value;
}

export function signPayload(payload: string, secretKey: string) {
  return sign(payload, secretKey);
}
"#,
    );
    let vocabulary = symbol(&file, "vocabulary");
    assert_eq!(vocabulary.health.incomplete_markers, 0);
    assert_eq!(vocabulary.health.secrets_score, 0);
    assert_eq!(symbol(&file, "unfinished").health.incomplete_markers, 2);
    assert!(symbol(&file, "literalLeak").health.secrets_score >= 60);
    assert!(symbol(&file, "classifyToken").health.secrets_score < 50);
    assert!(symbol(&file, "signPayload").health.secrets_score >= 50);
}

#[test]
fn clone_shape_digest_detects_alpha_renamed_literal_changed_type_two_clones() {
    let file = extract(
        "src/clones.ts",
        r"
export function first(input: number) {
  const doubled = input * 3;
  if (doubled > 9) {
    return doubled - 4;
  }
  return doubled + 5;
}

export function second(value: number) {
  const scaled = value * 7;
  if (scaled > 21) {
    return scaled - 8;
  }
  return scaled + 11;
}
",
    );
    let first = symbol(&file, "first");
    let second = symbol(&file, "second");
    assert_ne!(first.structural_digest, second.structural_digest);
    assert_eq!(first.clone_shape_digest, second.clone_shape_digest);
}

fn extract(path: &str, source: &str) -> ExtractedFile {
    let limits = match SourceLimits::new(SOURCE_LIMIT_BYTES) {
        Ok(limits) => limits,
        Err(error) => panic!("polyglot source limits are invalid: {error}"),
    };
    let snapshot = match SourceSnapshot::from_bytes(path, source.as_bytes(), limits) {
        Ok(snapshot) => snapshot,
        Err(error) => panic!("polyglot snapshot failed: {error}"),
    };
    let mut extractor = match NativeExtractor::new(snapshot.language()) {
        Ok(extractor) => extractor,
        Err(error) => panic!("polyglot grammar failed: {error}"),
    };
    match extractor.extract(&snapshot) {
        Ok(file) => file,
        Err(error) => panic!("polyglot extraction failed: {error}"),
    }
}

fn symbol<'a>(
    file: &'a ExtractedFile,
    qualified_name: &str,
) -> &'a cartograph_extract::ExtractedSymbol {
    file.symbols
        .iter()
        .find(|symbol| symbol.qualified_name == qualified_name)
        .unwrap_or_else(|| panic!("missing polyglot symbol {qualified_name}"))
}
