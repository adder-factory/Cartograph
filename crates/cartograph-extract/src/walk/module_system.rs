use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind};
use tree_sitter::Node;

use crate::{ExtractError, ExtractedImportBinding, ImportBindingKind};

use super::{
    ExtractionBuilder, PendingReference, PendingSymbol, references,
    syntax::{descendants_including_root, has_child_kind, named_children, span_for},
};

struct CommonJsRequire<'tree> {
    call: Node<'tree>,
    selected_member: Option<Node<'tree>>,
    module_specifier: String,
}

pub(super) struct ExportAlias<'tree> {
    pub(super) public_name: String,
    pub(super) local_name: String,
    pub(super) span_node: Node<'tree>,
    pub(super) reference_node: Node<'tree>,
    pub(super) source: Option<String>,
}

#[derive(Default)]
pub(super) struct CommonJsShadowing {
    require: bool,
    module: bool,
    exports: bool,
}

impl CommonJsShadowing {
    fn record(&mut self, name: &str) {
        match name.trim() {
            "require" => self.require = true,
            "module" => self.module = true,
            "exports" => self.exports = true,
            _ => {}
        }
    }
}

pub(super) fn collect_explicit_exports(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    if !is_javascript_family(builder.context.snapshot.language()) {
        return Ok(());
    }
    collect_commonjs_shadowing(builder, root)?;
    for node in descendants_including_root(root) {
        builder.context.ensure_active()?;
        match node.kind() {
            "export_statement" if node.child_by_field_name("source").is_none() => {
                collect_local_export_statement(builder, node)?;
            }
            "assignment_expression" => collect_commonjs_export_assignment(builder, node)?,
            _ => {}
        }
    }
    Ok(())
}

fn collect_commonjs_shadowing(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    for node in descendants_including_root(root) {
        builder.context.ensure_active()?;
        match node.kind() {
            "variable_declarator" | "class_declaration" => {
                record_binding_field(builder, node, "name")?;
            }
            "function_declaration"
            | "generator_function_declaration"
            | "function_expression"
            | "generator_function"
            | "method_definition"
            | "arrow_function" => record_callable_bindings(builder, node)?,
            "import_statement" => record_binding_tree(builder, node)?,
            "catch_clause" => record_binding_field(builder, node, "parameter")?,
            _ => {}
        }
    }
    Ok(())
}

fn record_callable_bindings(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    record_binding_field(builder, node, "name")?;
    if let Some(parameters) = node
        .child_by_field_name("parameters")
        .or_else(|| node.child_by_field_name("parameter"))
    {
        record_binding_tree(builder, parameters)?;
    }
    Ok(())
}

fn record_binding_field(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    field: &str,
) -> Result<(), ExtractError> {
    let Some(binding) = node.child_by_field_name(field) else {
        return Ok(());
    };
    record_binding_tree(builder, binding)
}

fn record_binding_tree(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    for node in descendants_including_root(root) {
        builder.context.ensure_active()?;
        if matches!(
            node.kind(),
            "identifier" | "property_identifier" | "shorthand_property_identifier_pattern"
        ) {
            builder
                .commonjs_shadowing
                .record(builder.context.text(node));
        }
    }
    Ok(())
}

pub(super) fn capture_commonjs_require(
    builder: &mut ExtractionBuilder<'_, '_>,
    name_node: Node<'_>,
    value: Option<Node<'_>>,
) -> Result<(), ExtractError> {
    if !is_javascript_family(builder.context.snapshot.language()) {
        return Ok(());
    }
    if builder.commonjs_shadowing.require {
        return Ok(());
    }
    let Some(require) = parse_commonjs_require(builder, value)? else {
        return Ok(());
    };
    if !capture_commonjs_binding(builder, name_node, &require)? {
        return Ok(());
    }
    emit_commonjs_module_reference(builder, require)
}

fn parse_commonjs_require<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    value: Option<Node<'tree>>,
) -> Result<Option<CommonJsRequire<'tree>>, ExtractError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some((call, selected_member)) = commonjs_require_shape(value) else {
        return Ok(None);
    };
    let Some(source) = commonjs_require_source(builder, call) else {
        return Ok(None);
    };
    Ok(Some(CommonJsRequire {
        call,
        selected_member,
        module_specifier: builder.context.owned_unquoted_text(source)?,
    }))
}

