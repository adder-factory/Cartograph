use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId, SymbolKind, Visibility};
use tree_sitter::Node;

use crate::{ExtractError, ExtractedImportBinding, ImportBindingKind};

use super::{
    ExtractionBuilder, PendingReference, PendingSymbol, references,
    syntax::{children, descendants_including_root, has_child_kind, named_children, span_for},
};

#[derive(Clone, Copy)]
struct ContainerDeclaration<'tree> {
    node: Node<'tree>,
    depth: usize,
    kind: SymbolKind,
    exported: bool,
    visibility: Option<Visibility>,
}

#[derive(Clone, Copy)]
struct CallableDeclaration<'tree> {
    node: Node<'tree>,
    depth: usize,
    kind: SymbolKind,
    exported: bool,
    async_symbol: bool,
    visibility: Option<Visibility>,
}

#[derive(Clone, Copy)]
struct LeafDeclaration<'tree> {
    node: Node<'tree>,
    kind: SymbolKind,
    exported: bool,
    visibility: Option<Visibility>,
}

struct PolyglotNodeReference<'tree> {
    owner: Option<SymbolId>,
    node: Node<'tree>,
    kind: ReferenceKind,
}

struct OwnedBody<'tree> {
    owner: SymbolId,
    qualifier: String,
    body: Node<'tree>,
    depth: usize,
}

struct ContainerScope<'tree> {
    declaration: ContainerDeclaration<'tree>,
    owner: SymbolId,
    qualifier: String,
}

struct CallableSymbolInput<'tree> {
    declaration: CallableDeclaration<'tree>,
    name: String,
    body: Option<Node<'tree>>,
}

struct LeafSymbolInput<'tree> {
    declaration: LeafDeclaration<'tree>,
    name: String,
}

struct CallableScope<'tree> {
    declaration: CallableDeclaration<'tree>,
    owner: Option<SymbolId>,
    qualifier: Option<String>,
}

struct ReceiverOwner {
    symbol: Option<SymbolId>,
    name: Option<String>,
}

struct PolyglotImport<'tree> {
    node: Node<'tree>,
    module_specifier: String,
    kind: ImportBindingKind,
    imported_name: String,
    local_name: String,
    binding_node: Node<'tree>,
}

struct PythonImportName<'tree> {
    imported: Node<'tree>,
    name_node: Node<'tree>,
    name: String,
    alias: Option<String>,
}

struct PythonFromBinding<'tree, 'text> {
    binding: PythonImportName<'tree>,
    module_specifier: &'text str,
    package_prefix: Option<&'text str>,
}

#[derive(Clone, Copy)]
struct GoTypeDeclaration<'tree> {
    node: Node<'tree>,
    depth: usize,
    alias: bool,
}

pub(super) fn visit_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    match builder.context.snapshot.language() {
        SourceLanguage::Rust => visit_rust_declaration(builder, node, depth),
        SourceLanguage::Python => visit_python_declaration(builder, node, depth),
        SourceLanguage::Go => visit_go_declaration(builder, node, depth),
        SourceLanguage::TypeScript
        | SourceLanguage::Tsx
        | SourceLanguage::JavaScript
        | SourceLanguage::Jsx => Ok(false),
    }
}

pub(super) fn capture_usage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    match (builder.context.snapshot.language(), node.kind()) {
        (SourceLanguage::Rust | SourceLanguage::Go, "call_expression")
        | (SourceLanguage::Python, "call") => {
            references::capture_invocation(builder, node, references::InvocationKind::Call)
        }
        (SourceLanguage::Rust, "field_expression") => {
            references::capture_member_field(builder, node, "field")
        }
        (SourceLanguage::Python, "attribute") => {
            references::capture_member_field(builder, node, "attribute")
        }
        (SourceLanguage::Go, "selector_expression") => {
            references::capture_member_field(builder, node, "field")
        }
        (SourceLanguage::Rust, "macro_invocation") => capture_rust_macro(builder, node),
        _ => Ok(()),
    }
}

fn visit_rust_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    if visit_rust_container(builder, node, depth)? || visit_rust_leaf(builder, node)? {
        return Ok(true);
    }
    visit_rust_special_declaration(builder, node, depth)
}

