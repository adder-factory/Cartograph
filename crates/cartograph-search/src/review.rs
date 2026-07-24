use crate::{
    AffectedTest, EvidenceItem, GenerationEvidence, IndexFreshness, RetrievalConfidence,
    ReviewAbstention, ReviewPacket, ReviewTruncation, packet::bound_evidence,
};
use cartograph_domain::NormalizedPath;

pub(crate) struct ReviewAssembly {
    pub(crate) generation: Option<GenerationEvidence>,
    pub(crate) freshness: IndexFreshness,
    pub(crate) changed_file_count: usize,
    pub(crate) indexed_changed_files: Vec<NormalizedPath>,
    pub(crate) evidence: Vec<EvidenceItem>,
    pub(crate) affected_tests: Vec<AffectedTest>,
    pub(crate) evidence_limit: u16,
    pub(crate) truncation: ReviewTruncation,
}

pub(crate) fn assemble_review_packet(input: ReviewAssembly) -> ReviewPacket {
    let (evidence, evidence_was_truncated) = bound_evidence(input.evidence, input.evidence_limit);
    let (confidence, abstention) = classify_review(
        input.generation.as_ref(),
        input.freshness,
        input.changed_file_count,
        &input.indexed_changed_files,
    );
    ReviewPacket::new(
        input.generation,
        input.freshness,
        (confidence, abstention),
        input.indexed_changed_files,
        evidence,
        input.affected_tests,
        input.truncation.with_evidence(evidence_was_truncated),
    )
}

fn classify_review(
    generation: Option<&GenerationEvidence>,
    freshness: IndexFreshness,
    changed_file_count: usize,
    indexed_changed_files: &[NormalizedPath],
) -> (RetrievalConfidence, Option<ReviewAbstention>) {
    if generation.is_none() {
        return (
            RetrievalConfidence::None,
            Some(ReviewAbstention::NoCurrentGeneration),
        );
    }
    if changed_file_count == 0 {
        return (
            RetrievalConfidence::None,
            Some(ReviewAbstention::NoChangedFiles),
        );
    }
    if indexed_changed_files.is_empty() {
        return (
            RetrievalConfidence::None,
            Some(ReviewAbstention::NoIndexedChangedFiles),
        );
    }
    match freshness {
        IndexFreshness::Current => (RetrievalConfidence::High, None),
        IndexFreshness::Stale => (RetrievalConfidence::Low, Some(ReviewAbstention::StaleIndex)),
        IndexFreshness::Unknown => (
            RetrievalConfidence::Low,
            Some(ReviewAbstention::UnknownFreshness),
        ),
    }
}
