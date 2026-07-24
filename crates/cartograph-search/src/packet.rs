use std::collections::BTreeMap;

use crate::{
    AffectedTest, ContextAbstention, ContextPacket, EvidenceItem, EvidenceReason,
    GenerationEvidence, IndexFreshness, RetrievalConfidence,
};

pub(crate) struct PacketAssembly {
    pub(crate) generation: Option<GenerationEvidence>,
    pub(crate) freshness: IndexFreshness,
    pub(crate) evidence: Vec<EvidenceItem>,
    pub(crate) affected_tests: Vec<AffectedTest>,
    pub(crate) evidence_limit: u16,
    pub(crate) truncated: bool,
}

pub(crate) fn assemble_packet(input: PacketAssembly) -> ContextPacket {
    let (evidence, evidence_was_truncated) = bound_evidence(input.evidence, input.evidence_limit);
    let (confidence, abstention) = classify_packet(
        input.generation.as_ref(),
        input.freshness,
        evidence.as_slice(),
    );
    ContextPacket::new(
        input.generation,
        input.freshness,
        confidence,
        abstention,
        evidence,
        input.affected_tests,
        input.truncated || evidence_was_truncated,
    )
}

pub(crate) fn bound_evidence(
    evidence: Vec<EvidenceItem>,
    evidence_limit: u16,
) -> (Vec<EvidenceItem>, bool) {
    let mut merged = BTreeMap::<String, EvidenceItem>::new();
    for item in evidence {
        let key = item.key();
        if let Some(existing) = merged.get_mut(&key) {
            existing.merge(item);
        } else {
            merged.insert(key, item);
        }
    }
    let mut evidence = merged.into_values().collect::<Vec<_>>();
    evidence.sort_by(evidence_order);
    let evidence_was_truncated = evidence.len() > usize::from(evidence_limit);
    evidence.truncate(usize::from(evidence_limit));
    (evidence, evidence_was_truncated)
}

fn evidence_order(left: &EvidenceItem, right: &EvidenceItem) -> std::cmp::Ordering {
    left.priority()
        .cmp(&right.priority())
        .then_with(|| left.path().cmp(right.path()))
        .then_with(|| left.start_line().cmp(&right.start_line()))
        .then_with(|| left.qualified_name().cmp(right.qualified_name()))
        .then_with(|| left.key().cmp(&right.key()))
}

fn classify_packet(
    generation: Option<&GenerationEvidence>,
    freshness: IndexFreshness,
    evidence: &[EvidenceItem],
) -> (RetrievalConfidence, Option<ContextAbstention>) {
    if generation.is_none() {
        return (
            RetrievalConfidence::None,
            Some(ContextAbstention::NoCurrentGeneration),
        );
    }
    if evidence.is_empty() {
        return (
            RetrievalConfidence::None,
            Some(ContextAbstention::NoRelevantEvidence),
        );
    }
    match freshness {
        IndexFreshness::Stale => (
            RetrievalConfidence::Low,
            Some(ContextAbstention::StaleIndex),
        ),
        IndexFreshness::Unknown => (
            RetrievalConfidence::Low,
            Some(ContextAbstention::UnknownFreshness),
        ),
        IndexFreshness::Current => {
            let has_exact = evidence.iter().any(|item| {
                item.reasons().iter().any(|reason| {
                    matches!(
                        reason,
                        EvidenceReason::ExactName
                            | EvidenceReason::ExactPath
                            | EvidenceReason::ExactReference
                    )
                })
            });
            if has_exact {
                (RetrievalConfidence::High, None)
            } else {
                (RetrievalConfidence::Medium, None)
            }
        }
    }
}
