use cartograph_domain::{ReferenceKind, SymbolKind};
use tree_sitter::Node;

use crate::{
    ExtractError, ExtractedReference,
    walk::{
        ExtractionBuilder, JoinedSignature, PendingSymbol, joined_signature,
        syntax::{DescendantQuery, descendant_of_kind, named_children, span_for},
    },
};

const MAX_TYPE_DEPTH: usize = 16;

pub(super) fn visit_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    _depth: usize,
) -> Result<bool, ExtractError> {
    match node.kind() {
        "model_declaration" => {
            emit_record(builder, node, "model")?;
            Ok(true)
        }
        "type_declaration" => {
            emit_record(builder, node, "type")?;
            Ok(true)
        }
        "view_declaration" => {
            emit_record(builder, node, "view")?;
            Ok(true)
        }
        "enum_declaration" => {
            emit_enum(builder, node)?;
            Ok(true)
        }
        "datasource_declaration" | "generator_declaration" => Ok(true),
        _ => Ok(false),
    }
}

fn emit_record(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    keyword: &str,
) -> Result<(), ExtractError> {
    let Some(name_node) = direct_child(node, "identifier") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    let signature = joined_signature(builder, JoinedSignature::words(keyword, &name))?;
    let owner = builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Struct,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: Some(signature),
        export: crate::SymbolExportFlags::new(true, false),
        async_symbol: false,
        static_member: false,
        visibility: None,
    })?;
    builder.owners.push(owner);
    builder.native_owner_kinds.push(SymbolKind::Struct);
    builder.native_visibilities.push(None);
    builder.qualifiers.push(name);
    if let Some(block) = direct_child(node, "statement_block") {
        for column in direct_named_children(block) {
            builder.context.ensure_active()?;
            if column.kind() == "column_declaration" {
                emit_field(builder, column)?;
            }
        }
    }
    builder.qualifiers.pop();
    builder.native_visibilities.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    Ok(())
}

fn emit_field(builder: &mut ExtractionBuilder<'_, '_>, node: Node<'_>) -> Result<(), ExtractError> {
    let Some(name_node) = direct_child(node, "identifier") else {
        return Ok(());
    };
    let Some(type_node) = direct_child(node, "column_type") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    let Some((base_node, base_name)) = base_type(builder, type_node, 0)? else {
        return Ok(());
    };
    let signature = safe_column_signature(builder, type_node, &base_name)?;
    let field = builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Field,
        name,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: Some(signature),
        export: crate::SymbolExportFlags::new(false, false),
        async_symbol: false,
        static_member: false,
        visibility: None,
    })?;
    if !is_scalar(&base_name) {
        builder.emit_reference(ExtractedReference {
            owner: Some(field),
            name: base_name,
            resolution_name: None,
            kind: ReferenceKind::TypeOf,
            span: span_for(base_node)?,
        })?;
    }
    Ok(())
}

fn emit_enum(builder: &mut ExtractionBuilder<'_, '_>, node: Node<'_>) -> Result<(), ExtractError> {
    let Some(name_node) = direct_child(node, "identifier") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    let signature = joined_signature(builder, JoinedSignature::words("enum", &name))?;
    let owner = builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Enum,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: Some(signature),
        export: crate::SymbolExportFlags::new(true, false),
        async_symbol: false,
        static_member: false,
        visibility: None,
    })?;
    builder.owners.push(owner);
    builder.native_owner_kinds.push(SymbolKind::Enum);
    builder.native_visibilities.push(None);
    builder.qualifiers.push(name);
    if let Some(block) = direct_child(node, "enum_block") {
        for value in direct_named_children(block) {
            builder.context.ensure_active()?;
            if value.kind() != "enumeral" {
                continue;
            }
            let Some(value_node) = direct_child(value, "identifier") else {
                continue;
            };
            let member = builder.context.owned_text(value_node)?;
            builder.emit_symbol(PendingSymbol {
                kind: SymbolKind::EnumMember,
                name: member.clone(),
                span_node: value,
                structural_node: value,
                doc_anchor: value,
                body_node: None,
                declaration_only: false,
                signature: Some(member),
                export: crate::SymbolExportFlags::new(false, false),
                async_symbol: false,
                static_member: false,
                visibility: None,
            })?;
        }
    }
    builder.qualifiers.pop();
    builder.native_visibilities.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    Ok(())
}

fn base_type<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'tree>,
    depth: usize,
) -> Result<Option<(Node<'tree>, String)>, ExtractError> {
    if depth > MAX_TYPE_DEPTH {
        return Err(ExtractError::NestingLimit);
    }
    if node.kind() == "identifier" {
        let name = builder.context.owned_text(node)?;
        return Ok(Some((node, name)));
    }
    for child in direct_named_children(node) {
        if let Some(found) = base_type(builder, child, depth.saturating_add(1))? {
            return Ok(Some(found));
        }
    }
    Ok(None)
}

fn safe_column_signature(
    builder: &ExtractionBuilder<'_, '_>,
    type_node: Node<'_>,
    base_name: &str,
) -> Result<String, ExtractError> {
    let array = descendant_of_kind(DescendantQuery {
        node: type_node,
        kind: "array",
        depth: 0,
        maximum_depth: MAX_TYPE_DEPTH,
    })
    .is_some();
    let optional = descendant_of_kind(DescendantQuery {
        node: type_node,
        kind: "maybe",
        depth: 0,
        maximum_depth: MAX_TYPE_DEPTH,
    })
    .is_some();
    let extra = usize::from(array).saturating_mul(2) + usize::from(optional);
    let length = base_name
        .len()
        .checked_add(extra)
        .ok_or(ExtractError::OutputLimit)?;
    let mut signature = String::new();
    signature
        .try_reserve(length)
        .map_err(|_| ExtractError::OutputLimit)?;
    signature.push_str(base_name);
    if array {
        signature.push_str("[]");
    }
    if optional {
        signature.push('?');
    }
    builder.context.copy_text(&signature)
}

const PRISMA_SCALAR_NAMES: &[&str] = &[
    "String",
    "Boolean",
    "Int",
    "BigInt",
    "Float",
    "Decimal",
    "DateTime",
    "Json",
    "Bytes",
    "Unsupported",
];

fn is_scalar(name: &str) -> bool {
    PRISMA_SCALAR_NAMES.contains(&name)
}

fn direct_child<'tree>(node: Node<'tree>, kind: &str) -> Option<Node<'tree>> {
    direct_named_children(node).find(|child| child.kind() == kind)
}

fn direct_named_children(node: Node<'_>) -> impl Iterator<Item = Node<'_>> {
    named_children(node)
}