fn visit_rust_container(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    if let Some(kind) = rust_container_kind(node.kind()) {
        let visibility = rust_visibility(builder, node);
        visit_named_container(
            builder,
            ContainerDeclaration {
                node,
                depth,
                kind,
                exported: visibility.is_some(),
                visibility,
            },
        )?;
        return Ok(true);
    }
    Ok(false)
}

fn visit_rust_leaf(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<bool, ExtractError> {
    if let Some(kind) = rust_leaf_kind(node.kind()) {
        let visibility = rust_visibility(builder, node);
        visit_leaf_declaration(
            builder,
            LeafDeclaration {
                node,
                kind,
                exported: visibility.is_some(),
                visibility,
            },
        )?;
        return Ok(true);
    }
    Ok(false)
}

fn visit_rust_special_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    match node.kind() {
        "mod_item" => visit_rust_module(builder, node, depth)?,
        "impl_item" => visit_rust_impl(builder, node, depth)?,
        "function_item" | "function_signature_item" => visit_rust_callable(builder, node, depth)?,
        "enum_variant" => visit_leaf_declaration(
            builder,
            LeafDeclaration {
                node,
                kind: SymbolKind::EnumMember,
                exported: false,
                visibility: None,
            },
        )?,
        "use_declaration" => visit_rust_use(builder, node)?,
        _ => return Ok(false),
    }
    Ok(true)
}

fn rust_container_kind(node_kind: &str) -> Option<SymbolKind> {
    [
        ("struct_item", SymbolKind::Struct),
        ("enum_item", SymbolKind::Enum),
        ("trait_item", SymbolKind::Trait),
    ]
    .into_iter()
    .find_map(|(candidate, kind)| (candidate == node_kind).then_some(kind))
}

fn rust_leaf_kind(node_kind: &str) -> Option<SymbolKind> {
    [
        ("type_item", SymbolKind::TypeAlias),
        ("associated_type", SymbolKind::TypeAlias),
        ("const_item", SymbolKind::Constant),
        ("static_item", SymbolKind::Variable),
    ]
    .into_iter()
    .find_map(|(candidate, kind)| (candidate == node_kind).then_some(kind))
}

fn visit_rust_module(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    if node.child_by_field_name("body").is_none() {
        return visit_rust_external_module(builder, node);
    }
    let visibility = rust_visibility(builder, node);
    visit_named_container(
        builder,
        ContainerDeclaration {
            node,
            depth,
            kind: SymbolKind::Module,
            exported: visibility.is_some(),
            visibility,
        },
    )
    .map(|_| ())
}

fn visit_rust_callable(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let kind = if is_rust_associated_callable(node) {
        SymbolKind::Method
    } else {
        SymbolKind::Function
    };
    let visibility = rust_visibility(builder, node);
    visit_callable(
        builder,
        CallableDeclaration {
            node,
            depth,
            kind,
            exported: visibility.is_some(),
            async_symbol: rust_async(node),
            visibility,
        },
    )
}

fn visit_python_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    match node.kind() {
        "class_definition" => visit_python_class(builder, node, depth)?,
        "function_definition" => {
            let kind = if is_python_class_member(node) {
                SymbolKind::Method
            } else {
                SymbolKind::Function
            };
            let exported = node
                .child_by_field_name("name")
                .is_some_and(|name| python_exported(builder, name));
            visit_callable(
                builder,
                CallableDeclaration {
                    node,
                    depth,
                    kind,
                    exported,
                    async_symbol: has_child_kind(node, "async"),
                    visibility: None,
                },
            )?;
        }
        "import_statement" | "import_from_statement" => visit_python_import(builder, node)?,
        _ => return Ok(false),
    }
    Ok(true)
}

