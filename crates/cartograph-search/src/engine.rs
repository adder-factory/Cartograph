use std::collections::{BTreeMap, BTreeSet};

use cartograph_db::{
    CartographDatabase, CurrentReferenceRecord, CurrentSymbolRecord, GraphDirection, SearchHit,
    SearchQuery,
};
use cartograph_domain::{NormalizedPath, ProjectId, SymbolId};

use crate::{
    AffectedTestsResult, ContextAnchor, ContextPacket, ContextRequest, EvidenceItem,
    EvidenceReason, ExactPathResult, GenerationEvidence, RetrievalError, ReviewPacket,
    ReviewRequest, ReviewTruncation, TraversalDirection, TraversalHop, TraversalNode,
    TraversalRequest, TraversalResult,
    packet::{PacketAssembly, assemble_packet},
    review::{ReviewAssembly, assemble_review_packet},
    traversal::{GraphArc, affected_tests_from_traversal, expand_frontier},
};

const GRAPH_EDGE_READ_LIMIT: u16 = 2_000;
const MAX_CONTEXT_ROOTS: usize = 32;

#[derive(Clone, Copy)]
enum TraversalKind {
    Callers,
    Callees,
    Impact,
}

/// Deterministic retrieval facade over one PostgreSQL-backed Cartograph schema.
#[derive(Clone)]
pub struct DeterministicRetriever {
    database: CartographDatabase,
}

impl DeterministicRetriever {
    /// Bind deterministic retrieval to an established database handle.
    #[must_use]
    pub const fn new(database: CartographDatabase) -> Self {
        Self { database }
    }

    /// Exact fully qualified declaration-name lookup in the published generation.
    pub async fn exact_name(
        &self,
        project_id: &ProjectId,
        name: &str,
        limit: u16,
    ) -> Result<Vec<CurrentSymbolRecord>, RetrievalError> {
        self.database
            .exact_current_symbols_by_name(project_id, name, limit)
            .await
            .map_err(Into::into)
    }

    /// Exact canonical-path lookup with source-ordered declarations.
    pub async fn exact_path(
        &self,
        project_id: &ProjectId,
        path: &NormalizedPath,
        symbol_limit: u16,
    ) -> Result<Option<ExactPathResult>, RetrievalError> {
        if symbol_limit == 0 || symbol_limit > 500 {
            return Err(RetrievalError::InvalidInput {
                field: "symbol_limit",
            });
        }
        let Some(file) = self
            .database
            .exact_current_file_by_path(project_id, path)
            .await?
        else {
            return Ok(None);
        };
        let symbols = self
            .database
            .current_symbols_by_file(project_id, file.file_id(), symbol_limit)
            .await?;
        Ok(Some(ExactPathResult::new(file, symbols)))
    }

    /// Exact source-reference lookup, including unresolved reference evidence.
    pub async fn exact_reference(
        &self,
        project_id: &ProjectId,
        name: &str,
        limit: u16,
    ) -> Result<Vec<CurrentReferenceRecord>, RetrievalError> {
        self.database
            .exact_current_references_by_name(project_id, name, limit)
            .await
            .map_err(Into::into)
    }

    /// Current-generation ParadeDB BM25 with ordered field provenance.
    pub async fn bm25(
        &self,
        project_id: ProjectId,
        query: impl Into<String>,
        limit: u16,
    ) -> Result<Vec<SearchHit>, RetrievalError> {
        self.database
            .search_current_code(SearchQuery::new(project_id, query, limit))
            .await
            .map_err(Into::into)
    }

    /// Follow incoming `calls` edges to discover bounded callers.
    pub async fn callers(
        &self,
        request: &TraversalRequest,
    ) -> Result<TraversalResult, RetrievalError> {
        self.traverse(request, TraversalKind::Callers).await
    }

    /// Follow outgoing `calls` edges to discover bounded callees.
    pub async fn callees(
        &self,
        request: &TraversalRequest,
    ) -> Result<TraversalResult, RetrievalError> {
        self.traverse(request, TraversalKind::Callees).await
    }