fn commonjs_require_shape(value: Node<'_>) -> Option<(Node<'_>, Option<Node<'_>>)> {
    if value.kind() == "call_expression" {
        return Some((value, None));
    }
    if value.kind() == "member_expression" {
        let object = value.child_by_field_name("object")?;
        let property = value.child_by_field_name("property")?;
        return Some((object, Some(property)));
    }
    None
}

fn commonjs_require_source<'tree>(
    builder: &ExtractionBuilder<'_, '_>,
    call: Node<'tree>,
) -> Option<Node<'tree>> {
    if call.kind() != "call_expression" {
        return None;
    }
    let function = call.child_by_field_name("function")?;
    if builder.context.text(function).trim() != "require" {
        return None;
    }
    let arguments = call.child_by_field_name("arguments")?;
    if arguments.named_child_count() != 1 {
        return None;
    }
    arguments
        .named_child(0)
        .filter(|child| child.kind() == "string")
}

pub(super) fn is_static_commonjs_binding_call(
    builder: &ExtractionBuilder<'_, '_>,
    call: Node<'_>,
) -> bool {
    if builder.commonjs_shadowing.require
        || !is_javascript_family(builder.context.snapshot.language())
        || commonjs_require_source(builder, call).is_none()
    {
        return false;
    }
    let Some((declarator, selected_member)) = commonjs_binding_declarator(call) else {
        return false;
    };
    let Some(name) = declarator.child_by_field_name("name") else {
        return false;
    };
    matches!(name.kind(), "identifier" | "property_identifier")
        || (name.kind() == "object_pattern" && selected_member.is_none())
}

fn commonjs_binding_declarator(call: Node<'_>) -> Option<(Node<'_>, Option<Node<'_>>)> {
    let parent = call.parent()?;
    if parent.kind() == "variable_declarator" && field_matches(parent, "value", call) {
        return Some((parent, None));
    }
    if parent.kind() != "member_expression" || !field_matches(parent, "object", call) {
        return None;
    }
    let selected_member = parent.child_by_field_name("property")?;
    let declarator = parent.parent()?;
    (declarator.kind() == "variable_declarator" && field_matches(declarator, "value", parent))
        .then_some((declarator, Some(selected_member)))
}

fn field_matches(parent: Node<'_>, field: &str, expected: Node<'_>) -> bool {
    parent.child_by_field_name(field).is_some_and(|node| {
        node.start_byte() == expected.start_byte() && node.end_byte() == expected.end_byte()
    })
}

fn capture_commonjs_binding(
    builder: &mut ExtractionBuilder<'_, '_>,
    name_node: Node<'_>,
    require: &CommonJsRequire<'_>,
) -> Result<bool, ExtractError> {
    match name_node.kind() {
        "identifier" | "property_identifier" => {
            capture_commonjs_identifier_binding(builder, name_node, require)?;
        }
        "object_pattern" if require.selected_member.is_none() => {
            capture_commonjs_destructuring(builder, name_node, &require.module_specifier)?;
        }
        _ => return Ok(false),
    }
    Ok(true)
}

fn capture_commonjs_identifier_binding(
    builder: &mut ExtractionBuilder<'_, '_>,
    name_node: Node<'_>,
    require: &CommonJsRequire<'_>,
) -> Result<(), ExtractError> {
    let local_name = builder.context.owned_text(name_node)?;
    let (kind, imported_name, binding_node) = match require.selected_member {
        Some(member) => (
            ImportBindingKind::Named,
            builder.context.owned_text(member)?,
            member,
        ),
        None => (ImportBindingKind::Namespace, "*".to_owned(), name_node),
    };
    builder.emit_import_binding(ExtractedImportBinding {
        kind,
        module_specifier: require.module_specifier.clone(),
        imported_name: imported_name.clone(),
        local_name,
        span: span_for(binding_node)?,
    })?;
    if kind == ImportBindingKind::Named {
        emit_imported_name_reference(builder, imported_name, binding_node)?;
    }
    Ok(())
}

fn emit_commonjs_module_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    require: CommonJsRequire<'_>,
) -> Result<(), ExtractError> {
    references::push_reference(
        builder,
        PendingReference {
            owner: None,
            name: require.module_specifier,
            kind: ReferenceKind::Imports,
            node: require.call,
        },
    )
}

