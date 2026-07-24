use std::{collections::BTreeMap, fmt, mem::size_of, time::Duration};

use cartograph_db::{
    CanonicalGenerationFacts, EdgeInput, FileInput, GenerationFacts, GenerationValidationLimits,
    GenerationValidationReport, ReferenceInput, SearchDocumentInput, SymbolInput,
    validate_generation_facts,
};
use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, EdgeKind, FileId, NormalizedPath, ReferenceKind,
    SourceLanguage, SymbolId, SymbolKind, Visibility,
};
use cartograph_extract::{
    Containment, DiscoveredSource, DiscoveryLimits, ExtractedFile, ExtractedReference,
    NativeExtractor, SourceDiscoveryOptions, SourceLimits, SourceReadOptions, SourceRoot,
    is_test_source_path, native_extraction_reservation, native_read_reservation,
};
use serde_json::json;
use thiserror::Error;
use tokio::{
    runtime::{Handle, RuntimeFlavor},
    task::block_in_place,
    time::Instant,
};

use crate::{
    PipelineStage, StageCapacity, StageDeadlinePolicy, StageEnvelope, StageExecution, StageFold,
    StageItemBudget, StageItemFailure, StageItemMeta, StageOutput, StageRunConfig, StageRunError,
    StageRunner, StageSequence, StageWorkItem, StageWorkload,
};

const MAX_PIPELINE_RETAINED_BYTES: u64 = 64 * 1024 * 1024 * 1024;
const MAX_STAGE_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const MAX_CLEANUP_GRACE: Duration = Duration::from_secs(60);
const DOCUMENT_ID_DOMAIN: &[u8] = b"cartograph-v2-native-document-v1";
const CONTAINMENT_PROVENANCE: &str = "native-tree-sitter-containment";
const EXACT_SAME_FILE_PROVENANCE: &str = "native-exact-same-file";
const EXACT_PROJECT_PROVENANCE: &str = "native-exact-project";
const UNRESOLVED_PROVENANCE: &str = "native-unresolved";
const EXACT_SAME_FILE_CONFIDENCE: f32 = 1.0;
const EXACT_PROJECT_CONFIDENCE: f32 = 0.95;
const EXTRACTED_EDGE_CONFIDENCE: f32 = 1.0;
const UNRESOLVED_CONFIDENCE: f32 = 0.0;
const DOCUMENT_METADATA_FIXED_ALLOWANCE: u64 = 2 * 1024;
const DOCUMENT_UUID_BYTES: usize = 16;
const UUID_TEXT_BYTES: u64 = 36;
const VALIDATION_WORKING_MULTIPLIER: u64 = 4;
const RESOLUTION_MAP_NODE_ALLOWANCE: u64 = 128;
const REFERENCE_EDGE_KINDS: [EdgeKind; ReferenceKind::DefUse as usize + 1] = [
    EdgeKind::Calls,
    EdgeKind::Imports,
    EdgeKind::References,
    EdgeKind::Implements,
    EdgeKind::Extends,
    EdgeKind::Tests,
    EdgeKind::Exports,
    EdgeKind::TypeOf,
    EdgeKind::Returns,
    EdgeKind::Instantiates,
    EdgeKind::Overrides,
    EdgeKind::Decorates,
    EdgeKind::FieldAccess,
    EdgeKind::DefUse,
];

/// Hard discovery, source, manifest, and canonical-generation memory bounds.
#[derive(Clone, Copy, Debug)]
pub struct NativePipelineLimits {
    discovery_limits: DiscoveryLimits,
    source_limits: SourceLimits,
    retained: NativeRetainedLimits,
}

/// Separately bounded compact manifest and canonical generation storage.
#[derive(Clone, Copy, Debug)]
pub struct NativeRetainedLimits {
    max_manifest_bytes: u64,
    max_generation_bytes: u64,
}

impl NativeRetainedLimits {
    /// Validate both project-retained memory ceilings.
    pub fn new(
        max_manifest_bytes: u64,
        max_generation_bytes: u64,
    ) -> Result<Self, NativePipelineConfigError> {
        validate_retained_limit(max_manifest_bytes, "max_manifest_bytes")?;
        validate_retained_limit(max_generation_bytes, "max_generation_bytes")?;
        Ok(Self {
            max_manifest_bytes,
            max_generation_bytes,
        })
    }
}

impl NativePipelineLimits {
    /// Combine validated discovery, source, and retained-memory policies.
    #[must_use]
    pub const fn new(
        discovery_limits: DiscoveryLimits,
        source_limits: SourceLimits,
        retained: NativeRetainedLimits,
    ) -> Self {
        Self {
            discovery_limits,
            source_limits,
            retained,
        }
    }
}

/// Independent bounded worker windows for streamed reads and native parsing.
#[derive(Clone, Copy, Debug)]
pub struct NativePipelineParallelism {
    read_capacity: StageCapacity,
    parse_capacity: StageCapacity,
}

impl NativePipelineParallelism {
    /// Validate both active-worker plus queue windows.
    pub fn new(
        read_capacity: StageCapacity,
        parse_capacity: StageCapacity,
    ) -> Result<Self, NativePipelineConfigError> {
        validate_capacity(read_capacity, "read_capacity")?;
        validate_capacity(parse_capacity, "parse_capacity")?;
        Ok(Self {
            read_capacity,
            parse_capacity,
        })
    }
}

/// Per-item, whole-stage, and post-cancellation cleanup bounds.
#[derive(Clone, Copy, Debug)]
pub struct NativePipelineDeadlines {
    item_timeout: Duration,
    stage_timeout: Duration,
    cleanup_grace: Duration,
}

impl NativePipelineDeadlines {
    /// Validate independent work, stage, and cleanup durations.
    pub fn new(
        item_timeout: Duration,
        stage_timeout: Duration,
        cleanup_grace: Duration,
    ) -> Result<Self, NativePipelineConfigError> {
        if item_timeout.is_zero() || item_timeout > MAX_STAGE_TIMEOUT {
            return Err(NativePipelineConfigError::invalid("item_timeout"));
        }
        if stage_timeout.is_zero() || stage_timeout > MAX_STAGE_TIMEOUT {
            return Err(NativePipelineConfigError::invalid("stage_timeout"));
        }
        if cleanup_grace.is_zero() || cleanup_grace > MAX_CLEANUP_GRACE {
            return Err(NativePipelineConfigError::invalid("cleanup_grace"));
        }
        Ok(Self {
            item_timeout,
            stage_timeout,
            cleanup_grace,
        })
    }
}

/// Complete validated policy for one native source-to-facts build.
#[derive(Clone, Copy, Debug)]
pub struct NativePipelineConfig {
    limits: NativePipelineLimits,
    parallelism: NativePipelineParallelism,
    deadlines: NativePipelineDeadlines,
}

impl NativePipelineConfig {
    /// Combine already validated memory, parallelism, and deadline policies.
    #[must_use]
    pub const fn new(
        limits: NativePipelineLimits,
        parallelism: NativePipelineParallelism,
        deadlines: NativePipelineDeadlines,
    ) -> Self {
        Self {
            limits,
            parallelism,
            deadlines,
        }
    }

    fn stage_deadlines(self) -> StageDeadlinePolicy {
        let now = Instant::now();
        StageDeadlinePolicy::new(
            now.checked_add(self.deadlines.stage_timeout).unwrap_or(now),
            self.deadlines.cleanup_grace,
        )
    }
}

/// A native pipeline policy was zero, overflowed, or exceeded a hard ceiling.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
#[error("invalid {field} in native pipeline configuration")]
pub struct NativePipelineConfigError {
    /// Stable field name without project data.
    pub field: &'static str,
}

impl NativePipelineConfigError {
    const fn invalid(field: &'static str) -> Self {
        Self { field }
    }
}

/// Fixed-size accounting for one complete native source-to-facts build.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct NativePipelineReport {
    discovered_files: u64,
    source_bytes: u64,
    symbols: u64,
    resolved_references: u64,
    unresolved_references: u64,
    diagnostics: u64,
    modeled_generation_bytes: u64,
    resolve_high_water_bytes: u64,
    validation_high_water_bytes: u64,
}

impl NativePipelineReport {
    /// Supported source files admitted by discovery.
    #[must_use]
    pub const fn discovered_files(self) -> u64 {
        self.discovered_files
    }

    /// Exact source bytes hashed and then revalidated before parsing.
    #[must_use]
    pub const fn source_bytes(self) -> u64 {
        self.source_bytes
    }

    /// Native declarations emitted into the generation.
    #[must_use]
    pub const fn symbols(self) -> u64 {
        self.symbols
    }

    /// References assigned one deterministic project symbol.
    #[must_use]
    pub const fn resolved_references(self) -> u64 {
        self.resolved_references
    }

    /// Explicit unresolved reference rows retained for later improvements.
    #[must_use]
    pub const fn unresolved_references(self) -> u64 {
        self.unresolved_references
    }

    /// Recoverable parser diagnostics observed but not persisted in the first schema.
    #[must_use]
    pub const fn diagnostics(self) -> u64 {
        self.diagnostics
    }

    /// Conservative Rust-owned bytes retained by the canonical COPY payload.
    #[must_use]
    pub const fn modeled_generation_bytes(self) -> u64 {
        self.modeled_generation_bytes
    }

    /// Conservative cumulative allocation charge observed while resolving facts.
    #[must_use]
    pub const fn resolve_high_water_bytes(self) -> u64 {
        self.resolve_high_water_bytes
    }

    /// Conservative cumulative allocation charge observed while canonicalizing the payload.
    #[must_use]
    pub const fn validation_high_water_bytes(self) -> u64 {
        self.validation_high_water_bytes
    }
}

