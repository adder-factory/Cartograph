use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId};
use tree_sitter::Node;

use crate::{ExtractError, ExtractedReference};

use super::{
    ExtractionBuilder, PendingReference, module_system,
    syntax::{
        descendants_including_root, is_call_or_construction_target, named_children,
        reference_type_node, span_for, starts_uppercase,
    },
};

#[derive(Clone, Copy)]
pub(super) enum InvocationKind {
    Call,
    Construction,
}

struct NodeReference<'tree> {
    owner: Option<SymbolId>,
    name: Node<'tree>,
    kind: ReferenceKind,
    span: Node<'tree>,
}

#[derive(Clone, Copy)]
struct TypeTreeCapture<'tree, 'owner> {
    root: Node<'tree>,
    owner: &'owner SymbolId,
    kind: ReferenceKind,
}

pub(super) fn capture_heritage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    for child in named_children(node) {
        builder.context.ensure_active()?;
        match child.kind() {
            "extends_type_clause" => {
                for target in named_children(child) {
                    builder.context.ensure_active()?;
                    if let Some(name_node) = reference_type_node(target) {
                        push_node_reference(
                            builder,
                            NodeReference {
                                owner: Some(owner.clone()),
                                name: name_node,
                                kind: ReferenceKind::Extends,
                                span: name_node,
                            },
                        )?;
                    }
                }
            }
            "class_heritage" => capture_class_heritage(builder, child, owner)?,
            _ => {}
        }
    }
    Ok(())
}

fn capture_class_heritage(
    builder: &mut ExtractionBuilder<'_, '_>,
    heritage: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    for clause in named_children(heritage) {
        builder.context.ensure_active()?;
        match clause.kind() {
            "extends_clause" => {
                if let Some(target) = clause.child_by_field_name("value") {
                    push_node_reference(
                        builder,
                        NodeReference {
                            owner: Some(owner.clone()),
                            name: target,
                            kind: ReferenceKind::Extends,
                            span: target,
                        },
                    )?;
                }
            }
            "implements_clause" => {
                for target in named_children(clause) {
                    builder.context.ensure_active()?;
                    if let Some(name_node) = reference_type_node(target) {
                        push_node_reference(
                            builder,
                            NodeReference {
                                owner: Some(owner.clone()),
                                name: name_node,
                                kind: ReferenceKind::Implements,
                                span: name_node,
                            },
                        )?;
                    }
                }
            }
            _ => {}
        }
    }
    Ok(())
}

pub(super) fn capture_callable_types(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    if let Some(parameters) = node
        .child_by_field_name("parameters")
        .or_else(|| node.child_by_field_name("parameter"))
    {
        if builder.context.snapshot.language() == SourceLanguage::Python {
            capture_python_parameter_types(builder, parameters, owner)?;
        } else {
            capture_type_nodes(builder, parameters, owner)?;
        }
    }
    if let Some(return_type) = node
        .child_by_field_name("return_type")
        .or_else(|| node.child_by_field_name("result"))
    {
        capture_type_tree(
            builder,
            TypeTreeCapture {
                root: return_type,
                owner,
                kind: ReferenceKind::Returns,
            },
        )?;
        capture_type_tree(
            builder,
            TypeTreeCapture {
                root: return_type,
                owner,
                kind: ReferenceKind::TypeOf,
            },
        )?;
    }
    Ok(())
}

fn capture_python_parameter_types(
    builder: &mut ExtractionBuilder<'_, '_>,
    parameters: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    for parameter in descendants_including_root(parameters) {
        builder.context.ensure_active()?;
        let Some(type_node) = parameter.child_by_field_name("type") else {
            continue;
        };
        capture_type_tree(
            builder,
            TypeTreeCapture {
                root: type_node,
                owner,
                kind: ReferenceKind::TypeOf,
            },
        )?;
    }
    Ok(())
}

