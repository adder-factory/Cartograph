use std::mem;

use cartograph_domain::{
    ReferenceKind, SourceLanguage, SymbolId, SymbolKind, Visibility,
    callable_signature_is_literal_free,
};
use tree_sitter::Node;

use crate::{ExtractError, ExtractedImportBinding, ImportBindingKind};

use super::{
    ExtractionBuilder, PendingReference, PendingSymbol, references,
    syntax::{children, descendants_including_root, named_children, span_for},
};

const MAX_SIGNATURE_BYTES: usize = 512;
const MAX_REFERENCE_TARGET_BYTES: usize = 512;
const MAX_TYPE_DEPTH: usize = 64;

pub(super) fn visit_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    match node.kind() {
        "package_declaration" | "file_scoped_namespace_declaration" => {
            visit_persistent_namespace(builder, node)?;
        }
        "namespace_declaration" => visit_scoped_namespace(builder, node, depth)?,
        "import_declaration" => visit_java_import(builder, node)?,
        "using_directive" => visit_csharp_using(builder, node)?,
        "class_declaration"
        | "interface_declaration"
        | "record_declaration"
        | "struct_declaration"
        | "enum_declaration"
        | "annotation_type_declaration" => visit_container(builder, node, depth)?,
        "method_declaration" | "constructor_declaration" | "compact_constructor_declaration" => {
            visit_callable(builder, node, depth)?;
        }
        "annotation_type_element_declaration" | "property_declaration" => {
            visit_property(builder, node, depth)?;
        }
        "field_declaration" | "event_field_declaration" | "constant_declaration" => {
            visit_variables(builder, node, depth, SymbolKind::Field)?;
        }
        "local_variable_declaration" | "local_declaration_statement" => {
            visit_variables(builder, node, depth, SymbolKind::Variable)?;
        }
        "enum_constant" | "enum_member_declaration" => visit_enum_member(builder, node)?,
        _ => return Ok(false),
    }
    Ok(true)
}

pub(super) fn capture_usage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    match node.kind() {
        "method_invocation" | "invocation_expression" => capture_call(builder, node),
        "object_creation_expression" => capture_construction(builder, node),
        "field_access" | "member_access_expression" => capture_member_access(builder, node),
        _ => Ok(()),
    }
}

fn visit_persistent_namespace(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = namespace_name_node(node) else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    let id = emit_namespace(builder, node, name.clone())?;
    builder.owners.push(id);
    builder.native_owner_kinds.push(SymbolKind::Namespace);
    builder.qualifiers.push(name);
    Ok(())
}

fn visit_scoped_namespace(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let Some(name_node) = namespace_name_node(node) else {
        return builder.visit_named_children(node, depth);
    };
    let Some(body) = node.child_by_field_name("body") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    let id = emit_namespace(builder, node, name.clone())?;
    builder.owners.push(id);
    builder.native_owner_kinds.push(SymbolKind::Namespace);
    builder.qualifiers.push(name);
    let result = builder.visit(body, depth.saturating_add(1));
    builder.qualifiers.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    result
}

fn namespace_name_node(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("name").or_else(|| {
        named_children(node).find(|child| {
            matches!(
                child.kind(),
                "identifier" | "scoped_identifier" | "qualified_name" | "alias_qualified_name"
            )
        })
    })
}

fn emit_namespace(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    name: String,
) -> Result<SymbolId, ExtractError> {
    builder.emit_symbol(PendingSymbol {
        kind: SymbolKind::Namespace,
        name,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: true,
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility: None,
    })
}

fn visit_java_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let raw = builder.context.owned_text(node)?;
    let Some(parsed) = parse_java_import(&raw) else {
        return Ok(());
    };
    let module_name = builder.context.copy_text(parsed.target)?;
    emit_import(builder, node, module_name.clone(), &raw)?;
    if parsed.wildcard {
        emit_binding(
            builder,
            node,
            ImportBindingKind::Namespace,
            parsed.target,
            "*",
            "*",
        )?;
    } else if let Some((module, imported)) = parsed.target.rsplit_once('.') {
        emit_binding(
            builder,
            node,
            ImportBindingKind::Named,
            module,
            imported,
            imported,
        )?;
    }
    Ok(())
}

struct JavaImport<'source> {
    target: &'source str,
    wildcard: bool,
}

fn parse_java_import(raw: &str) -> Option<JavaImport<'_>> {
    let mut body = strip_keyword(raw, "import")?;
    body = strip_keyword(body, "static").unwrap_or(body);
    body = body.strip_suffix(';').unwrap_or(body).trim();
    let wildcard = body.ends_with(".*");
    let target = body.strip_suffix(".*").unwrap_or(body).trim();
    safe_import_target(target).then_some(JavaImport { target, wildcard })
}

