//! WGSL shader declarations, references, and `naga_oil` module imports.
//!
//! Shaders are where a large share of a renderer's logic lives, and they are
//! exactly the code that is hardest to navigate by text search. Entry points are
//! the top of a real call stack that otherwise stops at the host-language
//! boundary, and `@group`/`@binding` declarations are a contract between host
//! code and shader code.
//!
//! Stage attributes are retained as an explicit symbol role rather than being
//! flattened into "some function", so `entry-points` can report a vertex,
//! fragment, or compute entry as what it is.

use cartograph_domain::{ReferenceKind, SymbolKind, Visibility};
use tree_sitter::Node;

use super::{
    ExtractionBuilder, PendingReference, PendingSymbol, references, syntax::named_children,
};
use crate::{ExtractError, SymbolExportFlags};

/// Attribute names that make a WGSL function a pipeline entry point.
const STAGE_ATTRIBUTES: [&str; 3] = ["vertex", "fragment", "compute"];

pub(super) fn visit_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    match node.kind() {
        "function_declaration" => visit_function(builder, node, depth),
        "struct_declaration" => visit_struct(builder, node, depth),
        "global_variable_declaration" | "global_constant_declaration" => {
            visit_global(builder, node)
        }
        "type_alias_declaration" => visit_type_alias(builder, node),
        "preproc_import" => visit_import(builder, node).map(|()| true),
        "define_import_path" => visit_define_import_path(builder, node).map(|()| true),
        _ => Ok(false),
    }
}

pub(super) fn capture_usage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    if node.kind() != "type_constructor_or_function_call_expression" {
        return Ok(());
    }
    // The grammar cannot tell a call from a type construction, so the reference
    // stays a call with the exact spelled name and resolution decides later.
    let Some(target) = node
        .child_by_field_name("type")
        .or_else(|| named_children(node).find(|child| child.kind() == "type_declaration"))
    else {
        return Ok(());
    };
    let name = builder.context.owned_text(target)?;
    if name.is_empty() {
        return Ok(());
    }
    let owner = super::owner_for_node(builder, node);
    references::push_reference(
        builder,
        PendingReference {
            owner,
            name,
            kind: ReferenceKind::Calls,
            node,
        },
    )
}

fn visit_function(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return Ok(false);
    };
    let name = builder.context.owned_text(name_node)?;
    let stage = entry_point_stage(builder, node)?;
    let signature = function_signature(builder, node, stage.as_deref())?;
    let pending = PendingSymbol {
        kind: SymbolKind::Function,
        name,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: node.child_by_field_name("body"),
        declaration_only: false,
        signature: Some(signature),
        // A stage entry point is reachable from the host pipeline rather than
        // from shader code, so it is an exported boundary.
        export: SymbolExportFlags::new(stage.is_some(), false),
        async_symbol: false,
        static_member: false,
        visibility: Some(if stage.is_some() {
            Visibility::Public
        } else {
            Visibility::Internal
        }),
    };
    let symbol = builder.emit_symbol(pending)?;
    builder.owners.push(symbol);
    let result = builder.visit_named_children(node, depth);
    builder.owners.pop();
    result?;
    Ok(true)
}

fn visit_struct(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return Ok(false);
    };
    let name = builder.context.owned_text(name_node)?;
    let pending = PendingSymbol {
        kind: SymbolKind::Struct,
        name,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        export: SymbolExportFlags::new(true, false),
        async_symbol: false,
        static_member: false,
        visibility: Some(Visibility::Public),
    };
    let symbol = builder.emit_symbol(pending)?;
    builder.owners.push(symbol);
    let result = visit_struct_members(builder, node, depth);
    builder.owners.pop();
    result?;
    Ok(true)
}

fn visit_struct_members(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    for member in named_children(node) {
        builder.context.ensure_active()?;
        if member.kind() != "struct_member" {
            continue;
        }
        let Some(declaration) =
            named_children(member).find(|child| child.kind() == "variable_identifier_declaration")
        else {
            continue;
        };
        let Some(name_node) = declaration.child_by_field_name("name") else {
            continue;
        };
        let name = builder.context.owned_text(name_node)?;
        // Struct layouts are duplicated on both sides of the host boundary, so
        // members carry their declared type for pairing.
        let signature = declaration
            .child_by_field_name("type")
            .map(|node| builder.context.owned_text(node))
            .transpose()?;
        builder.emit_symbol(PendingSymbol {
            kind: SymbolKind::Field,
            name,
            span_node: member,
            structural_node: member,
            doc_anchor: member,
            body_node: None,
            declaration_only: true,
            signature,
            export: SymbolExportFlags::new(true, false),
            async_symbol: false,
            static_member: false,
            visibility: Some(Visibility::Public),
        })?;
        capture_member_type_reference(builder, declaration)?;
    }
    builder.visit_named_children(node, depth)
}

fn capture_member_type_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(type_node) = declaration.child_by_field_name("type") else {
        return Ok(());
    };
    let name = builder.context.owned_text(type_node)?;
    if name.is_empty() {
        return Ok(());
    }
    let owner = super::owner_for_node(builder, declaration);
    references::push_reference(
        builder,
        PendingReference {
            owner,
            name,
            kind: ReferenceKind::TypeOf,
            node: type_node,
        },
    )
}

