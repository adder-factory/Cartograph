use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId};
use tree_sitter::Node;

use crate::{
    DYNAMIC_DISPATCH_RESOLUTION_PREFIX, ExtractError, ExtractedReference,
    TYPE_QUERY_VALUE_RESOLUTION_PREFIX,
};

use super::{
    ExtractionBuilder, PendingReference, module_system,
    syntax::{
        descendants_including_root, is_call_or_construction_target, named_children,
        reference_type_node, span_for, starts_uppercase,
    },
};

const MAX_DURABLE_REFERENCE_NAME_BYTES: usize = 4_096;

#[derive(Clone, Copy, PartialEq, Eq)]
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
    let language = builder.context.snapshot.language();
    for target in descendants_including_root(node) {
        builder.context.ensure_active()?;
        let type_query_value = matches!(language, SourceLanguage::TypeScript | SourceLanguage::Tsx)
            && target.kind() == "identifier"
            && target
                .parent()
                .is_some_and(|parent| parent.kind() == "type_query")
            && !zod_infer_type_query(builder, target);
        if target.kind() != "type_identifier" && !type_query_value {
            continue;
        }
        if type_query_value {
            let name = builder.context.owned_text(target)?;
            let capacity = TYPE_QUERY_VALUE_RESOLUTION_PREFIX
                .len()
                .checked_add(name.len())
                .ok_or(ExtractError::OutputLimit)?;
            let mut resolution_name = String::new();
            resolution_name
                .try_reserve(capacity)
                .map_err(|_| ExtractError::OutputLimit)?;
            resolution_name.push_str(TYPE_QUERY_VALUE_RESOLUTION_PREFIX);
            resolution_name.push_str(&name);
            builder.emit_reference(ExtractedReference {
                owner: Some(owner.clone()),
                name,
                resolution_name: Some(resolution_name),
                kind: ReferenceKind::TypeOf,
                span: span_for(target)?,
            })?;
        } else {
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
    }
    Ok(())
}

fn zod_infer_type_query(builder: &ExtractionBuilder<'_, '_>, target: Node<'_>) -> bool {
    let mut current = target.parent();
    for _ in 0..8 {
        let Some(node) = current else {
            return false;
        };
        if matches!(node.kind(), "generic_type" | "type_arguments")
            && builder.context.text(node).contains("z.infer")
        {
            return true;
        }
        if matches!(node.kind(), "type_alias_declaration" | "type_alias") {
            return false;
        }
        current = node.parent();
    }
    false
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
    if invocation == InvocationKind::Call
        && builder.context.snapshot.language() == SourceLanguage::Rust
        && let Some(resolution_name) = rust_receiver_call_resolution(builder, target)?
    {
        let owner = builder.owners.last().cloned();
        let name = builder.context.owned_text(target)?;
        builder.emit_reference(ExtractedReference {
            owner,
            name,
            resolution_name: Some(resolution_name),
            kind: reference_kind,
            span: span_for(target)?,
        })?;
        return Ok(());
    }
    if invocation == InvocationKind::Call
        && anonymous_call_target(builder.context.snapshot.language(), target, 0)
    {
        return Ok(());
    }
    if invocation == InvocationKind::Call
        && builder.context.snapshot.language() == SourceLanguage::Go
        && target.end_byte().saturating_sub(target.start_byte()) > MAX_DURABLE_REFERENCE_NAME_BYTES
    {
        if target.kind() == "selector_expression"
            && let Some(field) = target.child_by_field_name("field")
        {
            let name = builder.context.owned_text(field)?;
            let resolution_name = dynamic_dispatch_resolution(builder, &name)?;
            builder.emit_reference(ExtractedReference {
                owner: builder.owners.last().cloned(),
                name,
                resolution_name: Some(resolution_name),
                kind: reference_kind,
                span: span_for(field)?,
            })?;
        }
        return Ok(());
    }
    if invocation == InvocationKind::Call
        && matches!(
            builder.context.snapshot.language(),
            SourceLanguage::TypeScript
                | SourceLanguage::Tsx
                | SourceLanguage::JavaScript
                | SourceLanguage::Jsx
        )
        && let Some((property, resolution_name)) =
            javascript_dynamic_member_call_resolution(builder, target)?
    {
        let owner = builder.owners.last().cloned();
        let name = builder.context.owned_text(property)?;
        builder.emit_reference(ExtractedReference {
            owner,
            name,
            resolution_name: Some(resolution_name),
            kind: reference_kind,
            span: span_for(property)?,
        })?;
        return Ok(());
    }
    let Some((name_node, reference_node)) = invocation_reference_nodes(
        InvocationShape {
            language: builder.context.snapshot.language(),
            invocation,
        },
        target,
        node,
    ) else {
        return Ok(());
    };
    let owner = builder.owners.last().cloned();
    push_node_reference(
        builder,
        NodeReference {
            owner,
            name: name_node,
            kind: reference_kind,
            span: reference_node,
        },
    )
}

/// Language and call form one invocation reference is resolved under.
#[derive(Clone, Copy)]
struct InvocationShape {
    language: SourceLanguage,
    invocation: InvocationKind,
}