    /// Follow incoming dependency relations to estimate a bounded impact cone.
    pub async fn impact(
        &self,
        request: &TraversalRequest,
    ) -> Result<TraversalResult, RetrievalError> {
        self.traverse(request, TraversalKind::Impact).await
    }

    /// Discover test files/symbols in a bounded reverse impact cone.
    pub async fn affected_tests(
        &self,
        request: &TraversalRequest,
        limit: u16,
    ) -> Result<AffectedTestsResult, RetrievalError> {
        if limit == 0 || limit > 100 {
            return Err(RetrievalError::InvalidInput {
                field: "affected_test_limit",
            });
        }
        let impact = self.impact(request).await?;
        let (tests, output_was_truncated) = affected_tests_from_traversal(&impact, limit);
        Ok(AffectedTestsResult::new(
            tests,
            impact.truncated() || output_was_truncated,
        ))
    }

    /// Assemble compact exact, BM25, graph, and affected-test evidence without
    /// invoking any model or external service.
    pub async fn context_packet(
        &self,
        request: &ContextRequest,
    ) -> Result<ContextPacket, RetrievalError> {
        let generation = self
            .database
            .current_generation_record(request.project_id())
            .await?;
        let Some(generation) = generation else {
            return Ok(assemble_packet(PacketAssembly {
                generation: None,
                freshness: request.freshness(),
                evidence: Vec::new(),
                affected_tests: Vec::new(),
                evidence_limit: request.budget().evidence_limit(),
                truncated: false,
            }));
        };

        let mut evidence = Vec::new();
        let mut roots = BTreeSet::new();
        let budget = request.budget();
        for anchor in request.anchors() {
            match anchor {
                ContextAnchor::ExactName(name) => {
                    for symbol in self
                        .exact_name(request.project_id(), name, budget.exact_limit())
                        .await?
                    {
                        roots.insert(symbol.symbol_id().clone());
                        evidence.push(EvidenceItem::from_symbol(
                            &symbol,
                            EvidenceReason::ExactName,
                        ));
                    }
                }
                ContextAnchor::ExactPath(path) => {
                    if let Some(result) = self
                        .exact_path(request.project_id(), path, budget.exact_limit())
                        .await?
                    {
                        evidence.push(EvidenceItem::from_file(result.file()));
                        for symbol in result.symbols() {
                            roots.insert(symbol.symbol_id().clone());
                            evidence
                                .push(EvidenceItem::from_symbol(symbol, EvidenceReason::ExactPath));
                        }
                    }
                }
                ContextAnchor::ExactReference(name) => {
                    for reference in self
                        .exact_reference(request.project_id(), name, budget.exact_limit())
                        .await?
                    {
                        if let Some(symbol_id) = reference.target_symbol_id() {
                            roots.insert(symbol_id.clone());
                        }
                        if let Some(symbol_id) = reference.owner_symbol_id() {
                            roots.insert(symbol_id.clone());
                        }
                        evidence.push(EvidenceItem::from_reference(&reference));
                    }
                }
            }
        }

        let hits = self
            .bm25(
                request.project_id().clone(),
                request.query(),
                budget.candidate_limit(),
            )
            .await?;
        for (index, hit) in hits.iter().enumerate() {
            if let Some(symbol_id) = hit.symbol_id() {
                roots.insert(symbol_id.clone());
            }
            let rank = u16::try_from(index + 1).map_err(|_| RetrievalError::InvalidInput {
                field: "candidate_limit",
            })?;
            evidence.push(EvidenceItem::from_search_hit(hit, rank));
        }

        let roots_were_truncated = roots.len() > MAX_CONTEXT_ROOTS;
        let roots = roots
            .into_iter()
            .take(MAX_CONTEXT_ROOTS)
            .collect::<Vec<_>>();
        let (affected_tests, graph_was_truncated) = if roots.is_empty() {
            (Vec::new(), false)
        } else {
            let traversal_request =
                TraversalRequest::new(request.project_id().clone(), roots, budget.traversal())?;
            let impact = self.impact(&traversal_request).await?;
            for node in impact.nodes() {
                evidence.push(EvidenceItem::from_traversal_node(node));
            }
            let (tests, tests_were_truncated) =
                affected_tests_from_traversal(&impact, budget.affected_test_limit());
            (tests, impact.truncated() || tests_were_truncated)
        };

        Ok(assemble_packet(PacketAssembly {
            generation: Some(GenerationEvidence::new(
                generation.generation_id().clone(),
                generation.sequence(),
            )),
            freshness: request.freshness(),
            evidence,
            affected_tests,
            evidence_limit: budget.evidence_limit(),
            truncated: roots_were_truncated || graph_was_truncated,
        }))
    }

