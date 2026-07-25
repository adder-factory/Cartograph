use std::collections::BTreeSet;

use cartograph_domain::{ReferenceKind, SourceLanguage};
use tree_sitter::Node;

use crate::{
    DYNAMIC_DISPATCH_RESOLUTION_PREFIX, ExtractError, ExtractedReference,
    walk::{ExtractionBuilder, syntax::span_for},
};

const MAX_AST_DEPTH: usize = 256;
const MAX_VISITS: usize = 500_000;
const MAX_TABLES: usize = 512;
const MAX_DISPATCH_FANOUT: usize = 10;
const MAX_TOTAL_TARGETS: usize = MAX_TABLES * MAX_DISPATCH_FANOUT;
const MAX_IDENTIFIER_BYTES: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum DispatchKind {
    Object,
    Map,
}

struct DispatchTarget<'tree> {
    name: String,
    node: Node<'tree>,
}

struct DispatchTable<'tree> {
    name: String,
    kind: DispatchKind,
    targets: Vec<DispatchTarget<'tree>>,
}

#[derive(Default)]
struct DispatchBudget {
    visits: usize,
    targets: usize,
}

impl DispatchBudget {
    fn observe(
        &mut self,
        builder: &mut ExtractionBuilder<'_, '_>,
        depth: usize,
    ) -> Result<(), ExtractError> {
        if depth > MAX_AST_DEPTH {
            return Err(ExtractError::NestingLimit);
        }
        self.visits = self
            .visits
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.visits > MAX_VISITS {
            return Err(ExtractError::OutputLimit);
        }
        if self.visits.is_multiple_of(256) {
            builder.context.ensure_active()?;
        }
        Ok(())
    }

    fn admit_target(&mut self) -> Result<(), ExtractError> {
        self.targets = self
            .targets
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.targets > MAX_TOTAL_TARGETS {
            return Err(ExtractError::OutputLimit);
        }
        Ok(())
    }
}

pub(super) fn enrich(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    if !matches!(
        builder.context.snapshot.language(),
        SourceLanguage::TypeScript
            | SourceLanguage::Tsx
            | SourceLanguage::JavaScript
            | SourceLanguage::Jsx
    ) {
        return Ok(());
    }
    let mut budget = DispatchBudget::default();
    let mut tables = Vec::new();
    tables
        .try_reserve(16)
        .map_err(|_| ExtractError::OutputLimit)?;
    collect_tables(builder, root, 0, &mut budget, &mut tables)?;
    if tables.is_empty() {
        return Ok(());
    }
    let mut used = BTreeSet::new();
    collect_dispatch_calls(builder, root, 0, &mut budget, &tables, &mut used)?;
    for table in tables {
        if !used.contains(table.name.as_str())
            || table.targets.is_empty()
            || table.targets.len() > MAX_DISPATCH_FANOUT
        {
            continue;
        }
        for target in table.targets {
            let mut resolution_name = String::new();
            resolution_name
                .try_reserve(
                    DYNAMIC_DISPATCH_RESOLUTION_PREFIX
                        .len()
                        .checked_add(target.name.len())
                        .ok_or(ExtractError::OutputLimit)?,
                )
                .map_err(|_| ExtractError::OutputLimit)?;
            resolution_name.push_str(DYNAMIC_DISPATCH_RESOLUTION_PREFIX);
            resolution_name.push_str(&target.name);
            builder.emit_reference(ExtractedReference {
                owner: None,
                name: target.name,
                resolution_name: Some(resolution_name),
                kind: ReferenceKind::Calls,
                span: span_for(target.node)?,
            })?;
        }
    }
    Ok(())
}

fn collect_tables<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'tree>,
    depth: usize,
    budget: &mut DispatchBudget,
    tables: &mut Vec<DispatchTable<'tree>>,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    if node.kind() == "variable_declarator" && tables.len() < MAX_TABLES {
        if let Some(table) = dispatch_table(builder, node, budget)? {
            tables
                .try_reserve(1)
                .map_err(|_| ExtractError::OutputLimit)?;
            tables.push(table);
        }
    } else if node.kind() == "variable_declarator" {
        return Err(ExtractError::OutputLimit);
    }
    for child in super::syntax::named_children(node) {
        collect_tables(builder, child, depth.saturating_add(1), budget, tables)?;
    }
    Ok(())
}

fn dispatch_table<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    declaration: Node<'tree>,
    budget: &mut DispatchBudget,
) -> Result<Option<DispatchTable<'tree>>, ExtractError> {
    let Some(name_node) = declaration.child_by_field_name("name") else {
        return Ok(None);
    };
    let Some(value) = declaration.child_by_field_name("value") else {
        return Ok(None);
    };
    if name_node.kind() != "identifier" {
        return Ok(None);
    }
    let name = builder.context.owned_text(name_node)?;
    if !safe_identifier(&name) {
        return Ok(None);
    }
    if value.kind() == "object" {
        return collect_object_table(builder, value, name, budget).map(Some);
    }
    if value.kind() == "new_expression"
        && value
            .child_by_field_name("constructor")
            .is_some_and(|constructor| builder.context.text(constructor) == "Map")
    {
        return collect_map_table(builder, value, name, budget);
    }
    Ok(None)
}

