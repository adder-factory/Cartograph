use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolKind, Visibility};
use tree_sitter::Node;

use crate::{
    ExtractError, ExtractedImportBinding, ExtractedReference, ImportBindingKind,
    walk::{ExtractionBuilder, PendingSymbol, syntax::span_for},
};

const NAME_SEARCH_DEPTH: usize = 6;
const PREFIX_SCAN_BYTES: usize = 512;

pub(super) fn visit_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
) -> Result<bool, ExtractError> {
    if node.parent().is_none()
        && node.kind() == "program"
        && matches!(
            builder.context.snapshot.language(),
            SourceLanguage::Dart | SourceLanguage::Php | SourceLanguage::R | SourceLanguage::Ruby
        )
    {
        builder.visit_named_children(node, depth)?;
        return Ok(true);
    }
    if is_import_node(node.kind()) {
        capture_import(builder, node)?;
        return Ok(true);
    }
    let Some((kind, name)) = declaration(builder, node)? else {
        return Ok(false);
    };
    if should_skip_markup_symbol(builder.context.snapshot.language(), kind, &name) {
        return Ok(false);
    }
    if builder
        .qualifiers
        .last()
        .is_some_and(|qualifier| qualifier == &name)
    {
        builder.visit_named_children(node, depth)?;
        return Ok(true);
    }
    let qualified_name = builder.qualified_name(&name)?;
    if let Some(existing) = builder
        .facts
        .symbols
        .iter()
        .find(|symbol| symbol.kind == kind && symbol.qualified_name == qualified_name)
        .map(|symbol| symbol.id.clone())
    {
        builder.owners.push(existing);
        builder.native_owner_kinds.push(kind);
        builder.native_visibilities.push(None);
        builder.qualifiers.push(name);
        builder.visit_named_children(node, depth)?;
        builder.qualifiers.pop();
        builder.native_visibilities.pop();
        builder.native_owner_kinds.pop();
        builder.owners.pop();
        return Ok(true);
    }
    let body = node.child_by_field_name("body");
    let definition = is_definition_node(node.kind());
    let visibility = generic_visibility(node, builder.context.source());
    let exported = generic_exported(
        builder.context.snapshot.language(),
        builder.owners.is_empty(),
        visibility,
        &name,
        node,
        builder.context.source(),
    );
    let pending = PendingSymbol {
        kind,
        name: name.clone(),
        span_node: node,
        structural_node: node,
        doc_anchor: node,
        body_node: body.or(definition.then_some(node)),
        declaration_only: is_callable(kind) && body.is_none() && !definition,
        signature: None,
        exported,
        default_export: false,
        async_symbol: source_prefix_contains(node, builder.context.source(), "async"),
        static_member: source_prefix_contains(node, builder.context.source(), "static"),
        visibility,
    };
    let id = builder.emit_symbol(pending)?;
    builder.owners.push(id);
    builder.native_owner_kinds.push(kind);
    builder.native_visibilities.push(visibility);
    builder.qualifiers.push(name);
    builder.visit_named_children(node, depth)?;
    builder.qualifiers.pop();
    builder.native_visibilities.pop();
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    Ok(true)
}

pub(super) fn capture_usage(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    if is_import_node(node.kind()) {
        return capture_import(builder, node);
    }
    if is_call_node(node.kind()) {
        capture_call(builder, node)?;
    }
    if is_inheritance_node(node.kind()) {
        capture_named_reference(builder, node, ReferenceKind::Inherits)?;
    }
    Ok(())
}

fn declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<Option<(SymbolKind, String)>, ExtractError> {
    if let Some(kind) = declaration_kind(node.kind()) {
        let name = find_name_node(node, 0)
            .map(|name| builder.context.owned_text(name))
            .transpose()?
            .and_then(|name| normalize_name(&name));
        if let Some(name) = name {
            return Ok(Some((kind, name)));
        }
    }
    textual_declaration(builder, node)
}