/// Canonical database facts plus fixed-size build accounting.
pub struct NativeGeneration {
    facts: CanonicalGenerationFacts,
    report: NativePipelineReport,
}

impl fmt::Debug for NativeGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("NativeGeneration")
            .field("report", &self.report)
            .field("files", &self.facts.files().len())
            .field("symbols", &self.facts.symbols().len())
            .field("edges", &self.facts.edges().len())
            .field("references", &self.facts.references().len())
            .field("documents", &self.facts.documents().len())
            .finish()
    }
}

impl NativeGeneration {
    /// Borrow the canonical facts before moving them into generation preparation.
    #[must_use]
    pub const fn facts(&self) -> &CanonicalGenerationFacts {
        &self.facts
    }

    /// Fixed-size discovery, extraction, and resolution accounting.
    #[must_use]
    pub const fn report(&self) -> NativePipelineReport {
        self.report
    }

    /// Split the ready-to-COPY facts from their build report.
    #[must_use]
    pub fn into_parts(self) -> (CanonicalGenerationFacts, NativePipelineReport) {
        (self.facts, self.report)
    }
}

/// Native project ingestion failed without embedding paths, source, or credentials.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum NativePipelineError {
    /// Blocking filesystem and parser work requires Tokio's multi-thread runtime.
    #[error("native pipeline requires a multi-thread Tokio runtime")]
    Runtime,
    /// A bounded stage rejected, cancelled, or failed work.
    #[error(transparent)]
    Stage(#[from] StageRunError),
    /// A supposedly single-output stage violated its internal contract.
    #[error("native pipeline stage output was incomplete")]
    Incomplete,
}

/// Discover, hash, parse, resolve, and canonically reduce native source facts.
///
/// Source buffers are never retained across stages. Read/hash emits a compact manifest, parse
/// reopens each file under its exact observed size and rejects content drift, and ordered parse
/// output is moved into a separately bounded project fact accumulator before the worker
/// reservation is acknowledged.
pub async fn build_native_generation(
    runner: &StageRunner,
    source_root: SourceRoot,
    config: NativePipelineConfig,
) -> Result<NativeGeneration, NativePipelineError> {
    require_multithread_runtime()?;
    let stages = NativeStageContext {
        runner,
        source_root,
        config,
    };
    let discovered = run_discovery_stage(&stages).await?;
    let manifest = run_read_stage(&stages, discovered).await?;
    let report_seed = NativePipelineReport {
        discovered_files: usize_to_u64(manifest.entries.len()),
        source_bytes: manifest.source_bytes,
        ..NativePipelineReport::default()
    };
    let extracted = run_parse_stage(&stages, manifest.entries).await?;
    let (facts, resolution) = run_resolve_stage(&stages, extracted).await?;
    let (facts, validation) = run_reduce_stage(&stages, facts, resolution.retained_bytes).await?;
    let modeled_generation_bytes = validation.output_bytes();
    Ok(NativeGeneration {
        report: NativePipelineReport {
            symbols: usize_to_u64(facts.symbols().len()),
            resolved_references: resolution.resolved,
            unresolved_references: resolution.unresolved,
            diagnostics: resolution.diagnostics,
            modeled_generation_bytes,
            resolve_high_water_bytes: resolution.charged_high_water_bytes,
            validation_high_water_bytes: validation.charged_high_water_bytes(),
            ..report_seed
        },
        facts,
    })
}

struct NativeStageContext<'a> {
    runner: &'a StageRunner,
    source_root: SourceRoot,
    config: NativePipelineConfig,
}

async fn run_discovery_stage(
    stages: &NativeStageContext<'_>,
) -> Result<Vec<DiscoveredSource>, NativePipelineError> {
    let config = stages.config;
    let reservation = config
        .limits
        .discovery_limits
        .max_retained_path_bytes()
        .checked_add(usize_to_u64(size_of::<SourceRoot>()))
        .ok_or(NativePipelineError::Incomplete)?;
    let deadline = config.stage_deadlines();
    let item_deadline = planned_item_deadline(config.deadlines.item_timeout, deadline.deadline());
    let inputs = [StageEnvelope::new(
        StageItemMeta::new(
            StageSequence::new(0),
            0_u8,
            StageItemBudget::new(reservation.max(1), 0, item_deadline),
        ),
        stages.source_root.clone(),
    )];
    let limits = config.limits.discovery_limits;
    let execution = StageExecution::new(
        StageRunConfig::new(PipelineStage::Discover, StageCapacity::new(1, 0), deadline),
        StageWorkload::new(
            inputs,
            move |item: StageWorkItem<u8, SourceRoot>| async move {
                let cancellation = item.cancellation();
                let (_, _, source_root) = item.into_parts();
                block_in_place(move || {
                    source_root
                        .discover_with_cancellation(SourceDiscoveryOptions::new(limits, || {
                            cancellation.is_cancelled()
                        }))
                        .map_err(|_| StageItemFailure)
                })
            },
        ),
        StageFold::new(
            Vec::new(),
            |discovered: &mut Vec<DiscoveredSource>,
             output: StageOutput<u8, Vec<DiscoveredSource>>| {
                let (_, output) = output.into_parts();
                *discovered = output;
                Ok(())
            },
        ),
    );
    stages.runner.execute(execution).await.map_err(Into::into)
}

async fn run_read_stage(
    stages: &NativeStageContext<'_>,
    discovered: Vec<DiscoveredSource>,
) -> Result<SourceManifest, NativePipelineError> {
    let config = stages.config;
    let deadline = config.stage_deadlines();
    let envelopes = ReadEnvelopeIterator {
        sources: discovered.into_iter(),
        sequence: 0,
        item_timeout: config.deadlines.item_timeout,
        stage_deadline: deadline.deadline(),
        maximum_source_bytes: usize_to_u64(config.limits.source_limits.max_source_bytes()),
    };
    let global_limits = config.limits.source_limits;
    let source_root = stages.source_root.clone();
    let execution = StageExecution::new(
        StageRunConfig::new(
            PipelineStage::Read,
            config.parallelism.read_capacity,
            deadline,
        ),
        StageWorkload::new(
            envelopes,
            move |item: StageWorkItem<NormalizedPath, DiscoveredSource>| {
                let source_root = source_root.clone();
                async move {
                    let cancellation = item.cancellation();
                    let (_, _, discovered) = item.into_parts();
                    block_in_place(move || {
                        read_manifest_entry(
                            ReadManifestInput {
                                source_root,
                                discovered,
                                global_limits,
                            },
                            || cancellation.is_cancelled(),
                        )
                    })
                }
            },
        ),
        StageFold::new(
            SourceManifest::new(config.limits.retained.max_manifest_bytes),
            |manifest: &mut SourceManifest,
             output: StageOutput<NormalizedPath, SourceManifestEntry>| {
                let (_, entry) = output.into_parts();
                manifest.push(entry)
            },
        ),
    );
    stages.runner.execute(execution).await.map_err(Into::into)
}

async fn run_parse_stage(
    stages: &NativeStageContext<'_>,
    manifest: Vec<SourceManifestEntry>,
) -> Result<NativeFactAccumulator, NativePipelineError> {
    let config = stages.config;
    let deadline = config.stage_deadlines();
    let envelopes = ParseEnvelopeIterator {
        entries: manifest.into_iter(),
        sequence: 0,
        item_timeout: config.deadlines.item_timeout,
        stage_deadline: deadline.deadline(),
    };
    let source_root = stages.source_root.clone();
    let execution = StageExecution::new(
        StageRunConfig::new(
            PipelineStage::Parse,
            config.parallelism.parse_capacity,
            deadline,
        ),
        StageWorkload::new(
            envelopes,
            move |item: StageWorkItem<FileId, SourceManifestEntry>| {
                let source_root = source_root.clone();
                async move {
                    let cancellation = item.cancellation();
                    let (_, _, manifest) = item.into_parts();
                    block_in_place(move || {
                        parse_manifest_entry(&source_root, manifest, || cancellation.is_cancelled())
                    })
                }
            },
        ),
        StageFold::new(
            NativeFactAccumulator::new(config.limits.retained.max_generation_bytes),
            |facts: &mut NativeFactAccumulator, output: StageOutput<FileId, ExtractedFile>| {
                let (_, file) = output.into_parts();
                facts.push(file)
            },
        ),
    );
    stages.runner.execute(execution).await.map_err(Into::into)
}

async fn run_resolve_stage(
    stages: &NativeStageContext<'_>,
    extracted: NativeFactAccumulator,
) -> Result<(GenerationFacts, ResolutionReport), NativePipelineError> {
    let config = stages.config;
    let deadline = config.stage_deadlines();
    let item_deadline = planned_item_deadline(config.deadlines.item_timeout, deadline.deadline());
    let inputs = [StageEnvelope::new(
        StageItemMeta::new(
            StageSequence::new(0),
            0_u8,
            StageItemBudget::new(
                resolve_reservation(config.limits.retained.max_generation_bytes)?,
                extracted.retained_bytes,
                item_deadline,
            ),
        ),
        extracted,
    )];
    let maximum = config.limits.retained.max_generation_bytes;
    let execution = StageExecution::new(
        StageRunConfig::new(PipelineStage::Resolve, StageCapacity::new(1, 0), deadline),
        StageWorkload::new(
            inputs,
            move |item: StageWorkItem<u8, NativeFactAccumulator>| async move {
                let cancellation = item.cancellation();
                let (_, _, extracted) = item.into_parts();
                block_in_place(move || {
                    resolve_generation(extracted, maximum, || cancellation.is_cancelled())
                })
            },
        ),
        StageFold::new(
            None,
            |resolved: &mut Option<(GenerationFacts, ResolutionReport)>,
             output: StageOutput<u8, (GenerationFacts, ResolutionReport)>| {
                let (_, output) = output.into_parts();
                *resolved = Some(output);
                Ok(())
            },
        ),
    );
    stages
        .runner
        .execute(execution)
        .await?
        .ok_or(NativePipelineError::Incomplete)
}

