use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind, Visibility};
use cartograph_extract::{ExtractedFile, NativeExtractor, SourceLimits, SourceSnapshot};

const SOURCE_LIMIT_BYTES: usize = 256 * 1024;

#[test]
fn rust_extracts_types_methods_calls_and_containment() {
    let file = extract(
        "src/worker.rs",
        r#"
pub struct Worker {
    value: u32,
}

impl Worker {
    pub fn run(&self) -> u32 {
        helper(self.value)
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
"#,
    );

    let worker = symbol(&file, "Worker");
    let run = symbol(&file, "Worker::run");
    let helper = symbol(&file, "helper");
    assert_eq!(file.language, SourceLanguage::Rust);
    assert_eq!(worker.kind, SymbolKind::Struct);
    assert_eq!(run.kind, SymbolKind::Method);
    assert_eq!(helper.kind, SymbolKind::Function);
    assert!(worker.exported && run.exported && helper.exported);
    let private_helper = symbol(&file, "private_helper");
    let crate_helper = symbol(&file, "crate_helper");
    assert!(!private_helper.exported && private_helper.visibility.is_none());
    assert!(crate_helper.exported);
    assert_eq!(crate_helper.visibility, Some(Visibility::Internal));
    assert_eq!(helper.visibility, Some(Visibility::Public));
    assert!(!symbol(&file, "sync_with_async_block").async_symbol);
    assert!(symbol(&file, "async_helper").async_symbol);
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
    assert!(execute.declaration_only);
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
    assert!(class.exported && !method.exported && helper.exported);
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
    assert!(worker.exported && run.exported && helper.exported);
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
    assert!(execute.declaration_only);
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
    assert!(symbol(&local, "local").exported);

    let local_alias = extract(
        "src/local-alias.ts",
        "const local = (): void => {};\nexport { local as publicLocal };\n",
    );
    let public_local = symbol(&local_alias, "publicLocal");
    assert_eq!(public_local.kind, SymbolKind::Export);
    assert!(public_local.exported);
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
    assert!(default_symbol.exported && default_symbol.default_export);

    let barrel = extract(
        "src/barrel.ts",
        "export { helper as renamed } from './helper';\n",
    );
    let renamed = symbol(&barrel, "renamed");
    assert_eq!(renamed.kind, SymbolKind::Export);
    assert!(renamed.exported);
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

    let commonjs = extract(
        "src/consumer.cjs",
        "const helper = require('./helper');\nfunction use() { helper.run(); }\nmodule.exports = { use };\n",
    );
    assert!(symbol(&commonjs, "use").exported);
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

    let conditional = extract(
        "src/conditional.cjs",
        "const hidden = () => {};\nif (enabled) { exports.hidden = hidden; }\n",
    );
    assert!(!symbol(&conditional, "hidden").exported);

    let computed = extract(
        "src/computed.cjs",
        "const hidden = () => {};\nmodule.exports = { [name]: hidden };\n",
    );
    assert!(!symbol(&computed, "hidden").exported);
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
        assert!(!symbol(&shadowed_export, "local").exported);
    }
}

#[test]
fn symbol_health_metrics_are_ast_scoped_privacy_safe_and_agent_focused() {
    let file = extract(
        "src/risky.ts",
        r#"
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
"#,
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
fn clone_shape_digest_detects_alpha_renamed_literal_changed_type_two_clones() {
    let file = extract(
        "src/clones.ts",
        r#"
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
"#,
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