fn capture_commonjs_destructuring(
    builder: &mut ExtractionBuilder<'_, '_>,
    pattern: Node<'_>,
    module_specifier: &str,
) -> Result<(), ExtractError> {
    for child in named_children(pattern) {
        let (imported_node, local_node) = match child.kind() {
            "shorthand_property_identifier_pattern" => (child, child),
            "pair_pattern" => {
                let Some(key) = child.child_by_field_name("key") else {
                    continue;
                };
                let Some(value) = child.child_by_field_name("value") else {
                    continue;
                };
                if !matches!(value.kind(), "identifier" | "property_identifier") {
                    continue;
                }
                (key, value)
            }
            _ => continue,
        };
        let imported_name = builder.context.owned_unquoted_text(imported_node)?;
        let local_name = builder.context.owned_text(local_node)?;
        builder.emit_import_binding(ExtractedImportBinding {
            kind: ImportBindingKind::Named,
            module_specifier: module_specifier.to_owned(),
            imported_name: imported_name.clone(),
            local_name,
            span: span_for(imported_node)?,
        })?;
        emit_imported_name_reference(builder, imported_name, imported_node)?;
    }
    Ok(())
}

fn emit_imported_name_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    name: String,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    references::push_reference(
        builder,
        PendingReference {
            owner: None,
            name,
            kind: ReferenceKind::References,
            node,
        },
    )
}

pub(super) fn capture_commonjs_assignment(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    if node.kind() != "assignment_expression"
        || !is_javascript_family(builder.context.snapshot.language())
        || !is_top_level_assignment(node)
    {
        return Ok(());
    }
    let Some(left) = node.child_by_field_name("left") else {
        return Ok(());
    };
    let Some(right) = node.child_by_field_name("right") else {
        return Ok(());
    };
    let left_text = builder.context.text(left).trim();
    if commonjs_export_root_shadowed(builder, left_text) {
        return Ok(());
    }
    if left_text == "module.exports" && right.kind() == "object" {
        for child in named_children(right) {
            if child.kind() != "pair" {
                continue;
            }
            let Some(public_node) = child.child_by_field_name("key") else {
                continue;
            };
            let Some(local_node) = child.child_by_field_name("value") else {
                continue;
            };
            if !is_static_export_name(public_node) {
                continue;
            }
            let public_name = builder.context.owned_unquoted_text(public_node)?;
            let local_name = builder.context.owned_text(local_node)?;
            if public_name != local_name && is_plain_identifier(local_node) {
                emit_export_alias(
                    builder,
                    ExportAlias {
                        public_name,
                        local_name,
                        span_node: child,
                        reference_node: local_node,
                        source: None,
                    },
                )?;
            }
        }
        return Ok(());
    }
    let Some(public_name) = commonjs_member_export_name(left_text).map(str::to_owned) else {
        return Ok(());
    };
    if !is_plain_identifier(right) {
        return Ok(());
    }
    let local_name = builder.context.owned_text(right)?;
    if public_name != local_name {
        emit_export_alias(
            builder,
            ExportAlias {
                public_name,
                local_name,
                span_node: left,
                reference_node: right,
                source: None,
            },
        )?;
    }
    Ok(())
}

pub(super) fn emit_export_alias(
    builder: &mut ExtractionBuilder<'_, '_>,
    alias: ExportAlias<'_>,
) -> Result<(), ExtractError> {
    let owner = emit_export_alias_symbol(builder, &alias)?;
    emit_export_alias_binding(builder, &alias)?;
    references::push_reference(
        builder,
        PendingReference {
            owner: Some(owner),
            name: alias.local_name,
            kind: ReferenceKind::Exports,
            node: alias.reference_node,
        },
    )
}

fn emit_export_alias_symbol(
    builder: &mut ExtractionBuilder<'_, '_>,
    alias: &ExportAlias<'_>,
) -> Result<cartograph_domain::SymbolId, ExtractError> {
    let pending = PendingSymbol {
        kind: SymbolKind::Export,
        name: alias.public_name.clone(),
        span_node: alias.span_node,
        structural_node: alias.span_node,
        doc_anchor: alias.span_node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: true,
        default_export: alias.public_name == "default",
        async_symbol: false,
        static_member: false,
        visibility: None,
    };
    builder.emit_symbol(pending)
}

fn emit_export_alias_binding(
    builder: &mut ExtractionBuilder<'_, '_>,
    alias: &ExportAlias<'_>,
) -> Result<(), ExtractError> {
    let Some(module_specifier) = &alias.source else {
        return Ok(());
    };
    builder.emit_import_binding(ExtractedImportBinding {
        kind: ImportBindingKind::Named,
        module_specifier: module_specifier.clone(),
        imported_name: alias.local_name.clone(),
        local_name: alias.local_name.clone(),
        span: span_for(alias.reference_node)?,
    })
}