async fn run_reduce_stage(
    stages: &NativeStageContext<'_>,
    facts: GenerationFacts,
    progress_bytes: u64,
) -> Result<(CanonicalGenerationFacts, GenerationValidationReport), NativePipelineError> {
    let config = stages.config;
    let deadline = config.stage_deadlines();
    let item_deadline = planned_item_deadline(config.deadlines.item_timeout, deadline.deadline());
    let validation_limits =
        generation_validation_limits(config.limits.retained.max_generation_bytes)?;
    let inputs = [StageEnvelope::new(
        StageItemMeta::new(
            StageSequence::new(0),
            0_u8,
            StageItemBudget::new(
                validation_limits.maximum_working_bytes(),
                progress_bytes,
                item_deadline,
            ),
        ),
        facts,
    )];
    let execution =
        StageExecution::new(
            StageRunConfig::new(PipelineStage::Reduce, StageCapacity::new(1, 0), deadline),
            StageWorkload::new(
                inputs,
                move |item: StageWorkItem<u8, GenerationFacts>| async move {
                    let cancellation = item.cancellation();
                    let (_, _, facts) = item.into_parts();
                    block_in_place(move || {
                        validate_generation_facts(facts, validation_limits, || {
                            cancellation.is_cancelled()
                        })
                        .map_err(|_| StageItemFailure)
                    })
                },
            ),
            StageFold::new(
                None,
                |reduced: &mut Option<(CanonicalGenerationFacts, GenerationValidationReport)>,
                 output: StageOutput<
                    u8,
                    (CanonicalGenerationFacts, GenerationValidationReport),
                >| {
                    let (_, output) = output.into_parts();
                    *reduced = Some(output);
                    Ok(())
                },
            ),
        );
    stages
        .runner
        .execute(execution)
        .await?
        .ok_or(NativePipelineError::Incomplete)
}

struct ReadEnvelopeIterator<Inputs> {
    sources: Inputs,
    sequence: u64,
    item_timeout: Duration,
    stage_deadline: Instant,
    maximum_source_bytes: u64,
}

impl<Inputs> Iterator for ReadEnvelopeIterator<Inputs>
where
    Inputs: Iterator<Item = DiscoveredSource>,
{
    type Item = StageEnvelope<NormalizedPath, DiscoveredSource>;

    fn next(&mut self) -> Option<Self::Item> {
        let source = self.sources.next()?;
        let admitted_bytes = source.byte_size().min(self.maximum_source_bytes);
        let reserved_bytes = native_read_reservation(admitted_bytes).unwrap_or(u64::MAX);
        let sequence = StageSequence::new(self.sequence);
        self.sequence = self.sequence.saturating_add(1);
        let key = source.path().clone();
        let item_deadline = planned_item_deadline(self.item_timeout, self.stage_deadline);
        Some(StageEnvelope::new(
            StageItemMeta::new(
                sequence,
                key,
                StageItemBudget::new(reserved_bytes, source.byte_size(), item_deadline),
            ),
            source,
        ))
    }
}

struct ParseEnvelopeIterator<Inputs> {
    entries: Inputs,
    sequence: u64,
    item_timeout: Duration,
    stage_deadline: Instant,
}

impl<Inputs> Iterator for ParseEnvelopeIterator<Inputs>
where
    Inputs: Iterator<Item = SourceManifestEntry>,
{
    type Item = StageEnvelope<FileId, SourceManifestEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        let entry = self.entries.next()?;
        let reserved_bytes = native_extraction_reservation(entry.byte_size).unwrap_or(u64::MAX);
        let sequence = StageSequence::new(self.sequence);
        self.sequence = self.sequence.saturating_add(1);
        let key = entry.file_id.clone();
        let item_deadline = planned_item_deadline(self.item_timeout, self.stage_deadline);
        Some(StageEnvelope::new(
            StageItemMeta::new(
                sequence,
                key,
                StageItemBudget::new(reserved_bytes, entry.byte_size, item_deadline),
            ),
            entry,
        ))
    }
}

#[derive(Debug)]
struct SourceManifestEntry {
    path: NormalizedPath,
    language: SourceLanguage,
    file_id: FileId,
    content_hash: ContentDigest,
    byte_size: u64,
}

impl SourceManifestEntry {
    fn modeled_retained_bytes(&self) -> u64 {
        usize_to_u64(size_of::<Self>())
            .saturating_mul(2)
            .saturating_add(usize_to_u64(self.path.as_str().len()))
            .saturating_add(usize_to_u64(self.file_id.as_str().len()))
            .saturating_add(usize_to_u64(self.content_hash.as_str().len()))
    }
}

struct SourceManifest {
    entries: Vec<SourceManifestEntry>,
    retained_bytes: u64,
    source_bytes: u64,
    maximum_bytes: u64,
}

impl SourceManifest {
    const fn new(maximum_bytes: u64) -> Self {
        Self {
            entries: Vec::new(),
            retained_bytes: 0,
            source_bytes: 0,
            maximum_bytes,
        }
    }

    fn push(&mut self, entry: SourceManifestEntry) -> Result<(), StageItemFailure> {
        let retained_bytes = self
            .retained_bytes
            .checked_add(entry.modeled_retained_bytes())
            .ok_or(StageItemFailure)?;
        let source_bytes = self
            .source_bytes
            .checked_add(entry.byte_size)
            .ok_or(StageItemFailure)?;
        if retained_bytes > self.maximum_bytes {
            return Err(StageItemFailure);
        }
        self.entries
            .try_reserve_exact(1)
            .map_err(|_| StageItemFailure)?;
        self.entries.push(entry);
        self.retained_bytes = retained_bytes;
        self.source_bytes = source_bytes;
        Ok(())
    }
}

struct ReadManifestInput {
    source_root: SourceRoot,
    discovered: DiscoveredSource,
    global_limits: SourceLimits,
}

fn read_manifest_entry<Cancel>(
    input: ReadManifestInput,
    cancelled: Cancel,
) -> Result<SourceManifestEntry, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let ReadManifestInput {
        source_root,
        discovered,
        global_limits,
    } = input;
    let exact_limits = exact_source_limits(discovered.byte_size(), global_limits)?;
    let snapshot = source_root
        .read_with_cancellation(
            discovered.path(),
            SourceReadOptions::new(exact_limits, cancelled),
        )
        .map_err(|_| StageItemFailure)?;
    if snapshot.byte_size() != discovered.byte_size() {
        return Err(StageItemFailure);
    }
    Ok(SourceManifestEntry {
        path: snapshot.path().clone(),
        language: snapshot.language(),
        file_id: snapshot.file_id().clone(),
        content_hash: snapshot.content_hash().clone(),
        byte_size: snapshot.byte_size(),
    })
}

fn parse_manifest_entry<Cancel>(
    source_root: &SourceRoot,
    manifest: SourceManifestEntry,
    mut cancelled: Cancel,
) -> Result<ExtractedFile, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let exact_limits =
        exact_source_limits(manifest.byte_size, exact_limit_ceiling(manifest.byte_size)?)?;
    let snapshot = source_root
        .read_with_cancellation(
            &manifest.path,
            SourceReadOptions::new(exact_limits, &mut cancelled),
        )
        .map_err(|_| StageItemFailure)?;
    if snapshot.byte_size() != manifest.byte_size
        || snapshot.content_hash() != &manifest.content_hash
        || snapshot.file_id() != &manifest.file_id
        || snapshot.language() != manifest.language
    {
        return Err(StageItemFailure);
    }
    let mut extractor = NativeExtractor::new(snapshot.language()).map_err(|_| StageItemFailure)?;
    extractor
        .extract_with_cancellation(&snapshot, cancelled)
        .map_err(|_| StageItemFailure)
}

fn exact_source_limits(
    observed_bytes: u64,
    global_limits: SourceLimits,
) -> Result<SourceLimits, StageItemFailure> {
    if observed_bytes > usize_to_u64(global_limits.max_source_bytes()) {
        return Err(StageItemFailure);
    }
    let exact = usize::try_from(observed_bytes.max(1)).map_err(|_| StageItemFailure)?;
    SourceLimits::new(exact).map_err(|_| StageItemFailure)
}

fn exact_limit_ceiling(observed_bytes: u64) -> Result<SourceLimits, StageItemFailure> {
    let exact = usize::try_from(observed_bytes.max(1)).map_err(|_| StageItemFailure)?;
    SourceLimits::new(exact).map_err(|_| StageItemFailure)
}

struct NativeFactAccumulator {
    files: Vec<NativeFileFacts>,
    retained_bytes: u64,
    maximum_bytes: u64,
    diagnostics: u64,
}

impl NativeFactAccumulator {
    const fn new(maximum_bytes: u64) -> Self {
        Self {
            files: Vec::new(),
            retained_bytes: 0,
            maximum_bytes,
            diagnostics: 0,
        }
    }