fn visit_csharp_using(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let raw = builder.context.owned_text(node)?;
    let Some(parsed) = parse_csharp_using(&raw) else {
        return Ok(());
    };
    let module_name = builder.context.copy_text(parsed.target)?;
    emit_import(builder, node, module_name, &raw)?;
    if let Some(alias) = parsed.alias {
        emit_binding(
            builder,
            node,
            ImportBindingKind::Namespace,
            parsed.target,
            "*",
            alias,
        )?;
    } else if parsed.static_import {
        emit_binding(
            builder,
            node,
            ImportBindingKind::Namespace,
            parsed.target,
            "*",
            "*",
        )?;
    }
    Ok(())
}

struct CsharpUsing<'source> {
    target: &'source str,
    alias: Option<&'source str>,
    static_import: bool,
}

fn parse_csharp_using(raw: &str) -> Option<CsharpUsing<'_>> {
    let mut body = strip_keyword(raw, "global").unwrap_or(raw.trim());
    body = strip_keyword(body, "using")?;
    body = body.strip_suffix(';').unwrap_or(body).trim();
    let static_body = strip_keyword(body, "static");
    let static_import = static_body.is_some();
    body = static_body.unwrap_or(body);
    let (alias, target) = body
        .split_once('=')
        .map_or((None, body), |(alias, target)| {
            (Some(alias.trim()), target.trim())
        });
    if !safe_import_target(target) || alias.is_some_and(|alias| !safe_identifier(alias)) {
        return None;
    }
    Some(CsharpUsing {
        target,
        alias,
        static_import,
    })
}

fn strip_keyword<'source>(value: &'source str, keyword: &str) -> Option<&'source str> {
    let value = value.trim_start();
    let suffix = value.strip_prefix(keyword)?;
    suffix
        .chars()
        .next()
        .is_some_and(char::is_whitespace)
        .then(|| suffix.trim_start())
}

fn safe_import_target(target: &str) -> bool {
    !target.is_empty()
        && target.len() <= MAX_REFERENCE_TARGET_BYTES
        && !target
            .bytes()
            .any(|byte| matches!(byte, b'\'' | b'"' | b'`' | b'=' | b';'))
        && target.bytes().all(|byte| {
            byte.is_ascii_alphanumeric()
                || matches!(
                    byte,
                    b'_' | b'.' | b':' | b'$' | b'<' | b'>' | b',' | b'?' | b'[' | b']' | b' '
                )
        })
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn emit_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    name: String,
    raw_signature: &str,
) -> Result<(), ExtractError> {
    let signature = if raw_signature.len() <= MAX_SIGNATURE_BYTES {
        Some(builder.context.copy_text(raw_signature)?)
    } else {
        None
    };
    let reference_name = name.clone();
    emit_root_symbol(
        builder,
        PendingSymbol {
            kind: SymbolKind::Import,
            name,
            span_node: node,
            structural_node: node,
            doc_anchor: node,
            body_node: None,
            declaration_only: false,
            signature,
            exported: false,
            default_export: false,
            async_symbol: false,
            static_member: false,
            visibility: None,
        },
    )?;
    references::push_reference(
        builder,
        PendingReference {
            owner: None,
            name: reference_name,
            kind: ReferenceKind::Imports,
            node,
        },
    )
}

fn emit_root_symbol(
    builder: &mut ExtractionBuilder<'_, '_>,
    pending: PendingSymbol<'_>,
) -> Result<SymbolId, ExtractError> {
    let owners = mem::take(&mut builder.owners);
    let owner_kinds = mem::take(&mut builder.native_owner_kinds);
    let visibilities = mem::take(&mut builder.native_visibilities);
    let qualifiers = mem::take(&mut builder.qualifiers);
    let result = builder.emit_symbol(pending);
    builder.owners = owners;
    builder.native_owner_kinds = owner_kinds;
    builder.native_visibilities = visibilities;
    builder.qualifiers = qualifiers;
    result
}

fn emit_binding(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    kind: ImportBindingKind,
    module: &str,
    imported: &str,
    local: &str,
) -> Result<(), ExtractError> {
    builder.emit_import_binding(ExtractedImportBinding {
        kind,
        module_specifier: builder.context.copy_text(module)?,
        imported_name: builder.context.copy_text(imported)?,
        local_name: builder.context.copy_text(local)?,
        span: span_for(node)?,
    })
}