fn declaration_kind(node_kind: &str) -> Option<SymbolKind> {
    let exact = match node_kind {
        "function"
        | "function_declaration"
        | "function_definition"
        | "function_item"
        | "function_statement"
        | "function_or_value_defn"
        | "function_binding"
        | "procedure_declaration"
        | "procedure_definition"
        | "defProc"
        | "subroutine"
        | "constructor_declaration"
        | "destructor_declaration" => SymbolKind::Function,
        "method"
        | "singleton_method"
        | "method_declaration"
        | "method_definition"
        | "method_implementation"
        | "method_block"
        | "method_statement"
        | "constructor_definition" => SymbolKind::Method,
        "class"
        | "class_declaration"
        | "class_definition"
        | "class_block"
        | "class_interface"
        | "class_implementation"
        | "object_declaration"
        | "object_definition"
        | "contract_declaration" => SymbolKind::Class,
        "struct_declaration"
        | "struct_definition"
        | "structure_declaration"
        | "record_declaration"
        | "record_definition"
        | "model_declaration" => SymbolKind::Struct,
        "interface_declaration"
        | "interface_definition"
        | "protocol_declaration"
        | "trait_declaration"
        | "trait_definition"
        | "object_type_definition" => SymbolKind::Interface,
        "enum" | "enum_declaration" | "enum_definition" | "enum_type_definition" => {
            SymbolKind::Enum
        }
        "enum_member" | "enum_value_definition" => SymbolKind::EnumMember,
        "module"
        | "program"
        | "module_declaration"
        | "module_definition"
        | "module_block"
        | "namespace_declaration"
        | "namespace_definition"
        | "unit_declaration"
        | "program_declaration"
        | "package_declaration" => SymbolKind::Module,
        "type_alias"
        | "type_alias_declaration"
        | "type_declaration"
        | "type_definition"
        | "alias_declaration" => SymbolKind::TypeAlias,
        "field"
        | "field_declaration"
        | "field_definition"
        | "property_declaration"
        | "property_definition"
        | "property_statement" => SymbolKind::Property,
        "constant" | "const_declaration" | "constant_declaration" | "constant_definition" => {
            SymbolKind::Constant
        }
        "variable_declaration"
        | "variable_definition"
        | "let_declaration"
        | "value_declaration"
        | "binding" => SymbolKind::Variable,
        "event_definition" | "event_declaration" => SymbolKind::Resource,
        "macro_declaration" | "macro_definition" => SymbolKind::Function,
        "table_declaration" | "create_table_statement" | "create_table" => SymbolKind::Table,
        "schema_declaration" | "schema_definition" => SymbolKind::Resource,
        "resource_declaration" => SymbolKind::Resource,
        "component_declaration" => SymbolKind::Component,
        _ => return heuristic_declaration_kind(node_kind),
    };
    Some(exact)
}

fn heuristic_declaration_kind(node_kind: &str) -> Option<SymbolKind> {
    let declaration_like = node_kind.ends_with("_declaration")
        || node_kind.ends_with("_definition")
        || node_kind.ends_with("_defn")
        || node_kind.ends_with("_block");
    if !declaration_like {
        return None;
    }
    if node_kind.contains("function") || node_kind.contains("procedure") {
        Some(SymbolKind::Function)
    } else if node_kind.contains("method") || node_kind.contains("constructor") {
        Some(SymbolKind::Method)
    } else if node_kind.contains("class") || node_kind.contains("contract") {
        Some(SymbolKind::Class)
    } else if node_kind.contains("interface") || node_kind.contains("protocol") {
        Some(SymbolKind::Interface)
    } else if node_kind.contains("struct") || node_kind.contains("record") {
        Some(SymbolKind::Struct)
    } else if node_kind.contains("enum") {
        Some(SymbolKind::Enum)
    } else if node_kind.contains("module") || node_kind.contains("namespace") {
        Some(SymbolKind::Module)
    } else if node_kind.contains("type") || node_kind.contains("alias") {
        Some(SymbolKind::TypeAlias)
    } else if node_kind.contains("field") || node_kind.contains("property") {
        Some(SymbolKind::Property)
    } else if node_kind.contains("constant") {
        Some(SymbolKind::Constant)
    } else if node_kind.contains("variable") || node_kind.contains("value") {
        Some(SymbolKind::Variable)
    } else {
        None
    }
}