fn visit_go_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    match node.kind() {
        "package_clause" => {
            visit_go_package(builder, node)?;
        }
        "function_declaration" => {
            let exported = node
                .child_by_field_name("name")
                .is_some_and(|name| go_exported(builder, name));
            visit_callable(
                builder,
                CallableDeclaration {
                    node,
                    depth,
                    kind: SymbolKind::Function,
                    exported,
                    async_symbol: false,
                    visibility: None,
                },
            )?;
        }
        "method_declaration" => visit_go_method(builder, node, depth)?,
        "method_elem" => {
            let exported = node
                .child_by_field_name("name")
                .is_some_and(|name| go_exported(builder, name));
            visit_callable(
                builder,
                CallableDeclaration {
                    node,
                    depth,
                    kind: SymbolKind::Method,
                    exported,
                    async_symbol: false,
                    visibility: None,
                },
            )?;
        }
        "type_declaration" => builder.visit_named_children(node, depth)?,
        "type_spec" => visit_go_type(
            builder,
            GoTypeDeclaration {
                node,
                depth,
                alias: false,
            },
        )?,
        "type_alias" => visit_go_type(
            builder,
            GoTypeDeclaration {
                node,
                depth,
                alias: true,
            },
        )?,
        "import_declaration" => visit_go_imports(builder, node)?,
        _ => return Ok(false),
    }
    Ok(true)
}

fn visit_named_container(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: ContainerDeclaration<'_>,
) -> Result<SymbolId, ExtractError> {
    let Some(name_node) = declaration.node.child_by_field_name("name") else {
        builder.visit_named_children(declaration.node, declaration.depth)?;
        return Err(ExtractError::InvalidSpan);
    };
    let name = builder.context.owned_text(name_node)?;
    let id = emit_container_symbol(builder, declaration, name.clone())?;
    visit_container_body(
        builder,
        ContainerScope {
            declaration,
            owner: id.clone(),
            qualifier: name,
        },
    )?;
    Ok(id)
}

fn visit_container_body(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: ContainerScope<'_>,
) -> Result<(), ExtractError> {
    let Some(body) = input.declaration.node.child_by_field_name("body") else {
        return Ok(());
    };
    visit_owned_body(
        builder,
        OwnedBody {
            owner: input.owner,
            qualifier: input.qualifier,
            body,
            depth: input.declaration.depth,
        },
    )
}

fn emit_container_symbol(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: ContainerDeclaration<'_>,
    name: String,
) -> Result<SymbolId, ExtractError> {
    let pending = PendingSymbol {
        kind: declaration.kind,
        name,
        span_node: declaration.node,
        structural_node: declaration.node,
        doc_anchor: declaration.node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: declaration.exported,
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility: declaration.visibility,
    };
    builder.emit_symbol(pending)
}

fn visit_python_class(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let exported = node
        .child_by_field_name("name")
        .is_some_and(|name| python_exported(builder, name));
    let id = visit_named_container(
        builder,
        ContainerDeclaration {
            node,
            depth,
            kind: SymbolKind::Class,
            exported,
            visibility: None,
        },
    )?;
    capture_python_heritage(builder, node, &id)
}

fn capture_python_heritage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    let Some(superclasses) = node.child_by_field_name("superclasses") else {
        return Ok(());
    };
    for target in named_children(superclasses)
        .filter(|target| matches!(target.kind(), "identifier" | "attribute"))
    {
        emit_node_reference(
            builder,
            PolyglotNodeReference {
                owner: Some(owner.clone()),
                node: target,
                kind: ReferenceKind::Extends,
            },
        )?;
    }
    Ok(())
}

fn visit_callable(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: CallableDeclaration<'_>,
) -> Result<(), ExtractError> {
    let Some(input) = callable_symbol_input(builder, declaration)? else {
        return builder.visit_named_children(declaration.node, declaration.depth);
    };
    let id = emit_callable_symbol(builder, &input)?;
    references::capture_callable_types(builder, declaration.node, &id)?;
    visit_callable_body(builder, input, id)
}

fn callable_symbol_input<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: CallableDeclaration<'tree>,
) -> Result<Option<CallableSymbolInput<'tree>>, ExtractError> {
    let Some(name_node) = declaration.node.child_by_field_name("name") else {
        return Ok(None);
    };
    Ok(Some(CallableSymbolInput {
        declaration,
        name: builder.context.owned_text(name_node)?,
        body: declaration.node.child_by_field_name("body"),
    }))
}