fn visit_container(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return builder.visit_named_children(node, depth);
    };
    let kind = match node.kind() {
        "class_declaration" => SymbolKind::Class,
        "interface_declaration" | "annotation_type_declaration" => SymbolKind::Interface,
        "record_declaration" | "struct_declaration" => SymbolKind::Struct,
        "enum_declaration" => SymbolKind::Enum,
        _ => return builder.visit_named_children(node, depth),
    };
    let name = builder.context.owned_text(name_node)?;
    let modifiers = managed_modifiers(builder, node)?;
    let visibility = managed_visibility(builder, modifiers, true);
    let body = node.child_by_field_name("body");
    let pending = PendingSymbol {
        kind,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: visibility == Some(Visibility::Public),
        default_export: false,
        async_symbol: false,
        static_member: modifiers.static_symbol
            || (builder.context.snapshot.language() == SourceLanguage::Java
                && matches!(
                    builder.native_owner_kinds.last(),
                    Some(SymbolKind::Interface)
                )),
        visibility,
    };
    let id = builder.emit_symbol(pending)?;
    capture_decorators(builder, node, &id)?;
    capture_inheritance(builder, node, &id, kind, name_node)?;

    builder.owners.push(id);
    builder.native_owner_kinds.push(kind);
    builder.qualifiers.push(name.clone());
    if let Some(parameters) = managed_parameters(node)
        && matches!(
            node.kind(),
            "record_declaration" | "class_declaration" | "struct_declaration"
        )
    {
        emit_primary_constructor(builder, parameters, &name, visibility)?;
    }
    let result = match body {
        Some(body) => builder.visit(body, depth.saturating_add(1)),
        None => Ok(()),
    };
    builder.qualifiers.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    result
}

fn emit_primary_constructor(
    builder: &mut ExtractionBuilder<'_, '_>,
    parameters: Node<'_>,
    name: &str,
    visibility: Option<Visibility>,
) -> Result<(), ExtractError> {
    let signature = managed_signature(builder, None, parameters)?;
    let pending = PendingSymbol {
        kind: SymbolKind::Method,
        name: builder.context.copy_text(name)?,
        span_node: parameters,
        structural_node: parameters,
        doc_anchor: parameters,
        body_node: None,
        declaration_only: false,
        signature,
        exported: visibility == Some(Visibility::Public),
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility,
    };
    let id = builder.emit_symbol(pending)?;
    capture_parameter_types(builder, parameters, &id)
}