fn textual_declaration(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<Option<(SymbolKind, String)>, ExtractError> {
    let language = builder.context.snapshot.language();
    let text = builder.context.text(node).trim_start();
    let candidate = match language {
        SourceLanguage::Clojure | SourceLanguage::CommonLisp => lisp_declaration(text),
        SourceLanguage::R if matches!(node.kind(), "left_assignment" | "binary_operator") => {
            r_declaration(text)
        }
        SourceLanguage::Sql if node.kind().contains("create") || starts_keyword(text, "create") => {
            sql_declaration(text)
        }
        SourceLanguage::Hcl if node.kind() == "block" => hcl_declaration(text),
        SourceLanguage::Nix if matches!(node.kind(), "binding" | "attrpath_value") => {
            assignment_declaration(text, SymbolKind::Property)
        }
        SourceLanguage::Yaml if node.kind().contains("mapping_pair") => {
            assignment_declaration(text, SymbolKind::Property)
        }
        SourceLanguage::Html | SourceLanguage::Astro if node.kind().contains("element") => {
            markup_declaration(text)
        }
        _ => None,
    };
    candidate
        .map(|(kind, name)| builder.context.copy_text(&name).map(|name| (kind, name)))
        .transpose()
}

fn lisp_declaration(text: &str) -> Option<(SymbolKind, String)> {
    let text = text.strip_prefix('(')?.trim_start();
    let (head, rest) = split_token(text)?;
    let kind = match head.to_ascii_lowercase().as_str() {
        "defn" | "defn-" | "defun" | "defmethod" | "defmacro" => SymbolKind::Function,
        "defclass" | "deftype" | "defrecord" | "defstruct" => SymbolKind::Class,
        "ns" | "defpackage" | "in-package" => SymbolKind::Module,
        "def" | "defonce" | "defparameter" | "defvar" | "defconstant" => SymbolKind::Variable,
        _ => return None,
    };
    let (name, _) = split_token(rest.trim_start())?;
    normalize_name(name).map(|name| (kind, name))
}

fn r_declaration(text: &str) -> Option<(SymbolKind, String)> {
    let (left, right) = text.split_once("<-").or_else(|| text.split_once('='))?;
    if !right.trim_start().starts_with("function") {
        return None;
    }
    normalize_name(left.trim()).map(|name| (SymbolKind::Function, name))
}

fn sql_declaration(text: &str) -> Option<(SymbolKind, String)> {
    let mut tokens = text
        .split(|character: char| character.is_whitespace() || matches!(character, '(' | ';'))
        .filter(|token| !token.is_empty());
    if !tokens.next()?.eq_ignore_ascii_case("create") {
        return None;
    }
    let mut object = tokens.next()?;
    if object.eq_ignore_ascii_case("or") {
        if !tokens.next()?.eq_ignore_ascii_case("replace") {
            return None;
        }
        object = tokens.next()?;
    }
    let kind = if object.eq_ignore_ascii_case("table") || object.eq_ignore_ascii_case("view") {
        SymbolKind::Table
    } else if object.eq_ignore_ascii_case("function") || object.eq_ignore_ascii_case("procedure") {
        SymbolKind::Function
    } else if object.eq_ignore_ascii_case("schema")
        || object.eq_ignore_ascii_case("database")
        || object.eq_ignore_ascii_case("trigger")
    {
        SymbolKind::Resource
    } else {
        return None;
    };
    normalize_name(tokens.next()?).map(|name| (kind, name))
}

fn hcl_declaration(text: &str) -> Option<(SymbolKind, String)> {
    let mut tokens = text.split_whitespace();
    let head = normalize_name(tokens.next()?)?;
    let label = tokens.next().and_then(normalize_name);
    let name = label.map_or(head.clone(), |label| format!("{head}.{label}"));
    let kind = if head.eq_ignore_ascii_case("resource") || head.eq_ignore_ascii_case("data") {
        SymbolKind::Resource
    } else {
        SymbolKind::Module
    };
    Some((kind, name))
}

fn assignment_declaration(text: &str, kind: SymbolKind) -> Option<(SymbolKind, String)> {
    let delimiter = if text.contains('=') { '=' } else { ':' };
    let (name, _) = text.split_once(delimiter)?;
    normalize_name(name.trim()).map(|name| (kind, name))
}

fn markup_declaration(text: &str) -> Option<(SymbolKind, String)> {
    let start = text.find('<')?.saturating_add(1);
    let tail = text.get(start..)?.trim_start_matches('/');
    let end = tail
        .find(|character: char| character.is_whitespace() || matches!(character, '>' | '/'))
        .unwrap_or(tail.len());
    let name = normalize_name(tail.get(..end)?)?;
    (name.contains('-') || name.chars().next().is_some_and(char::is_uppercase))
        .then_some((SymbolKind::Component, name))
}

fn find_name_node(node: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > NAME_SEARCH_DEPTH {
        return None;
    }
    for field in [
        "name",
        "identifier",
        "declarator",
        "path",
        "key",
        "property",
        "type",
    ] {
        if let Some(candidate) = node.child_by_field_name(field) {
            if is_name_node(candidate.kind()) {
                return Some(candidate);
            }
            if let Some(found) = find_name_node(candidate, depth.saturating_add(1)) {
                return Some(found);
            }
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if is_name_node(child.kind()) {
            return Some(child);
        }
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if let Some(found) = find_name_node(child, depth.saturating_add(1)) {
            return Some(found);
        }
    }
    None
}

fn is_name_node(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "name"
            | "type_identifier"
            | "field_identifier"
            | "property_identifier"
            | "constant"
            | "simple_identifier"
            | "bare_key"
            | "word"
            | "symbol"
            | "atom"
            | "namespace_name"
            | "class_name"
            | "method_name"
            | "function_name"
    ) || kind.ends_with("_identifier")
        || kind.ends_with("_name")
}

fn normalize_name(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(|character: char| {
        matches!(
            character,
            '"' | '\'' | '`' | ':' | ',' | ';' | '(' | ')' | '{' | '}'
        )
    });
    if value.is_empty()
        || value.len() > 512
        || value.chars().any(|character| {
            !(character.is_alphanumeric()
                || matches!(character, '_' | '$' | ':' | '.' | '-' | '/' | '@' | '#'))
        })
    {
        None
    } else {
        Some(value.to_owned())
    }
}

fn capture_call(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let target = ["function", "callee", "method", "name", "command"]
        .into_iter()
        .find_map(|field| node.child_by_field_name(field))
        .or_else(|| {
            let mut cursor = node.walk();
            node.named_children(&mut cursor).next()
        });
    let Some(target) = target else {
        return Ok(());
    };
    let name = builder.context.owned_text(target)?;
    let Some(name) = normalize_reference_name(&name) else {
        return Ok(());
    };
    let reference = ExtractedReference {
        owner: builder.owners.last().cloned(),
        name,
        resolution_name: None,
        kind: ReferenceKind::Calls,
        span: span_for(target)?,
    };
    builder.emit_reference(reference)
}

fn capture_named_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    kind: ReferenceKind,
) -> Result<(), ExtractError> {
    let Some(target) = find_name_node(node, 0) else {
        return Ok(());
    };
    let name = builder.context.owned_text(target)?;
    let Some(name) = normalize_reference_name(&name) else {
        return Ok(());
    };
    builder.emit_reference(ExtractedReference {
        owner: builder.owners.last().cloned(),
        name,
        resolution_name: None,
        kind,
        span: span_for(target)?,
    })
}

