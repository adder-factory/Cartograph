use std::collections::{BTreeMap, BTreeSet};

use cartograph_domain::{
    ReferenceKind, SourceLanguage, SymbolId, SymbolKind, declaration_value_is_search_safe,
};
use tree_sitter::Node;

use crate::{ExtractError, ExtractedReference};

use super::{ExtractionBuilder, PendingSymbol, syntax::span_for};

const MAX_SCHEMA_AST_DEPTH: usize = 256;
const MAX_SCHEMA_VISITS: usize = 500_000;
const MAX_SCHEMA_CANDIDATES: usize = 1_024;
const MAX_FIELDS_PER_SCHEMA: usize = 512;
const MAX_ENUM_MEMBERS_PER_FIELD: usize = 128;
const MAX_ZOD_NESTING: usize = 8;
const MAX_SCHEMA_NAME_BYTES: usize = 512;

#[derive(Default)]
struct ScanBudget {
    visits: usize,
    candidates: usize,
}

impl ScanBudget {
    fn observe(
        &mut self,
        builder: &mut ExtractionBuilder<'_, '_>,
        depth: usize,
    ) -> Result<(), ExtractError> {
        if depth > MAX_SCHEMA_AST_DEPTH {
            return Err(ExtractError::NestingLimit);
        }
        self.visits = self
            .visits
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.visits > MAX_SCHEMA_VISITS {
            return Err(ExtractError::OutputLimit);
        }
        if self.visits.is_multiple_of(256) {
            builder.context.ensure_active()?;
        }
        Ok(())
    }

    fn admit_candidate(&mut self) -> Result<(), ExtractError> {
        self.candidates = self
            .candidates
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.candidates > MAX_SCHEMA_CANDIDATES {
            return Err(ExtractError::OutputLimit);
        }
        Ok(())
    }
}

#[derive(Default)]
struct ZodSchemas {
    fields: BTreeMap<String, Option<BTreeSet<String>>>,
}

struct ZodSchemaInput<'tree, 'scan> {
    span_node: Node<'tree>,
    structural_node: Node<'tree>,
    object: Node<'tree>,
    name: &'scan str,
    nested_depth: usize,
    budget: &'scan mut ScanBudget,
    consumed_objects: &'scan mut BTreeSet<(usize, usize)>,
}

impl ZodSchemas {
    fn insert(&mut self, name: String, fields: BTreeSet<String>) {
        match self.fields.entry(name) {
            std::collections::btree_map::Entry::Vacant(entry) => {
                entry.insert(Some(fields));
            }
            std::collections::btree_map::Entry::Occupied(mut entry) => {
                entry.insert(None);
            }
        }
    }

    fn unique_fields(&self, name: &str) -> Option<&BTreeSet<String>> {
        self.fields.get(name)?.as_ref()
    }
}

pub(super) fn enrich(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    match builder.context.snapshot.language() {
        SourceLanguage::TypeScript
        | SourceLanguage::Tsx
        | SourceLanguage::JavaScript
        | SourceLanguage::Jsx
            if imports_package(builder, "zod") =>
        {
            enrich_zod(builder, root)?;
        }
        SourceLanguage::Python if imports_package(builder, "pydantic") => {
            enrich_pydantic(builder, root)?;
        }
        _ => {}
    }
    Ok(())
}

fn imports_package(builder: &ExtractionBuilder<'_, '_>, package: &str) -> bool {
    if builder.facts.import_bindings.iter().any(|binding| {
        binding.module_specifier == package
            || binding
                .module_specifier
                .strip_prefix(package)
                .is_some_and(|suffix| suffix.starts_with(['/', '.']))
    }) {
        return true;
    }
    if package != "pydantic" {
        return false;
    }
    builder.context.source().lines().any(|line| {
        let line = line.trim_start();
        line.starts_with("import pydantic") || line.starts_with("from pydantic import")
    })
}