fn capture_inheritance(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
    kind: SymbolKind,
    name_node: Node<'_>,
) -> Result<(), ExtractError> {
    match builder.context.snapshot.language() {
        SourceLanguage::Java => {
            if let Some(superclass) = node.child_by_field_name("superclass") {
                capture_type_references(builder, superclass, owner, ReferenceKind::Extends)?;
            }
            let interfaces_kind = if kind == SymbolKind::Interface {
                ReferenceKind::Extends
            } else {
                ReferenceKind::Implements
            };
            if let Some(interfaces) = node.child_by_field_name("interfaces") {
                capture_type_references(builder, interfaces, owner, interfaces_kind)?;
            }
            for child in named_children(node) {
                if child.kind() == "extends_interfaces" {
                    capture_type_references(builder, child, owner, ReferenceKind::Extends)?;
                }
            }
        }
        SourceLanguage::CSharp => {
            let Some(base_list) = named_children(node).find(|child| child.kind() == "base_list")
            else {
                return Ok(());
            };
            let value_type = node.kind() == "struct_declaration"
                || (node.kind() == "record_declaration"
                    && csharp_record_is_struct(builder, node, name_node)?);
            for target in named_children(base_list) {
                builder.context.ensure_active()?;
                if target.kind() == "argument_list" {
                    continue;
                }
                let Some((target_name, target_node)) = csharp_base_target(builder, target)? else {
                    continue;
                };
                let reference_kind = if kind == SymbolKind::Interface {
                    ReferenceKind::Extends
                } else if value_type {
                    ReferenceKind::Implements
                } else {
                    ReferenceKind::Inherits
                };
                push_named_reference(builder, owner, target_name, reference_kind, target_node)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn csharp_base_target<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    target: Node<'tree>,
) -> Result<Option<(String, Node<'tree>)>, ExtractError> {
    let target_node = if target.kind() == "primary_constructor_base_type" {
        let Some(type_node) = named_children(target).find(|child| child.kind() != "argument_list")
        else {
            return Ok(None);
        };
        type_node
    } else {
        target
    };
    let Some(name) = managed_outer_type_name(builder, target_node)? else {
        return Ok(None);
    };
    Ok(Some((name, target_node)))
}

fn csharp_record_is_struct(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    name: Node<'_>,
) -> Result<bool, ExtractError> {
    for child in children(node) {
        builder.context.ensure_active()?;
        if child.start_byte() >= name.start_byte() {
            break;
        }
        if child.kind() == "struct" || builder.context.text(child).trim() == "struct" {
            return Ok(true);
        }
    }
    Ok(false)
}

fn visit_callable(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return builder.visit_named_children(node, depth);
    };
    let Some(parameters) = managed_parameters(node) else {
        return builder.visit_named_children(node, depth);
    };
    let name = builder.context.owned_text(name_node)?;
    let return_type = managed_return_type(node);
    let body = node.child_by_field_name("body");
    let modifiers = managed_modifiers(builder, node)?;
    let visibility = managed_visibility(builder, modifiers, false);
    let pending = PendingSymbol {
        kind: SymbolKind::Method,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: body,
        declaration_only: body.is_none(),
        signature: managed_signature(builder, return_type, parameters)?,
        exported: visibility == Some(Visibility::Public),
        default_export: false,
        async_symbol: modifiers.async_symbol,
        static_member: modifiers.static_symbol,
        visibility,
    };
    let id = builder.emit_symbol(pending)?;
    capture_decorators(builder, node, &id)?;
    capture_parameter_types(builder, parameters, &id)?;
    if let Some(return_type) = return_type {
        capture_type_references(builder, return_type, &id, ReferenceKind::Returns)?;
    }

    builder.owners.push(id);
    builder.native_owner_kinds.push(SymbolKind::Method);
    builder.qualifiers.push(name);
    emit_annotated_parameters(builder, parameters)?;
    let result = match body {
        Some(body) => builder.visit(body, depth.saturating_add(1)),
        None => Ok(()),
    };
    builder.qualifiers.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    result
}

fn managed_parameters(node: Node<'_>) -> Option<Node<'_>> {
    node.child_by_field_name("parameters").or_else(|| {
        named_children(node)
            .find(|child| matches!(child.kind(), "formal_parameters" | "parameter_list"))
    })
}

fn managed_return_type(node: Node<'_>) -> Option<Node<'_>> {
    if matches!(
        node.kind(),
        "constructor_declaration" | "compact_constructor_declaration"
    ) {
        return None;
    }
    node.child_by_field_name("type")
        .or_else(|| node.child_by_field_name("returns"))
}

fn managed_signature(
    builder: &mut ExtractionBuilder<'_, '_>,
    return_type: Option<Node<'_>>,
    parameters: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    let parameter_text = builder.context.text(parameters).trim();
    let return_text = return_type
        .map(|node| builder.context.text(node).trim())
        .filter(|value| !value.is_empty());
    let length = parameter_text
        .len()
        .checked_add(return_text.map_or(0, |value| value.len().saturating_add(1)))
        .ok_or(ExtractError::OutputLimit)?;
    if length > MAX_SIGNATURE_BYTES {
        return Ok(None);
    }
    builder.context.budget.ensure_string_length(length)?;
    let mut signature = String::new();
    signature
        .try_reserve(length)
        .map_err(|_| ExtractError::OutputLimit)?;
    if let Some(return_text) = return_text {
        signature.push_str(return_text);
        signature.push(' ');
    }
    signature.push_str(parameter_text);
    if !callable_signature_is_literal_free(&signature) {
        return Ok(None);
    }
    Ok(Some(signature))
}

fn capture_parameter_types(
    builder: &mut ExtractionBuilder<'_, '_>,
    parameters: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    for parameter in named_children(parameters) {
        builder.context.ensure_active()?;
        if let Some(type_node) = parameter.child_by_field_name("type") {
            capture_type_references(builder, type_node, owner, ReferenceKind::TypeOf)?;
        }
    }
    Ok(())
}

fn emit_annotated_parameters(
    builder: &mut ExtractionBuilder<'_, '_>,
    parameters: Node<'_>,
) -> Result<(), ExtractError> {
    for parameter in named_children(parameters) {
        builder.context.ensure_active()?;
        if !managed_modifiers(builder, parameter)?.decorated {
            continue;
        }
        let Some(name_node) = parameter.child_by_field_name("name") else {
            continue;
        };
        let name = builder.context.owned_text(name_node)?;
        let type_node = parameter.child_by_field_name("type");
        let signature = managed_typed_name(builder, type_node, &name)?;
        let pending = PendingSymbol {
            kind: SymbolKind::Parameter,
            name,
            span_node: parameter,
            structural_node: parameter,
            doc_anchor: parameter,
            body_node: None,
            declaration_only: false,
            signature,
            exported: false,
            default_export: false,
            async_symbol: false,
            static_member: false,
            visibility: None,
        };
        let id = builder.emit_symbol(pending)?;
        capture_decorators(builder, parameter, &id)?;
        if let Some(type_node) = type_node {
            capture_type_references(builder, type_node, &id, ReferenceKind::TypeOf)?;
        }
    }
    Ok(())
}

fn visit_property(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return builder.visit_named_children(node, depth);
    };
    let name = builder.context.owned_text(name_node)?;
    let type_node = node.child_by_field_name("type");
    let modifiers = managed_modifiers(builder, node)?;
    let visibility = managed_visibility(builder, modifiers, false);
    let body = node
        .child_by_field_name("value")
        .or_else(|| node.child_by_field_name("accessors"));
    let declaration_only = matches!(
        builder.native_owner_kinds.last(),
        Some(SymbolKind::Interface)
    );
    let pending = PendingSymbol {
        kind: SymbolKind::Property,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: body,
        declaration_only,
        signature: managed_typed_name(builder, type_node, &name)?,
        exported: visibility == Some(Visibility::Public),
        default_export: false,
        async_symbol: false,
        static_member: modifiers.static_symbol,
        visibility,
    };
    let id = builder.emit_symbol(pending)?;
    capture_decorators(builder, node, &id)?;
    if let Some(type_node) = type_node {
        capture_type_references(builder, type_node, &id, ReferenceKind::TypeOf)?;
    }
    let Some(body) = body else {
        return Ok(());
    };
    builder.owners.push(id);
    builder.native_owner_kinds.push(SymbolKind::Property);
    builder.qualifiers.push(name);
    let result = builder.visit(body, depth.saturating_add(1));
    builder.qualifiers.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    result
}

fn visit_variables(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    kind: SymbolKind,
) -> Result<(), ExtractError> {
    let (declaration, type_node) = variable_declaration_and_type(node);
    let Some(declaration) = declaration else {
        return builder.visit_named_children(node, depth);
    };
    let modifiers = managed_modifiers(builder, node)?;
    let visibility = (kind == SymbolKind::Field)
        .then(|| managed_visibility(builder, modifiers, false))
        .flatten();
    for declarator in
        named_children(declaration).filter(|child| child.kind() == "variable_declarator")
    {
        builder.context.ensure_active()?;
        let Some(name_node) = declarator.child_by_field_name("name") else {
            continue;
        };
        let name = builder.context.owned_text(name_node)?;
        let pending = PendingSymbol {
            kind,
            name: name.clone(),
            span_node: declarator,
            structural_node: declarator,
            doc_anchor: node,
            body_node: None,
            declaration_only: false,
            signature: (kind == SymbolKind::Field)
                .then(|| managed_typed_name(builder, type_node, &name))
                .transpose()?
                .flatten(),
            exported: visibility == Some(Visibility::Public),
            default_export: false,
            async_symbol: false,
            static_member: kind == SymbolKind::Field
                && (modifiers.static_symbol
                    || modifiers.const_symbol
                    || (builder.context.snapshot.language() == SourceLanguage::Java
                        && matches!(
                            builder.native_owner_kinds.last(),
                            Some(SymbolKind::Interface)
                        ))),
            visibility,
        };
        let id = builder.emit_symbol(pending)?;
        capture_decorators(builder, node, &id)?;
        if let Some(type_node) = type_node {
            capture_type_references(builder, type_node, &id, ReferenceKind::TypeOf)?;
        }
        if let Some(value) = declarator
            .child_by_field_name("value")
            .or_else(|| named_children(declarator).find(|child| is_expression_kind(child.kind())))
        {
            builder.visit(value, depth.saturating_add(1))?;
        }
    }
    Ok(())
}

fn variable_declaration_and_type(node: Node<'_>) -> (Option<Node<'_>>, Option<Node<'_>>) {
    if matches!(
        node.kind(),
        "field_declaration" | "local_variable_declaration" | "constant_declaration"
    ) && node.child_by_field_name("declarator").is_some()
    {
        return (Some(node), node.child_by_field_name("type"));
    }
    let declaration = named_children(node).find(|child| child.kind() == "variable_declaration");
    let type_node = declaration.and_then(|declaration| declaration.child_by_field_name("type"));
    (declaration, type_node)
}

fn is_expression_kind(kind: &str) -> bool {
    kind.ends_with("_expression") || matches!(kind, "expression" | "array_initializer")
}

fn managed_typed_name(
    builder: &mut ExtractionBuilder<'_, '_>,
    type_node: Option<Node<'_>>,
    name: &str,
) -> Result<Option<String>, ExtractError> {
    let Some(type_node) = type_node else {
        return Ok(None);
    };
    let type_text = builder.context.text(type_node).trim();
    let length = type_text
        .len()
        .checked_add(name.len())
        .and_then(|length| length.checked_add(1))
        .ok_or(ExtractError::OutputLimit)?;
    if length > MAX_SIGNATURE_BYTES {
        return Ok(None);
    }
    builder.context.budget.ensure_string_length(length)?;
    let mut signature = String::new();
    signature
        .try_reserve(length)
        .map_err(|_| ExtractError::OutputLimit)?;
    signature.push_str(type_text);
    signature.push(' ');
    signature.push_str(name);
    if !callable_signature_is_literal_free(&signature) {
        return Ok(None);
    }
    Ok(Some(signature))
}

fn visit_enum_member(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = node.child_by_field_name("name") else {
        return Ok(());
    };
    let pending = PendingSymbol {
        kind: SymbolKind::EnumMember,
        name: builder.context.owned_text(name_node)?,
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: None,
        declaration_only: false,
        signature: None,
        exported: true,
        default_export: false,
        async_symbol: false,
        static_member: true,
        visibility: Some(Visibility::Public),
    };
    let id = builder.emit_symbol(pending)?;
    capture_decorators(builder, node, &id)
}

#[derive(Clone, Copy, Debug, Default)]
struct ManagedModifiers {
    public: bool,
    private: bool,
    protected: bool,
    internal: bool,
    static_symbol: bool,
    async_symbol: bool,
    const_symbol: bool,
    decorated: bool,
}

impl ManagedModifiers {
    const fn explicit_visibility(self) -> Option<Visibility> {
        if self.public {
            Some(Visibility::Public)
        } else if self.private {
            Some(Visibility::Private)
        } else if self.protected {
            Some(Visibility::Protected)
        } else if self.internal {
            Some(Visibility::Internal)
        } else {
            None
        }
    }
}

fn managed_visibility(
    builder: &ExtractionBuilder<'_, '_>,
    modifiers: ManagedModifiers,
    type_declaration: bool,
) -> Option<Visibility> {
    if let Some(visibility) = modifiers.explicit_visibility() {
        return Some(visibility);
    }
    if matches!(
        builder.native_owner_kinds.last(),
        Some(SymbolKind::Interface)
    ) {
        return Some(Visibility::Public);
    }
    if builder.context.snapshot.language() == SourceLanguage::CSharp {
        if type_declaration
            && matches!(
                builder.native_owner_kinds.last(),
                None | Some(SymbolKind::Namespace)
            )
        {
            Some(Visibility::Internal)
        } else {
            Some(Visibility::Private)
        }
    } else {
        None
    }
}

fn managed_modifiers(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<ManagedModifiers, ExtractError> {
    let mut modifiers = ManagedModifiers::default();
    for child in children(node) {
        builder.context.ensure_active()?;
        capture_modifier(builder, child, &mut modifiers)?;
    }
    Ok(modifiers)
}

fn capture_modifier(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    modifiers: &mut ManagedModifiers,
) -> Result<(), ExtractError> {
    builder.context.ensure_active()?;
    update_modifier(node.kind(), builder.context.text(node).trim(), modifiers);
    if matches!(node.kind(), "modifier" | "modifiers" | "attribute_list") {
        for child in children(node) {
            builder.context.ensure_active()?;
            update_modifier(child.kind(), builder.context.text(child).trim(), modifiers);
        }
    }
    Ok(())
}

fn update_modifier(kind: &str, text: &str, modifiers: &mut ManagedModifiers) {
    let token = if matches!(kind, "modifier" | "modifiers") {
        text
    } else {
        kind
    };
    match token {
        "public" => modifiers.public = true,
        "private" => modifiers.private = true,
        "protected" => modifiers.protected = true,
        "internal" => modifiers.internal = true,
        "static" => modifiers.static_symbol = true,
        "async" => modifiers.async_symbol = true,
        "const" => modifiers.const_symbol = true,
        _ => {}
    }
    if is_decorator(kind) {
        modifiers.decorated = true;
    }
}

fn capture_decorators(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    for child in named_children(node) {
        builder.context.ensure_active()?;
        if is_decorator(child.kind()) {
            capture_decorator(builder, child, owner)?;
        } else if matches!(child.kind(), "modifiers" | "attribute_list") {
            for candidate in
                named_children(child).filter(|candidate| is_decorator(candidate.kind()))
            {
                builder.context.ensure_active()?;
                capture_decorator(builder, candidate, owner)?;
            }
        }
    }
    Ok(())
}

fn is_decorator(kind: &str) -> bool {
    matches!(kind, "annotation" | "marker_annotation" | "attribute")
}

fn capture_decorator(
    builder: &mut ExtractionBuilder<'_, '_>,
    decorator: Node<'_>,
    owner: &SymbolId,
) -> Result<(), ExtractError> {
    let Some(name_node) = decorator.child_by_field_name("name") else {
        return Ok(());
    };
    let name = safe_reference_node_text(builder, name_node)?;
    let Some(name) = name else {
        return Ok(());
    };
    push_named_reference(builder, owner, name, ReferenceKind::Decorates, name_node)
}

fn capture_type_references(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
    owner: &SymbolId,
    kind: ReferenceKind,
) -> Result<(), ExtractError> {
    match builder.context.snapshot.language() {
        SourceLanguage::Java => capture_java_type(builder, root, owner, kind, 0),
        SourceLanguage::CSharp => capture_csharp_type(builder, root, owner, kind, 0),
        _ => Ok(()),
    }
}

fn capture_java_type(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
    kind: ReferenceKind,
    depth: usize,
) -> Result<(), ExtractError> {
    if depth > MAX_TYPE_DEPTH {
        return Err(ExtractError::NestingLimit);
    }
    builder.context.ensure_active()?;
    match node.kind() {
        "scoped_type_identifier" => {
            if let Some(name) = managed_outer_type_name(builder, node)? {
                push_named_reference(builder, owner, name, kind, node)?;
            }
            for child in named_children(node).filter(|child| child.kind() == "type_arguments") {
                capture_java_type(builder, child, owner, kind, depth.saturating_add(1))?;
            }
        }
        "generic_type" => {
            for child in named_children(node) {
                if matches!(
                    child.kind(),
                    "type_identifier" | "scoped_type_identifier" | "type_arguments"
                ) {
                    capture_java_type(builder, child, owner, kind, depth.saturating_add(1))?;
                }
            }
        }
        "type_identifier" => {
            if let Some(name) = managed_outer_type_name(builder, node)? {
                push_named_reference(builder, owner, name, kind, node)?;
            }
        }
        _ => {
            for child in named_children(node) {
                capture_java_type(builder, child, owner, kind, depth.saturating_add(1))?;
            }
        }
    }
    Ok(())
}

fn capture_csharp_type(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    owner: &SymbolId,
    kind: ReferenceKind,
    depth: usize,
) -> Result<(), ExtractError> {
    if depth > MAX_TYPE_DEPTH {
        return Err(ExtractError::NestingLimit);
    }
    builder.context.ensure_active()?;
    match node.kind() {
        "qualified_name" | "alias_qualified_name" => {
            if let Some(name) = managed_outer_type_name(builder, node)? {
                push_named_reference(builder, owner, name, kind, node)?;
            }
            for child in descendants_including_root(node)
                .filter(|child| child.kind() == "type_argument_list")
            {
                for argument in named_children(child) {
                    capture_csharp_type(builder, argument, owner, kind, depth.saturating_add(1))?;
                }
            }
        }
        "generic_name" => {
            for child in named_children(node) {
                match child.kind() {
                    "identifier" => {
                        if let Some(name) = managed_outer_type_name(builder, child)? {
                            push_named_reference(builder, owner, name, kind, child)?;
                        }
                    }
                    "type_argument_list" => {
                        for argument in named_children(child) {
                            capture_csharp_type(
                                builder,
                                argument,
                                owner,
                                kind,
                                depth.saturating_add(1),
                            )?;
                        }
                    }
                    _ => {}
                }
            }
        }
        "identifier" => {
            if let Some(name) = managed_outer_type_name(builder, node)? {
                push_named_reference(builder, owner, name, kind, node)?;
            }
        }
        "predefined_type" | "implicit_type" => {}
        _ => {
            for child in named_children(node) {
                capture_csharp_type(builder, child, owner, kind, depth.saturating_add(1))?;
            }
        }
    }
    Ok(())
}

fn managed_outer_type_name(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    let raw = builder.context.text(node).trim();
    let without_global = raw.strip_prefix("global::").unwrap_or(raw);
    let outer = without_global
        .find('<')
        .and_then(|index| without_global.get(..index))
        .unwrap_or(without_global)
        .trim()
        .trim_end_matches(['?', '*', '&']);
    if outer.is_empty()
        || outer.len() > MAX_REFERENCE_TARGET_BYTES
        || is_managed_builtin(outer)
        || !outer
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'$'))
    {
        return Ok(None);
    }
    builder.context.copy_text(outer).map(Some)
}

fn is_managed_builtin(name: &str) -> bool {
    matches!(
        name,
        "bool"
            | "byte"
            | "char"
            | "decimal"
            | "double"
            | "dynamic"
            | "float"
            | "int"
            | "long"
            | "nint"
            | "nuint"
            | "object"
            | "sbyte"
            | "short"
            | "string"
            | "uint"
            | "ulong"
            | "ushort"
            | "var"
            | "void"
            | "boolean"
    )
}

fn capture_call(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let target = if node.kind() == "method_invocation" {
        let Some(name_node) = node.child_by_field_name("name") else {
            return Ok(());
        };
        java_call_name(builder, node.child_by_field_name("object"), name_node)?
    } else {
        let Some(function) = node.child_by_field_name("function") else {
            return Ok(());
        };
        safe_reference_node_text(builder, function)?
    };
    let Some(name) = target else {
        return Ok(());
    };
    references::push_reference(
        builder,
        PendingReference {
            owner: builder.owners.last().cloned(),
            name,
            kind: ReferenceKind::Calls,
            node,
        },
    )
}

fn java_call_name(
    builder: &mut ExtractionBuilder<'_, '_>,
    object: Option<Node<'_>>,
    name: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    let Some(local_name) = safe_reference_node_text(builder, name)? else {
        return Ok(None);
    };
    let Some(object) = object else {
        return Ok(Some(local_name));
    };
    let Some(object_name) = safe_reference_node_text(builder, object)? else {
        return Ok(Some(local_name));
    };
    let object_name = object_name.strip_prefix("this.").unwrap_or(&object_name);
    let length = object_name
        .len()
        .checked_add(local_name.len())
        .and_then(|length| length.checked_add(1))
        .ok_or(ExtractError::OutputLimit)?;
    if length > MAX_REFERENCE_TARGET_BYTES {
        return Ok(Some(local_name));
    }
    builder.context.budget.ensure_string_length(length)?;
    let mut qualified = String::new();
    qualified
        .try_reserve(length)
        .map_err(|_| ExtractError::OutputLimit)?;
    qualified.push_str(object_name);
    qualified.push('.');
    qualified.push_str(&local_name);
    Ok(Some(qualified))
}

fn safe_reference_node_text(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    for descendant in descendants_including_root(node) {
        builder.context.ensure_active()?;
        if is_literal_kind(descendant.kind()) {
            return Ok(None);
        }
    }
    let raw = builder.context.text(node).trim();
    if raw.len() > MAX_REFERENCE_TARGET_BYTES {
        return Ok(None);
    }
    let normalized = strip_generic_arguments(raw)?;
    if normalized.is_empty()
        || normalized.len() > MAX_REFERENCE_TARGET_BYTES
        || !normalized
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'.' | b':' | b'$'))
    {
        return Ok(None);
    }
    builder.context.copy_text(&normalized).map(Some)
}