fn collect_local_export_statement(
    builder: &mut ExtractionBuilder<'_, '_>,
    statement: Node<'_>,
) -> Result<(), ExtractError> {
    for child in named_children(statement) {
        if child.kind() != "export_clause" {
            continue;
        }
        for specifier in named_children(child) {
            if specifier.kind() != "export_specifier" {
                continue;
            }
            let Some(name_node) = specifier.child_by_field_name("name") else {
                continue;
            };
            let alias = specifier.child_by_field_name("alias");
            if alias.is_none() {
                insert_explicit_export(builder, name_node, false)?;
            }
        }
    }
    if has_child_kind(statement, "default")
        && let Some(identifier) =
            named_children(statement).find(|child| child.kind() == "identifier")
    {
        insert_explicit_export(builder, identifier, true)?;
    }
    Ok(())
}

fn collect_commonjs_export_assignment(
    builder: &mut ExtractionBuilder<'_, '_>,
    assignment: Node<'_>,
) -> Result<(), ExtractError> {
    if !is_top_level_assignment(assignment) {
        return Ok(());
    }
    let Some(left) = assignment.child_by_field_name("left") else {
        return Ok(());
    };
    let Some(right) = assignment.child_by_field_name("right") else {
        return Ok(());
    };
    let left_text = builder.context.text(left).trim();
    if commonjs_export_root_shadowed(builder, left_text) {
        return Ok(());
    }
    if left_text == "module.exports" {
        return collect_commonjs_module_exports(builder, right);
    }
    let Some(public_name) = commonjs_member_export_name(left_text) else {
        return Ok(());
    };
    if is_plain_identifier(right) && builder.context.text(right).trim() == public_name {
        insert_explicit_export(builder, right, false)?;
    }
    Ok(())
}

fn collect_commonjs_module_exports(
    builder: &mut ExtractionBuilder<'_, '_>,
    right: Node<'_>,
) -> Result<(), ExtractError> {
    if is_plain_identifier(right) {
        return insert_explicit_export(builder, right, true);
    }
    if right.kind() != "object" {
        return Ok(());
    }
    for child in named_children(right) {
        match child.kind() {
            "shorthand_property_identifier" => {
                insert_explicit_export(builder, child, false)?;
            }
            "pair" => collect_commonjs_pair_export(builder, child)?,
            _ => {}
        }
    }
    Ok(())
}

fn collect_commonjs_pair_export(
    builder: &mut ExtractionBuilder<'_, '_>,
    pair: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(key) = pair.child_by_field_name("key") else {
        return Ok(());
    };
    let Some(value) = pair.child_by_field_name("value") else {
        return Ok(());
    };
    if is_plain_identifier(value)
        && builder.context.text(key).trim() == builder.context.text(value).trim()
    {
        insert_explicit_export(builder, value, false)?;
    }
    Ok(())
}

fn insert_explicit_export(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    default_export: bool,
) -> Result<(), ExtractError> {
    let name = builder.context.owned_text(node)?;
    builder.explicit_exports.insert(name.clone());
    if default_export {
        builder.explicit_default_exports.insert(name);
    }
    Ok(())
}

fn commonjs_member_export_name(left: &str) -> Option<&str> {
    left.strip_prefix("exports.")
        .or_else(|| left.strip_prefix("module.exports."))
        .filter(|name| !name.is_empty() && !name.contains('.'))
}

fn commonjs_export_root_shadowed(builder: &ExtractionBuilder<'_, '_>, left: &str) -> bool {
    (left.starts_with("module.exports") && builder.commonjs_shadowing.module)
        || (left.starts_with("exports.") && builder.commonjs_shadowing.exports)
}

fn is_plain_identifier(node: Node<'_>) -> bool {
    matches!(node.kind(), "identifier" | "shorthand_property_identifier")
}

fn is_static_export_name(node: Node<'_>) -> bool {
    matches!(node.kind(), "identifier" | "property_identifier" | "string")
}

fn is_top_level_assignment(node: Node<'_>) -> bool {
    node.parent()
        .filter(|parent| parent.kind() == "expression_statement")
        .and_then(|parent| parent.parent())
        .is_some_and(|parent| parent.kind() == "program")
}

fn is_javascript_family(language: SourceLanguage) -> bool {
    matches!(
        language,
        SourceLanguage::TypeScript
            | SourceLanguage::Tsx
            | SourceLanguage::JavaScript
            | SourceLanguage::Jsx
    )
}