fn enrich_zod(builder: &mut ExtractionBuilder<'_, '_>, root: Node<'_>) -> Result<(), ExtractError> {
    let mut budget = ScanBudget::default();
    let mut consumed_objects = BTreeSet::new();
    let mut schemas = ZodSchemas::default();
    scan_zod_declarations(
        builder,
        root,
        0,
        &mut budget,
        &mut consumed_objects,
        &mut schemas,
    )?;
    scan_zod_inline(builder, root, 0, &mut budget, &mut consumed_objects)?;
    if !schemas.fields.is_empty() {
        scan_zod_consumers(builder, root, 0, &mut budget, &schemas)?;
    }
    Ok(())
}

fn scan_zod_declarations(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    budget: &mut ScanBudget,
    consumed_objects: &mut BTreeSet<(usize, usize)>,
    schemas: &mut ZodSchemas,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    if node.kind() == "variable_declarator" {
        let name_node = node.child_by_field_name("name");
        let value_node = node.child_by_field_name("value");
        if let (Some(name_node), Some(value_node)) = (name_node, value_node)
            && name_node.kind() == "identifier"
            && let Some(call) = find_zod_call(value_node, "object", builder.context.source())
            && let Some(object) = first_named_argument(call)
            && object.kind() == "object"
        {
            budget.admit_candidate()?;
            let name = builder.context.owned_text(name_node)?;
            if safe_schema_name(&name, false) {
                consumed_objects.insert((object.start_byte(), object.end_byte()));
                let (struct_id, fields) = emit_zod_schema(
                    builder,
                    ZodSchemaInput {
                        span_node: node,
                        structural_node: value_node,
                        object,
                        name: &name,
                        nested_depth: 0,
                        budget,
                        consumed_objects,
                    },
                )?;
                let _ = struct_id;
                schemas.insert(name, fields);
            }
        }
    }
    for child in super::syntax::named_children(node) {
        scan_zod_declarations(
            builder,
            child,
            depth.saturating_add(1),
            budget,
            consumed_objects,
            schemas,
        )?;
    }
    Ok(())
}

fn emit_zod_schema(
    builder: &mut ExtractionBuilder<'_, '_>,
    input: ZodSchemaInput<'_, '_>,
) -> Result<(SymbolId, BTreeSet<String>), ExtractError> {
    let ZodSchemaInput {
        span_node,
        structural_node,
        object,
        name,
        nested_depth,
        budget,
        consumed_objects,
    } = input;
    let struct_id = emit_schema_symbol(
        builder,
        SymbolKind::Struct,
        name,
        span_node,
        structural_node,
        Some("z.object"),
    )?;
    let fields = with_scope(
        builder,
        &struct_id,
        SymbolKind::Struct,
        Some(name),
        |builder| emit_zod_fields(builder, object, nested_depth, budget, consumed_objects),
    )?;
    Ok((struct_id, fields))
}

fn emit_zod_fields(
    builder: &mut ExtractionBuilder<'_, '_>,
    object: Node<'_>,
    nested_depth: usize,
    budget: &mut ScanBudget,
    consumed_objects: &mut BTreeSet<(usize, usize)>,
) -> Result<BTreeSet<String>, ExtractError> {
    let mut fields = BTreeSet::new();
    for pair in super::syntax::named_children(object) {
        if pair.kind() != "pair" {
            continue;
        }
        if fields.len() >= MAX_FIELDS_PER_SCHEMA {
            return Err(ExtractError::OutputLimit);
        }
        let Some(key) = pair.child_by_field_name("key") else {
            continue;
        };
        let Some(value) = pair.child_by_field_name("value") else {
            continue;
        };
        let field_name = builder.context.owned_unquoted_text(key)?;
        if !safe_schema_name(&field_name, false) || !fields.insert(field_name.clone()) {
            continue;
        }
        let leaf = zod_leaf_type(value, builder.context.source());
        let signature = leaf.as_deref().map(|leaf| format!("z.{leaf}"));
        let field_id = emit_schema_symbol(
            builder,
            SymbolKind::Field,
            &field_name,
            pair,
            pair,
            signature.as_deref(),
        )?;
        if leaf.as_deref() == Some("enum") {
            emit_zod_enum_members(builder, value, &field_id, &field_name)?;
        } else if leaf.as_deref() == Some("object") && nested_depth < MAX_ZOD_NESTING {
            let nested = find_zod_call(value, "object", builder.context.source())
                .and_then(first_named_argument)
                .filter(|candidate| candidate.kind() == "object");
            if let Some(nested) = nested {
                let key = (nested.start_byte(), nested.end_byte());
                if consumed_objects.insert(key) {
                    budget.admit_candidate()?;
                    with_scope(builder, &field_id, SymbolKind::Field, None, |builder| {
                        let (nested_id, _) = emit_zod_schema(
                            builder,
                            ZodSchemaInput {
                                span_node: pair,
                                structural_node: value,
                                object: nested,
                                name: &field_name,
                                nested_depth: nested_depth.saturating_add(1),
                                budget,
                                consumed_objects,
                            },
                        )?;
                        let _ = nested_id;
                        Ok(())
                    })?;
                }
            }
        }
    }
    Ok(fields)
}

