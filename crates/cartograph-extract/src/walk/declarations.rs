use cartograph_domain::{ReferenceKind, SymbolKind};
use tree_sitter::Node;

use crate::{ExtractError, ExtractedImportBinding, ImportBindingKind};

use super::{
    ExtractionBuilder, PendingReference, PendingSymbol, references,
    syntax::{descendants, export_flags, named_children, span_for, visibility},
};

pub(super) fn visit_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(source_node) = node.child_by_field_name("source") else {
        return Ok(());
    };
    let module_name = builder.context.owned_unquoted_text(source_node)?;
    let pending = PendingSymbol {
        kind: SymbolKind::Import,
        name: module_name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: Some(builder.context.owned_text(node)?),
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
            name: module_name.clone(),
            kind: ReferenceKind::Imports,
            node,
        },
    )?;

    let import_clause = named_children(node).find(|child| child.kind() == "import_clause");
    if let Some(clause) = import_clause {
        for child in named_children(clause) {
            builder.context.ensure_active()?;
            match child.kind() {
                "identifier" => {
                    let local_name = builder.context.owned_text(child)?;
                    builder.emit_import_binding(ExtractedImportBinding {
                        kind: ImportBindingKind::Default,
                        module_specifier: module_name.clone(),
                        imported_name: "default".to_owned(),
                        local_name,
                        span: span_for(child)?,
                    })?;
                }
                "namespace_import" => {
                    if let Some(local) = child.named_child(0) {
                        let local_name = builder.context.owned_text(local)?;
                        builder.emit_import_binding(ExtractedImportBinding {
                            kind: ImportBindingKind::Namespace,
                            module_specifier: module_name.clone(),
                            imported_name: "*".to_owned(),
                            local_name,
                            span: span_for(local)?,
                        })?;
                    }
                }
                _ => {}
            }
        }
    }

    for specifier in descendants(node) {
        builder.context.ensure_active()?;
        if specifier.kind() != "import_specifier" {
            continue;
        }
        if let Some(name_node) = specifier.child_by_field_name("name") {
            let name = builder.context.owned_unquoted_text(name_node)?;
            let local_node = specifier.child_by_field_name("alias").unwrap_or(name_node);
            if local_node.kind() == "identifier" {
                let local_name = builder.context.owned_text(local_node)?;
                builder.emit_import_binding(ExtractedImportBinding {
                    kind: ImportBindingKind::Named,
                    module_specifier: module_name.clone(),
                    imported_name: name.clone(),
                    local_name,
                    span: span_for(name_node)?,
                })?;
            }
            references::push_reference(
                builder,
                PendingReference {
                    owner: None,
                    name,
                    kind: ReferenceKind::References,
                    node: name_node,
                },
            )?;
        }
    }
    Ok(())
}

pub(super) fn visit_type_alias(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return Ok(());
    };
    let (exported, default_export) = export_flags(node);
    let pending = PendingSymbol {
        kind: SymbolKind::TypeAlias,
        name: builder.context.owned_text(name_node)?,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported,
        default_export,
        async_symbol: false,
        static_member: false,
        visibility: visibility(node, builder.context.source()),
    };
    let id = builder.emit_symbol(pending)?;
    if let Some(value) = node.child_by_field_name("value") {
        references::capture_type_nodes(builder, value, &id)?;
    }
    Ok(())
}

pub(super) fn visit_enum(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    let (exported, default_export) = export_flags(node);
    let pending = PendingSymbol {
        kind: SymbolKind::Enum,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported,
        default_export,
        async_symbol: false,
        static_member: false,
        visibility: None,
    };
    let id = builder.emit_symbol(pending)?;
    builder.owners.push(id);
    builder.qualifiers.push(name);
    if let Some(body) = node.child_by_field_name("body") {
        for child in named_children(body) {
            builder.context.ensure_active()?;
            let member_name = match child.kind() {
                "enum_assignment" => child
                    .child_by_field_name("name")
                    .or_else(|| child.named_child(0)),
                "property_identifier"
                | "private_property_identifier"
                | "string"
                | "number"
                | "computed_property_name" => Some(child),
                _ => None,
            };
            let Some(member_name) = member_name else {
                continue;
            };
            let pending = PendingSymbol {
                kind: SymbolKind::EnumMember,
                name: builder.context.owned_text(member_name)?,
                span_node: child,
                structural_node: child,
                doc_anchor: child,
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
        }
    }
    builder.qualifiers.pop();
    builder.owners.pop();
    Ok(())
}