fn visit_callable_body(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: CallableSymbolInput<'_>,
    owner: SymbolId,
) -> Result<(), ExtractError> {
    let Some(body) = input.body else {
        return Ok(());
    };
    visit_owned_body(
        builder,
        OwnedBody {
            owner,
            qualifier: input.name,
            body,
            depth: input.declaration.depth,
        },
    )
}

fn emit_callable_symbol(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: &CallableSymbolInput<'_>,
) -> Result<SymbolId, ExtractError> {
    let pending = PendingSymbol {
        kind: input.declaration.kind,
        name: input.name.clone(),
        span_node: input.declaration.node,
        structural_node: input.declaration.node,
        doc_anchor: input.declaration.node,
        body_node: input.body,
        declaration_only: input.body.is_none(),
        signature: builder.context.callable_signature(input.declaration.node)?,
        exported: input.declaration.exported,
        default_export: false,
        async_symbol: input.declaration.async_symbol,
        static_member: false,
        visibility: input.declaration.visibility,
    };
    builder.emit_symbol(pending)
}

fn visit_leaf_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: LeafDeclaration<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = declaration.node.child_by_field_name("name") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    emit_leaf_symbol(builder, LeafSymbolInput { declaration, name })
}

fn emit_leaf_symbol(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: LeafSymbolInput<'_>,
) -> Result<(), ExtractError> {
    let pending = PendingSymbol {
        kind: input.declaration.kind,
        name: input.name,
        span_node: input.declaration.node,
        structural_node: input.declaration.node,
        doc_anchor: input.declaration.node,
        body_node: input.declaration.node.child_by_field_name("value"),
        declaration_only: false,
        signature: None,
        exported: input.declaration.exported,
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility: input.declaration.visibility,
    };
    builder.emit_symbol(pending).map(|_| ())
}

fn visit_owned_body(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: OwnedBody<'_>,
) -> Result<(), ExtractError> {
    builder.owners.push(input.owner);
    builder.qualifiers.push(input.qualifier);
    let result = builder.visit(input.body, input.depth.saturating_add(1));
    builder.qualifiers.pop();
    builder.owners.pop();
    result
}

fn visit_scoped_callable(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: CallableScope<'_>,
) -> Result<(), ExtractError> {
    let CallableScope {
        declaration,
        owner,
        qualifier,
    } = input;
    let owner_depth = builder.owners.len();
    let qualifier_depth = builder.qualifiers.len();
    builder.owners.extend(owner);
    builder.qualifiers.extend(qualifier);
    let result = visit_callable(builder, declaration);
    builder.qualifiers.truncate(qualifier_depth);
    builder.owners.truncate(owner_depth);
    result
}

fn visit_rust_impl(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let Some(type_node) = node.child_by_field_name("type") else {
        return builder.visit_named_children(node, depth);
    };
    let Some(type_name_node) = descendants_including_root(type_node)
        .find(|candidate| candidate.kind() == "type_identifier")
    else {
        return builder.visit_named_children(node, depth);
    };
    let type_name = builder.context.owned_text(type_name_node)?;
    let owner = top_level_symbol(builder, &type_name);
    if let Some(owner) = &owner {
        builder.owners.push(owner.clone());
    }
    builder.qualifiers.push(type_name);
    if let Some(trait_node) = node.child_by_field_name("trait") {
        emit_node_reference(
            builder,
            PolyglotNodeReference {
                owner: owner.clone(),
                node: trait_node,
                kind: ReferenceKind::Implements,
            },
        )?;
    }
    if let Some(body) = node.child_by_field_name("body") {
        builder.visit(body, depth.saturating_add(1))?;
    }
    builder.qualifiers.pop();
    if owner.is_some() {
        builder.owners.pop();
    }
    Ok(())
}