fn emit_zod_enum_members(
    builder: &mut ExtractionBuilder<'_, '_>,
    value: Node<'_>,
    field_id: &SymbolId,
    field_name: &str,
) -> Result<(), ExtractError> {
    let Some(array) = find_zod_call(value, "enum", builder.context.source())
        .and_then(first_named_argument)
        .filter(|argument| argument.kind() == "array")
    else {
        return Ok(());
    };
    let mut seen = BTreeSet::new();
    with_scope(
        builder,
        field_id,
        SymbolKind::Field,
        Some(field_name),
        |builder| {
            for element in super::syntax::named_children(array) {
                if !matches!(element.kind(), "string" | "string_fragment") {
                    continue;
                }
                if seen.len() >= MAX_ENUM_MEMBERS_PER_FIELD {
                    return Err(ExtractError::OutputLimit);
                }
                let member = builder.context.owned_unquoted_text(element)?;
                if !safe_schema_name(&member, true) || !seen.insert(member.clone()) {
                    continue;
                }
                emit_schema_symbol(
                    builder,
                    SymbolKind::EnumMember,
                    &member,
                    element,
                    element,
                    None,
                )?;
            }
            Ok(())
        },
    )
}

fn scan_zod_inline(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    budget: &mut ScanBudget,
    consumed_objects: &mut BTreeSet<(usize, usize)>,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    if node.kind() == "call_expression"
        && direct_zod_method(node, "object", builder.context.source())
        && let Some(object) =
            first_named_argument(node).filter(|argument| argument.kind() == "object")
    {
        let object_key = (object.start_byte(), object.end_byte());
        if !consumed_objects.contains(&object_key)
            && let Some((name_node, name)) = inline_zod_schema_name(builder, node)?
            && safe_schema_name(&name, false)
        {
            budget.admit_candidate()?;
            consumed_objects.insert(object_key);
            let _ = emit_zod_schema(
                builder,
                ZodSchemaInput {
                    span_node: name_node,
                    structural_node: node,
                    object,
                    name: &name,
                    nested_depth: 0,
                    budget,
                    consumed_objects,
                },
            )?;
        }
    }
    for child in super::syntax::named_children(node) {
        scan_zod_inline(
            builder,
            child,
            depth.saturating_add(1),
            budget,
            consumed_objects,
        )?;
    }
    Ok(())
}

fn inline_zod_schema_name<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    call: Node<'tree>,
) -> Result<Option<(Node<'tree>, String)>, ExtractError> {
    let mut current = call.parent();
    let mut depth = 0_usize;
    while let Some(node) = current {
        if depth > 32 {
            return Ok(None);
        }
        if node.kind() == "pair" {
            let Some(key) = node.child_by_field_name("key") else {
                return Ok(None);
            };
            let name = builder.context.owned_unquoted_text(key)?;
            return Ok(Some((node, name)));
        }
        if node.kind() == "variable_declarator" {
            return Ok(None);
        }
        if !matches!(
            node.kind(),
            "arguments"
                | "call_expression"
                | "member_expression"
                | "object"
                | "parenthesized_expression"
        ) {
            return Ok(None);
        }
        current = node.parent();
        depth = depth.saturating_add(1);
    }
    Ok(None)
}

