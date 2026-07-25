use std::collections::{BTreeMap, BTreeSet};

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId, SymbolKind};
use tree_sitter::Node;

use crate::{
    ExtractError, ExtractedReference,
    walk::{
        ExtractionBuilder,
        syntax::{named_children, span_for},
    },
};

const MAX_AST_DEPTH: usize = 256;
const MAX_AST_VISITS: usize = 500_000;
const MAX_VALUE_REFERENCES: usize = 8_192;

struct UniqueTargets {
    by_name: BTreeMap<String, Option<SymbolId>>,
}

impl UniqueTargets {
    fn from_builder(builder: &ExtractionBuilder<'_, '_>) -> Result<Self, ExtractError> {
        let mut by_name = BTreeMap::new();
        for symbol in &builder.facts.symbols {
            if matches!(symbol.kind, SymbolKind::File | SymbolKind::Import) {
                continue;
            }
            if let Some(existing) = by_name.get_mut(&symbol.name) {
                *existing = None;
            } else {
                let mut name = String::new();
                name.try_reserve(symbol.name.len())
                    .map_err(|_| ExtractError::OutputLimit)?;
                name.push_str(&symbol.name);
                by_name.insert(name, Some(symbol.id.clone()));
            }
        }
        Ok(Self { by_name })
    }

    fn unique(&self, name: &str) -> Option<&SymbolId> {
        self.by_name.get(name)?.as_ref()
    }
}

#[derive(Default)]
struct ScanBudget {
    visits: usize,
    references: usize,
    emitted: BTreeSet<(Option<SymbolId>, SymbolId, usize, usize)>,
}

impl ScanBudget {
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
        if self.visits > MAX_AST_VISITS {
            return Err(ExtractError::OutputLimit);
        }
        if self.visits.is_multiple_of(256) {
            builder.context.ensure_active()?;
        }
        Ok(())
    }

    fn admit(
        &mut self,
        owner: Option<&SymbolId>,
        target: &SymbolId,
        node: Node<'_>,
    ) -> Result<bool, ExtractError> {
        let key = (
            owner.cloned(),
            target.clone(),
            node.start_byte(),
            node.end_byte(),
        );
        if !self.emitted.insert(key) {
            return Ok(false);
        }
        self.references = self
            .references
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.references > MAX_VALUE_REFERENCES {
            Err(ExtractError::OutputLimit)
        } else {
            Ok(true)
        }
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
    let targets = UniqueTargets::from_builder(builder)?;
    if targets.by_name.is_empty() {
        return Ok(());
    }
    let mut budget = ScanBudget::default();
    scan(builder, root, 0, &targets, &mut budget)
}

fn scan(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    targets: &UniqueTargets,
    budget: &mut ScanBudget,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    match node.kind() {
        "arguments" | "array" => {
            for candidate in named_children(node) {
                emit_identifier(builder, candidate, targets, budget)?;
            }
        }
        "pair" => {
            if let Some(value) = node.child_by_field_name("value") {
                emit_identifier(builder, value, targets, budget)?;
            }
        }
        "shorthand_property_identifier" => {
            emit_identifier(builder, node, targets, budget)?;
        }
        "jsx_attribute" => {
            if let Some(value) = node
                .child_by_field_name("value")
                .or_else(|| named_children(node).find(|child| child.kind() == "jsx_expression"))
                && let Some(identifier) = unwrap_single_identifier(value, 0)
            {
                emit_identifier(builder, identifier, targets, budget)?;
            }
        }
        "call_expression" => emit_ternary_callee_arms(builder, node, targets, budget)?,
        _ => {}
    }
    for child in named_children(node) {
        scan(builder, child, depth.saturating_add(1), targets, budget)?;
    }
    Ok(())
}

fn emit_ternary_callee_arms(
    builder: &mut ExtractionBuilder<'_, '_>,
    call: Node<'_>,
    targets: &UniqueTargets,
    budget: &mut ScanBudget,
) -> Result<(), ExtractError> {
    let Some(function) = call.child_by_field_name("function") else {
        return Ok(());
    };
    let Some(ternary) = unwrap_to_ternary(function, 0) else {
        return Ok(());
    };
    for field in ["consequence", "alternative"] {
        if let Some(arm) = ternary.child_by_field_name(field)
            && let Some(identifier) = unwrap_single_identifier(arm, 0)
        {
            emit_identifier(builder, identifier, targets, budget)?;
        }
    }
    Ok(())
}

fn unwrap_to_ternary(node: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > 8 {
        return None;
    }
    if matches!(node.kind(), "ternary_expression" | "conditional_expression") {
        return Some(node);
    }
    if matches!(node.kind(), "parenthesized_expression" | "expression") {
        let mut children = named_children(node);
        let child = children.next()?;
        if children.next().is_none() {
            return unwrap_to_ternary(child, depth.saturating_add(1));
        }
    }
    None
}

fn unwrap_single_identifier(node: Node<'_>, depth: usize) -> Option<Node<'_>> {
    if depth > 8 {
        return None;
    }
    if value_identifier(node) {
        return Some(node);
    }
    if matches!(
        node.kind(),
        "jsx_expression" | "expression" | "parenthesized_expression" | "type_assertion"
    ) {
        let mut children = named_children(node);
        let child = children.next()?;
        if children.next().is_none() {
            return unwrap_single_identifier(child, depth.saturating_add(1));
        }
    }
    None
}

fn emit_identifier(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    targets: &UniqueTargets,
    budget: &mut ScanBudget,
) -> Result<(), ExtractError> {
    if !value_identifier(node) {
        return Ok(());
    }
    let name = builder.context.owned_text(node)?;
    let Some(target) = targets.unique(&name) else {
        return Ok(());
    };
    let owner = owner_for_node(builder, node);
    if owner.as_ref() == Some(target) || !budget.admit(owner.as_ref(), target, node)? {
        return Ok(());
    }
    builder.emit_reference(ExtractedReference {
        owner,
        name,
        resolution_name: None,
        kind: ReferenceKind::References,
        span: span_for(node)?,
    })
}

fn value_identifier(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "identifier" | "shorthand_property_identifier" | "shorthand_property_identifier_pattern"
    )
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
        .min_by_key(|symbol| {
            symbol
                .span
                .end_byte()
                .saturating_sub(symbol.span.start_byte())
        })
        .map(|symbol| symbol.id.clone())
}