    fn push(&mut self, extracted: ExtractedFile) -> Result<(), StageItemFailure> {
        let diagnostics = self
            .diagnostics
            .checked_add(usize_to_u64(extracted.diagnostics.len()))
            .ok_or(StageItemFailure)?;
        let file = NativeFileFacts::from_extracted(extracted)?;
        let file_bytes = file.modeled_retained_bytes();
        let minimum_retained = self
            .retained_bytes
            .checked_add(file_bytes)
            .and_then(|bytes| bytes.checked_add(usize_to_u64(size_of::<NativeFileFacts>())))
            .ok_or(StageItemFailure)?;
        if minimum_retained > self.maximum_bytes {
            return Err(StageItemFailure);
        }
        let old_capacity = self.files.capacity();
        self.files
            .try_reserve_exact(1)
            .map_err(|_| StageItemFailure)?;
        let added_capacity = self.files.capacity().saturating_sub(old_capacity);
        let retained_bytes = self
            .retained_bytes
            .checked_add(file_bytes)
            .and_then(|bytes| {
                bytes.checked_add(
                    usize_to_u64(added_capacity)
                        .saturating_mul(usize_to_u64(size_of::<NativeFileFacts>())),
                )
            })
            .ok_or(StageItemFailure)?;
        if retained_bytes > self.maximum_bytes {
            return Err(StageItemFailure);
        }
        self.files.push(file);
        self.retained_bytes = retained_bytes;
        self.diagnostics = diagnostics;
        Ok(())
    }
}

struct NativeFileFacts {
    file: FileInput,
    symbols: Vec<NativeSymbolFacts>,
    containments: Vec<Containment>,
    references: Vec<ExtractedReference>,
}

impl NativeFileFacts {
    fn from_extracted(extracted: ExtractedFile) -> Result<Self, StageItemFailure> {
        let ExtractedFile {
            file_id,
            path,
            language,
            content_hash,
            byte_size,
            parse_status,
            symbols,
            containments,
            references,
            diagnostics: _,
        } = extracted;
        let mut normalized_symbols = Vec::new();
        normalized_symbols
            .try_reserve(symbols.len())
            .map_err(|_| StageItemFailure)?;
        for symbol in symbols {
            let cartograph_extract::ExtractedSymbol {
                id,
                kind,
                name,
                qualified_name,
                span,
                signature,
                docstring,
                exported,
                default_export,
                async_symbol,
                static_member,
                visibility,
                structural_digest,
            } = symbol;
            normalized_symbols.push(NativeSymbolFacts {
                input: SymbolInput {
                    symbol_id: id,
                    file_id: file_id.clone(),
                    symbol_kind: kind.as_str().to_owned(),
                    qualified_name,
                    signature: persisted_signature(kind, signature),
                    start_byte: span.start_byte(),
                    end_byte: span.end_byte(),
                    start_line: span.start_line(),
                    end_line: span.end_line(),
                    structural_digest,
                },
                name,
                docstring,
                exported,
                default_export,
                async_symbol,
                static_member,
                visibility,
            });
        }
        Ok(Self {
            file: FileInput {
                file_id,
                normalized_path: path.as_str().to_owned(),
                language: language.as_str().to_owned(),
                content_hash,
                byte_size,
                parse_status,
            },
            symbols: normalized_symbols,
            containments,
            references,
        })
    }

    fn modeled_retained_bytes(&self) -> u64 {
        let mut bytes = usize_to_u64(size_of::<Self>())
            .saturating_add(modeled_file_input_bytes(&self.file))
            .saturating_add(vector_capacity_bytes(&self.symbols))
            .saturating_add(vector_capacity_bytes(&self.containments))
            .saturating_add(vector_capacity_bytes(&self.references));
        for symbol in &self.symbols {
            bytes = bytes.saturating_add(symbol.modeled_retained_bytes());
        }
        for containment in &self.containments {
            bytes = bytes
                .saturating_add(usize_to_u64(containment.parent.as_str().len()))
                .saturating_add(usize_to_u64(containment.child.as_str().len()));
        }
        for reference in &self.references {
            bytes = bytes
                .saturating_add(
                    reference
                        .owner
                        .as_ref()
                        .map_or(0, |owner| usize_to_u64(owner.as_str().len())),
                )
                .saturating_add(usize_to_u64(reference.name.capacity()));
        }
        bytes.saturating_add(self.anticipated_output_bytes())
    }

    fn anticipated_output_bytes(&self) -> u64 {
        let path_bytes = usize_to_u64(self.file.normalized_path.len());
        let language_bytes = usize_to_u64(self.file.language.len());
        let mut bytes = UUID_TEXT_BYTES
            .saturating_add(path_bytes)
            .saturating_add(language_bytes)
            .saturating_add(anticipated_file_document_bytes(&self.file));
        for containment in &self.containments {
            bytes = bytes
                .saturating_add(usize_to_u64(containment.parent.as_str().len()))
                .saturating_add(usize_to_u64(containment.child.as_str().len()))
                .saturating_add(usize_to_u64(CONTAINMENT_PROVENANCE.len()));
        }
        for reference in &self.references {
            bytes = bytes
                .saturating_add(reference.owner.as_ref().map_or(0, |owner| {
                    usize_to_u64(owner.as_str().len()).saturating_mul(2)
                }))
                .saturating_add(UUID_TEXT_BYTES.saturating_mul(3))
                .saturating_add(usize_to_u64(reference.name.len()))
                .saturating_add(usize_to_u64(reference.kind.as_str().len()))
                .saturating_add(usize_to_u64(EXACT_PROJECT_PROVENANCE.len()))
                .saturating_add(usize_to_u64(EXACT_PROJECT_PROVENANCE.len()));
        }
        for symbol in &self.symbols {
            bytes = bytes.saturating_add(anticipated_document_bytes(
                symbol,
                path_bytes,
                language_bytes,
            ));
        }
        bytes
    }
}

fn persisted_signature(kind: SymbolKind, signature: Option<String>) -> String {
    if matches!(
        kind,
        SymbolKind::Function | SymbolKind::Method | SymbolKind::Component
    ) {
        signature
            .filter(|value| {
                !value
                    .bytes()
                    .any(|byte| matches!(byte, b'=' | b'\'' | b'"' | b'`'))
            })
            .unwrap_or_default()
    } else {
        String::new()
    }
}

struct NativeSymbolFacts {
    input: SymbolInput,
    name: String,
    docstring: Option<String>,
    exported: bool,
    default_export: bool,
    async_symbol: bool,
    static_member: bool,
    visibility: Option<Visibility>,
}

impl NativeSymbolFacts {
    fn modeled_retained_bytes(&self) -> u64 {
        usize_to_u64(size_of::<Self>())
            .saturating_add(modeled_symbol_input_bytes(&self.input))
            .saturating_add(usize_to_u64(self.name.capacity()))
            .saturating_add(
                self.docstring
                    .as_ref()
                    .map_or(0, |docstring| usize_to_u64(docstring.capacity())),
            )
    }
}

#[derive(Clone)]
struct ResolutionCandidate {
    file_id: FileId,
    symbol_id: SymbolId,
}

type ResolutionCandidates = BTreeMap<String, Vec<ResolutionCandidate>>;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
struct ResolutionReport {
    resolved: u64,
    unresolved: u64,
    diagnostics: u64,
    retained_bytes: u64,
    charged_high_water_bytes: u64,
}

struct ResolveBudget {
    charged_bytes: u64,
    maximum_bytes: u64,
}

impl ResolveBudget {
    fn new(initial_bytes: u64, maximum_bytes: u64) -> Result<Self, StageItemFailure> {
        if initial_bytes > maximum_bytes {
            return Err(StageItemFailure);
        }
        Ok(Self {
            charged_bytes: initial_bytes,
            maximum_bytes,
        })
    }

    fn charge(&mut self, bytes: u64) -> Result<(), StageItemFailure> {
        self.charged_bytes = self
            .charged_bytes
            .checked_add(bytes)
            .ok_or(StageItemFailure)?;
        if self.charged_bytes > self.maximum_bytes {
            Err(StageItemFailure)
        } else {
            Ok(())
        }
    }
}

struct ResolvedTarget {
    symbol_id: SymbolId,
    confidence: f32,
    provenance: &'static str,
}

fn resolve_generation<Cancel>(
    extracted: NativeFactAccumulator,
    maximum_bytes: u64,
    mut cancelled: Cancel,
) -> Result<(GenerationFacts, ResolutionReport), StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    if cancelled() {
        return Err(StageItemFailure);
    }
    let working_limit = maximum_bytes.checked_mul(3).ok_or(StageItemFailure)?;
    let mut budget = ResolveBudget::new(extracted.retained_bytes, working_limit)?;
    let candidates = build_resolution_candidates(&extracted, &mut budget, &mut cancelled)?;
    let diagnostics = extracted.diagnostics;
    let mut report = ResolutionReport {
        diagnostics,
        ..ResolutionReport::default()
    };
    let mut facts = GenerationFacts::default();
    reserve_generation_vectors(&mut facts, &extracted, &mut budget)?;
    {
        let mut output = ResolutionOutput {
            candidates: &candidates,
            facts: &mut facts,
            report: &mut report,
            budget: &mut budget,
        };
        for file in extracted.files {
            output.append_file(file, &mut cancelled)?;
        }
    }
    let measurement = facts
        .measure_retained_bytes(maximum_bytes, &mut cancelled)
        .map_err(|_| StageItemFailure)?;
    budget.charge(measurement.transient_bytes())?;
    report.retained_bytes = measurement.retained_bytes();
    report.charged_high_water_bytes = budget.charged_bytes;
    Ok((facts, report))
}

