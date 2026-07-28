use cartograph_domain::{DocumentId, DocumentKind, GenerationId, NormalizedPath, SourceLanguage};
use cartograph_search::{
    ChannelCandidate, ChannelResults, HybridSearchInput, LexicalComponent, RetrievalAbstention,
    RetrievalChannel, RetrievalDocument, RetrievalDocumentInput, RetrievalExecution,
    RetrievalFallback, SearchMode, SemanticReadiness, fuse_search,
};

const RESULT_LIMIT: u16 = 20;
const LEXICAL_PRIMARY_SCORE: f64 = 12.5;
const LEXICAL_SECONDARY_SCORE: f64 = 8.25;
const SEMANTIC_PRIMARY_SCORE: f64 = 0.91;
const SEMANTIC_SECONDARY_SCORE: f64 = 0.82;

#[test]
fn reciprocal_rank_fusion_retains_channel_provenance_and_raw_values() {
    let lexical = channel(
        RetrievalChannel::Lexical,
        vec![
            lexical_candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE)),
            lexical_candidate("b", "src/b.rs", (2, LEXICAL_SECONDARY_SCORE)),
        ],
    );
    let semantic = channel(
        RetrievalChannel::Semantic,
        vec![
            candidate("b", "src/b.rs", (1, SEMANTIC_PRIMARY_SCORE)),
            candidate("c", "src/c.rs", (2, SEMANTIC_SECONDARY_SCORE)),
        ],
    );
    let packet = packet(
        SearchMode::Hybrid,
        SemanticReadiness::Ready,
        (lexical, semantic),
    );

    assert_eq!(packet.execution(), RetrievalExecution::Hybrid);
    assert_eq!(packet.fallback(), None);
    assert_eq!(paths(&packet), vec!["src/b.rs", "src/a.rs", "src/c.rs"]);
    let first = &packet.items()[0];
    assert_eq!(first.rank(), 1);
    assert_eq!(first.document().language(), SourceLanguage::Rust);
    assert_eq!(first.document().document_kind(), DocumentKind::Symbol);
    assert_eq!(first.contributions().len(), 2);
    assert_eq!(
        first.contributions()[0].channel(),
        RetrievalChannel::Lexical
    );
    assert_eq!(first.contributions()[0].rank(), 2);
    assert_eq!(
        first.contributions()[0].raw_score(),
        LEXICAL_SECONDARY_SCORE
    );
    assert_eq!(
        first.contributions()[0].lexical_components(),
        &[LexicalComponent::QualifiedName]
    );
    assert_eq!(
        first.contributions()[1].channel(),
        RetrievalChannel::Semantic
    );
    assert_eq!(first.contributions()[1].rank(), 1);
    assert_eq!(first.contributions()[1].raw_score(), SEMANTIC_PRIMARY_SCORE);
    assert!(first.reciprocal_rank_score() > packet.items()[1].reciprocal_rank_score());
}

#[test]
fn fusion_is_repeatable_across_candidate_and_channel_completion_order() {
    let lexical_forward = vec![
        lexical_candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE)),
        lexical_candidate("b", "src/b.rs", (2, LEXICAL_SECONDARY_SCORE)),
    ];
    let mut lexical_reverse = lexical_forward.clone();
    lexical_reverse.reverse();
    let semantic_forward = vec![
        candidate("b", "src/b.rs", (1, SEMANTIC_PRIMARY_SCORE)),
        candidate("c", "src/c.rs", (2, SEMANTIC_SECONDARY_SCORE)),
    ];
    let mut semantic_reverse = semantic_forward.clone();
    semantic_reverse.reverse();

    let expected = fused_with_order(lexical_forward.clone(), semantic_forward.clone(), false);
    for (lexical, semantic, semantic_first) in [
        (lexical_forward, semantic_forward, true),
        (lexical_reverse.clone(), semantic_reverse.clone(), false),
        (lexical_reverse, semantic_reverse, true),
    ] {
        assert_eq!(
            fused_with_order(lexical, semantic, semantic_first),
            expected
        );
    }
}

#[test]
fn equal_rrf_scores_use_stable_document_tie_breaks() {
    let lexical = channel(
        RetrievalChannel::Lexical,
        vec![candidate("z", "src/z.rs", (1, LEXICAL_PRIMARY_SCORE))],
    );
    let semantic = channel(
        RetrievalChannel::Semantic,
        vec![candidate("a", "src/a.rs", (1, SEMANTIC_PRIMARY_SCORE))],
    );
    let packet = packet(
        SearchMode::Hybrid,
        SemanticReadiness::Ready,
        (lexical, semantic),
    );
    assert_eq!(paths(&packet), vec!["src/a.rs", "src/z.rs"]);
}