fn collect_object_table<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    object: Node<'tree>,
    name: String,
    budget: &mut DispatchBudget,
) -> Result<DispatchTable<'tree>, ExtractError> {
    let mut targets = Vec::new();
    targets
        .try_reserve(MAX_DISPATCH_FANOUT.saturating_add(1))
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut seen = BTreeSet::new();
    for entry in super::syntax::named_children(object) {
        let candidate = if entry.kind() == "pair" {
            entry.child_by_field_name("value")
        } else if entry.kind().contains("identifier")
            && super::syntax::named_children(entry).next().is_none()
        {
            Some(entry)
        } else {
            None
        };
        let Some(candidate) = candidate.filter(|candidate| {
            candidate.kind() == "identifier"
                || candidate
                    .kind()
                    .starts_with("shorthand_property_identifier")
        }) else {
            continue;
        };
        let target = builder.context.owned_text(candidate)?;
        if !safe_identifier(&target) || !seen.insert(target.clone()) {
            continue;
        }
        budget.admit_target()?;
        targets.push(DispatchTarget {
            name: target,
            node: candidate,
        });
    }
    Ok(DispatchTable {
        name,
        kind: DispatchKind::Object,
        targets,
    })
}

fn collect_map_table<'tree>(
    builder: &mut ExtractionBuilder<'_, '_>,
    expression: Node<'tree>,
    name: String,
    budget: &mut DispatchBudget,
) -> Result<Option<DispatchTable<'tree>>, ExtractError> {
    let Some(arguments) = expression.child_by_field_name("arguments") else {
        return Ok(None);
    };
    let Some(array) = super::syntax::named_children(arguments)
        .next()
        .filter(|argument| argument.kind() == "array")
    else {
        return Ok(None);
    };
    let mut targets = Vec::new();
    targets
        .try_reserve(MAX_DISPATCH_FANOUT.saturating_add(1))
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut seen = BTreeSet::new();
    for tuple in super::syntax::named_children(array).filter(|entry| entry.kind() == "array") {
        let Some(candidate) = super::syntax::named_children(tuple).nth(1) else {
            continue;
        };
        if candidate.kind() != "identifier" {
            continue;
        }
        let target = builder.context.owned_text(candidate)?;
        if !safe_identifier(&target) || !seen.insert(target.clone()) {
            continue;
        }
        budget.admit_target()?;
        targets.push(DispatchTarget {
            name: target,
            node: candidate,
        });
    }
    Ok(Some(DispatchTable {
        name,
        kind: DispatchKind::Map,
        targets,
    }))
}

fn collect_dispatch_calls(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    budget: &mut DispatchBudget,
    tables: &[DispatchTable<'_>],
    used: &mut BTreeSet<String>,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    if node.kind() == "call_expression" {
        let raw = builder.context.text(node);
        for table in tables {
            if dispatch_call_uses(raw, table) {
                used.insert(table.name.clone());
            }
        }
    }
    for child in super::syntax::named_children(node) {
        collect_dispatch_calls(
            builder,
            child,
            depth.saturating_add(1),
            budget,
            tables,
            used,
        )?;
    }
    Ok(())
}

fn dispatch_call_uses(raw: &str, table: &DispatchTable<'_>) -> bool {
    let raw = raw.trim();
    let Some(suffix) = raw.strip_prefix(&table.name) else {
        return false;
    };
    if table.kind == DispatchKind::Object
        && let Some(suffix) = suffix.strip_prefix('[')
    {
        return matching_delimiter(suffix, b']')
            .and_then(|end| suffix.get(end.saturating_add(1)..))
            .is_some_and(invocation_suffix);
    }
    if table.kind != DispatchKind::Map {
        return false;
    }
    let Some(suffix) = suffix.strip_prefix(".get(") else {
        return false;
    };
    matching_delimiter(suffix, b')')
        .and_then(|end| suffix.get(end.saturating_add(1)..))
        .is_some_and(invocation_suffix)
}

fn invocation_suffix(value: &str) -> bool {
    let value = value.trim_start();
    value.starts_with('(') || value.starts_with("?.(")
}

fn matching_delimiter(value: &str, close: u8) -> Option<usize> {
    let open = match close {
        b']' => b'[',
        b')' => b'(',
        _ => return None,
    };
    let bytes = value.as_bytes();
    let mut depth = 1_usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, byte) in bytes.iter().copied().enumerate() {
        if let Some(active) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active {
                quote = None;
            }
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
        } else if byte == open {
            depth = depth.saturating_add(1);
        } else if byte == close {
            depth = depth.saturating_sub(1);
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn safe_identifier(value: &str) -> bool {
    value.len() <= MAX_IDENTIFIER_BYTES
        && value
            .as_bytes()
            .first()
            .is_some_and(|first| *first == b'_' || *first == b'$' || first.is_ascii_alphabetic())
        && value
            .bytes()
            .all(|byte| matches!(byte, b'_' | b'$') || byte.is_ascii_alphanumeric())
}
