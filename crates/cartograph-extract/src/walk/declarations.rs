use cartograph_domain::{ReferenceKind, SymbolKind};
use tree_sitter::Node;

use crate::ExtractError;

use super::{
    ExtractionBuilder, PendingReference, PendingSymbol, references,
    syntax::{descendants, export_flags, named_children, visibility},
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
            name: module_name,
            kind: ReferenceKind::Imports,
            node,
        },
    )?;

    for specifier in descendants(node) {
        builder.context.ensure_active()?;
        if specifier.kind() != "import_specifier" {
            continue;
        }
        if let Some(name_node) = specifier.child_by_field_name("name") {
            let name = builder.context.owned_text(name_node)?;
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
