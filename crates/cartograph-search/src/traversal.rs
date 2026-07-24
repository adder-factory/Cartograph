use std::collections::{BTreeMap, BTreeSet};

use cartograph_db::CurrentGraphEdge;
use cartograph_domain::SymbolId;

use crate::{AffectedTest, TraversalDirection, TraversalResult};

const TEST_SEGMENTS: [&str; 3] = ["test", "tests", "__tests__"];
const TEST_INFIXES: [&str; 4] = [".test.", ".spec.", "_test.", "_spec."];

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct GraphArc {
    pub(crate) source: SymbolId,
    pub(crate) target: SymbolId,
    pub(crate) edge_kind: String,
    pub(crate) confidence: f32,
    pub(crate) provenance: String,
}

impl GraphArc {
    pub(crate) fn from_record(edge: &CurrentGraphEdge) -> Self {
        Self {
            source: edge.source_symbol_id().clone(),
            target: edge.target_symbol_id().clone(),
            edge_kind: edge.edge_kind().to_owned(),
            confidence: edge.confidence(),
            provenance: edge.provenance().to_owned(),
        }
    }

    #[cfg(test)]
    pub(crate) fn fixture(
        source: SymbolId,
        target: SymbolId,
        edge_kind: &str,
        confidence: f32,
    ) -> Self {
        Self {
            source,
            target,
            edge_kind: edge_kind.to_owned(),
            confidence,
            provenance: "fixture".to_owned(),
        }
    }

    pub(crate) fn adjacent(&self, direction: TraversalDirection) -> &SymbolId {
        match direction {
            TraversalDirection::Outgoing => &self.target,
            TraversalDirection::Incoming => &self.source,
        }
    }

    pub(crate) fn origin(&self, direction: TraversalDirection) -> &SymbolId {
        match direction {
            TraversalDirection::Outgoing => &self.source,
            TraversalDirection::Incoming => &self.target,
        }
    }
}

pub(crate) struct FrontierExpansion {
    pub(crate) next: Vec<SymbolId>,
    pub(crate) arcs: Vec<GraphArc>,
    pub(crate) truncated: bool,
}

pub(crate) fn expand_frontier(
    frontier: &[SymbolId],
    arcs: &[GraphArc],
    direction: TraversalDirection,
    max_new_nodes: usize,
) -> FrontierExpansion {
    let frontier = frontier.iter().collect::<BTreeSet<_>>();
    let mut ordered_arcs = arcs
        .iter()
        .filter(|arc| frontier.contains(arc.origin(direction)))
        .cloned()
        .collect::<Vec<_>>();
    ordered_arcs.sort_by(|left, right| {
        left.source
            .cmp(&right.source)
            .then_with(|| left.target.cmp(&right.target))
            .then_with(|| left.edge_kind.cmp(&right.edge_kind))
            .then_with(|| left.provenance.cmp(&right.provenance))
    });
    let all_next = ordered_arcs
        .iter()
        .map(|arc| arc.adjacent(direction).clone())
        .collect::<BTreeSet<_>>();
    let truncated = all_next.len() > max_new_nodes;
    let next = all_next.into_iter().take(max_new_nodes).collect();
    FrontierExpansion {
        next,
        arcs: ordered_arcs,
        truncated,
    }
}

/// Return whether a canonical path uses a conventional test directory or filename.
#[must_use]
pub fn is_test_path(path: &str) -> bool {
    let normalized = path.replace('\\', "/").to_ascii_lowercase();
    let mut components = normalized.split('/').collect::<Vec<_>>();
    let filename = components.pop().unwrap_or_default();
    components
        .iter()
        .any(|component| TEST_SEGMENTS.contains(component))
        || filename.starts_with("test_")
        || TEST_INFIXES.iter().any(|infix| filename.contains(infix))
}

pub(crate) fn affected_tests_from_traversal(
    traversal: &TraversalResult,
    limit: u16,
) -> (Vec<AffectedTest>, bool) {
    let mut by_file = BTreeMap::new();
    for node in traversal.nodes() {
        let edge_is_test = node.via().edge_kind() == "tests";
        if !edge_is_test && !is_test_path(node.symbol().path().as_str()) {
            continue;
        }
        let reason = if edge_is_test {
            "tests-edge"
        } else {
            "test-path"
        };
        by_file
            .entry(node.symbol().file_id().clone())
            .or_insert_with(|| {
                AffectedTest::new(node.symbol().clone(), node.depth(), reason.to_owned())
            });
    }
    let mut tests = by_file.into_values().collect::<Vec<_>>();
    tests.sort_by(|left, right| {
        left.distance()
            .cmp(&right.distance())
            .then_with(|| {
                left.symbol()
                    .path()
                    .as_str()
                    .cmp(right.symbol().path().as_str())
            })
            .then_with(|| left.symbol().start_line().cmp(&right.symbol().start_line()))
            .then_with(|| {
                left.symbol()
                    .qualified_name()
                    .cmp(right.symbol().qualified_name())
            })
            .then_with(|| left.symbol().symbol_id().cmp(right.symbol().symbol_id()))
    });
    let truncated = tests.len() > usize::from(limit);
    tests.truncate(usize::from(limit));
    (tests, truncated)
}