#[test]
fn unavailable_or_empty_channels_degrade_explicitly() {
    let lexical = channel(
        RetrievalChannel::Lexical,
        vec![candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE))],
    );
    let not_ready = input(SearchMode::Auto, SemanticReadiness::NotIndexed)
        .with_channel(lexical.clone())
        .unwrap_or_else(|error| panic!("lexical channel failed: {error}"));
    let packet = fuse_search(not_ready).unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(packet.execution(), RetrievalExecution::Lexical);
    assert_eq!(packet.fallback(), Some(RetrievalFallback::SemanticNotReady));
    assert_eq!(packet.abstention(), None);

    let semantic_only = input(SearchMode::Hybrid, SemanticReadiness::Ready)
        .with_channel(channel(
            RetrievalChannel::Semantic,
            vec![candidate("b", "src/b.rs", (1, SEMANTIC_PRIMARY_SCORE))],
        ))
        .unwrap_or_else(|error| panic!("semantic channel failed: {error}"));
    let packet =
        fuse_search(semantic_only).unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(packet.execution(), RetrievalExecution::Semantic);
    assert_eq!(
        packet.fallback(),
        Some(RetrievalFallback::LexicalUnavailable)
    );

    let semantic_empty = input(SearchMode::Hybrid, SemanticReadiness::Ready)
        .with_channel(lexical)
        .and_then(|value| value.with_channel(channel(RetrievalChannel::Semantic, Vec::new())))
        .unwrap_or_else(|error| panic!("channels failed: {error}"));
    let packet =
        fuse_search(semantic_empty).unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(packet.execution(), RetrievalExecution::Lexical);
    assert_eq!(packet.fallback(), Some(RetrievalFallback::SemanticEmpty));
}

#[test]
fn deterministic_mode_ignores_semantic_candidates_without_hiding_readiness() {
    let input = input(SearchMode::Deterministic, SemanticReadiness::Ready)
        .with_channel(channel(
            RetrievalChannel::Lexical,
            vec![candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE))],
        ))
        .and_then(|value| {
            value.with_channel(channel(
                RetrievalChannel::Semantic,
                vec![candidate("b", "src/b.rs", (1, SEMANTIC_PRIMARY_SCORE))],
            ))
        })
        .unwrap_or_else(|error| panic!("channels failed: {error}"));
    let packet = fuse_search(input).unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(packet.requested_mode(), SearchMode::Deterministic);
    assert_eq!(packet.semantic_readiness(), SemanticReadiness::Ready);
    assert_eq!(packet.execution(), RetrievalExecution::Lexical);
    assert_eq!(packet.fallback(), None);
    assert_eq!(paths(&packet), vec!["src/a.rs"]);
}

#[test]
fn empty_inputs_abstain_and_limits_are_explicit() {
    let unavailable = fuse_search(input(SearchMode::Auto, SemanticReadiness::Unavailable))
        .unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(unavailable.execution(), RetrievalExecution::Abstained);
    assert_eq!(
        unavailable.abstention(),
        Some(RetrievalAbstention::NoUsableChannel)
    );

    let empty = input(SearchMode::Hybrid, SemanticReadiness::Ready)
        .with_channel(channel(RetrievalChannel::Lexical, Vec::new()))
        .and_then(|value| value.with_channel(channel(RetrievalChannel::Semantic, Vec::new())))
        .unwrap_or_else(|error| panic!("channels failed: {error}"));
    let empty = fuse_search(empty).unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(
        empty.abstention(),
        Some(RetrievalAbstention::NoRelevantEvidence)
    );

    let limited = HybridSearchInput::new(SearchMode::Deterministic, SemanticReadiness::Ready, 1)
        .and_then(|value| {
            value.with_channel(
                ChannelResults::new(
                    RetrievalChannel::Lexical,
                    vec![
                        candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE)),
                        candidate("b", "src/b.rs", (2, LEXICAL_SECONDARY_SCORE)),
                    ],
                )
                .map(|channel| channel.with_truncated(true))?,
            )
        })
        .unwrap_or_else(|error| panic!("limited input failed: {error}"));
    let limited = fuse_search(limited).unwrap_or_else(|error| panic!("fusion failed: {error}"));
    assert_eq!(limited.items().len(), 1);
    assert!(limited.truncated());
}

