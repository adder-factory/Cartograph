use std::collections::{BTreeMap, BTreeSet};

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId, SymbolKind};
use tree_sitter::Node;

use crate::{
    ExtractError, ExtractedReference,
    walk::{
        AstVisitBudget, ExtractionBuilder, SingleChildUnwrap, owner_for_node,
        syntax::{named_children, span_for},
    },
};

const MAX_AST_DEPTH: usize = 256;
const MAX_VALUE_REFERENCES: usize = 8_192;
const VALUE_IDENTIFIER_UNWRAP: SingleChildUnwrap = SingleChildUnwrap::new(
    value_identifier,
    &[
        "jsx_expression",
        "expression",
        "parenthesized_expression",
        "type_assertion",
    ],
);

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
    visits: AstVisitBudget<MAX_AST_DEPTH>,
    references: usize,
    emitted: BTreeSet<(Option<SymbolId>, SymbolId, usize, usize)>,
}

impl ScanBudget {
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
    ValueScanner {
        builder,
        targets: &targets,
        budget: ScanBudget::default(),
    }
    .scan(root, 0)
}

struct ValueScanner<'builder, 'source, 'cancel, 'targets> {
    builder: &'builder mut ExtractionBuilder<'source, 'cancel>,
    targets: &'targets UniqueTargets,
    budget: ScanBudget,
}

impl ValueScanner<'_, '_, '_, '_> {
    fn scan(&mut self, node: Node<'_>, depth: usize) -> Result<(), ExtractError> {
        self.budget.visits.observe(self.builder, depth)?;
        match node.kind() {
            "arguments" | "array" => {
                for candidate in named_children(node) {
                    self.emit_identifier(candidate)?;
                }
            }
            "pair" => {
                if let Some(value) = node.child_by_field_name("value") {
                    self.emit_identifier(value)?;
                }
            }
            "shorthand_property_identifier" => {
                self.emit_identifier(node)?;
            }
            "jsx_attribute" => {
                if let Some(value) = node
                    .child_by_field_name("value")
                    .or_else(|| named_children(node).find(|child| child.kind() == "jsx_expression"))
                    && let Some(identifier) =
                        super::unwrap_single_child(value, 0, VALUE_IDENTIFIER_UNWRAP)
                {
                    self.emit_identifier(identifier)?;
                }
            }
            "call_expression" => self.emit_ternary_callee_arms(node)?,
            _ => {}
        }
        for child in named_children(node) {
            self.scan(child, depth.saturating_add(1))?;
        }
        Ok(())
    }

    fn emit_ternary_callee_arms(&mut self, call: Node<'_>) -> Result<(), ExtractError> {
        let Some(function) = call.child_by_field_name("function") else {
            return Ok(());
        };
        let Some(ternary) = unwrap_to_ternary(function, 0) else {
            return Ok(());
        };
        for field in ["consequence", "alternative"] {
            if let Some(arm) = ternary.child_by_field_name(field)
                && let Some(identifier) =
                    super::unwrap_single_child(arm, 0, VALUE_IDENTIFIER_UNWRAP)
            {
                self.emit_identifier(identifier)?;
            }
        }
        Ok(())
    }

    fn emit_identifier(&mut self, node: Node<'_>) -> Result<(), ExtractError> {
        if !value_identifier(node) {
            return Ok(());
        }
        let name = self.builder.context.owned_text(node)?;
        let Some(target) = self.targets.unique(&name) else {
            return Ok(());
        };
        let owner = owner_for_node(self.builder, node);
        if owner.as_ref() == Some(target) || !self.budget.admit(owner.as_ref(), target, node)? {
            return Ok(());
        }
        self.builder.emit_reference(ExtractedReference {
            owner,
            name,
            resolution_name: None,
            kind: ReferenceKind::References,
            span: span_for(node)?,
        })
    }
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

fn value_identifier(node: Node<'_>) -> bool {
    matches!(
        node.kind(),
        "identifier" | "shorthand_property_identifier" | "shorthand_property_identifier_pattern"
    )
}