fn build_resolution_candidates<Cancel>(
    extracted: &NativeFactAccumulator,
    budget: &mut ResolveBudget,
    cancelled: &mut Cancel,
) -> Result<ResolutionCandidates, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let mut candidates = ResolutionCandidates::new();
    for file in &extracted.files {
        if cancelled() {
            return Err(StageItemFailure);
        }
        for symbol in &file.symbols {
            if cancelled() {
                return Err(StageItemFailure);
            }
            if symbol.input.symbol_kind != "import" {
                push_candidate(
                    &mut candidates,
                    ResolutionCandidateInsertion {
                        key: &symbol.name,
                        symbol,
                    },
                    budget,
                )?;
                if symbol.input.qualified_name != symbol.name {
                    push_candidate(
                        &mut candidates,
                        ResolutionCandidateInsertion {
                            key: &symbol.input.qualified_name,
                            symbol,
                        },
                        budget,
                    )?;
                }
            }
        }
    }
    Ok(candidates)
}

struct ResolutionOutput<'a> {
    candidates: &'a ResolutionCandidates,
    facts: &'a mut GenerationFacts,
    report: &'a mut ResolutionReport,
    budget: &'a mut ResolveBudget,
}

struct FileDocumentIdentity {
    file_id: FileId,
    path: String,
    language: String,
}

impl<'a> ResolutionOutput<'a> {
    fn append_file<Cancel>(
        &mut self,
        file: NativeFileFacts,
        cancelled: &mut Cancel,
    ) -> Result<(), StageItemFailure>
    where
        Cancel: FnMut() -> bool,
    {
        if cancelled() {
            return Err(StageItemFailure);
        }
        self.budget.charge(file.anticipated_output_bytes())?;
        let NativeFileFacts {
            file,
            symbols,
            containments,
            references,
        } = file;
        let identity = FileDocumentIdentity {
            file_id: file.file_id.clone(),
            path: try_clone_text(&file.normalized_path)?,
            language: try_clone_text(&file.language)?,
        };
        self.facts.documents.push(SearchDocumentInput {
            document_id: native_document_id("file", identity.file_id.as_str()),
            file_id: Some(identity.file_id.clone()),
            symbol_id: None,
            path: try_clone_text(&identity.path)?,
            language: try_clone_text(&identity.language)?,
            kind: document_kind_for_path(&identity.path, DocumentKind::File),
            qualified_name: String::new(),
            code: try_clone_text(&identity.path)?,
            natural_text: String::new(),
            metadata: json!({
                "byte_size": file.byte_size,
                "parse_status": file.parse_status.as_str(),
            }),
        });
        for containment in containments {
            if cancelled() {
                return Err(StageItemFailure);
            }
            self.facts.edges.push(EdgeInput {
                source_symbol_id: containment.parent,
                target_symbol_id: containment.child,
                kind: EdgeKind::Contains,
                confidence: EXTRACTED_EDGE_CONFIDENCE,
                provenance: CONTAINMENT_PROVENANCE.to_owned(),
            });
        }
        for reference in references {
            if cancelled() {
                return Err(StageItemFailure);
            }
            self.append_reference(&identity.file_id, reference)?;
        }
        for symbol in symbols {
            if cancelled() {
                return Err(StageItemFailure);
            }
            self.append_symbol(&identity, symbol)?;
        }
        self.facts.files.push(file);
        Ok(())
    }

    fn append_reference(
        &mut self,
        file_id: &FileId,
        reference: ExtractedReference,
    ) -> Result<(), StageItemFailure> {
        let target = resolve_reference(self.candidates, file_id, &reference.name);
        if target.is_some() {
            self.report.resolved = self
                .report
                .resolved
                .checked_add(1)
                .ok_or(StageItemFailure)?;
        } else {
            self.report.unresolved = self
                .report
                .unresolved
                .checked_add(1)
                .ok_or(StageItemFailure)?;
        }
        if let Some(target) = target.as_ref()
            && let Some(owner) = reference.owner.clone()
            && owner != target.symbol_id
        {
            self.facts.edges.push(EdgeInput {
                source_symbol_id: owner,
                target_symbol_id: target.symbol_id.clone(),
                kind: reference_edge_kind(reference.kind),
                confidence: target.confidence,
                provenance: target.provenance.to_owned(),
            });
        }
        self.facts
            .references
            .push(reference_input(file_id, reference, target));
        Ok(())
    }

    fn append_symbol(
        &mut self,
        identity: &FileDocumentIdentity,
        symbol: NativeSymbolFacts,
    ) -> Result<(), StageItemFailure> {
        let document_id = native_document_id("symbol", symbol.input.symbol_id.as_str());
        let symbol_id = symbol.input.symbol_id.clone();
        let code = if symbol.input.signature.is_empty() {
            try_clone_text(&symbol.input.qualified_name)?
        } else {
            try_clone_text(&symbol.input.signature)?
        };
        self.facts.documents.push(SearchDocumentInput {
            document_id,
            file_id: Some(identity.file_id.clone()),
            symbol_id: Some(symbol_id),
            path: try_clone_text(&identity.path)?,
            language: try_clone_text(&identity.language)?,
            kind: document_kind_for_path(&identity.path, DocumentKind::Symbol),
            qualified_name: try_clone_text(&symbol.input.qualified_name)?,
            code,
            natural_text: symbol.docstring.unwrap_or_default(),
            metadata: json!({
                "async": symbol.async_symbol,
                "default_export": symbol.default_export,
                "exported": symbol.exported,
                "name": symbol.name,
                "static": symbol.static_member,
                "visibility": symbol.visibility.map(Visibility::as_str),
            }),
        });
        self.facts.symbols.push(symbol.input);
        Ok(())
    }
}

fn reserve_generation_vectors(
    facts: &mut GenerationFacts,
    extracted: &NativeFactAccumulator,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    let files = extracted.files.len();
    let symbols = sum_lengths(&extracted.files, |file| file.symbols.len())?;
    let containments = sum_lengths(&extracted.files, |file| file.containments.len())?;
    let references = sum_lengths(&extracted.files, |file| file.references.len())?;
    budget.charge(
        usize_to_u64(files)
            .saturating_mul(usize_to_u64(size_of::<FileInput>()))
            .saturating_add(
                usize_to_u64(symbols).saturating_mul(usize_to_u64(size_of::<SymbolInput>())),
            )
            .saturating_add(
                usize_to_u64(containments.saturating_add(references))
                    .saturating_mul(usize_to_u64(size_of::<EdgeInput>())),
            )
            .saturating_add(
                usize_to_u64(references).saturating_mul(usize_to_u64(size_of::<ReferenceInput>())),
            )
            .saturating_add(
                usize_to_u64(files.saturating_add(symbols))
                    .saturating_mul(usize_to_u64(size_of::<SearchDocumentInput>())),
            ),
    )?;
    facts
        .files
        .try_reserve_exact(files)
        .map_err(|_| StageItemFailure)?;
    facts
        .symbols
        .try_reserve_exact(symbols)
        .map_err(|_| StageItemFailure)?;
    facts
        .edges
        .try_reserve_exact(containments.saturating_add(references))
        .map_err(|_| StageItemFailure)?;
    facts
        .references
        .try_reserve_exact(references)
        .map_err(|_| StageItemFailure)?;
    facts
        .documents
        .try_reserve_exact(files.saturating_add(symbols))
        .map_err(|_| StageItemFailure)?;
    Ok(())
}

fn sum_lengths(
    files: &[NativeFileFacts],
    length: impl Fn(&NativeFileFacts) -> usize,
) -> Result<usize, StageItemFailure> {
    files.iter().try_fold(0_usize, |total, file| {
        total.checked_add(length(file)).ok_or(StageItemFailure)
    })
}

struct ResolutionCandidateInsertion<'a> {
    key: &'a str,
    symbol: &'a NativeSymbolFacts,
}

fn push_candidate(
    candidates: &mut ResolutionCandidates,
    insertion: ResolutionCandidateInsertion<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    let ResolutionCandidateInsertion { key, symbol } = insertion;
    if !candidates.contains_key(key) {
        budget.charge(
            RESOLUTION_MAP_NODE_ALLOWANCE
                .saturating_add(usize_to_u64(size_of::<(String, Vec<ResolutionCandidate>)>()))
                .saturating_add(usize_to_u64(key.len())),
        )?;
        candidates.insert(try_clone_text(key)?, Vec::new());
    }
    let entries = candidates.get_mut(key).ok_or(StageItemFailure)?;
    budget.charge(
        usize_to_u64(size_of::<ResolutionCandidate>())
            .saturating_add(usize_to_u64(symbol.input.file_id.as_str().len()))
            .saturating_add(usize_to_u64(symbol.input.symbol_id.as_str().len())),
    )?;
    entries.try_reserve_exact(1).map_err(|_| StageItemFailure)?;
    entries.push(ResolutionCandidate {
        file_id: symbol.input.file_id.clone(),
        symbol_id: symbol.input.symbol_id.clone(),
    });
    Ok(())
}

fn resolve_reference(
    candidates: &ResolutionCandidates,
    file_id: &FileId,
    name: &str,
) -> Option<ResolvedTarget> {
    choose_candidate(candidates.get(name).map_or(&[], Vec::as_slice), file_id)
}

fn choose_candidate(
    candidates: &[ResolutionCandidate],
    file_id: &FileId,
) -> Option<ResolvedTarget> {
    let mut same_file = candidates
        .iter()
        .filter(|candidate| &candidate.file_id == file_id);
    if let Some(candidate) = same_file.next()
        && same_file.next().is_none()
    {
        return Some(ResolvedTarget {
            symbol_id: candidate.symbol_id.clone(),
            confidence: EXACT_SAME_FILE_CONFIDENCE,
            provenance: EXACT_SAME_FILE_PROVENANCE,
        });
    }
    if candidates.len() == 1 {
        return Some(ResolvedTarget {
            symbol_id: candidates[0].symbol_id.clone(),
            confidence: EXACT_PROJECT_CONFIDENCE,
            provenance: EXACT_PROJECT_PROVENANCE,
        });
    }
    None
}