fn strip_generic_arguments(raw: &str) -> Result<String, ExtractError> {
    let mut normalized = String::new();
    normalized
        .try_reserve(raw.len())
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut generic_depth = 0_usize;
    for character in raw.chars() {
        match character {
            '<' => generic_depth = generic_depth.saturating_add(1),
            '>' => generic_depth = generic_depth.saturating_sub(1),
            _ if generic_depth == 0 && !character.is_whitespace() => normalized.push(character),
            _ => {}
        }
    }
    Ok(normalized)
}

fn is_literal_kind(kind: &str) -> bool {
    kind.contains("string")
        || kind.contains("character")
        || kind.contains("integer_literal")
        || kind.contains("real_literal")
        || kind.contains("number_literal")
}

fn capture_construction(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(type_node) = node.child_by_field_name("type") else {
        return Ok(());
    };
    let Some(name) = managed_outer_type_name(builder, type_node)? else {
        return Ok(());
    };
    references::push_reference(
        builder,
        PendingReference {
            owner: builder.owners.last().cloned(),
            name,
            kind: ReferenceKind::Instantiates,
            node: type_node,
        },
    )
}

fn capture_member_access(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    if is_csharp_invocation_target(node) {
        return Ok(());
    }
    let field = if node.kind() == "field_access" {
        node.child_by_field_name("field")
    } else {
        node.child_by_field_name("name")
    };
    let Some(field) = field else {
        return Ok(());
    };
    let Some(name) = safe_reference_node_text(builder, field)? else {
        return Ok(());
    };
    references::push_reference(
        builder,
        PendingReference {
            owner: builder.owners.last().cloned(),
            name,
            kind: ReferenceKind::FieldAccess,
            node: field,
        },
    )
}

fn is_csharp_invocation_target(node: Node<'_>) -> bool {
    let Some(parent) = node
        .parent()
        .filter(|parent| parent.kind() == "invocation_expression")
    else {
        return false;
    };
    parent
        .child_by_field_name("function")
        .is_some_and(|function| {
            function.start_byte() == node.start_byte() && function.end_byte() == node.end_byte()
        })
}

fn push_named_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    owner: &SymbolId,
    name: String,
    kind: ReferenceKind,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    references::push_reference(
        builder,
        PendingReference {
            owner: Some(owner.clone()),
            name,
            kind,
            node,
        },
    )
}