fn scan_zod_consumers(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    budget: &mut ScanBudget,
    schemas: &ZodSchemas,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    if matches!(node.kind(), "generic_type" | "type_arguments")
        && builder.context.text(node).contains("z.infer")
        && let Some(schema_node) = typeof_identifier(node, builder.context.source())
    {
        let schema = builder.context.owned_text(schema_node)?;
        if schemas.unique_fields(&schema).is_some() {
            emit_schema_reference(builder, schema_node, &schema, None, ReferenceKind::TypeOf)?;
        }
    }
    if node.kind() == "member_expression"
        && let Some((schema_node, field_node)) = zod_shape_reference(node, builder.context.source())
    {
        let schema = builder.context.owned_text(schema_node)?;
        let field = builder.context.owned_text(field_node)?;
        if schemas
            .unique_fields(&schema)
            .is_some_and(|fields| fields.contains(&field))
        {
            let resolution_name = format!("{schema}::{field}");
            emit_schema_reference(
                builder,
                field_node,
                &field,
                Some(resolution_name),
                ReferenceKind::References,
            )?;
        }
    }
    if node.kind() == "call_expression" {
        emit_zod_selection_references(builder, node, schemas)?;
    }
    for child in super::syntax::named_children(node) {
        scan_zod_consumers(builder, child, depth.saturating_add(1), budget, schemas)?;
    }
    Ok(())
}

fn emit_zod_selection_references(
    builder: &mut ExtractionBuilder<'_, '_>,
    call: Node<'_>,
    schemas: &ZodSchemas,
) -> Result<(), ExtractError> {
    let Some(function) = call.child_by_field_name("function") else {
        return Ok(());
    };
    if function.kind() != "member_expression" {
        return Ok(());
    }
    let Some(schema_node) = function.child_by_field_name("object") else {
        return Ok(());
    };
    let Some(method_node) = function.child_by_field_name("property") else {
        return Ok(());
    };
    if schema_node.kind() != "identifier"
        || !matches!(builder.context.text(method_node), "pick" | "omit")
    {
        return Ok(());
    }
    let schema = builder.context.owned_text(schema_node)?;
    let Some(fields) = schemas.unique_fields(&schema) else {
        return Ok(());
    };
    let Some(selection) = first_named_argument(call).filter(|argument| argument.kind() == "object")
    else {
        return Ok(());
    };
    for pair in super::syntax::named_children(selection) {
        let Some(key) = pair.child_by_field_name("key") else {
            continue;
        };
        let field = builder.context.owned_unquoted_text(key)?;
        if !fields.contains(&field) {
            continue;
        }
        let resolution_name = format!("{schema}::{field}");
        emit_schema_reference(
            builder,
            key,
            &field,
            Some(resolution_name),
            ReferenceKind::References,
        )?;
    }
    Ok(())
}

fn emit_schema_reference(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    name: &str,
    resolution_name: Option<String>,
    kind: ReferenceKind,
) -> Result<(), ExtractError> {
    builder.emit_reference(ExtractedReference {
        owner: owner_for_node(builder, node),
        name: name.to_owned(),
        resolution_name,
        kind,
        span: span_for(node)?,
    })
}

fn owner_for_node(builder: &ExtractionBuilder<'_, '_>, node: Node<'_>) -> Option<SymbolId> {
    let start = u64::try_from(node.start_byte()).ok()?;
    let end = u64::try_from(node.end_byte()).ok()?;
    builder
        .facts
        .symbols
        .iter()
        .filter(|symbol| {
            symbol.span.start_byte() <= start
                && end <= symbol.span.end_byte()
                && !matches!(symbol.kind, SymbolKind::File | SymbolKind::Import)
        })
        .min_by_key(|symbol| symbol.span.end_byte() - symbol.span.start_byte())
        .map(|symbol| symbol.id.clone())
}

fn enrich_pydantic(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    let mut budget = ScanBudget::default();
    scan_pydantic_models(builder, root, 0, &mut budget)
}

fn scan_pydantic_models(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    budget: &mut ScanBudget,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    if node.kind() == "class_definition" && is_pydantic_model(node, builder.context.source()) {
        budget.admit_candidate()?;
        emit_pydantic_model(builder, node)?;
    }
    for child in super::syntax::named_children(node) {
        scan_pydantic_models(builder, child, depth.saturating_add(1), budget)?;
    }
    Ok(())
}