    /// Assemble exact changed-file, reverse-impact, and affected-test evidence
    /// for a deterministic compare-to-ref workflow.
    pub async fn review_packet(
        &self,
        request: &ReviewRequest,
    ) -> Result<ReviewPacket, RetrievalError> {
        let Some(project_id) = request.project_id() else {
            return Ok(assemble_review_packet(ReviewAssembly {
                generation: None,
                freshness: request.freshness(),
                changed_file_count: request.changed_paths().len(),
                indexed_changed_files: Vec::new(),
                evidence: Vec::new(),
                affected_tests: Vec::new(),
                evidence_limit: request.budget().evidence_limit(),
                truncation: ReviewTruncation::new(
                    request.changed_files_truncated(),
                    false,
                    false,
                    false,
                ),
            }));
        };
        let generation = self.database.current_generation_record(project_id).await?;
        let Some(generation) = generation else {
            return Ok(assemble_review_packet(ReviewAssembly {
                generation: None,
                freshness: request.freshness(),
                changed_file_count: request.changed_paths().len(),
                indexed_changed_files: Vec::new(),
                evidence: Vec::new(),
                affected_tests: Vec::new(),
                evidence_limit: request.budget().evidence_limit(),
                truncation: ReviewTruncation::new(
                    request.changed_files_truncated(),
                    false,
                    false,
                    false,
                ),
            }));
        };

        let budget = request.budget();
        let mut indexed_changed_files = Vec::new();
        let mut evidence = Vec::new();
        let mut roots = BTreeSet::new();
        let mut symbol_roots_were_truncated = false;
        for path in request.changed_paths() {
            let Some(result) = self
                .exact_path(project_id, path, budget.symbols_per_file())
                .await?
            else {
                continue;
            };
            indexed_changed_files.push(path.clone());
            evidence.push(EvidenceItem::from_file(result.file()));
            if result.symbols().len() == usize::from(budget.symbols_per_file()) {
                symbol_roots_were_truncated = true;
            }
            for symbol in result.symbols() {
                if roots.contains(symbol.symbol_id()) {
                    continue;
                }
                if roots.len() >= usize::from(budget.root_limit()) {
                    symbol_roots_were_truncated = true;
                    continue;
                }
                roots.insert(symbol.symbol_id().clone());
                evidence.push(EvidenceItem::from_symbol(symbol, EvidenceReason::ExactPath));
            }
        }

        let roots = roots.into_iter().collect::<Vec<_>>();
        let (affected_tests, graph_was_truncated, tests_were_truncated) = if roots.is_empty() {
            (Vec::new(), false, false)
        } else {
            let traversal_request =
                TraversalRequest::new(project_id.clone(), roots, budget.traversal())?;
            let impact = self.impact(&traversal_request).await?;
            for node in impact.nodes() {
                evidence.push(EvidenceItem::from_traversal_node(node));
            }
            let (tests, tests_were_truncated) =
                affected_tests_from_traversal(&impact, budget.affected_test_limit());
            (tests, impact.truncated(), tests_were_truncated)
        };

        Ok(assemble_review_packet(ReviewAssembly {
            generation: Some(GenerationEvidence::new(
                generation.generation_id().clone(),
                generation.sequence(),
            )),
            freshness: request.freshness(),
            changed_file_count: request.changed_paths().len(),
            indexed_changed_files,
            evidence,
            affected_tests,
            evidence_limit: budget.evidence_limit(),
            truncation: ReviewTruncation::new(
                request.changed_files_truncated(),
                symbol_roots_were_truncated,
                graph_was_truncated,
                tests_were_truncated,
            ),
        }))
    }

