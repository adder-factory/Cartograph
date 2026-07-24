//! Deterministic, non-LLM retrieval over Cartograph's published PostgreSQL graph.

mod engine;
mod model;
mod packet;
mod traversal;

pub use engine::DeterministicRetriever;
pub use model::{
    AffectedTest, AffectedTestsResult, ContextAbstention, ContextAnchor, ContextBudget,
    ContextPacket, ContextRequest, EvidenceItem, EvidenceReason, ExactPathResult,
    GenerationEvidence, IndexFreshness, RetrievalConfidence, RetrievalError, TraversalBudget,
    TraversalDirection, TraversalHop, TraversalNode, TraversalRequest, TraversalResult,
};
pub use traversal::is_test_path;

#[cfg(test)]
use packet::{PacketAssembly, assemble_packet};
#[cfg(test)]
use traversal::{GraphArc, expand_frontier};

#[cfg(test)]
fn fixture_generation() -> GenerationEvidence {
    let generation_id =
        match cartograph_domain::GenerationId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
            Ok(value) => value,
            Err(error) => panic!("fixture generation id is invalid: {error}"),
        };
    GenerationEvidence::new(generation_id, 1)
}

#[cfg(test)]
mod contract_tests {
    use cartograph_domain::{ProjectId, SymbolId};

    use super::*;

    fn project_id() -> ProjectId {
        match ProjectId::parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa") {
            Ok(value) => value,
            Err(error) => panic!("fixture project id is invalid: {error}"),
        }
    }

    fn symbol_id(value: &str) -> SymbolId {
        match SymbolId::parse(value) {
            Ok(value) => value,
            Err(error) => panic!("fixture symbol id is invalid: {error}"),
        }
    }

    #[test]
    fn traversal_budget_rejects_unbounded_work() {
        assert!(TraversalBudget::new(0, 10).is_err());
        assert!(TraversalBudget::new(2, 0).is_err());
        assert!(TraversalBudget::new(9, 10).is_err());
        assert!(TraversalBudget::new(2, 501).is_err());
        assert!(TraversalBudget::new(2, 50).is_ok());
    }

    #[test]
    fn context_request_debug_redacts_query_and_anchor_text() {
        let request = match ContextRequest::new(
            project_id(),
            "credential shaped private query",
            IndexFreshness::Current,
            ContextBudget::default(),
        ) {
            Ok(request) => request,
            Err(error) => panic!("context request fixture was rejected: {error}"),
        };
        let request =
            match request.with_anchor(ContextAnchor::ExactName("private_anchor_name".to_owned())) {
                Ok(request) => request,
                Err(error) => panic!("context anchor fixture was rejected: {error}"),
            };
        let rendered = format!("{request:?}");
        assert!(!rendered.contains("credential shaped private query"));
        assert!(!rendered.contains("private_anchor_name"));
        assert!(rendered.contains("query: <redacted>"));
    }

    #[test]
    fn affected_test_detection_is_conservative_and_platform_independent() {
        assert!(is_test_path("tests/search/retrieval.rs"));
        assert!(is_test_path("src/search/__tests__/packet.ts"));
        assert!(is_test_path("src/search/packet.test.ts"));
        assert!(is_test_path("src/search/packet_spec.rb"));
        assert!(!is_test_path("src/contest/parser.ts"));
        assert!(!is_test_path("src/testing_helpers.ts"));
    }

    #[test]
    fn graph_frontier_is_deduplicated_and_stably_ordered() {
        let root = symbol_id("11111111-1111-4111-8111-111111111111");
        let first = symbol_id("22222222-2222-4222-8222-222222222222");
        let second = symbol_id("33333333-3333-4333-8333-333333333333");
        let arcs = vec![
            GraphArc::fixture(root.clone(), second.clone(), "calls", 0.8),
            GraphArc::fixture(root.clone(), first.clone(), "calls", 0.9),
            GraphArc::fixture(root.clone(), first.clone(), "references", 0.7),
        ];
        let expansion = expand_frontier(&[root], &arcs, TraversalDirection::Outgoing, 10);
        assert_eq!(expansion.next, vec![first, second]);
        assert_eq!(expansion.arcs.len(), 3);
    }

    #[test]
    fn packet_abstains_without_evidence_and_orders_evidence_deterministically() {
        let empty = assemble_packet(PacketAssembly {
            generation: None,
            freshness: IndexFreshness::Unknown,
            evidence: Vec::new(),
            affected_tests: Vec::new(),
            evidence_limit: 10,
            truncated: false,
        });
        assert_eq!(empty.confidence(), RetrievalConfidence::None);
        assert_eq!(
            empty.abstention(),
            Some(ContextAbstention::NoCurrentGeneration)
        );
        let serialized = match serde_json::to_string(&empty) {
            Ok(serialized) => serialized,
            Err(error) => panic!("packet did not serialize: {error}"),
        };
        assert!(serialized.contains("\"abstention\":\"no_current_generation\""));
        assert!(serialized.contains("\"freshness\":\"unknown\""));

        let mut evidence = vec![
            EvidenceItem::fixture("src/z.ts", "z", EvidenceReason::Bm25),
            EvidenceItem::fixture("src/a.ts", "a", EvidenceReason::ExactName),
            EvidenceItem::fixture("src/b.ts", "b", EvidenceReason::ExactReference),
        ];
        evidence.reverse();
        let packet = assemble_packet(PacketAssembly {
            generation: Some(fixture_generation()),
            freshness: IndexFreshness::Current,
            evidence,
            affected_tests: Vec::new(),
            evidence_limit: 10,
            truncated: false,
        });
        let paths = packet
            .evidence()
            .iter()
            .map(EvidenceItem::path)
            .collect::<Vec<_>>();
        assert_eq!(paths, vec!["src/a.ts", "src/b.ts", "src/z.ts"]);
        assert_eq!(packet.confidence(), RetrievalConfidence::High);
        assert_eq!(packet.abstention(), None);
    }
}