#[test]
fn malformed_channel_inputs_fail_closed() {
    assert!(ChannelCandidate::new(document("a", "src/a.rs"), 0, 1.0).is_err());
    assert!(ChannelCandidate::new(document("a", "src/a.rs"), 1, f64::NAN).is_err());
    let duplicate_rank = ChannelResults::new(
        RetrievalChannel::Lexical,
        vec![
            candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE)),
            candidate("b", "src/b.rs", (1, LEXICAL_SECONDARY_SCORE)),
        ],
    );
    assert!(duplicate_rank.is_err());
    let duplicate_document = ChannelResults::new(
        RetrievalChannel::Lexical,
        vec![
            candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE)),
            candidate("a", "src/a.rs", (2, LEXICAL_SECONDARY_SCORE)),
        ],
    );
    assert!(duplicate_document.is_err());

    let semantic_components = ChannelResults::new(
        RetrievalChannel::Semantic,
        vec![lexical_candidate(
            "a",
            "src/a.rs",
            (1, SEMANTIC_PRIMARY_SCORE),
        )],
    );
    assert!(semantic_components.is_err());

    let duplicate_channel = input(SearchMode::Hybrid, SemanticReadiness::Ready)
        .with_channel(channel(RetrievalChannel::Lexical, Vec::new()))
        .and_then(|value| value.with_channel(channel(RetrievalChannel::Lexical, Vec::new())));
    assert!(duplicate_channel.is_err());
}

#[test]
fn all_non_ready_semantic_states_have_the_same_explicit_lexical_fallback() {
    for readiness in [
        SemanticReadiness::NotConfigured,
        SemanticReadiness::NotIndexed,
        SemanticReadiness::Stale,
        SemanticReadiness::Unavailable,
    ] {
        let input = input(SearchMode::Auto, readiness)
            .with_channel(channel(
                RetrievalChannel::Lexical,
                vec![candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE))],
            ))
            .unwrap_or_else(|error| panic!("lexical channel failed: {error}"));
        let packet = fuse_search(input).unwrap_or_else(|error| panic!("fusion failed: {error}"));
        assert_eq!(packet.execution(), RetrievalExecution::Lexical);
        assert_eq!(packet.fallback(), Some(RetrievalFallback::SemanticNotReady));
        assert_eq!(paths(&packet), vec!["src/a.rs"]);
    }
}

#[test]
fn packet_rejects_mixed_generations_and_inconsistent_shared_documents() {
    let mixed_generation = input(SearchMode::Hybrid, SemanticReadiness::Ready)
        .with_channel(channel(
            RetrievalChannel::Lexical,
            vec![candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE))],
        ))
        .and_then(|value| {
            value.with_channel(channel(
                RetrievalChannel::Semantic,
                vec![
                    ChannelCandidate::new(
                        document_in_generation("b", "src/b.rs", second_generation()),
                        1,
                        SEMANTIC_PRIMARY_SCORE,
                    )
                    .unwrap_or_else(|error| panic!("candidate failed: {error}")),
                ],
            ))
        })
        .unwrap_or_else(|error| panic!("channel input failed: {error}"));
    assert!(fuse_search(mixed_generation).is_err());

    let inconsistent_document = input(SearchMode::Hybrid, SemanticReadiness::Ready)
        .with_channel(channel(
            RetrievalChannel::Lexical,
            vec![candidate("a", "src/a.rs", (1, LEXICAL_PRIMARY_SCORE))],
        ))
        .and_then(|value| {
            value.with_channel(channel(
                RetrievalChannel::Semantic,
                vec![candidate("a", "src/other.rs", (1, SEMANTIC_PRIMARY_SCORE))],
            ))
        })
        .unwrap_or_else(|error| panic!("channel input failed: {error}"));
    assert!(fuse_search(inconsistent_document).is_err());
}

#[test]
fn compact_packet_serialization_keeps_explanation_without_query_or_source() {
    let packet = packet(
        SearchMode::Hybrid,
        SemanticReadiness::Ready,
        (
            channel(
                RetrievalChannel::Lexical,
                vec![lexical_candidate(
                    "a",
                    "src/a.rs",
                    (1, LEXICAL_PRIMARY_SCORE),
                )],
            ),
            channel(
                RetrievalChannel::Semantic,
                vec![candidate("a", "src/a.rs", (1, SEMANTIC_PRIMARY_SCORE))],
            ),
        ),
    );
    let serialized = serde_json::to_string(&packet)
        .unwrap_or_else(|error| panic!("packet serialization failed: {error}"));
    assert!(serialized.contains("\"requested_mode\":\"hybrid\""));
    assert!(serialized.contains("\"channel\":\"lexical\""));
    assert!(serialized.contains("\"language\":\"rust\""));
    assert!(serialized.contains("\"document_kind\":\"symbol\""));
    assert!(serialized.contains("\"raw_score\""));
    assert!(!serialized.contains("query"));
    assert!(!serialized.contains("source"));
}