    async fn traverse(
        &self,
        request: &TraversalRequest,
        kind: TraversalKind,
    ) -> Result<TraversalResult, RetrievalError> {
        let direction = match kind {
            TraversalKind::Callees => TraversalDirection::Outgoing,
            TraversalKind::Callers | TraversalKind::Impact => TraversalDirection::Incoming,
        };
        let database_direction = match direction {
            TraversalDirection::Outgoing => GraphDirection::Outgoing,
            TraversalDirection::Incoming => GraphDirection::Incoming,
        };
        let budget = request.budget();
        let mut visited = request.roots().iter().cloned().collect::<BTreeSet<_>>();
        let mut frontier = request.roots().to_vec();
        let mut discoveries = BTreeMap::<SymbolId, (u8, GraphArc)>::new();
        let mut truncated = false;

        for depth in 1..=budget.max_depth() {
            let edges = self
                .database
                .current_graph_edges(
                    request.project_id(),
                    &frontier,
                    database_direction,
                    GRAPH_EDGE_READ_LIMIT,
                )
                .await?;
            if edges.len() == usize::from(GRAPH_EDGE_READ_LIMIT) {
                truncated = true;
            }
            let arcs = edges
                .iter()
                .map(GraphArc::from_record)
                .filter(|arc| edge_is_relevant(arc, kind))
                .filter(|arc| !visited.contains(arc.adjacent(direction)))
                .collect::<Vec<_>>();
            let remaining = usize::from(budget.max_nodes()).saturating_sub(discoveries.len());
            if remaining == 0 {
                if !arcs.is_empty() {
                    truncated = true;
                }
                break;
            }
            let expansion = expand_frontier(&frontier, &arcs, direction, remaining);
            truncated |= expansion.truncated;
            for symbol_id in &expansion.next {
                let first_arc = expansion
                    .arcs
                    .iter()
                    .find(|arc| arc.adjacent(direction) == symbol_id);
                if let Some(first_arc) = first_arc {
                    visited.insert(symbol_id.clone());
                    discoveries.insert(symbol_id.clone(), (depth, first_arc.clone()));
                }
            }
            frontier = expansion.next;
            if frontier.is_empty() {
                break;
            }
        }

        let ids = discoveries.keys().cloned().collect::<Vec<_>>();
        let symbols = self
            .database
            .current_symbols_by_ids(request.project_id(), &ids)
            .await?;
        let mut symbols = symbols
            .into_iter()
            .map(|symbol| (symbol.symbol_id().clone(), symbol))
            .collect::<BTreeMap<_, _>>();
        let mut nodes = Vec::with_capacity(discoveries.len());
        for (symbol_id, (depth, arc)) in discoveries {
            let Some(symbol) = symbols.remove(&symbol_id) else {
                truncated = true;
                continue;
            };
            let hop = TraversalHop::new(
                arc.origin(direction).clone(),
                arc.adjacent(direction).clone(),
                arc.edge_kind,
                arc.confidence,
                arc.provenance,
            );
            nodes.push(TraversalNode::new(symbol, depth, hop));
        }
        nodes.sort_by(|left, right| {
            left.depth()
                .cmp(&right.depth())
                .then_with(|| {
                    left.symbol()
                        .path()
                        .as_str()
                        .cmp(right.symbol().path().as_str())
                })
                .then_with(|| left.symbol().start_line().cmp(&right.symbol().start_line()))
                .then_with(|| left.symbol().symbol_id().cmp(right.symbol().symbol_id()))
        });
        Ok(TraversalResult::new(
            direction,
            request.roots().to_vec(),
            nodes,
            truncated,
        ))
    }
}

fn edge_is_relevant(arc: &GraphArc, kind: TraversalKind) -> bool {
    match kind {
        TraversalKind::Callers | TraversalKind::Callees => arc.edge_kind == "calls",
        TraversalKind::Impact => matches!(
            arc.edge_kind.as_str(),
            "calls"
                | "imports"
                | "references"
                | "implements"
                | "extends"
                | "tests"
                | "type_of"
                | "returns"
                | "instantiates"
                | "overrides"
                | "decorates"
                | "field_access"
                | "def_use"
                | "exports"
        ),
    }
}