fn visit_rust_external_module(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return Ok(());
    };
    let local_name = builder.context.owned_text(name_node)?;
    let module_specifier = format!("./{local_name}");
    if !builder.owners.is_empty()
        || !matches!(
            builder
                .context
                .snapshot
                .path()
                .as_str()
                .rsplit_once('/')
                .map_or(builder.context.snapshot.path().as_str(), |(_, name)| name),
            "lib.rs" | "main.rs" | "mod.rs"
        )
    {
        return emit_import_symbol_and_reference(builder, node, module_specifier);
    }
    emit_import(
        builder,
        PolyglotImport {
            node,
            module_specifier,
            kind: ImportBindingKind::Namespace,
            imported_name: "*".to_owned(),
            local_name,
            binding_node: name_node,
        },
    )
}

fn visit_rust_use(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(argument) = node.child_by_field_name("argument") else {
        return Ok(());
    };
    let raw = builder.context.owned_text(argument)?;
    emit_import_symbol_and_reference(builder, node, raw)
}

fn visit_python_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    if node.kind() == "import_from_statement" {
        visit_python_from_import(builder, node)
    } else {
        visit_python_plain_import(builder, node)
    }
}

fn visit_python_plain_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let mut cursor = node.walk();
    for imported in node.children_by_field_name("name", &mut cursor) {
        let Some(binding) = python_import_name(builder, imported)? else {
            continue;
        };
        let local_name = binding.alias.unwrap_or_else(|| {
            binding
                .name
                .split('.')
                .next()
                .unwrap_or(binding.name.as_str())
                .to_owned()
        });
        emit_import(
            builder,
            PolyglotImport {
                node,
                module_specifier: binding.name,
                kind: ImportBindingKind::Namespace,
                imported_name: "*".to_owned(),
                local_name,
                binding_node: binding.name_node,
            },
        )?;
    }
    Ok(())
}

fn visit_python_from_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(module_node) = node.child_by_field_name("module_name") else {
        return Ok(());
    };
    let raw_module = builder.context.owned_text(module_node)?;
    let package_prefix = python_package_relative_prefix(&raw_module);
    let module_specifier = python_module_specifier(&raw_module);
    if package_prefix.is_none() {
        emit_import_symbol_and_reference(builder, node, raw_module)?;
    }
    let mut cursor = node.walk();
    for imported in node.children_by_field_name("name", &mut cursor) {
        let Some(binding) = python_import_name(builder, imported)? else {
            continue;
        };
        emit_python_from_binding(
            builder,
            PythonFromBinding {
                binding,
                module_specifier: &module_specifier,
                package_prefix: package_prefix.as_deref(),
            },
        )?;
    }
    Ok(())
}

fn emit_python_from_binding(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: PythonFromBinding<'_, '_>,
) -> Result<(), ExtractError> {
    let PythonFromBinding {
        binding,
        module_specifier,
        package_prefix,
    } = input;
    let local_name = binding.alias.unwrap_or_else(|| binding.name.clone());
    if let Some(prefix) = package_prefix {
        if binding.name == "*" {
            return Ok(());
        }
        return emit_import(
            builder,
            PolyglotImport {
                node: binding.imported,
                module_specifier: format!("{prefix}{}", binding.name.replace('.', "/")),
                kind: ImportBindingKind::Namespace,
                imported_name: "*".to_owned(),
                local_name,
                binding_node: binding.name_node,
            },
        );
    }
    builder.emit_import_binding(ExtractedImportBinding {
        kind: ImportBindingKind::Named,
        module_specifier: module_specifier.to_owned(),
        imported_name: binding.name.clone(),
        local_name,
        span: span_for(binding.name_node)?,
    })?;
    emit_node_reference(
        builder,
        PolyglotNodeReference {
            owner: None,
            node: binding.name_node,
            kind: ReferenceKind::References,
        },
    )
}

fn python_import_name<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    imported: Node<'tree>,
) -> Result<Option<PythonImportName<'tree>>, ExtractError> {
    let (name_node, alias_node) = if imported.kind() == "aliased_import" {
        (
            imported.child_by_field_name("name"),
            imported.child_by_field_name("alias"),
        )
    } else {
        (Some(imported), None)
    };
    let Some(name_node) = name_node else {
        return Ok(None);
    };
    Ok(Some(PythonImportName {
        imported,
        name_node,
        name: builder.context.owned_text(name_node)?,
        alias: alias_node
            .map(|alias| builder.context.owned_text(alias))
            .transpose()?,
    }))
}