fn is_pydantic_model(class_definition: Node<'_>, source: &str) -> bool {
    let Some(superclasses) = class_definition.child_by_field_name("superclasses") else {
        return false;
    };
    descendants(superclasses, 0).any(|node| {
        matches!(node.kind(), "identifier" | "attribute")
            && matches!(
                source
                    .get(node.start_byte()..node.end_byte())
                    .unwrap_or_default()
                    .rsplit('.')
                    .next(),
                Some("BaseModel" | "BaseSettings")
            )
    })
}

fn emit_pydantic_model(
    builder: &mut ExtractionBuilder<'_, '_>,
    class_definition: Node<'_>,
) -> Result<(), ExtractError> {
    let Some(name_node) = class_definition.child_by_field_name("name") else {
        return Ok(());
    };
    let Some(body) = class_definition.child_by_field_name("body") else {
        return Ok(());
    };
    let name = builder.context.owned_text(name_node)?;
    if !safe_schema_name(&name, false) {
        return Ok(());
    }
    let struct_id = emit_schema_symbol(
        builder,
        SymbolKind::Struct,
        &name,
        class_definition,
        class_definition,
        Some("pydantic.BaseModel"),
    )?;
    with_scope(
        builder,
        &struct_id,
        SymbolKind::Struct,
        Some(&name),
        |builder| {
            let mut fields = BTreeSet::new();
            for statement in super::syntax::named_children(body) {
                if fields.len() >= MAX_FIELDS_PER_SCHEMA {
                    return Err(ExtractError::OutputLimit);
                }
                let Some(assignment) = python_assignment(statement) else {
                    continue;
                };
                let Some(left) = assignment.child_by_field_name("left") else {
                    continue;
                };
                let Some(annotation) = assignment.child_by_field_name("type") else {
                    continue;
                };
                if left.kind() != "identifier" || is_class_var(annotation, builder.context.source())
                {
                    continue;
                }
                let field_name = builder.context.owned_text(left)?;
                if !safe_schema_name(&field_name, false) || !fields.insert(field_name.clone()) {
                    continue;
                }
                let signature = safe_type_signature(builder, annotation)?;
                let field_id = emit_schema_symbol(
                    builder,
                    SymbolKind::Field,
                    &field_name,
                    statement,
                    assignment,
                    signature.as_deref(),
                )?;
                emit_pydantic_literals(builder, annotation, &field_id, &field_name)?;
            }
            Ok(())
        },
    )
}