fn capture_import(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
) -> Result<(), ExtractError> {
    let target = ["source", "module", "path", "argument", "name"]
        .into_iter()
        .find_map(|field| node.child_by_field_name(field))
        .or_else(|| find_import_target(node, 0));
    let Some(target) = target else {
        return Ok(());
    };
    let raw = builder.context.owned_text(target)?;
    let Some(module) = normalize_module_specifier(&raw) else {
        return Ok(());
    };
    let span = span_for(target)?;
    builder.emit_reference(ExtractedReference {
        owner: builder.owners.last().cloned(),
        name: module.clone(),
        resolution_name: None,
        kind: ReferenceKind::Imports,
        span,
    })?;
    builder.emit_import_binding(ExtractedImportBinding {
        kind: ImportBindingKind::Namespace,
        module_specifier: module,
        imported_name: "*".to_owned(),
        local_name: "*".to_owned(),
        span,
    })
}

fn find_import_target(node: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > NAME_SEARCH_DEPTH {
        return None;
    }
    let mut cursor = node.walk();
    for child in node.named_children(&mut cursor) {
        if child.kind().contains("string")
            || is_name_node(child.kind())
            || matches!(
                child.kind(),
                "scoped_identifier" | "dotted_name" | "namespace_identifier"
            )
        {
            return Some(child);
        }
    }
    let mut cursor = node.walk();
    node.named_children(&mut cursor)
        .find_map(|child| find_import_target(child, depth.saturating_add(1)))
}

fn normalize_reference_name(value: &str) -> Option<String> {
    let value = value.trim();
    let head = value
        .split(['(', '[', '{', ' ', '\t', '\n'])
        .next()
        .unwrap_or_default();
    normalize_name(head)
}