fn invocation_reference_nodes<'tree>(
    shape: InvocationShape,
    target: Node<'tree>,
    expression: Node<'tree>,
) -> Option<(Node<'tree>, Node<'tree>)> {
    let InvocationShape {
        language,
        invocation,
    } = shape;
    let javascript = matches!(
        language,
        SourceLanguage::TypeScript
            | SourceLanguage::Tsx
            | SourceLanguage::JavaScript
            | SourceLanguage::Jsx
    );
    match (invocation, javascript) {
        (InvocationKind::Call, true) => {
            normalized_javascript_call_target(target, 0).map(|name| (name, name))
        }
        (InvocationKind::Call, false) => Some((target, target)),
        (InvocationKind::Construction, true) => {
            normalized_javascript_construction_target(target, 0).map(|name| (name, expression))
        }
        (InvocationKind::Construction, false) => Some((target, expression)),
    }
}

fn anonymous_call_target(language: SourceLanguage, target: Node<'_>, depth: usize) -> bool {
    if depth > 8 {
        return false;
    }
    match (language, target.kind()) {
        (SourceLanguage::Rust, "closure_expression")
        | (SourceLanguage::Go, "func_literal")
        | (SourceLanguage::Python, "lambda") => true,
        (_, "parenthesized_expression") => {
            let mut children = named_children(target);
            let Some(child) = children.next() else {
                return false;
            };
            children.next().is_none()
                && anonymous_call_target(language, child, depth.saturating_add(1))
        }
        _ => false,
    }
}

fn rust_receiver_call_resolution(
    builder: &ExtractionBuilder<'_, '_>,
    target: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    let Some(target) = rust_receiver_target(target, 0) else {
        return Ok(None);
    };
    let Some(field) = target.child_by_field_name("field") else {
        return Ok(None);
    };
    let field = builder.context.text(field).trim();
    if field.is_empty() {
        return Ok(None);
    }
    dynamic_dispatch_resolution(builder, field).map(Some)
}

fn rust_receiver_target(target: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > 8 {
        return None;
    }
    match target.kind() {
        "field_expression" => Some(target),
        "generic_function" => target
            .child_by_field_name("function")
            .or_else(|| named_children(target).next())
            .and_then(|function| rust_receiver_target(function, depth.saturating_add(1))),
        _ => None,
    }
}

fn javascript_dynamic_member_call_resolution<'tree>(
    builder: &ExtractionBuilder<'_, '_>,
    target: Node<'tree>,
) -> Result<Option<(Node<'tree>, String)>, ExtractError> {
    if target.kind() != "member_expression" || static_javascript_member_chain(target, 0) {
        return Ok(None);
    }
    let Some(property) = target
        .child_by_field_name("property")
        .and_then(|property| normalized_javascript_call_target(property, 0))
    else {
        return Ok(None);
    };
    let name = builder.context.text(property).trim();
    if name.is_empty() {
        return Ok(None);
    }
    let resolution_name = dynamic_dispatch_resolution(builder, name)?;
    Ok(Some((property, resolution_name)))
}

pub(super) fn dynamic_dispatch_resolution(
    builder: &ExtractionBuilder<'_, '_>,
    name: &str,
) -> Result<String, ExtractError> {
    let capacity = DYNAMIC_DISPATCH_RESOLUTION_PREFIX
        .len()
        .checked_add(name.len())
        .ok_or(ExtractError::OutputLimit)?;
    builder.context.budget.ensure_string_length(capacity)?;
    let mut resolution_name = String::new();
    resolution_name
        .try_reserve_exact(capacity)
        .map_err(|_| ExtractError::OutputLimit)?;
    resolution_name.push_str(DYNAMIC_DISPATCH_RESOLUTION_PREFIX);
    resolution_name.push_str(name);
    Ok(resolution_name)
}

fn normalized_javascript_call_target(target: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > 64 {
        return None;
    }
    match target.kind() {
        "identifier" | "property_identifier" | "private_property_identifier" | "this" | "super" => {
            Some(target)
        }
        "member_expression" if static_javascript_member_chain(target, 0) => Some(target),
        "member_expression" => target.child_by_field_name("property").and_then(|property| {
            normalized_javascript_call_target(property, depth.saturating_add(1))
        }),
        "parenthesized_expression" => {
            let mut children = named_children(target);
            let child = children.next()?;
            if children.next().is_some() {
                return None;
            }
            normalized_javascript_call_target(child, depth.saturating_add(1))
        }
        // The inner call already records its statically known target. The value it returns is
        // dynamically callable, while arrow/function IIFEs have no stable declaration target.
        _ => None,
    }
}

fn normalized_javascript_construction_target(target: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > 64 {
        return None;
    }
    match target.kind() {
        "identifier" => Some(target),
        "member_expression" if static_javascript_member_chain(target, 0) => Some(target),
        "parenthesized_expression" => {
            let mut children = named_children(target);
            let child = children.next()?;
            if children.next().is_some() {
                return None;
            }
            normalized_javascript_construction_target(child, depth.saturating_add(1))
        }
        // Anonymous classes, calls returning constructors, and computed member
        // expressions have no exact declaration target. Their named type usages are
        // still captured independently by the normal type-reference walk.
        _ => None,
    }
}

fn static_javascript_member_chain(node: Node<'_>, depth: usize) -> bool {
    if depth > 64 {
        return false;
    }
    match node.kind() {
        "identifier" | "property_identifier" | "private_property_identifier" | "this" | "super" => {
            true
        }
        "member_expression" => {
            node.child_by_field_name("object").is_some_and(|object| {
                static_javascript_member_chain(object, depth.saturating_add(1))
            }) && node
                .child_by_field_name("property")
                .is_some_and(|property| {
                    static_javascript_member_chain(property, depth.saturating_add(1))
                })
        }
        _ => false,
    }
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

fn push_node_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    reference: NodeReference<'_>,
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