fn reference_input(
    file_id: &FileId,
    reference: ExtractedReference,
    target: Option<ResolvedTarget>,
) -> ReferenceInput {
    let (target_symbol_id, confidence, resolution_provenance) = match target {
        Some(target) => (
            Some(target.symbol_id),
            target.confidence,
            target.provenance.to_owned(),
        ),
        None => (
            None,
            UNRESOLVED_CONFIDENCE,
            UNRESOLVED_PROVENANCE.to_owned(),
        ),
    };
    ReferenceInput {
        file_id: file_id.clone(),
        owner_symbol_id: reference.owner,
        target_symbol_id,
        reference_name: reference.name,
        reference_kind: reference.kind.as_str().to_owned(),
        start_byte: reference.span.start_byte(),
        end_byte: reference.span.end_byte(),
        confidence,
        resolution_provenance,
    }
}

const fn reference_edge_kind(kind: ReferenceKind) -> EdgeKind {
    REFERENCE_EDGE_KINDS[kind as usize]
}

fn native_document_id(kind: &str, identity: &str) -> DocumentId {
    let mut hasher = blake3::Hasher::new();
    hasher.update(DOCUMENT_ID_DOMAIN);
    hash_text(&mut hasher, kind);
    hash_text(&mut hasher, identity);
    let digest = hasher.finalize();
    let mut bytes = [0_u8; DOCUMENT_UUID_BYTES];
    bytes.copy_from_slice(&digest.as_bytes()[..DOCUMENT_UUID_BYTES]);
    DocumentId::from_uuid_v8(bytes)
}

fn hash_text(hasher: &mut blake3::Hasher, value: &str) {
    hasher.update(&usize_to_u64(value.len()).to_be_bytes());
    hasher.update(value.as_bytes());
}

fn document_kind_for_path(path: &str, ordinary: DocumentKind) -> DocumentKind {
    if is_test_source_path(path) {
        DocumentKind::Test
    } else {
        ordinary
    }
}

fn modeled_file_input_bytes(file: &FileInput) -> u64 {
    usize_to_u64(size_of::<FileInput>())
        .saturating_add(usize_to_u64(file.file_id.as_str().len()))
        .saturating_add(usize_to_u64(file.normalized_path.capacity()))
        .saturating_add(usize_to_u64(file.language.capacity()))
        .saturating_add(usize_to_u64(file.content_hash.as_str().len()))
}

fn modeled_symbol_input_bytes(symbol: &SymbolInput) -> u64 {
    usize_to_u64(size_of::<SymbolInput>())
        .saturating_add(usize_to_u64(symbol.symbol_id.as_str().len()))
        .saturating_add(usize_to_u64(symbol.file_id.as_str().len()))
        .saturating_add(usize_to_u64(symbol.symbol_kind.capacity()))
        .saturating_add(usize_to_u64(symbol.qualified_name.capacity()))
        .saturating_add(usize_to_u64(symbol.signature.capacity()))
        .saturating_add(usize_to_u64(symbol.structural_digest.as_str().len()))
}

fn anticipated_file_document_bytes(file: &FileInput) -> u64 {
    usize_to_u64(size_of::<SearchDocumentInput>())
        .saturating_add(UUID_TEXT_BYTES.saturating_mul(2))
        .saturating_add(usize_to_u64(file.normalized_path.len()).saturating_mul(2))
        .saturating_add(usize_to_u64(file.language.len()))
        .saturating_add(DOCUMENT_METADATA_FIXED_ALLOWANCE)
}

fn anticipated_document_bytes(
    symbol: &NativeSymbolFacts,
    path_bytes: u64,
    language_bytes: u64,
) -> u64 {
    let code_bytes = if symbol.input.signature.is_empty() {
        usize_to_u64(symbol.input.qualified_name.len())
    } else {
        usize_to_u64(symbol.input.signature.len())
    };
    usize_to_u64(size_of::<SearchDocumentInput>())
        .saturating_add(UUID_TEXT_BYTES.saturating_mul(3))
        .saturating_add(path_bytes)
        .saturating_add(language_bytes)
        .saturating_add(usize_to_u64(symbol.input.qualified_name.len()))
        .saturating_add(code_bytes)
        .saturating_add(
            symbol
                .docstring
                .as_ref()
                .map_or(0, |docstring| usize_to_u64(docstring.len())),
        )
        .saturating_add(usize_to_u64(symbol.name.capacity()))
        .saturating_add(DOCUMENT_METADATA_FIXED_ALLOWANCE)
}

fn try_clone_text(value: &str) -> Result<String, StageItemFailure> {
    let mut cloned = String::new();
    cloned
        .try_reserve(value.len())
        .map_err(|_| StageItemFailure)?;
    cloned.push_str(value);
    Ok(cloned)
}

fn resolve_reservation(maximum_generation_bytes: u64) -> Result<u64, NativePipelineError> {
    maximum_generation_bytes
        .checked_mul(3)
        .ok_or(NativePipelineError::Incomplete)
}

fn generation_validation_limits(
    maximum_generation_bytes: u64,
) -> Result<GenerationValidationLimits, NativePipelineError> {
    let maximum_working_bytes = maximum_generation_bytes
        .checked_mul(VALIDATION_WORKING_MULTIPLIER)
        .ok_or(NativePipelineError::Incomplete)?;
    GenerationValidationLimits::new(maximum_generation_bytes, maximum_working_bytes)
        .map_err(|_| NativePipelineError::Incomplete)
}

fn vector_capacity_bytes<T>(values: &Vec<T>) -> u64 {
    usize_to_u64(values.capacity()).saturating_mul(usize_to_u64(size_of::<T>()))
}

fn validate_retained_limit(
    value: u64,
    field: &'static str,
) -> Result<(), NativePipelineConfigError> {
    if value == 0 || value > MAX_PIPELINE_RETAINED_BYTES {
        Err(NativePipelineConfigError::invalid(field))
    } else {
        Ok(())
    }
}

fn validate_capacity(
    capacity: StageCapacity,
    field: &'static str,
) -> Result<(), NativePipelineConfigError> {
    if capacity.workers() == 0
        || capacity
            .workers()
            .checked_add(capacity.queued_items())
            .is_none()
    {
        Err(NativePipelineConfigError::invalid(field))
    } else {
        Ok(())
    }
}

fn require_multithread_runtime() -> Result<(), NativePipelineError> {
    let runtime = Handle::try_current().map_err(|_| NativePipelineError::Runtime)?;
    if matches!(runtime.runtime_flavor(), RuntimeFlavor::MultiThread) {
        Ok(())
    } else {
        Err(NativePipelineError::Runtime)
    }
}

fn planned_item_deadline(item_timeout: Duration, stage_deadline: Instant) -> Instant {
    Instant::now()
        .checked_add(item_timeout)
        .unwrap_or(stage_deadline)
        .min(stage_deadline)
}