fn python_assignment(statement: Node<'_>) -> Option<Node<'_>> {
    if statement.kind() == "assignment" {
        return Some(statement);
    }
    if statement.kind() != "expression_statement" {
        return None;
    }
    super::syntax::named_children(statement).find(|child| child.kind() == "assignment")
}

fn is_class_var(annotation: Node<'_>, source: &str) -> bool {
    let raw = source
        .get(annotation.start_byte()..annotation.end_byte())
        .unwrap_or_default()
        .trim();
    raw.starts_with("ClassVar[") || raw.starts_with("typing.ClassVar[")
}

fn safe_type_signature(
    builder: &mut ExtractionBuilder<'_, '_>,
    annotation: Node<'_>,
) -> Result<Option<String>, ExtractError> {
    let raw = builder.context.owned_text(annotation)?;
    if declaration_value_is_search_safe(&raw)
        && !raw.bytes().any(|byte| matches!(byte, b'\'' | b'"'))
    {
        return Ok(Some(raw));
    }
    let head = raw
        .split(['[', '<', '(', ' ', '\t', '\r', '\n'])
        .next()
        .unwrap_or_default();
    if !safe_schema_name(head.rsplit('.').next().unwrap_or_default(), false) {
        return Ok(None);
    }
    Ok(Some(format!("{head}[...]")))
}

fn emit_pydantic_literals(
    builder: &mut ExtractionBuilder<'_, '_>,
    annotation: Node<'_>,
    field_id: &SymbolId,
    field_name: &str,
) -> Result<(), ExtractError> {
    let Some(literal) = descendants(annotation, 0).find(|node| {
        if node.kind() != "generic_type" {
            return false;
        }
        super::syntax::named_children(*node)
            .next()
            .is_some_and(|head| {
                builder
                    .context
                    .text(head)
                    .rsplit('.')
                    .next()
                    .is_some_and(|name| name == "Literal")
            })
    }) else {
        return Ok(());
    };
    let mut members = BTreeSet::new();
    with_scope(
        builder,
        field_id,
        SymbolKind::Field,
        Some(field_name),
        |builder| {
            for node in descendants(literal, 0) {
                if !matches!(node.kind(), "string" | "string_content") {
                    continue;
                }
                if node.kind() == "string" && super::syntax::named_children(node).next().is_some() {
                    continue;
                }
                if members.len() >= MAX_ENUM_MEMBERS_PER_FIELD {
                    return Err(ExtractError::OutputLimit);
                }
                let member = builder.context.owned_unquoted_text(node)?;
                if !safe_schema_name(&member, true) || !members.insert(member.clone()) {
                    continue;
                }
                emit_schema_symbol(builder, SymbolKind::EnumMember, &member, node, node, None)?;
            }
            Ok(())
        },
    )
}

fn emit_schema_symbol(
    builder: &mut ExtractionBuilder<'_, '_>,
    kind: SymbolKind,
    name: &str,
    span_node: Node<'_>,
    structural_node: Node<'_>,
    signature: Option<&str>,
) -> Result<SymbolId, ExtractError> {
    builder.emit_symbol(PendingSymbol {
        kind,
        name: name.to_owned(),
        span_node,
        structural_node,
        doc_anchor: span_node,
        body_node: None,
        declaration_only: false,
        signature: signature.map(str::to_owned),
        exported: false,
        default_export: false,
        async_symbol: false,
        static_member: false,
        visibility: None,
    })
}

fn with_scope<T>(
    builder: &mut ExtractionBuilder<'_, '_>,
    owner: &SymbolId,
    kind: SymbolKind,
    qualifier: Option<&str>,
    operation: impl FnOnce(&mut ExtractionBuilder<'_, '_>) -> Result<T, ExtractError>,
) -> Result<T, ExtractError> {
    builder.owners.push(owner.clone());
    builder.native_owner_kinds.push(kind);
    if let Some(qualifier) = qualifier {
        builder.qualifiers.push(qualifier.to_owned());
    }
    let result = operation(builder);
    if qualifier.is_some() {
        builder.qualifiers.pop();
    }
    builder.native_owner_kinds.pop();
    builder.owners.pop();
    result
}

fn find_zod_call<'tree>(value: Node<'tree>, method: &str, source: &str) -> Option<Node<'tree>> {
    let mut current = Some(value);
    for _ in 0..64 {
        let node = current?;
        match node.kind() {
            "call_expression" => {
                let function = node.child_by_field_name("function")?;
                if function.kind() == "member_expression" {
                    if direct_zod_member(function, method, source) {
                        return Some(node);
                    }
                    current = function.child_by_field_name("object");
                } else {
                    current = Some(function);
                }
            }
            "member_expression" => current = node.child_by_field_name("object"),
            _ => return None,
        }
    }
    None
}

fn direct_zod_method(call: Node<'_>, method: &str, source: &str) -> bool {
    call.child_by_field_name("function")
        .is_some_and(|function| direct_zod_member(function, method, source))
}

fn direct_zod_member(member: Node<'_>, method: &str, source: &str) -> bool {
    if member.kind() != "member_expression" {
        return false;
    }
    let Some(object) = member.child_by_field_name("object") else {
        return false;
    };
    let Some(property) = member.child_by_field_name("property") else {
        return false;
    };
    object.kind() == "identifier"
        && source
            .get(object.start_byte()..object.end_byte())
            .is_some_and(|name| name == "z")
        && source
            .get(property.start_byte()..property.end_byte())
            .is_some_and(|name| name == method)
}