fn packet(
    mode: SearchMode,
    readiness: SemanticReadiness,
    channels: (ChannelResults, ChannelResults),
) -> cartograph_search::HybridSearchPacket {
    let (lexical, semantic) = channels;
    let input = input(mode, readiness)
        .with_channel(lexical)
        .and_then(|value| value.with_channel(semantic))
        .unwrap_or_else(|error| panic!("channels failed: {error}"));
    fuse_search(input).unwrap_or_else(|error| panic!("fusion failed: {error}"))
}

fn fused_with_order(
    lexical: Vec<ChannelCandidate>,
    semantic: Vec<ChannelCandidate>,
    semantic_first: bool,
) -> cartograph_search::HybridSearchPacket {
    let lexical = channel(RetrievalChannel::Lexical, lexical);
    let semantic = channel(RetrievalChannel::Semantic, semantic);
    let input = input(SearchMode::Hybrid, SemanticReadiness::Ready);
    let input = if semantic_first {
        input
            .with_channel(semantic)
            .and_then(|value| value.with_channel(lexical))
    } else {
        input
            .with_channel(lexical)
            .and_then(|value| value.with_channel(semantic))
    }
    .unwrap_or_else(|error| panic!("channels failed: {error}"));
    fuse_search(input).unwrap_or_else(|error| panic!("fusion failed: {error}"))
}

fn input(mode: SearchMode, readiness: SemanticReadiness) -> HybridSearchInput {
    HybridSearchInput::new(mode, readiness, RESULT_LIMIT)
        .unwrap_or_else(|error| panic!("hybrid input failed: {error}"))
}

fn channel(channel: RetrievalChannel, candidates: Vec<ChannelCandidate>) -> ChannelResults {
    ChannelResults::new(channel, candidates)
        .unwrap_or_else(|error| panic!("channel input failed: {error}"))
}

fn lexical_candidate(id: &str, path: &str, ranking: (u16, f64)) -> ChannelCandidate {
    candidate(id, path, ranking).with_lexical_components(vec![LexicalComponent::QualifiedName])
}

fn candidate(id: &str, path: &str, ranking: (u16, f64)) -> ChannelCandidate {
    let (rank, score) = ranking;
    ChannelCandidate::new(document(id, path), rank, score)
        .unwrap_or_else(|error| panic!("candidate failed: {error}"))
}

fn document(id: &str, path: &str) -> RetrievalDocument {
    document_in_generation(id, path, primary_generation())
}

fn document_in_generation(id: &str, path: &str, generation_id: GenerationId) -> RetrievalDocument {
    let document_id = DocumentId::parse(document_uuid(id))
        .unwrap_or_else(|error| panic!("document id fixture failed: {error}"));
    let path = NormalizedPath::parse(path)
        .unwrap_or_else(|error| panic!("document path fixture failed: {error}"));
    RetrievalDocument::new(RetrievalDocumentInput {
        document_id,
        generation_id,
        path,
        language: SourceLanguage::Rust,
        document_kind: DocumentKind::Symbol,
    })
    .with_qualified_name(format!("symbol_{id}"))
    .unwrap_or_else(|error| panic!("qualified name fixture failed: {error}"))
}

fn primary_generation() -> GenerationId {
    generation("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
}

fn second_generation() -> GenerationId {
    generation("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
}

fn generation(value: &str) -> GenerationId {
    GenerationId::parse(value)
        .unwrap_or_else(|error| panic!("generation id fixture failed: {error}"))
}

fn document_uuid(id: &str) -> &str {
    match id {
        "a" => "11111111-1111-4111-8111-111111111111",
        "b" => "22222222-2222-4222-8222-222222222222",
        "c" => "33333333-3333-4333-8333-333333333333",
        "z" => "99999999-9999-4999-8999-999999999999",
        _ => panic!("unknown document fixture"),
    }
}

fn paths(packet: &cartograph_search::HybridSearchPacket) -> Vec<&str> {
    packet
        .items()
        .iter()
        .map(|item| item.document().path().as_str())
        .collect()
}