fn capture_type_tree(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: TypeTreeCapture<'_, '_>,
) -> Result<(), ExtractError> {
    let language = builder.context.snapshot.language();
    for target in descendants_including_root(input.root) {
        builder.context.ensure_active()?;
        if !is_type_name(language, target) {
            continue;
        }
        push_node_reference(
            builder,
            NodeReference {
                owner: Some(input.owner.clone()),
                name: target,
                kind: input.kind,
                span: target,
            },
        )?;
    }
    Ok(())
}

fn is_type_name(language: SourceLanguage, node: Node<'_>) -> bool {
    node.kind() == "type_identifier"
        || (language == SourceLanguage::Python && node.kind() == "identifier")
}

pub(super) fn capture_type_nodes(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    for target in descendants_including_root(node) {
        builder.context.ensure_active()?;
        if target.kind() != "type_identifier" {
            continue;
        }
        push_node_reference(
            builder,
            NodeReference {
                owner: Some(owner.clone()),
                name: target,
                kind: ReferenceKind::TypeOf,
                span: target,
            },
        )?;
    }
    Ok(())
}

pub(super) fn capture_invocation(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    invocation: InvocationKind,
) -> Result<(), ExtractError> {
    let (target_field, reference_kind) = match invocation {
        InvocationKind::Call => ("function", ReferenceKind::Calls),
        InvocationKind::Construction => ("constructor", ReferenceKind::Instantiates),
    };
    let Some(target) = node.child_by_field_name(target_field) else {
        return Ok(());
    };
    if module_system::is_static_commonjs_binding_call(builder, node) {
        return Ok(());
    }
    let reference_node = match invocation {
        InvocationKind::Call => target,
        InvocationKind::Construction => node,
    };
    let owner = builder.owners.last().cloned();
    push_node_reference(
        builder,
        NodeReference {
            owner,
            name: target,
            kind: reference_kind,
            span: reference_node,
        },
    )
}

pub(super) fn capture_jsx_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(target) = node.child_by_field_name("name") else {
        return Ok(());
    };
    let name = builder.context.owned_text(target)?;
    if !starts_uppercase(&name) {
        return Ok(());
    }
    push_reference(
        builder,
        PendingReference {
            owner: builder.owners.last().cloned(),
            name,
            kind: ReferenceKind::References,
            node: target,
        },
    )
}

pub(super) fn capture_field_access(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    if is_call_or_construction_target(node) {
        return Ok(());
    }
    capture_member_field(builder, node, "property")
}

pub(super) fn capture_member_field(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    field_name: &str,
) -> Result<(), ExtractError> {
    if is_call_or_construction_target(node) || is_commonjs_require_selection(builder, node) {
        return Ok(());
    }
    let Some(property) = node.child_by_field_name(field_name) else {
        return Ok(());
    };
    let owner = builder.owners.last().cloned();
    push_node_reference(
        builder,
        NodeReference {
            owner,
            name: property,
            kind: ReferenceKind::FieldAccess,
            span: property,
        },
    )
}

fn is_commonjs_require_selection(builder: &ExtractionBuilder<'_, '_>, node: Node<'_>) -> bool {
    if node.kind() != "member_expression"
        || !matches!(
            builder.context.snapshot.language(),
            SourceLanguage::TypeScript
                | SourceLanguage::Tsx
                | SourceLanguage::JavaScript
                | SourceLanguage::Jsx
        )
    {
        return false;
    }
    node.child_by_field_name("object")
        .filter(|object| object.kind() == "call_expression")
        .and_then(|call| call.child_by_field_name("function"))
        .is_some_and(|function| builder.context.text(function).trim() == "require")
}

fn push_node_reference<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    reference: NodeReference<'tree>,
) -> Result<(), ExtractError> {
    let name = builder.context.owned_text(reference.name)?;
    push_reference(
        builder,
        PendingReference {
            owner: reference.owner,
            name,
            kind: reference.kind,
            node: reference.span,
        },
    )
}

pub(super) fn push_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    pending: PendingReference<'_>,
) -> Result<(), ExtractError> {
    if pending.name.is_empty() {
        return Ok(());
    }
    builder.emit_reference(ExtractedReference {
        owner: pending.owner,
        name: pending.name,
        resolution_name: None,
        kind: pending.kind,
        span: span_for(pending.node)?,
    })
}
