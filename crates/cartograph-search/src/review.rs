use crate::{
    AffectedTest, EvidenceItem, GenerationEvidence, IndexFreshness, RetrievalConfidence,
    ReviewAbstention, ReviewPacket, ReviewTruncation, model::ReviewPacketDetails,
    packet::bound_evidence,
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

struct ReviewClassificationInput<'input> {
    generation: Option<&'input GenerationEvidence>,
    freshness: IndexFreshness,
    changed_file_count: usize,
    indexed_changed_files: &'input [NormalizedPath],
}

pub(crate) fn assemble_review_packet(input: ReviewAssembly) -> ReviewPacket {
    let (evidence, evidence_was_truncated) = bound_evidence(input.evidence, input.evidence_limit);
    let (confidence, abstention) = classify_review(ReviewClassificationInput {
        generation: input.generation.as_ref(),
        freshness: input.freshness,
        changed_file_count: input.changed_file_count,
        indexed_changed_files: &input.indexed_changed_files,
    });
    ReviewPacket {
        details: ReviewPacketDetails {
            generation: input.generation,
            freshness: input.freshness,
            confidence,
            abstention,
            indexed_changed_files: input.indexed_changed_files,
            evidence,
            affected_tests: input.affected_tests,
            truncation: input.truncation.with_evidence(evidence_was_truncated),
        },
    }
}

fn classify_review(
    input: ReviewClassificationInput<'_>,
) -> (RetrievalConfidence, Option<ReviewAbstention>) {
    if input.generation.is_none() {
        return (
            RetrievalConfidence::None,
            Some(ReviewAbstention::NoCurrentGeneration),
        );
    }
    if input.changed_file_count == 0 {
        return (
            RetrievalConfidence::None,
            Some(ReviewAbstention::NoChangedFiles),
        );
    }
    if input.indexed_changed_files.is_empty() {
        return (
            RetrievalConfidence::None,
            Some(ReviewAbstention::NoIndexedChangedFiles),
        );
    }
    match input.freshness {
        IndexFreshness::Current => (RetrievalConfidence::High, None),
        IndexFreshness::Stale => (RetrievalConfidence::Low, Some(ReviewAbstention::StaleIndex)),
        IndexFreshness::Unknown => (
            RetrievalConfidence::Low,
            Some(ReviewAbstention::UnknownFreshness),
        ),
    }
}