fn visit_go_imports(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    for specifier in descendants_including_root(node) {
        if specifier.kind() != "import_spec" {
            continue;
        }
        let Some(path_node) = specifier.child_by_field_name("path") else {
            continue;
        };
        let module_specifier = builder.context.owned_unquoted_text(path_node)?;
        let local_name = match specifier.child_by_field_name("name") {
            Some(alias) => builder.context.owned_text(alias)?,
            None => module_specifier
                .rsplit('/')
                .next()
                .unwrap_or(module_specifier.as_str())
                .to_owned(),
        };
        emit_import(
            builder,
            PolyglotImport {
                node: specifier,
                module_specifier,
                kind: ImportBindingKind::Namespace,
                imported_name: "*".to_owned(),
                local_name,
                binding_node: path_node,
            },
        )?;
    }
    Ok(())
}

fn visit_go_type(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: GoTypeDeclaration<'_>,
) -> Result<(), ExtractError> {
    let node = declaration.node;
    let Some(type_node) = node.child_by_field_name("type") else {
        return Ok(());
    };
    let kind = if declaration.alias {
        SymbolKind::TypeAlias
    } else {
        match type_node.kind() {
            "struct_type" => SymbolKind::Struct,
            "interface_type" => SymbolKind::Interface,
            _ => SymbolKind::TypeAlias,
        }
    };
    let exported = node
        .child_by_field_name("name")
        .is_some_and(|name| go_exported(builder, name));
    if matches!(kind, SymbolKind::Struct | SymbolKind::Interface) {
        let name_node = node
            .child_by_field_name("name")
            .ok_or(ExtractError::InvalidSpan)?;
        let name = builder.context.owned_text(name_node)?;
        let owner = visit_named_container(
            builder,
            ContainerDeclaration {
                node,
                depth: declaration.depth,
                kind,
                exported,
                visibility: None,
            },
        )?;
        builder.owners.push(owner);
        builder.qualifiers.push(name);
        builder.visit(type_node, declaration.depth.saturating_add(1))?;
        builder.qualifiers.pop();
        builder.owners.pop();
        Ok(())
    } else {
        visit_leaf_declaration(
            builder,
            LeafDeclaration {
                node,
                kind,
                exported,
                visibility: None,
            },
        )
    }
}

fn visit_go_package(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = named_children(node).find(|child| child.kind() == "package_identifier")
    else {
        return Ok(());
    };
    let pending = PendingSymbol {
        kind: SymbolKind::Module,
        name: builder.context.owned_text(name_node)?,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: false,
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility: None,
    };
    builder.emit_symbol(pending).map(|_| ())
}

fn visit_go_method(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let receiver = go_receiver_owner(builder, node)?;
    let exported = node
        .child_by_field_name("name")
        .is_some_and(|name| go_exported(builder, name));
    visit_scoped_callable(
        builder,
        CallableScope {
            declaration: CallableDeclaration {
                node,
                depth,
                kind: SymbolKind::Method,
                exported,
                async_symbol: false,
                visibility: None,
            },
            owner: receiver.symbol,
            qualifier: receiver.name,
        },
    )
}

fn go_receiver_owner(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<ReceiverOwner, ExtractError> {
    let name = node
        .child_by_field_name("receiver")
        .and_then(|receiver| {
            descendants_including_root(receiver)
                .find(|candidate| candidate.kind() == "type_identifier")
        })
        .map(|name| builder.context.owned_text(name))
        .transpose()?;
    let symbol = name
        .as_deref()
        .and_then(|name| top_level_symbol(builder, name));
    Ok(ReceiverOwner { symbol, name })
}

fn emit_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: PolyglotImport<'_>,
) -> Result<(), ExtractError> {
    emit_import_symbol_and_reference(builder, input.node, input.module_specifier.clone())?;
    builder.emit_import_binding(ExtractedImportBinding {
        kind: input.kind,
        module_specifier: input.module_specifier,
        imported_name: input.imported_name,
        local_name: input.local_name,
        span: span_for(input.binding_node)?,
    })
}