fn normalize_module_specifier(value: &str) -> Option<String> {
    normalize_name(
        value
            .trim()
            .trim_matches(|character| matches!(character, '"' | '\'' | '`')),
    )
}

fn generic_visibility(node: Node<'_>, source: &str) -> Option<Visibility> {
    for (token, visibility) in [
        ("public", Visibility::Public),
        ("private", Visibility::Private),
        ("protected", Visibility::Protected),
        ("internal", Visibility::Internal),
    ] {
        if source_prefix_contains(node, source, token) {
            return Some(visibility);
        }
    }
    None
}

fn generic_exported(
    language: SourceLanguage,
    top_level: bool,
    visibility: Option<Visibility>,
    name: &str,
    node: Node<'_>,
    source: &str,
) -> bool {
    if visibility == Some(Visibility::Private) || name.starts_with('_') {
        return false;
    }
    if visibility == Some(Visibility::Public)
        || ["pub", "export", "external"]
            .into_iter()
            .any(|token| source_prefix_contains(node, source, token))
    {
        return true;
    }
    top_level
        && matches!(
            language,
            SourceLanguage::Clojure
                | SourceLanguage::CommonLisp
                | SourceLanguage::Dart
                | SourceLanguage::GraphQl
                | SourceLanguage::Hcl
                | SourceLanguage::Html
                | SourceLanguage::Khn
                | SourceLanguage::Lua
                | SourceLanguage::Luau
                | SourceLanguage::Php
                | SourceLanguage::Prisma
                | SourceLanguage::R
                | SourceLanguage::Ruby
                | SourceLanguage::Solidity
                | SourceLanguage::Sql
                | SourceLanguage::Yaml
        )
}

fn source_prefix_contains(node: Node<'_>, source: &str, token: &str) -> bool {
    let end = node
        .end_byte()
        .min(node.start_byte().saturating_add(PREFIX_SCAN_BYTES));
    let Some(prefix) = source.get(node.start_byte()..end) else {
        return false;
    };
    prefix
        .split(|character: char| !(character.is_alphanumeric() || character == '_'))
        .any(|candidate| candidate.eq_ignore_ascii_case(token))
}

fn is_definition_node(kind: &str) -> bool {
    kind.ends_with("_definition")
        || kind.ends_with("_block")
        || matches!(
            kind,
            "function"
                | "method"
                | "singleton_method"
                | "class"
                | "module"
                | "class_implementation"
                | "function_item"
        )
}

fn is_callable(kind: SymbolKind) -> bool {
    matches!(kind, SymbolKind::Function | SymbolKind::Method)
}

fn is_import_node(kind: &str) -> bool {
    matches!(
        kind,
        "import_declaration"
            | "import_statement"
            | "import_directive"
            | "use_declaration"
            | "use_statement"
            | "include_statement"
            | "require_expression"
            | "include_expression"
    ) || (kind.contains("import")
        && (kind.ends_with("_declaration") || kind.ends_with("_statement")))
}

fn is_call_node(kind: &str) -> bool {
    matches!(
        kind,
        "call"
            | "call_expression"
            | "function_call"
            | "function_call_expression"
            | "method_invocation"
            | "invocation_expression"
            | "command_call"
            | "send"
    )
}

fn is_inheritance_node(kind: &str) -> bool {
    matches!(
        kind,
        "superclass"
            | "base_list"
            | "extends_clause"
            | "implements_clause"
            | "inheritance_specifier"
            | "super_interfaces"
    )
}

fn should_skip_markup_symbol(language: SourceLanguage, kind: SymbolKind, name: &str) -> bool {
    matches!(language, SourceLanguage::Html | SourceLanguage::Astro)
        && kind == SymbolKind::Component
        && !name.contains('-')
        && !name.chars().next().is_some_and(char::is_uppercase)
}

fn split_token(value: &str) -> Option<(&str, &str)> {
    let end = value
        .find(|character: char| {
            character.is_whitespace() || matches!(character, '(' | ')' | '[' | ']')
        })
        .unwrap_or(value.len());
    (end != 0).then(|| (&value[..end], &value[end..]))
}

fn starts_keyword(value: &str, keyword: &str) -> bool {
    value
        .get(..keyword.len())
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case(keyword))
        && value
            .get(keyword.len()..)
            .and_then(|tail| tail.chars().next())
            .is_none_or(|character| !character.is_alphanumeric() && character != '_')
}