fn first_named_argument(call: Node<'_>) -> Option<Node<'_>> {
    let arguments = call.child_by_field_name("arguments")?;
    super::syntax::named_children(arguments).next()
}

fn zod_leaf_type(value: Node<'_>, source: &str) -> Option<String> {
    let mut current = Some(value);
    for _ in 0..64 {
        let node = current?;
        if node.kind() == "call_expression" {
            let function = node.child_by_field_name("function")?;
            if function.kind() == "member_expression" {
                let object = function.child_by_field_name("object")?;
                let property = function.child_by_field_name("property")?;
                if object.kind() == "identifier"
                    && source
                        .get(object.start_byte()..object.end_byte())
                        .is_some_and(|name| name == "z")
                {
                    let method = source.get(property.start_byte()..property.end_byte())?;
                    if method
                        .bytes()
                        .all(|byte| byte == b'_' || byte.is_ascii_alphanumeric())
                    {
                        return Some(method.to_owned());
                    }
                    return None;
                }
                current = Some(object);
                continue;
            }
            current = Some(function);
            continue;
        }
        if node.kind() == "member_expression" {
            current = node.child_by_field_name("object");
            continue;
        }
        return None;
    }
    None
}

fn typeof_identifier<'tree>(node: Node<'tree>, source: &str) -> Option<Node<'tree>> {
    for candidate in descendants(node, 0) {
        if candidate.kind() != "type_query" {
            continue;
        }
        if let Some(identifier) =
            descendants(candidate, 0).find(|child| child.kind() == "identifier")
            && source
                .get(identifier.start_byte()..identifier.end_byte())
                .is_some_and(|name| safe_schema_name(name, false))
        {
            return Some(identifier);
        }
    }
    None
}

fn zod_shape_reference<'tree>(
    member: Node<'tree>,
    source: &str,
) -> Option<(Node<'tree>, Node<'tree>)> {
    let field = member.child_by_field_name("property")?;
    let shape = member.child_by_field_name("object")?;
    if shape.kind() != "member_expression" {
        return None;
    }
    let shape_property = shape.child_by_field_name("property")?;
    let schema = shape.child_by_field_name("object")?;
    if schema.kind() != "identifier"
        || source
            .get(shape_property.start_byte()..shape_property.end_byte())
            .is_none_or(|name| name != "shape")
    {
        return None;
    }
    Some((schema, field))
}

fn safe_schema_name(value: &str, literal: bool) -> bool {
    if value.is_empty()
        || value.len() > MAX_SCHEMA_NAME_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.' | b'$'))
    {
        return false;
    }
    if !literal {
        return true;
    }
    let lower = value.to_ascii_lowercase();
    declaration_value_is_search_safe(value)
        && ![
            "sk_live_",
            "sk_test_",
            "ghp_",
            "github_pat_",
            "xoxb_",
            "xoxp_",
            "akia",
            "asia",
        ]
        .into_iter()
        .any(|prefix| lower.starts_with(prefix))
}

struct Descendants<'tree> {
    cursor: tree_sitter::TreeCursor<'tree>,
    started: bool,
    depth: usize,
    done: bool,
}

impl<'tree> Descendants<'tree> {
    fn new(root: Node<'tree>, depth: usize) -> Self {
        Self {
            cursor: root.walk(),
            started: false,
            depth,
            done: false,
        }
    }
}

impl<'tree> Iterator for Descendants<'tree> {
    type Item = Node<'tree>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        if !self.started {
            self.started = true;
            return Some(self.cursor.node());
        }
        loop {
            if self.depth < MAX_SCHEMA_AST_DEPTH && self.cursor.goto_first_child() {
                self.depth = self.depth.saturating_add(1);
                if self.cursor.node().is_named() {
                    return Some(self.cursor.node());
                }
                continue;
            }
            loop {
                if self.cursor.goto_next_sibling() {
                    if self.cursor.node().is_named() {
                        return Some(self.cursor.node());
                    }
                    break;
                }
                if self.depth == 0 || !self.cursor.goto_parent() {
                    self.done = true;
                    return None;
                }
                self.depth = self.depth.saturating_sub(1);
            }
        }
    }
}

fn descendants(root: Node<'_>, depth: usize) -> Descendants<'_> {
    Descendants::new(root, depth)
}