fn visit_global(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<bool, ExtractError> {
    let Some(declaration) = named_children(node).find_map(|child| match child.kind() {
        "variable_declaration" => {
            named_children(child).find(|inner| inner.kind() == "variable_identifier_declaration")
        }
        "variable_identifier_declaration" => Some(child),
        _ => None,
    }) else {
        return Ok(false);
    };
    let Some(name_node) = declaration.child_by_field_name("name") else {
        return Ok(false);
    };
    let name = builder.context.owned_text(name_node)?;
    // A bound resource is the shader half of a host-side layout entry, so the
    // binding attributes are retained in the signature.
    let signature = binding_signature(builder, node, declaration)?;
    builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Variable,
        name,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: true,
        signature,
        export: SymbolExportFlags::new(true, false),
        async_symbol: false,
        static_member: false,
        visibility: Some(Visibility::Public),
    })?;
    capture_member_type_reference(builder, declaration)?;
    Ok(true)
}

fn visit_type_alias(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<bool, ExtractError> {
    let Some(name_node) = named_children(node).find(|child| child.kind() == "identifier") else {
        return Ok(false);
    };
    let name = builder.context.owned_text(name_node)?;
    builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::TypeAlias,
        name,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: true,
        signature: None,
        export: SymbolExportFlags::new(true, false),
        async_symbol: false,
        static_member: false,
        visibility: Some(Visibility::Public),
    })?;
    Ok(true)
}

/// `naga_oil` `#import "path"` forms the shader module graph.
fn visit_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(path_node) = node.child_by_field_name("path") else {
        return Ok(());
    };
    let path = builder.context.owned_text(path_node)?;
    let module = path.trim_matches('"').to_owned();
    if module.is_empty() {
        return Ok(());
    }
    builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Import,
        name: module.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: true,
        signature: None,
        export: SymbolExportFlags::new(false, false),
        async_symbol: false,
        static_member: false,
        visibility: None,
    })?;
    references::push_reference(
        builder,
        PendingReference {
            owner: None,
            name: module,
            kind: ReferenceKind::Imports,
            node,
        },
    )
}

/// `naga_oil` `#define_import_path` names the module other shaders import.
fn visit_define_import_path(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(path_node) = node.child_by_field_name("path") else {
        return Ok(());
    };
    let module = builder.context.owned_text(path_node)?.trim().to_owned();
    if module.is_empty() {
        return Ok(());
    }
    builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Module,
        name: module,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: true,
        signature: None,
        export: SymbolExportFlags::new(true, false),
        async_symbol: false,
        static_member: false,
        visibility: Some(Visibility::Public),
    })?;
    Ok(())
}

/// Pipeline stage for a function carrying `@vertex`, `@fragment`, or `@compute`.
fn entry_point_stage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    for attribute in named_children(node).filter(|child| child.kind() == "attribute") {
        builder.context.ensure_active()?;
        for identifier in named_children(attribute).filter(|child| child.kind() == "identifier") {
            let name = builder.context.owned_text(identifier)?;
            if STAGE_ATTRIBUTES.contains(&name.as_str()) {
                return Ok(Some(name));
            }
        }
    }
    Ok(None)
}

/// Literal-free callable signature naming the stage and declared return type.
fn function_signature(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    stage: Option<&str>,
) -> Result<String, ExtractError> {
    let mut signature = String::new();
    if let Some(stage) = stage {
        signature.push('@');
        signature.push_str(stage);
        signature.push(' ');
    }
    signature.push_str("fn");
    // A return type can carry `@location(0)`, and a literal-bearing signature is
    // rejected before persistence, so only the declared type is retained.
    if let Some(declared) = node.child_by_field_name("type").and_then(|returns| {
        named_children(returns).find(|child| child.kind() == "type_declaration")
    }) {
        let declared = builder.context.owned_text(declared)?;
        let declared = declared.trim();
        if !declared.is_empty() {
            signature.push_str(" -> ");
            signature.push_str(declared);
        }
    }
    Ok(signature)
}

/// Literal-free declaration signature for a module-scope binding.
///
/// The `@group(N)`/`@binding(N)` indices are deliberately not spelled here: a
/// literal-bearing signature is rejected before persistence, which would blank
/// the declared type as well. Correlating those indices with a host-side layout
/// entry needs a structured channel rather than a signature string.
fn binding_signature(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    declaration: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    let mut signature = String::new();
    if let Some(qualifier) = named_children(node)
        .find(|child| child.kind() == "variable_declaration")
        .and_then(|declaration| {
            named_children(declaration).find(|child| child.kind() == "variable_qualifier")
        })
    {
        let qualifier = builder.context.owned_text(qualifier)?;
        let qualifier = qualifier.trim();
        if !qualifier.is_empty() {
            signature.push_str("var");
            signature.push_str(qualifier);
        }
    }
    if let Some(declared) = declaration.child_by_field_name("type") {
        let declared = builder.context.owned_text(declared)?;
        let declared = declared.trim();
        if !declared.is_empty() {
            if !signature.is_empty() {
                signature.push_str(": ");
            }
            signature.push_str(declared);
        }
    }
    if signature.is_empty() {
        return Ok(None);
    }
    Ok(Some(signature))
}