fn emit_import_symbol_and_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    module_name: String,
) -> Result<(), ExtractError> {
    let pending = PendingSymbol {
        kind: SymbolKind::Import,
        name: module_name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: false,
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility: None,
    };
    builder.emit_symbol(pending)?;
    references::push_reference(
        builder,
        PendingReference {
            owner: None,
            name: module_name,
            kind: ReferenceKind::Imports,
            node,
        },
    )
}

fn emit_node_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: PolyglotNodeReference<'_>,
) -> Result<(), ExtractError> {
    let name = builder.context.owned_text(input.node)?;
    references::push_reference(
        builder,
        PendingReference {
            owner: input.owner,
            name,
            kind: input.kind,
            node: input.node,
        },
    )
}

fn capture_rust_macro(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(target) = node.child_by_field_name("macro") else {
        return Ok(());
    };
    emit_node_reference(
        builder,
        PolyglotNodeReference {
            owner: builder.owners.last().cloned(),
            node: target,
            kind: ReferenceKind::Calls,
        },
    )
}

fn top_level_symbol(builder: &ExtractionBuilder<'_, '_>, name: &str) -> Option<SymbolId> {
    builder
        .facts
        .symbols
        .iter()
        .find(|symbol| {
            symbol.name == name
                && symbol.qualified_name == name
                && matches!(
                    symbol.kind,
                    SymbolKind::Struct
                        | SymbolKind::Class
                        | SymbolKind::Enum
                        | SymbolKind::Interface
                        | SymbolKind::Trait
                        | SymbolKind::TypeAlias
                )
        })
        .map(|symbol| symbol.id.clone())
}

fn python_module_specifier(raw: &str) -> String {
    let dots = raw
        .chars()
        .take_while(|character| *character == '.')
        .count();
    let suffix = raw[dots..].replace('.', "/");
    if dots == 0 {
        return suffix;
    }
    if dots == 1 {
        format!("./{suffix}")
    } else {
        format!("{}{suffix}", "../".repeat(dots.saturating_sub(1)))
    }
}

fn python_package_relative_prefix(raw: &str) -> Option<String> {
    let dots = raw
        .chars()
        .take_while(|character| *character == '.')
        .count();
    (dots > 0 && dots == raw.len()).then(|| {
        if dots == 1 {
            "./".to_owned()
        } else {
            "../".repeat(dots.saturating_sub(1))
        }
    })
}

fn python_exported(builder: &ExtractionBuilder<'_, '_>, name: Node<'_>) -> bool {
    builder.owners.is_empty() && !builder.context.text(name).trim().starts_with('_')
}

fn go_exported(builder: &ExtractionBuilder<'_, '_>, name: Node<'_>) -> bool {
    builder
        .context
        .text(name)
        .trim()
        .chars()
        .next()
        .is_some_and(char::is_uppercase)
}

fn rust_visibility(builder: &ExtractionBuilder<'_, '_>, node: Node<'_>) -> Option<Visibility> {
    let visibility = named_children(node)
        .find(|child| child.kind() == "visibility_modifier")
        .map(|node| builder.context.text(node).trim())?;
    match visibility {
        "pub" => Some(Visibility::Public),
        "pub(crate)" | "pub(super)" => Some(Visibility::Internal),
        _ => None,
    }
}

fn rust_async(node: Node<'_>) -> bool {
    named_children(node)
        .find(|child| child.kind() == "function_modifiers")
        .is_some_and(|modifiers| children(modifiers).any(|child| child.kind() == "async"))
}

fn is_rust_associated_callable(node: Node<'_>) -> bool {
    node.parent()
        .and_then(|parent| parent.parent())
        .is_some_and(|parent| matches!(parent.kind(), "impl_item" | "trait_item"))
}

fn is_python_class_member(node: Node<'_>) -> bool {
    node.parent()
        .and_then(|parent| {
            if parent.kind() == "decorated_definition" {
                parent.parent()
            } else {
                Some(parent)
            }
        })
        .and_then(|body| body.parent())
        .is_some_and(|parent| parent.kind() == "class_definition")
}
