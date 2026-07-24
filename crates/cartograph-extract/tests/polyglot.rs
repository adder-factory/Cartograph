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