fn usize_to_u64(value: usize) -> u64 {
    u64::try_from(value).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use std::{cell::Cell, collections::BTreeSet, fs, time::Duration};

    use tempfile::tempdir;

    use super::*;
    use crate::stage::test_stage_runner;

    const TEST_FILES: usize = 128;
    const TEST_PATH_BYTES: u64 = 2 * 1024 * 1024;
    const TEST_SOURCE_BYTES: usize = 1024 * 1024;
    const TEST_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
    const TEST_GENERATION_BYTES: u64 = 32 * 1024 * 1024;
    const TEST_SCOPE_BYTES: u64 = 128 * 1024 * 1024;
    const TEST_TIMEOUT: Duration = Duration::from_secs(5);
    const CLEANUP_GRACE: Duration = Duration::from_millis(500);
    const SERIAL_WORKERS: usize = 1;
    const PARALLEL_WORKERS: usize = 4;
    const DRIFT_SCOPE_TASKS: usize = 8;
    const EXPECTED_SOURCE_FILES: u64 = 3;
    const EXPECTED_MINIMUM_SYMBOLS: u64 = 4;
    const EXPECTED_MINIMUM_RESOLVED_REFERENCES: u64 = 3;
    const REJECTING_GENERATION_BYTES: u64 = 1;
    const INITIALIZER_SECRET: &str = "sk-cartograph-never-index-this";
    const SCALAR_DEFAULT_SECRET: &str = "sk-cartograph-scalar-default";
    const DESTRUCTURED_DEFAULT_SECRET: &str = "sk-cartograph-destructured-default";
    const ARROW_DEFAULT_SECRET: &str = "sk-cartograph-arrow-default";
    const METHOD_DEFAULT_SECRET: &str = "sk-cartograph-method-default";
    const COMPONENT_DEFAULT_SECRET: &str = "sk-cartograph-component-default";
    const SECRET_LITERAL_COUNT: usize = 6;
    const LONG_PATH_COMPONENT_BYTES: usize = 190;
    const LONG_PATH_COMPONENT_COUNT: usize = 11;
    const MINIMUM_LONG_PATH_BYTES: usize = 2_048;
    const MANY_SYMBOL_COUNT: usize = 256;
    const CANCELLATION_SYMBOL_COUNT: usize = 512;
    const CANCEL_AFTER_POLLS: u64 = 16;

    fn config(workers: usize) -> NativePipelineConfig {
        config_with_generation_limit(workers, TEST_GENERATION_BYTES)
    }

    fn config_with_generation_limit(workers: usize, generation_bytes: u64) -> NativePipelineConfig {
        let discovery = match DiscoveryLimits::new(TEST_FILES, TEST_PATH_BYTES) {
            Ok(discovery) => discovery,
            Err(error) => panic!("test discovery limits were invalid: {error}"),
        };
        let source = match SourceLimits::new(TEST_SOURCE_BYTES) {
            Ok(source) => source,
            Err(error) => panic!("test source limits were invalid: {error}"),
        };
        let retained = match NativeRetainedLimits::new(TEST_MANIFEST_BYTES, generation_bytes) {
            Ok(retained) => retained,
            Err(error) => panic!("test retained limits were invalid: {error}"),
        };
        let limits = NativePipelineLimits::new(discovery, source, retained);
        let parallelism = match NativePipelineParallelism::new(
            StageCapacity::new(workers, workers),
            StageCapacity::new(workers, workers),
        ) {
            Ok(parallelism) => parallelism,
            Err(error) => panic!("test native pipeline parallelism was invalid: {error}"),
        };
        let deadlines =
            match NativePipelineDeadlines::new(TEST_TIMEOUT, TEST_TIMEOUT, CLEANUP_GRACE) {
                Ok(deadlines) => deadlines,
                Err(error) => panic!("test native pipeline deadlines were invalid: {error}"),
            };
        NativePipelineConfig::new(limits, parallelism, deadlines)
    }

    fn write_project(root: &std::path::Path) {
        assert!(fs::create_dir(root.join(".git")).is_ok());
        assert!(fs::create_dir_all(root.join("src/ignored")).is_ok());
        assert!(fs::write(root.join(".gitignore"), "src/ignored/\n").is_ok());
        assert!(fs::write(root.join("src/ignored/no.ts"), "export const no = 1;\n").is_ok());
        assert!(
            fs::write(
                root.join("src/service.ts"),
                "export class Base {}\nexport interface Greeter {}\nexport function format(): string { return 'ok'; }\nexport class Service extends Base implements Greeter {\n  greet(): string { return format(); }\n  use(): void { this.greet; }\n}\n",
            )
            .is_ok()
        );
        assert!(
            fs::write(
                root.join("src/build.ts"),
                "import { Service } from './service';\nexport function build(): Service { return new Service(); }\n",
            )
            .is_ok()
        );
        assert!(
            fs::write(
                root.join("src/view.test.tsx"),
                "export function View(): JSX.Element { return <Service />; }\n",
            )
            .is_ok()
        );
    }

    async fn build(root: &std::path::Path, workers: usize) -> NativeGeneration {
        let (runner, tasks, cancellation) = test_stage_runner(
            workers.saturating_mul(2).saturating_add(4),
            TEST_SCOPE_BYTES,
        )
        .await;
        let source_root = match SourceRoot::open(root) {
            Ok(source_root) => source_root,
            Err(error) => panic!("could not open pipeline fixture: {error}"),
        };
        let generation = match build_native_generation(&runner, source_root, config(workers)).await
        {
            Ok(generation) => generation,
            Err(error) => panic!("native pipeline failed: {error}"),
        };
        drop(cancellation);
        let report = tasks
            .close_abort_and_reap(Instant::now() + TEST_TIMEOUT)
            .await;
        assert!(report.all_joined);
        assert!(!report.worker_failed);
        assert!(!report.unobserved_results);
        generation
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn pipeline_is_gitignore_aware_resolves_unique_symbols_and_is_worker_deterministic() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create pipeline fixture: {error}"),
        };
        write_project(directory.path());
        let serial = build(directory.path(), SERIAL_WORKERS).await;
        let parallel = build(directory.path(), PARALLEL_WORKERS).await;
        assert_eq!(serial.report(), parallel.report());
        assert_eq!(serial.facts().digest(), parallel.facts().digest());
        assert_eq!(serial.report().discovered_files(), EXPECTED_SOURCE_FILES);
        assert!(serial.report().symbols() >= EXPECTED_MINIMUM_SYMBOLS);
        assert!(serial.report().resolved_references() >= EXPECTED_MINIMUM_RESOLVED_REFERENCES);
        assert!(
            serial
                .facts()
                .edges()
                .iter()
                .any(|edge| edge.kind == EdgeKind::Implements)
        );
        assert!(
            serial
                .facts()
                .edges()
                .iter()
                .any(|edge| edge.kind == EdgeKind::Instantiates)
        );
        assert!(serial.facts().references().iter().any(|reference| {
            reference.target_symbol_id.is_none()
                && !reference.reference_name.is_empty()
                && reference.owner_symbol_id.is_some()
                && reference.resolution_provenance == UNRESOLVED_PROVENANCE
        }));
        assert!(
            serial
                .facts()
                .documents()
                .iter()
                .any(|document| document.kind() == DocumentKind::Test)
        );
        let reference_kinds = serial
            .facts()
            .references()
            .iter()
            .map(|reference| reference.reference_kind.as_str())
            .collect::<BTreeSet<_>>();
        for expected in [
            "calls",
            "imports",
            "references",
            "implements",
            "extends",
            "type_of",
            "returns",
            "instantiates",
            "field_access",
        ] {
            assert!(reference_kinds.contains(expected), "{expected}");
        }
        let edge_kinds = serial
            .facts()
            .edges()
            .iter()
            .map(|edge| edge.kind.as_str())
            .collect::<BTreeSet<_>>();
        for expected in [
            "calls",
            "references",
            "implements",
            "extends",
            "type_of",
            "returns",
            "instantiates",
            "field_access",
            "contains",
        ] {
            assert!(edge_kinds.contains(expected), "{expected}");
        }
        assert_eq!(
            serial.facts().documents().len(),
            serial.facts().files().len() + serial.facts().symbols().len()
        );
        let debug = format!("{serial:?}");
        assert!(!debug.contains("Service"));
        assert!(!debug.contains("src/service.ts"));
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn test_qualified_members_remain_unresolved_and_sensitive_literals_are_redacted() {
        const SECRET_LITERALS: [&str; SECRET_LITERAL_COUNT] = [
            INITIALIZER_SECRET,
            SCALAR_DEFAULT_SECRET,
            DESTRUCTURED_DEFAULT_SECRET,
            ARROW_DEFAULT_SECRET,
            METHOD_DEFAULT_SECRET,
            COMPONENT_DEFAULT_SECRET,
        ];
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create resolver fixture: {error}"),
        };
        assert!(
            fs::write(
                directory.path().join("local.ts"),
                format!(
                    "export function log(): void {{}}\n\
                     export class A {{ log(): void {{}} }}\n\
                     export class B {{ log(): void {{}} }}\n\
                     export function local(): void {{ console.log('x'); }}\n\
                     export const credentials = {{ token: '{}' }};\n\
                     export function scalar(token = '{}'): void {{}}\n\
                     export function destructured({{ token = '{}' }} = {{}}): void {{}}\n\
                     export const arrow = (token = '{}'): void => {{}};\n\
                     export class Client {{ method(token = '{}'): void {{}} }}\n\
                     export function Component({{ token = '{}' }} = {{}}): null {{ return null; }}\n",
                    INITIALIZER_SECRET,
                    SCALAR_DEFAULT_SECRET,
                    DESTRUCTURED_DEFAULT_SECRET,
                    ARROW_DEFAULT_SECRET,
                    METHOD_DEFAULT_SECRET,
                    COMPONENT_DEFAULT_SECRET,
                ),
            )
            .is_ok()
        );
        assert!(
            fs::write(
                directory.path().join("remote.ts"),
                "export function remote(): void { console.log('y'); }\n",
            )
            .is_ok()
        );

        let generation = build(directory.path(), PARALLEL_WORKERS).await;
        let console_references = generation
            .facts()
            .references()
            .iter()
            .filter(|reference| reference.reference_name == "console.log")
            .collect::<Vec<_>>();
        assert_eq!(console_references.len(), 2);
        assert!(console_references.iter().all(|reference| {
            reference.target_symbol_id.is_none()
                && reference.owner_symbol_id.is_some()
                && reference.confidence == UNRESOLVED_CONFIDENCE
                && reference.resolution_provenance == UNRESOLVED_PROVENANCE
        }));
        assert!(
            generation
                .facts()
                .symbols()
                .iter()
                .filter(|symbol| symbol.qualified_name.ends_with("credentials"))
                .all(|symbol| symbol.signature.is_empty())
        );
        for secret in SECRET_LITERALS {
            assert!(
                generation
                    .facts()
                    .symbols()
                    .iter()
                    .all(|symbol| !symbol.signature.contains(secret))
            );
            assert!(generation.facts().documents().iter().all(|document| {
                !document.code().contains(secret)
                    && !document.natural_text().contains(secret)
                    && !document.metadata_json().contains(secret)
            }));
        }
    }

    #[test]
    fn long_paths_and_many_symbols_stay_inside_resolve_and_validation_charges() {
        let component = "p".repeat(LONG_PATH_COMPONENT_BYTES);
        let directory = std::iter::repeat_n(component.as_str(), LONG_PATH_COMPONENT_COUNT)
            .collect::<Vec<_>>()
            .join("/");
        let path = format!("{directory}/many.ts");
        assert!(path.len() > MINIMUM_LONG_PATH_BYTES);
        let source = (0..MANY_SYMBOL_COUNT)
            .map(|index| format!("export function symbol_{index}(): void {{}}\n"))
            .collect::<String>();
        let limits = SourceLimits::new(TEST_SOURCE_BYTES)
            .unwrap_or_else(|error| panic!("source limits were invalid: {error}"));
        let snapshot =
            cartograph_extract::SourceSnapshot::from_bytes(&path, source.as_bytes(), limits)
                .unwrap_or_else(|error| panic!("long-path snapshot was rejected: {error}"));
        let mut extractor = NativeExtractor::new(snapshot.language())
            .unwrap_or_else(|error| panic!("native extractor was unavailable: {error}"));
        let extracted = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("long-path extraction failed: {error}"));
        let mut accumulator = NativeFactAccumulator::new(TEST_GENERATION_BYTES);
        accumulator
            .push(extracted)
            .unwrap_or_else(|_| panic!("long-path facts exceeded the modeled input limit"));
        let (facts, resolve) = resolve_generation(accumulator, TEST_GENERATION_BYTES, || false)
            .unwrap_or_else(|_| panic!("long-path resolution exceeded its declared budget"));
        assert!(
            resolve.charged_high_water_bytes
                <= resolve_reservation(TEST_GENERATION_BYTES)
                    .unwrap_or_else(|error| panic!("resolve reservation failed: {error}"))
        );
        let validation_limits = generation_validation_limits(TEST_GENERATION_BYTES)
            .unwrap_or_else(|error| panic!("validation limits failed: {error}"));
        let (canonical, validation) = validate_generation_facts(facts, validation_limits, || false)
            .unwrap_or_else(|error| panic!("long-path validation failed: {error}"));
        assert!(validation.charged_high_water_bytes() <= validation_limits.maximum_working_bytes());
        let file_document = canonical
            .documents()
            .iter()
            .find(|document| document.symbol_id().is_none())
            .unwrap_or_else(|| panic!("file search document was missing"));
        assert!(file_document.qualified_name().is_empty());
        assert_eq!(file_document.code(), path);
    }

    #[test]
    fn resolve_polls_cancellation_between_candidate_symbols() {
        let source = (0..CANCELLATION_SYMBOL_COUNT)
            .map(|index| format!("export function symbol_{index}(): void {{}}\n"))
            .collect::<String>();
        let limits = SourceLimits::new(TEST_SOURCE_BYTES)
            .unwrap_or_else(|error| panic!("source limits were invalid: {error}"));
        let snapshot =
            cartograph_extract::SourceSnapshot::from_bytes("many.ts", source.as_bytes(), limits)
                .unwrap_or_else(|error| panic!("cancellation snapshot failed: {error}"));
        let mut extractor = NativeExtractor::new(snapshot.language())
            .unwrap_or_else(|error| panic!("native extractor was unavailable: {error}"));
        let extracted = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("cancellation extraction failed: {error}"));
        let mut accumulator = NativeFactAccumulator::new(TEST_GENERATION_BYTES);
        accumulator
            .push(extracted)
            .unwrap_or_else(|_| panic!("cancellation facts exceeded the modeled input limit"));
        let polls = Cell::new(0_u64);
        let result = resolve_generation(accumulator, TEST_GENERATION_BYTES, || {
            let next = polls.get().saturating_add(1);
            polls.set(next);
            next >= CANCEL_AFTER_POLLS
        });
        assert!(matches!(result, Err(StageItemFailure)));
        assert_eq!(polls.get(), CANCEL_AFTER_POLLS);
    }

    #[test]
    fn unresolved_reference_edge_capacity_is_part_of_the_retained_proof() {
        let calls = (0..256)
            .map(|index| format!("missing_{index}();"))
            .collect::<String>();
        let source = format!("export function owner(): void {{ {calls} }}\n");
        let limits = SourceLimits::new(TEST_SOURCE_BYTES)
            .unwrap_or_else(|error| panic!("source limits were invalid: {error}"));
        let snapshot = cartograph_extract::SourceSnapshot::from_bytes(
            "unresolved.ts",
            source.as_bytes(),
            limits,
        )
        .unwrap_or_else(|error| panic!("unresolved snapshot failed: {error}"));
        let mut extractor = NativeExtractor::new(snapshot.language())
            .unwrap_or_else(|error| panic!("native extractor was unavailable: {error}"));
        let extracted = extractor
            .extract(&snapshot)
            .unwrap_or_else(|error| panic!("unresolved extraction failed: {error}"));
        let mut accumulator = NativeFactAccumulator::new(TEST_GENERATION_BYTES);
        accumulator
            .push(extracted)
            .unwrap_or_else(|_| panic!("unresolved facts exceeded the modeled input limit"));
        let (facts, report) = resolve_generation(accumulator, TEST_GENERATION_BYTES, || false)
            .unwrap_or_else(|_| panic!("unresolved resolution exceeded its declared budget"));
        assert_eq!(report.resolved, 0);
        assert_eq!(report.unresolved, 256);
        assert!(facts.edges.is_empty());
        assert!(facts.edges.capacity() >= facts.references.len());
        let edge_capacity_bytes = usize_to_u64(facts.edges.capacity())
            .saturating_mul(usize_to_u64(size_of::<EdgeInput>()));
        assert!(report.retained_bytes >= edge_capacity_bytes);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn pipeline_rejects_storage_oversized_names_and_signatures_before_returning() {
        let long_name = "n".repeat(2_049);
        assert_storage_boundary_rejection(format!("export function {long_name}(): void {{}}\n"))
            .await;

        let long_type = "T".repeat(65_537);
        assert_storage_boundary_rejection(format!(
            "export function bounded(value: {long_type}): void {{}}\n"
        ))
        .await;
    }

    async fn assert_storage_boundary_rejection(source: String) {
        let directory = tempdir()
            .unwrap_or_else(|error| panic!("could not create storage-boundary fixture: {error}"));
        assert!(fs::write(directory.path().join("oversized.ts"), source).is_ok());
        let source_root = SourceRoot::open(directory.path())
            .unwrap_or_else(|error| panic!("could not open storage-boundary fixture: {error}"));
        let (runner, tasks, cancellation) =
            test_stage_runner(DRIFT_SCOPE_TASKS, TEST_SCOPE_BYTES).await;
        let result = build_native_generation(&runner, source_root, config(SERIAL_WORKERS)).await;
        assert!(matches!(
            result,
            Err(NativePipelineError::Stage(StageRunError::Item {
                stage: PipelineStage::Reduce,
                kind: crate::StageFailureKind::Worker,
                ..
            }))
        ));
        drop(cancellation);
        let report = tasks
            .close_abort_and_reap(Instant::now() + TEST_TIMEOUT)
            .await;
        assert!(report.all_joined);
        assert!(report.worker_failed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn parse_refuses_content_drift_after_the_read_manifest() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create pipeline fixture: {error}"),
        };
        assert!(
            fs::write(
                directory.path().join("drift.ts"),
                "export const before = 1;\n"
            )
            .is_ok()
        );
        let source_root = match SourceRoot::open(directory.path()) {
            Ok(source_root) => source_root,
            Err(error) => panic!("could not open pipeline fixture: {error}"),
        };
        let (runner, tasks, cancellation) =
            test_stage_runner(DRIFT_SCOPE_TASKS, TEST_SCOPE_BYTES).await;
        let stages = NativeStageContext {
            runner: &runner,
            source_root,
            config: config(SERIAL_WORKERS),
        };
        let discovered = match run_discovery_stage(&stages).await {
            Ok(discovered) => discovered,
            Err(error) => panic!("discovery failed: {error}"),
        };
        let manifest = match run_read_stage(&stages, discovered).await {
            Ok(manifest) => manifest,
            Err(error) => panic!("read stage failed: {error}"),
        };
        assert!(
            fs::write(
                directory.path().join("drift.ts"),
                "export const afterx = 2;\n"
            )
            .is_ok()
        );
        assert!(matches!(
            run_parse_stage(&stages, manifest.entries).await,
            Err(NativePipelineError::Stage(StageRunError::Item {
                stage: PipelineStage::Parse,
                ..
            }))
        ));
        drop(cancellation);
        let report = tasks
            .close_abort_and_reap(Instant::now() + TEST_TIMEOUT)
            .await;
        assert!(report.all_joined);
        assert!(report.worker_failed);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn retained_generation_limit_fails_before_unbounded_accumulation() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create pipeline fixture: {error}"),
        };
        write_project(directory.path());
        let source_root = match SourceRoot::open(directory.path()) {
            Ok(source_root) => source_root,
            Err(error) => panic!("could not open pipeline fixture: {error}"),
        };
        let (runner, tasks, cancellation) =
            test_stage_runner(DRIFT_SCOPE_TASKS, TEST_SCOPE_BYTES).await;
        let result = build_native_generation(
            &runner,
            source_root,
            config_with_generation_limit(SERIAL_WORKERS, REJECTING_GENERATION_BYTES),
        )
        .await;
        assert!(matches!(
            result,
            Err(NativePipelineError::Stage(StageRunError::Reduce {
                stage: PipelineStage::Parse,
                ..
            }))
        ));
        drop(cancellation);
        let report = tasks
            .close_abort_and_reap(Instant::now() + TEST_TIMEOUT)
            .await;
        assert!(report.all_joined);
        assert!(report.worker_failed);
    }

    #[test]
    fn config_rejects_zero_capacity_and_unbounded_memory() {
        assert!(matches!(
            NativePipelineParallelism::new(
                StageCapacity::new(0, 0),
                StageCapacity::new(SERIAL_WORKERS, SERIAL_WORKERS),
            ),
            Err(error) if error == NativePipelineConfigError::invalid("read_capacity")
        ));
        assert!(matches!(
            NativeRetainedLimits::new(
                TEST_MANIFEST_BYTES,
                MAX_PIPELINE_RETAINED_BYTES + 1,
            ),
            Err(error) if error == NativePipelineConfigError::invalid("max_generation_bytes")
        ));
    }
}
