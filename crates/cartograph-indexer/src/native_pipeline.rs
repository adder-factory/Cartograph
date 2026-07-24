use std::{collections::BTreeMap, fmt, mem::size_of, time::Duration};

use cartograph_db::{
    CanonicalGenerationFacts, EdgeInput, FileInput, GenerationFacts, GenerationValidationLimits,
    GenerationValidationReport, ReferenceInput, SearchDocumentInput, SymbolInput,
    validate_generation_facts,
};
use cartograph_domain::{
    ContentDigest, DocumentId, DocumentKind, EdgeKind, FileId, NormalizedPath, ReferenceKind,
    SourceLanguage, SourceSpan, SymbolId, SymbolKind, Visibility,
};
use cartograph_extract::{
    Containment, DiscoveredSource, DiscoveryLimits, ExtractedFile, ExtractedImportBinding,
    ExtractedReference, ImportBindingKind, NativeExtractor, SourceDiscoveryOptions, SourceLimits,
    SourceReadOptions, SourceRoot, is_test_source_path, native_extraction_reservation,
    native_read_reservation,
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
const EXACT_LEXICAL_PROVENANCE: &str = "native-exact-lexical";
const IMPORT_BINDING_PROVENANCE: &str = "native-import-binding";
const EXACT_SAME_FILE_PROVENANCE: &str = "native-exact-same-file";
const EXACT_PROJECT_PROVENANCE: &str = "native-exact-project";
const UNRESOLVED_IMPORT_PROVENANCE: &str = "native-unresolved-import";
const UNRESOLVED_PROVENANCE: &str = "native-unresolved";
const EXACT_LEXICAL_CONFIDENCE: f32 = 1.0;
const IMPORT_BINDING_CONFIDENCE: f32 = 1.0;
const EXACT_SAME_FILE_CONFIDENCE: f32 = 1.0;
const EXACT_PROJECT_CONFIDENCE: f32 = 0.95;
const EXTRACTED_EDGE_CONFIDENCE: f32 = 1.0;
const UNRESOLVED_CONFIDENCE: f32 = 0.0;
const DOCUMENT_METADATA_FIXED_ALLOWANCE: u64 = 2 * 1024;
const DOCUMENT_UUID_BYTES: usize = 16;
const UUID_TEXT_BYTES: u64 = 36;
const MAX_RESOLUTION_PROVENANCE_BYTES: u64 = 64;
const VALIDATION_WORKING_MULTIPLIER: u64 = 4;
const RESOLUTION_MAP_NODE_ALLOWANCE: u64 = 128;
const MODULE_EXTENSIONS: [&str; 15] = [
    ".d.ts", ".d.mts", ".d.cts", ".pyi", ".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs",
    ".cjs", ".rs", ".py", ".go",
];
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
    import_bindings: Vec<ExtractedImportBinding>,
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
            import_bindings,
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
                body_search_text,
                body_search_truncated,
                declaration_only,
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
                kind,
                name,
                docstring,
                body_search_text,
                body_search_truncated,
                declaration_only,
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
            import_bindings,
        })
    }

    fn modeled_retained_bytes(&self) -> u64 {
        let mut bytes = usize_to_u64(size_of::<Self>())
            .saturating_add(modeled_file_input_bytes(&self.file))
            .saturating_add(vector_capacity_bytes(&self.symbols))
            .saturating_add(vector_capacity_bytes(&self.containments))
            .saturating_add(vector_capacity_bytes(&self.references))
            .saturating_add(vector_capacity_bytes(&self.import_bindings));
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
        for binding in &self.import_bindings {
            bytes = bytes
                .saturating_add(usize_to_u64(binding.module_specifier.capacity()))
                .saturating_add(usize_to_u64(binding.imported_name.capacity()))
                .saturating_add(usize_to_u64(binding.local_name.capacity()));
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
                .saturating_add(MAX_RESOLUTION_PROVENANCE_BYTES.saturating_mul(2));
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
    kind: SymbolKind,
    name: String,
    docstring: Option<String>,
    body_search_text: String,
    body_search_truncated: bool,
    declaration_only: bool,
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
            .saturating_add(usize_to_u64(self.body_search_text.capacity()))
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
    parent_symbol_id: Option<SymbolId>,
    kind: SymbolKind,
    exported: bool,
    declaration_only: bool,
    top_level: bool,
}

type CandidateMap = BTreeMap<String, Vec<ResolutionCandidate>>;
type DefaultExportMap = BTreeMap<FileId, Vec<ResolutionCandidate>>;
type ParentMap = BTreeMap<SymbolId, SymbolId>;
type ModulePathMap = BTreeMap<String, Vec<FileId>>;
type FileResolutionContextMap = BTreeMap<FileId, ResolutionFileContext>;

struct ResolutionFileContext {
    directory: String,
    language: String,
    package: Option<String>,
}

#[derive(Default)]
struct ModulePathIndex {
    exact: ModulePathMap,
    stem: ModulePathMap,
    directory_index: ModulePathMap,
    files: FileResolutionContextMap,
}

#[derive(Default)]
struct ResolutionIndex {
    candidates: CandidateMap,
    default_exports: DefaultExportMap,
    parents: ParentMap,
    modules: ModulePathIndex,
}

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

struct ReferenceResolution {
    target: Option<ResolvedTarget>,
    unresolved_provenance: &'static str,
}

impl ReferenceResolution {
    fn resolved(target: ResolvedTarget) -> Self {
        Self {
            target: Some(target),
            unresolved_provenance: UNRESOLVED_PROVENANCE,
        }
    }

    const fn unresolved(provenance: &'static str) -> Self {
        Self {
            target: None,
            unresolved_provenance: provenance,
        }
    }
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
    let index = build_resolution_index(&extracted, &mut budget, &mut cancelled)?;
    let diagnostics = extracted.diagnostics;
    let mut report = ResolutionReport {
        diagnostics,
        ..ResolutionReport::default()
    };
    let mut facts = GenerationFacts::default();
    reserve_generation_vectors(&mut facts, &extracted, &mut budget)?;
    {
        let mut output = ResolutionOutput {
            index: &index,
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

fn build_resolution_index<Cancel>(
    extracted: &NativeFactAccumulator,
    budget: &mut ResolveBudget,
    cancelled: &mut Cancel,
) -> Result<ResolutionIndex, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let mut index = ResolutionIndex::default();
    for file in &extracted.files {
        if cancelled() {
            return Err(StageItemFailure);
        }
        index_module_path(
            &mut index.modules,
            ModuleFileIndexInput {
                file: &file.file,
                package: native_package_name(file),
            },
            budget,
        )?;
        for containment in &file.containments {
            if cancelled() {
                return Err(StageItemFailure);
            }
            insert_parent(&mut index.parents, containment, budget)?;
        }
    }
    for file in &extracted.files {
        if cancelled() {
            return Err(StageItemFailure);
        }
        for symbol in &file.symbols {
            if cancelled() {
                return Err(StageItemFailure);
            }
            if symbol.input.symbol_kind != "import" {
                let parent_symbol_id = index.parents.get(&symbol.input.symbol_id).cloned();
                push_candidate(
                    &mut index.candidates,
                    ResolutionCandidateInsertion {
                        key: &symbol.name,
                        symbol,
                        parent_symbol_id: parent_symbol_id.as_ref(),
                    },
                    budget,
                )?;
                if symbol.input.qualified_name != symbol.name {
                    push_candidate(
                        &mut index.candidates,
                        ResolutionCandidateInsertion {
                            key: &symbol.input.qualified_name,
                            symbol,
                            parent_symbol_id: parent_symbol_id.as_ref(),
                        },
                        budget,
                    )?;
                }
                if symbol.default_export {
                    push_default_export(
                        &mut index.default_exports,
                        DefaultExportInsertion {
                            symbol,
                            parent_symbol_id: parent_symbol_id.as_ref(),
                        },
                        budget,
                    )?;
                }
            }
        }
    }
    Ok(index)
}

struct ResolutionOutput<'a> {
    index: &'a ResolutionIndex,
    facts: &'a mut GenerationFacts,
    report: &'a mut ResolutionReport,
    budget: &'a mut ResolveBudget,
}

struct FileDocumentIdentity {
    file_id: FileId,
    path: String,
    language: String,
}

struct FileResolutionContext<'a> {
    identity: &'a FileDocumentIdentity,
    import_bindings: &'a [ExtractedImportBinding],
}

struct ReferenceAppendRequest<'a, 'b> {
    context: &'a FileResolutionContext<'b>,
    reference: ExtractedReference,
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
            import_bindings,
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
            self.append_reference(
                ReferenceAppendRequest {
                    context: &FileResolutionContext {
                        identity: &identity,
                        import_bindings: &import_bindings,
                    },
                    reference,
                },
                cancelled,
            )?;
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

    fn append_reference<Cancel>(
        &mut self,
        request: ReferenceAppendRequest<'_, '_>,
        cancelled: &mut Cancel,
    ) -> Result<(), StageItemFailure>
    where
        Cancel: FnMut() -> bool,
    {
        let ReferenceAppendRequest { context, reference } = request;
        let resolution = resolve_reference(
            self.index,
            &ResolutionRequest {
                file_id: &context.identity.file_id,
                file_path: &context.identity.path,
                language: &context.identity.language,
                import_bindings: context.import_bindings,
                owner: reference.owner.as_ref(),
                name: &reference.name,
                kind: reference.kind,
                span: reference.span,
            },
            cancelled,
        )?;
        if resolution.target.is_some() {
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
        if let Some(target) = resolution.target.as_ref()
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
        self.facts.references.push(reference_input(
            &context.identity.file_id,
            reference,
            resolution,
        ));
        Ok(())
    }

    fn append_symbol(
        &mut self,
        identity: &FileDocumentIdentity,
        symbol: NativeSymbolFacts,
    ) -> Result<(), StageItemFailure> {
        let document_id = native_document_id("symbol", symbol.input.symbol_id.as_str());
        let symbol_id = symbol.input.symbol_id.clone();
        let code = symbol_document_code(&symbol)?;
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
                "body_search_truncated": symbol.body_search_truncated,
                "declaration_only": symbol.declaration_only,
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
    parent_symbol_id: Option<&'a SymbolId>,
}

struct ModulePathInsertion<'a> {
    key: &'a str,
    file_id: &'a FileId,
}

#[derive(Clone, Copy)]
struct ModuleFileIndexInput<'a> {
    file: &'a FileInput,
    package: Option<&'a str>,
}

#[derive(Clone, Copy)]
struct ModuleStemInput<'a> {
    file: &'a FileInput,
    stem: &'a str,
}

struct DefaultExportInsertion<'a> {
    symbol: &'a NativeSymbolFacts,
    parent_symbol_id: Option<&'a SymbolId>,
}

fn insert_parent(
    parents: &mut ParentMap,
    containment: &Containment,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    if let Some(existing) = parents.get(&containment.child) {
        return if existing == &containment.parent {
            Ok(())
        } else {
            Err(StageItemFailure)
        };
    }
    budget.charge(
        RESOLUTION_MAP_NODE_ALLOWANCE
            .saturating_add(usize_to_u64(size_of::<(SymbolId, SymbolId)>()))
            .saturating_add(usize_to_u64(containment.child.as_str().len()))
            .saturating_add(usize_to_u64(containment.parent.as_str().len())),
    )?;
    parents.insert(containment.child.clone(), containment.parent.clone());
    Ok(())
}

fn index_module_path(
    modules: &mut ModulePathIndex,
    input: ModuleFileIndexInput<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    index_resolution_file_context(modules, input, budget)?;
    let file = input.file;
    push_module_path(
        &mut modules.exact,
        ModulePathInsertion {
            key: &file.normalized_path,
            file_id: &file.file_id,
        },
        budget,
    )?;
    let Some(stem) = strip_module_extension(&file.normalized_path) else {
        return Ok(());
    };
    index_module_stem(modules, ModuleStemInput { file, stem }, budget)
}

fn index_module_stem(
    modules: &mut ModulePathIndex,
    input: ModuleStemInput<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    push_module_path(
        &mut modules.stem,
        ModulePathInsertion {
            key: input.stem,
            file_id: &input.file.file_id,
        },
        budget,
    )?;
    if let Some(directory) = directory_module_stem(&input.file.language, input.stem) {
        push_module_path(
            &mut modules.directory_index,
            ModulePathInsertion {
                key: directory,
                file_id: &input.file.file_id,
            },
            budget,
        )?;
    }
    Ok(())
}

fn directory_module_stem<'a>(language: &str, stem: &'a str) -> Option<&'a str> {
    let directory = if language == SourceLanguage::Rust.as_str() {
        stem.strip_suffix("/mod")
    } else if javascript_family_name(language) {
        stem.strip_suffix("/index")
    } else {
        None
    };
    directory.filter(|value| !value.is_empty())
}

fn index_resolution_file_context(
    modules: &mut ModulePathIndex,
    input: ModuleFileIndexInput<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    if modules.files.contains_key(&input.file.file_id) {
        return Err(StageItemFailure);
    }
    let directory = input
        .file
        .normalized_path
        .rsplit_once('/')
        .map_or("", |(directory, _)| directory);
    budget.charge(resolution_file_context_bytes(input, directory))?;
    modules.files.insert(
        input.file.file_id.clone(),
        ResolutionFileContext {
            directory: try_clone_text(directory)?,
            language: try_clone_text(&input.file.language)?,
            package: input.package.map(try_clone_text).transpose()?,
        },
    );
    Ok(())
}

fn resolution_file_context_bytes(input: ModuleFileIndexInput<'_>, directory: &str) -> u64 {
    RESOLUTION_MAP_NODE_ALLOWANCE
        .saturating_add(usize_to_u64(size_of::<(FileId, ResolutionFileContext)>()))
        .saturating_add(usize_to_u64(input.file.file_id.as_str().len()))
        .saturating_add(usize_to_u64(directory.len()))
        .saturating_add(usize_to_u64(input.file.language.len()))
        .saturating_add(input.package.map_or(0, |name| usize_to_u64(name.len())))
}

fn native_package_name(file: &NativeFileFacts) -> Option<&str> {
    if file.file.language != SourceLanguage::Go.as_str() {
        return None;
    }
    file.symbols
        .iter()
        .find(|symbol| {
            symbol.kind == SymbolKind::Module && symbol.input.qualified_name == symbol.name
        })
        .map(|symbol| symbol.name.as_str())
}

fn strip_module_extension(path: &str) -> Option<&str> {
    MODULE_EXTENSIONS
        .iter()
        .find_map(|extension| path.strip_suffix(extension))
}

fn push_module_path(
    paths: &mut ModulePathMap,
    insertion: ModulePathInsertion<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    let ModulePathInsertion { key, file_id } = insertion;
    if !paths.contains_key(key) {
        budget.charge(
            RESOLUTION_MAP_NODE_ALLOWANCE
                .saturating_add(usize_to_u64(size_of::<(String, Vec<FileId>)>()))
                .saturating_add(usize_to_u64(key.len())),
        )?;
        paths.insert(try_clone_text(key)?, Vec::new());
    }
    let entries = paths.get_mut(key).ok_or(StageItemFailure)?;
    if entries.iter().any(|candidate| candidate == file_id) {
        return Ok(());
    }
    budget.charge(
        usize_to_u64(size_of::<FileId>()).saturating_add(usize_to_u64(file_id.as_str().len())),
    )?;
    entries.try_reserve_exact(1).map_err(|_| StageItemFailure)?;
    entries.push(file_id.clone());
    Ok(())
}

fn push_candidate(
    candidates: &mut CandidateMap,
    insertion: ResolutionCandidateInsertion<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    let ResolutionCandidateInsertion {
        key,
        symbol,
        parent_symbol_id,
    } = insertion;
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
            .saturating_add(usize_to_u64(symbol.input.symbol_id.as_str().len()))
            .saturating_add(
                parent_symbol_id.map_or(0, |parent| usize_to_u64(parent.as_str().len())),
            ),
    )?;
    entries.try_reserve_exact(1).map_err(|_| StageItemFailure)?;
    entries.push(ResolutionCandidate {
        file_id: symbol.input.file_id.clone(),
        symbol_id: symbol.input.symbol_id.clone(),
        parent_symbol_id: parent_symbol_id.cloned(),
        kind: symbol.kind,
        exported: symbol.exported,
        declaration_only: symbol.declaration_only,
        top_level: symbol.input.qualified_name == symbol.name,
    });
    Ok(())
}

fn push_default_export(
    exports: &mut DefaultExportMap,
    insertion: DefaultExportInsertion<'_>,
    budget: &mut ResolveBudget,
) -> Result<(), StageItemFailure> {
    let DefaultExportInsertion {
        symbol,
        parent_symbol_id,
    } = insertion;
    if !exports.contains_key(&symbol.input.file_id) {
        budget.charge(
            RESOLUTION_MAP_NODE_ALLOWANCE
                .saturating_add(usize_to_u64(size_of::<(FileId, Vec<ResolutionCandidate>)>()))
                .saturating_add(usize_to_u64(symbol.input.file_id.as_str().len())),
        )?;
        exports.insert(symbol.input.file_id.clone(), Vec::new());
    }
    let entries = exports
        .get_mut(&symbol.input.file_id)
        .ok_or(StageItemFailure)?;
    budget.charge(
        usize_to_u64(size_of::<ResolutionCandidate>())
            .saturating_add(usize_to_u64(symbol.input.file_id.as_str().len()))
            .saturating_add(usize_to_u64(symbol.input.symbol_id.as_str().len()))
            .saturating_add(
                parent_symbol_id.map_or(0, |parent| usize_to_u64(parent.as_str().len())),
            ),
    )?;
    entries.try_reserve_exact(1).map_err(|_| StageItemFailure)?;
    entries.push(ResolutionCandidate {
        file_id: symbol.input.file_id.clone(),
        symbol_id: symbol.input.symbol_id.clone(),
        parent_symbol_id: parent_symbol_id.cloned(),
        kind: symbol.kind,
        exported: symbol.exported,
        declaration_only: symbol.declaration_only,
        top_level: symbol.input.qualified_name == symbol.name,
    });
    Ok(())
}

struct ResolutionRequest<'a> {
    file_id: &'a FileId,
    file_path: &'a str,
    language: &'a str,
    import_bindings: &'a [ExtractedImportBinding],
    owner: Option<&'a SymbolId>,
    name: &'a str,
    kind: ReferenceKind,
    span: SourceSpan,
}

struct ProjectCandidateInput<'a> {
    modules: &'a ModulePathIndex,
    source: &'a ResolutionFileContext,
    source_file_id: &'a FileId,
    candidate: &'a ResolutionCandidate,
}

#[derive(Clone, Copy)]
enum ImportReferenceSite {
    Declaration,
    Usage,
}

struct ImportResolutionRequest<'a, 'b> {
    reference: &'a ResolutionRequest<'b>,
    site: ImportReferenceSite,
}

struct ModuleResolutionRequest<'a> {
    importing_path: &'a str,
    specifier: &'a str,
    importing_language: &'a str,
}

fn resolve_reference<Cancel>(
    index: &ResolutionIndex,
    request: &ResolutionRequest<'_>,
    cancelled: &mut Cancel,
) -> Result<ReferenceResolution, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    if request.owner.is_none() && request.kind == ReferenceKind::References {
        match resolve_import(
            index,
            ImportResolutionRequest {
                reference: request,
                site: ImportReferenceSite::Declaration,
            },
            cancelled,
        )? {
            ImportResolution::NotBound => {}
            ImportResolution::Resolved(target) => {
                return Ok(ReferenceResolution::resolved(target));
            }
            ImportResolution::Unresolved => {
                return Ok(ReferenceResolution::unresolved(
                    UNRESOLVED_IMPORT_PROVENANCE,
                ));
            }
        }
    }
    if request.kind == ReferenceKind::Exports {
        match resolve_import(
            index,
            ImportResolutionRequest {
                reference: request,
                site: ImportReferenceSite::Usage,
            },
            cancelled,
        )? {
            ImportResolution::NotBound => {}
            ImportResolution::Resolved(target) => {
                return Ok(ReferenceResolution::resolved(target));
            }
            ImportResolution::Unresolved => {
                return Ok(ReferenceResolution::unresolved(
                    UNRESOLVED_IMPORT_PROVENANCE,
                ));
            }
        }
    }
    if let Some(target) = resolve_lexical(index, request, cancelled)? {
        return Ok(ReferenceResolution::resolved(target));
    }
    match resolve_import(
        index,
        ImportResolutionRequest {
            reference: request,
            site: ImportReferenceSite::Usage,
        },
        cancelled,
    )? {
        ImportResolution::NotBound => {}
        ImportResolution::Resolved(target) => {
            return Ok(ReferenceResolution::resolved(target));
        }
        ImportResolution::Unresolved => {
            return Ok(ReferenceResolution::unresolved(
                UNRESOLVED_IMPORT_PROVENANCE,
            ));
        }
    }
    if project_fallback_allowed(request)
        && let Some(target) = resolve_project(index, request, cancelled)?
    {
        return Ok(ReferenceResolution::resolved(target));
    }
    Ok(ReferenceResolution::unresolved(UNRESOLVED_PROVENANCE))
}

fn project_fallback_allowed(request: &ResolutionRequest<'_>) -> bool {
    !(javascript_family_name(request.language)
        && request.kind == ReferenceKind::Calls
        && request.name == "require")
}

fn resolve_lexical<Cancel>(
    index: &ResolutionIndex,
    request: &ResolutionRequest<'_>,
    cancelled: &mut Cancel,
) -> Result<Option<ResolvedTarget>, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let candidates = index
        .candidates
        .get(request.name)
        .map_or(&[] as &[ResolutionCandidate], Vec::as_slice);
    let mut scope = request.owner;
    // There can be one more lexical scope than parent-map entries: an
    // uncontained owner must still advance once to the file's top-level scope.
    for _ in 0..=index.parents.len().saturating_add(1) {
        if cancelled() {
            return Err(StageItemFailure);
        }
        if let Some(candidate) = select_candidate(
            candidates,
            |candidate| {
                is_lexical_candidate(request.kind, candidate)
                    && &candidate.file_id == request.file_id
                    && candidate.parent_symbol_id.as_ref() == scope
            },
            cancelled,
        )? {
            let (confidence, provenance) = if candidate.parent_symbol_id.is_some() {
                (EXACT_LEXICAL_CONFIDENCE, EXACT_LEXICAL_PROVENANCE)
            } else {
                (EXACT_SAME_FILE_CONFIDENCE, EXACT_SAME_FILE_PROVENANCE)
            };
            return Ok(Some(ResolvedTarget {
                symbol_id: candidate.symbol_id.clone(),
                confidence,
                provenance,
            }));
        }
        let Some(symbol_id) = scope else {
            return Ok(None);
        };
        scope = index.parents.get(symbol_id);
    }
    Ok(None)
}

fn is_lexical_candidate(reference_kind: ReferenceKind, candidate: &ResolutionCandidate) -> bool {
    reference_kind_candidate(reference_kind, candidate)
        && (reference_kind == ReferenceKind::FieldAccess
            || !matches!(
                candidate.kind,
                SymbolKind::Method
                    | SymbolKind::Property
                    | SymbolKind::Field
                    | SymbolKind::EnumMember
            ))
}

fn reference_kind_candidate(
    reference_kind: ReferenceKind,
    candidate: &ResolutionCandidate,
) -> bool {
    !(matches!(
        reference_kind,
        ReferenceKind::Calls | ReferenceKind::Instantiates
    ) && candidate.kind == SymbolKind::Module)
}

enum ImportResolution {
    NotBound,
    Resolved(ResolvedTarget),
    Unresolved,
}

fn resolve_import<Cancel>(
    index: &ResolutionIndex,
    input: ImportResolutionRequest<'_, '_>,
    cancelled: &mut Cancel,
) -> Result<ImportResolution, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let ImportResolutionRequest { reference, site } = input;
    let mut matched: Option<(&ExtractedImportBinding, &str)> = None;
    for binding in reference.import_bindings {
        if cancelled() {
            return Err(StageItemFailure);
        }
        let imported_name = match site {
            ImportReferenceSite::Declaration => {
                binding_matches_declaration_site(binding, reference)
                    .then_some(binding.imported_name.as_str())
            }
            ImportReferenceSite::Usage => runtime_binding_target_name(binding, reference.name),
        };
        let Some(imported_name) = imported_name else {
            continue;
        };
        if matched.is_some() {
            return Ok(ImportResolution::Unresolved);
        }
        matched = Some((binding, imported_name));
    }
    let Some((binding, imported_name)) = matched else {
        return Ok(ImportResolution::NotBound);
    };
    if imported_name.is_empty() {
        return Ok(ImportResolution::Unresolved);
    }
    let Some(module_file_id) = resolve_module_file(
        &index.modules,
        ModuleResolutionRequest {
            importing_path: reference.file_path,
            specifier: &binding.module_specifier,
            importing_language: reference.language,
        },
    ) else {
        return Ok(ImportResolution::Unresolved);
    };
    let candidates = if binding.kind == ImportBindingKind::Default || imported_name == "default" {
        index
            .default_exports
            .get(module_file_id)
            .map_or(&[] as &[ResolutionCandidate], Vec::as_slice)
    } else {
        index
            .candidates
            .get(imported_name)
            .map_or(&[] as &[ResolutionCandidate], Vec::as_slice)
    };
    let Some(candidate) = select_candidate(
        candidates,
        |candidate| {
            &candidate.file_id == module_file_id
                && candidate.exported
                && reference_kind_candidate(reference.kind, candidate)
                && (reference.language != SourceLanguage::Rust.as_str()
                    || (candidate.parent_symbol_id.is_none() && candidate.top_level))
        },
        cancelled,
    )?
    else {
        return Ok(ImportResolution::Unresolved);
    };
    Ok(ImportResolution::Resolved(ResolvedTarget {
        symbol_id: candidate.symbol_id.clone(),
        confidence: IMPORT_BINDING_CONFIDENCE,
        provenance: IMPORT_BINDING_PROVENANCE,
    }))
}

fn binding_matches_declaration_site(
    binding: &ExtractedImportBinding,
    request: &ResolutionRequest<'_>,
) -> bool {
    binding.kind == ImportBindingKind::Named
        && binding.span == request.span
        && binding.imported_name == request.name
}

fn runtime_binding_target_name<'a>(
    binding: &'a ExtractedImportBinding,
    reference_name: &'a str,
) -> Option<&'a str> {
    match binding.kind {
        ImportBindingKind::Default | ImportBindingKind::Named => {
            (binding.local_name == reference_name).then_some(binding.imported_name.as_str())
        }
        ImportBindingKind::Namespace => {
            if binding.local_name == reference_name {
                return Some("");
            }
            reference_name
                .strip_prefix(&binding.local_name)
                .and_then(|suffix| {
                    suffix
                        .strip_prefix('.')
                        .or_else(|| suffix.strip_prefix("::"))
                })
        }
    }
}

fn resolve_module_file<'a>(
    modules: &'a ModulePathIndex,
    request: ModuleResolutionRequest<'_>,
) -> Option<&'a FileId> {
    let normalized = normalize_relative_module_path(request.importing_path, request.specifier)?;
    match module_file_match(
        modules.exact.get(&normalized),
        &modules.files,
        request.importing_language,
    ) {
        ModuleFileMatch::Unique(file_id) => return Some(file_id),
        ModuleFileMatch::Ambiguous => return None,
        ModuleFileMatch::Missing => {}
    }
    let stem = strip_module_extension(&normalized).unwrap_or(&normalized);
    let stem_match = module_file_match(
        modules.stem.get(stem),
        &modules.files,
        request.importing_language,
    );
    let directory_match = module_file_match(
        modules.directory_index.get(&normalized),
        &modules.files,
        request.importing_language,
    );
    match choose_module_file_match(
        stem_match,
        directory_match,
        request.importing_language == SourceLanguage::Rust.as_str(),
    ) {
        ModuleFileMatch::Unique(file_id) => Some(file_id),
        ModuleFileMatch::Missing | ModuleFileMatch::Ambiguous => None,
    }
}

enum ModuleFileMatch<'a> {
    Missing,
    Unique(&'a FileId),
    Ambiguous,
}

fn choose_module_file_match<'a>(
    stem: ModuleFileMatch<'a>,
    directory: ModuleFileMatch<'a>,
    merge_conventions: bool,
) -> ModuleFileMatch<'a> {
    if !merge_conventions {
        return match stem {
            ModuleFileMatch::Missing => directory,
            selected => selected,
        };
    }
    match (stem, directory) {
        (ModuleFileMatch::Missing, selected) | (selected, ModuleFileMatch::Missing) => selected,
        (ModuleFileMatch::Ambiguous, _) | (_, ModuleFileMatch::Ambiguous) => {
            ModuleFileMatch::Ambiguous
        }
        (ModuleFileMatch::Unique(_), ModuleFileMatch::Unique(_)) => ModuleFileMatch::Ambiguous,
    }
}

fn module_file_match<'a>(
    candidates: Option<&'a Vec<FileId>>,
    files: &FileResolutionContextMap,
    importing_language: &str,
) -> ModuleFileMatch<'a> {
    let mut matched = candidates
        .map(Vec::as_slice)
        .unwrap_or_default()
        .iter()
        .filter(|file_id| {
            files.get(*file_id).is_some_and(|target| {
                resolution_languages_compatible(importing_language, &target.language)
            })
        });
    let Some(file_id) = matched.next() else {
        return ModuleFileMatch::Missing;
    };
    if matched.next().is_some() {
        ModuleFileMatch::Ambiguous
    } else {
        ModuleFileMatch::Unique(file_id)
    }
}

fn normalize_relative_module_path(importing_path: &str, specifier: &str) -> Option<String> {
    if !(matches!(specifier, "." | "..")
        || specifier.starts_with("./")
        || specifier.starts_with("../"))
        || specifier.contains(['\\', '\0'])
    {
        return None;
    }
    let directory = importing_path
        .rsplit_once('/')
        .map_or("", |(directory, _)| directory);
    let component_capacity = directory
        .bytes()
        .filter(|byte| *byte == b'/')
        .count()
        .checked_add(specifier.bytes().filter(|byte| *byte == b'/').count())?
        .checked_add(2)?;
    let mut components = Vec::new();
    components.try_reserve(component_capacity).ok()?;
    components.extend(
        directory
            .split('/')
            .filter(|component| !component.is_empty()),
    );
    for component in specifier.split('/') {
        match component {
            "" | "." => {}
            ".." => {
                components.pop()?;
            }
            value => components.push(value),
        }
    }
    if components.is_empty() {
        return None;
    }
    let output_bytes = components
        .iter()
        .try_fold(components.len().saturating_sub(1), |total, component| {
            total.checked_add(component.len())
        })?;
    let mut normalized = String::new();
    normalized.try_reserve(output_bytes).ok()?;
    for (index, component) in components.into_iter().enumerate() {
        if index != 0 {
            normalized.push('/');
        }
        normalized.push_str(component);
    }
    Some(normalized)
}

fn resolve_project<Cancel>(
    index: &ResolutionIndex,
    request: &ResolutionRequest<'_>,
    cancelled: &mut Cancel,
) -> Result<Option<ResolvedTarget>, StageItemFailure>
where
    Cancel: FnMut() -> bool,
{
    let source = project_source_context(index, request)?;
    let candidates = index
        .candidates
        .get(request.name)
        .map_or(&[] as &[ResolutionCandidate], Vec::as_slice);
    let candidate = select_candidate(
        candidates,
        |candidate| {
            is_project_candidate(ProjectCandidateInput {
                modules: &index.modules,
                source,
                source_file_id: request.file_id,
                candidate,
            })
        },
        cancelled,
    )?;
    Ok(candidate.map(project_resolved_target))
}

fn project_source_context<'a>(
    index: &'a ResolutionIndex,
    request: &ResolutionRequest<'_>,
) -> Result<&'a ResolutionFileContext, StageItemFailure> {
    let source = index
        .modules
        .files
        .get(request.file_id)
        .ok_or(StageItemFailure)?;
    (source.language == request.language)
        .then_some(source)
        .ok_or(StageItemFailure)
}

fn is_project_candidate(input: ProjectCandidateInput<'_>) -> bool {
    &input.candidate.file_id != input.source_file_id
        && input.candidate.exported
        && project_scope_matches(input.modules, input.source, &input.candidate.file_id)
        && !matches!(
            input.candidate.kind,
            SymbolKind::Method
                | SymbolKind::Property
                | SymbolKind::Field
                | SymbolKind::EnumMember
                | SymbolKind::Parameter
        )
}

fn project_resolved_target(candidate: &ResolutionCandidate) -> ResolvedTarget {
    ResolvedTarget {
        symbol_id: candidate.symbol_id.clone(),
        confidence: EXACT_PROJECT_CONFIDENCE,
        provenance: EXACT_PROJECT_PROVENANCE,
    }
}

fn project_scope_matches(
    modules: &ModulePathIndex,
    source: &ResolutionFileContext,
    target_file_id: &FileId,
) -> bool {
    let Some(target) = modules.files.get(target_file_id) else {
        return false;
    };
    if javascript_family_name(&source.language) && javascript_family_name(&target.language) {
        return true;
    }
    source.language == SourceLanguage::Go.as_str()
        && target.language == SourceLanguage::Go.as_str()
        && source.directory == target.directory
        && source.package.is_some()
        && source.package == target.package
}

fn javascript_family_name(language: &str) -> bool {
    matches!(language, "typescript" | "tsx" | "javascript" | "jsx")
}

fn resolution_languages_compatible(source: &str, target: &str) -> bool {
    source == target || (javascript_family_name(source) && javascript_family_name(target))
}

fn select_candidate<'a, Eligible, Cancel>(
    candidates: &'a [ResolutionCandidate],
    mut eligible: Eligible,
    cancelled: &mut Cancel,
) -> Result<Option<&'a ResolutionCandidate>, StageItemFailure>
where
    Eligible: FnMut(&ResolutionCandidate) -> bool,
    Cancel: FnMut() -> bool,
{
    let mut sole = None;
    let mut total = 0_usize;
    let mut implementation = None;
    let mut implementations = 0_usize;
    for candidate in candidates {
        if cancelled() {
            return Err(StageItemFailure);
        }
        if !eligible(candidate) {
            continue;
        }
        total = total.saturating_add(1);
        sole = Some(candidate);
        if !candidate.declaration_only {
            implementations = implementations.saturating_add(1);
            implementation = Some(candidate);
        }
    }
    if implementations == 1 {
        Ok(implementation)
    } else if implementations == 0 && total == 1 {
        Ok(sole)
    } else {
        Ok(None)
    }
}

fn reference_input(
    file_id: &FileId,
    reference: ExtractedReference,
    resolution: ReferenceResolution,
) -> ReferenceInput {
    let ReferenceResolution {
        target,
        unresolved_provenance,
    } = resolution;
    let (target_symbol_id, confidence, resolution_provenance) = match target {
        Some(target) => (
            Some(target.symbol_id),
            target.confidence,
            target.provenance.to_owned(),
        ),
        None => (
            None,
            UNRESOLVED_CONFIDENCE,
            unresolved_provenance.to_owned(),
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
    let base_code_bytes = if symbol.input.signature.is_empty() {
        usize_to_u64(symbol.input.qualified_name.len())
    } else {
        usize_to_u64(symbol.input.signature.len())
    };
    let code_bytes = base_code_bytes
        .saturating_add(usize_to_u64(symbol.body_search_text.len()))
        .saturating_add(u64::from(!symbol.body_search_text.is_empty()));
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

fn symbol_document_code(symbol: &NativeSymbolFacts) -> Result<String, StageItemFailure> {
    let base = if symbol.input.signature.is_empty() {
        &symbol.input.qualified_name
    } else {
        &symbol.input.signature
    };
    let separator = usize::from(!base.is_empty() && !symbol.body_search_text.is_empty());
    let capacity = base
        .len()
        .checked_add(separator)
        .and_then(|length| length.checked_add(symbol.body_search_text.len()))
        .ok_or(StageItemFailure)?;
    let mut code = String::new();
    code.try_reserve(capacity).map_err(|_| StageItemFailure)?;
    code.push_str(base);
    if separator != 0 {
        code.push(' ');
    }
    code.push_str(&symbol.body_search_text);
    Ok(code)
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
    const INNER_CANCELLATION_CANDIDATE_COUNT: u8 = 64;
    const INNER_CANCEL_AFTER_POLLS: u64 = 8;
    const TEST_FILE_ID_BYTE: u8 = 0x21;
    const TEST_SYMBOL_ID_BYTE: u8 = 0x42;

    struct ModuleResolverFacts<'a> {
        facts: &'a CanonicalGenerationFacts,
    }

    struct ExpectedResolvedReference {
        caller_path: &'static str,
        caller_name: &'static str,
        reference_name: &'static str,
        target_path: &'static str,
        target_name: &'static str,
        provenance: &'static str,
    }

    const POLYGLOT_RESOLVED_REFERENCES: [ExpectedResolvedReference; 11] = [
        ExpectedResolvedReference {
            caller_path: "lib.rs",
            caller_name: "rust_use",
            reference_name: "nested::nested_helper",
            target_path: "nested/mod.rs",
            target_name: "nested_helper",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "lib.rs",
            caller_name: "rust_use",
            reference_name: "rust_helper::rust_helper",
            target_path: "rust_helper.rs",
            target_name: "rust_helper",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "py_consumer.py",
            caller_name: "python_use",
            reference_name: "python_helper",
            target_path: "py_helpers.py",
            target_name: "python_helper",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "py_namespace_consumer.py",
            caller_name: "python_namespace_use",
            reference_name: "helpers.python_helper",
            target_path: "py_helpers.py",
            target_name: "python_helper",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "go_consumer.go",
            caller_name: "GoUse",
            reference_name: "GoHelper",
            target_path: "go_helpers.go",
            target_name: "GoHelper",
            provenance: EXACT_PROJECT_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "use_barrel.ts",
            caller_name: "consume",
            reference_name: "renamed",
            target_path: "barrel.ts",
            target_name: "renamed",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "use_local_alias.ts",
            caller_name: "consumeLocalAlias",
            reference_name: "publicInternal",
            target_path: "local_alias.ts",
            target_name: "publicInternal",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "use_default_local.ts",
            caller_name: "useDefaultLocal",
            reference_name: "selected",
            target_path: "default_local.ts",
            target_name: "defaultLocal",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "cjs_consumer.cjs",
            caller_name: "cjsUse",
            reference_name: "helper.cjsHelper",
            target_path: "cjs_helper.js",
            target_name: "cjsHelper",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "cjs_destructured.cjs",
            caller_name: "cjsSelectedUse",
            reference_name: "selectedHelper",
            target_path: "cjs_helper.js",
            target_name: "cjsHelper",
            provenance: IMPORT_BINDING_PROVENANCE,
        },
        ExpectedResolvedReference {
            caller_path: "local_require.cjs",
            caller_name: "localRequireUse",
            reference_name: "require",
            target_path: "local_require.cjs",
            target_name: "require",
            provenance: EXACT_SAME_FILE_PROVENANCE,
        },
    ];

    const POLYGLOT_DIRECTORIES: [&str; 5] = ["other", "nested", "conflict", "index_only", "fake"];

    const POLYGLOT_FIXTURES: [(&str, &str); 30] = [
        (
            "rust_helper.rs",
            "impl LateWorker { pub fn orphan_method() -> usize { 8 } }\npub struct LateWorker;\npub mod inner { pub fn nested_only() -> usize { 7 } }\npub fn rust_helper() -> usize { 1 }\npub(self) fn hidden() -> usize { 9 }\n",
        ),
        ("nested/mod.rs", "pub fn nested_helper() -> usize { 2 }\n"),
        ("conflict.rs", "pub fn conflict_helper() -> usize { 3 }\n"),
        (
            "conflict/mod.rs",
            "pub fn conflict_helper() -> usize { 4 }\n",
        ),
        (
            "index_only/index.rs",
            "pub fn index_helper() -> usize { 5 }\n",
        ),
        (
            "lib.rs",
            "mod conflict;\nmod index_only;\nmod nested;\nmod rust_helper;\npub fn rust_use() -> usize { nested::nested_helper() + rust_helper::rust_helper() }\npub fn rust_rejected() -> usize { rust_helper::hidden() + rust_helper::nested_only() + rust_helper::orphan_method() + rust_helper::inner() + conflict::conflict_helper() + index_only::index_helper() }\n",
        ),
        ("py_helpers.py", "def python_helper():\n    return 1\n"),
        (
            "py_consumer.py",
            "from .py_helpers import python_helper\n\ndef python_use():\n    return python_helper()\n",
        ),
        (
            "py_namespace_consumer.py",
            "from . import py_helpers as helpers\n\ndef python_namespace_use():\n    return helpers.python_helper()\n",
        ),
        (
            "go_helpers.go",
            "package fixture\n\nfunc GoHelper() int { return 1 }\n",
        ),
        (
            "go_consumer.go",
            "package fixture\n\nfunc GoUse() int { return GoHelper() }\n",
        ),
        (
            "go_bare.go",
            "package fixture\n\nfunc BareGoCall() int { return Run() + ForeignOnly() + ExternalOnly() + fixture() }\n",
        ),
        (
            "go_external_test.go",
            "package fixture_test\n\nfunc ExternalOnly() int { return 1 }\n",
        ),
        (
            "other/go_foreign.go",
            "package other\n\nfunc ForeignOnly() int { return 1 }\n",
        ),
        (
            "cross_language.ts",
            "import { python_helper } from './py_helpers';\nexport function crossLanguage(): number { return python_helper(); }\n",
        ),
        (
            "fake/mod.ts",
            "export function fake(): number { return 1; }\n",
        ),
        (
            "use_fake.ts",
            "import { fake } from './fake';\nexport function useFake(): number { return fake(); }\n",
        ),
        ("core.ts", "export function core(): number { return 1; }\n"),
        (
            "barrel.ts",
            "const core = (): number => 0;\nexport { core as renamed } from './core';\n",
        ),
        (
            "use_barrel.ts",
            "import { renamed } from './barrel';\nexport function consume(): number { return renamed(); }\n",
        ),
        (
            "local_alias.ts",
            "const internal = (): number => 2;\nexport { internal as publicInternal };\n",
        ),
        (
            "use_local_alias.ts",
            "import { publicInternal } from './local_alias';\nexport function consumeLocalAlias(): number { return publicInternal(); }\n",
        ),
        (
            "default_local.ts",
            "const defaultLocal = (): number => 5;\nexport default defaultLocal;\n",
        ),
        (
            "use_default_local.ts",
            "import selected from './default_local';\nexport function useDefaultLocal(): number { return selected(); }\n",
        ),
        (
            "cjs_helper.js",
            "function cjsHelper() { return 1; }\nexports.cjsHelper = cjsHelper;\n",
        ),
        (
            "cjs_consumer.cjs",
            "const helper = require('./cjs_helper');\nfunction cjsUse() { return helper.cjsHelper(); }\nmodule.exports = { cjsUse };\n",
        ),
        (
            "cjs_destructured.cjs",
            "const { cjsHelper: selectedHelper } = require('./cjs_helper');\nfunction cjsSelectedUse() { return selectedHelper(); }\nmodule.exports = { cjsSelectedUse };\n",
        ),
        (
            "dynamic_require.cjs",
            "function dynamicUse(name) { return require(name); }\nmodule.exports = { dynamicUse };\n",
        ),
        (
            "exported_require.js",
            "export function require() { return 1; }\n",
        ),
        (
            "local_require.cjs",
            "function require(name) { return name; }\nfunction localRequireUse() { return require('local'); }\nmodule.exports = { localRequireUse };\n",
        ),
    ];

    impl ModuleResolverFacts<'_> {
        fn symbol(&self, path: &str, qualified_name: &str) -> SymbolId {
            let file_id = self
                .facts
                .files()
                .iter()
                .find(|file| file.normalized_path == path)
                .map(|file| &file.file_id)
                .unwrap_or_else(|| panic!("missing module resolver file {path}"));
            let mut symbols = self.facts.symbols().iter().filter(|symbol| {
                &symbol.file_id == file_id && symbol.qualified_name == qualified_name
            });
            let symbol = symbols
                .next()
                .unwrap_or_else(|| panic!("missing module symbol {path}:{qualified_name}"));
            assert!(symbols.next().is_none(), "{path}:{qualified_name}");
            symbol.symbol_id.clone()
        }

        fn parse_implementation(&self) -> SymbolId {
            self.facts
                .documents()
                .iter()
                .find(|document| {
                    document.path() == "src/api.ts"
                        && document.qualified_name() == "parse"
                        && document
                            .metadata_json()
                            .contains("\"declaration_only\":false")
                })
                .and_then(|document| document.symbol_id().cloned())
                .unwrap_or_else(|| panic!("parse implementation document was missing"))
        }

        fn reference(&self, owner: &SymbolId, name: &str) -> &ReferenceInput {
            self.facts
                .references()
                .iter()
                .find(|reference| {
                    reference.owner_symbol_id.as_ref() == Some(owner)
                        && reference.reference_name == name
                })
                .unwrap_or_else(|| panic!("missing reference {name}"))
        }

        fn import_declaration_reference(&self, path: &str, name: &str) -> &ReferenceInput {
            let file_id = self
                .facts
                .files()
                .iter()
                .find(|file| file.normalized_path == path)
                .map(|file| &file.file_id)
                .unwrap_or_else(|| panic!("missing import declaration file {path}"));
            let mut references = self.facts.references().iter().filter(|reference| {
                &reference.file_id == file_id
                    && reference.owner_symbol_id.is_none()
                    && reference.reference_name == name
                    && reference.reference_kind == ReferenceKind::References.as_str()
            });
            let reference = references
                .next()
                .unwrap_or_else(|| panic!("missing import declaration reference {path}:{name}"));
            assert!(references.next().is_none(), "{path}:{name}");
            reference
        }

        fn assert_use_document_terms(&self, owner: &SymbolId) {
            let document = self
                .facts
                .documents()
                .iter()
                .find(|document| document.symbol_id() == Some(owner))
                .unwrap_or_else(|| panic!("use search document was missing"));
            for term in [
                "DefaultClient",
                "RemoteService",
                "parse",
                "api",
                "make",
                "external",
            ] {
                assert!(document.code().contains(term), "{term}");
            }
            assert!(!document.code().contains("'value'"));
        }
    }

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

    fn write_module_project(root: &std::path::Path) {
        assert!(fs::create_dir(root.join(".git")).is_ok());
        assert!(fs::create_dir_all(root.join("src/foo")).is_ok());
        assert!(
            fs::write(
                root.join("src/api.ts"),
                "export default class DefaultClient {}\n\
                 export function Service(): void {}\n\
                 export function parse(value: string): string;\n\
                 export function parse(value: number): string;\n\
                 export function parse(value: unknown): string { return String(value); }\n\
                 export function make(): void {}\n",
            )
            .is_ok()
        );
        assert!(
            fs::write(
                root.join("src/other.ts"),
                "export function external(): void {}\n\
                 export function Service(): void {}\n",
            )
            .is_ok()
        );
        assert!(
            fs::write(
                root.join("src/consumer.ts"),
                "import DefaultClient, { Service as RemoteService, parse } from './api';\n\
                 import * as api from './api';\n\
                 import { external } from 'package';\n\
                 function Service(): void {}\n\
                 export function use(): void {\n\
                   new DefaultClient();\n\
                   RemoteService();\n\
                   parse('value');\n\
                   api.make();\n\
                   external();\n\
                 }\n\
                 export function shadow(): void {\n\
                   const RemoteService = (): void => {};\n\
                   RemoteService();\n\
                 }\n",
            )
            .is_ok()
        );
        assert!(
            fs::write(
                root.join("src/members.ts"),
                "export function run(): void {}\n\
                 export class Worker {\n\
                   run(): void {}\n\
                   execute(): void { run(); }\n\
                 }\n",
            )
            .is_ok()
        );
        for path in ["src/foo.ts", "src/foo.js", "src/foo/index.ts"] {
            assert!(fs::write(root.join(path), "export function choose(): void {}\n",).is_ok());
        }
        assert!(
            fs::write(
                root.join("src/ambiguous.ts"),
                "import { choose } from './foo';\n\
                 export function useAmbiguous(): void { choose(); }\n",
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn module_aliases_lexical_shadowing_and_overloads_resolve_deterministically() {
        let directory = tempdir()
            .unwrap_or_else(|error| panic!("could not create module resolver fixture: {error}"));
        write_module_project(directory.path());
        let generation = build(directory.path(), PARALLEL_WORKERS).await;
        let facts = ModuleResolverFacts {
            facts: generation.facts(),
        };
        let use_id = facts.symbol("src/consumer.ts", "use");
        let shadow_id = facts.symbol("src/consumer.ts", "shadow");
        let default_id = facts.symbol("src/api.ts", "DefaultClient");
        let service_id = facts.symbol("src/api.ts", "Service");
        let make_id = facts.symbol("src/api.ts", "make");
        let shadow_service_id = facts.symbol("src/consumer.ts", "shadow::RemoteService");
        let parse_implementation = facts.parse_implementation();
        let import_service = facts.import_declaration_reference("src/consumer.ts", "Service");

        assert_eq!(import_service.target_symbol_id.as_ref(), Some(&service_id));
        assert_eq!(
            import_service.resolution_provenance,
            IMPORT_BINDING_PROVENANCE
        );

        for (name, target) in [
            ("DefaultClient", default_id),
            ("RemoteService", service_id),
            ("parse", parse_implementation),
            ("api.make", make_id),
        ] {
            let reference = facts.reference(&use_id, name);
            assert_eq!(reference.target_symbol_id.as_ref(), Some(&target));
            assert_eq!(reference.resolution_provenance, IMPORT_BINDING_PROVENANCE);
        }
        let package_reference = facts.reference(&use_id, "external");
        assert!(package_reference.target_symbol_id.is_none());
        assert_eq!(
            package_reference.resolution_provenance,
            UNRESOLVED_IMPORT_PROVENANCE
        );
        let shadow_reference = facts.reference(&shadow_id, "RemoteService");
        assert_eq!(
            shadow_reference.target_symbol_id.as_ref(),
            Some(&shadow_service_id)
        );
        assert_eq!(
            shadow_reference.resolution_provenance,
            EXACT_LEXICAL_PROVENANCE
        );
        facts.assert_use_document_terms(&use_id);
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn ambiguous_module_stems_do_not_fall_through_to_directory_indexes() {
        let directory = tempdir()
            .unwrap_or_else(|error| panic!("could not create module resolver fixture: {error}"));
        write_module_project(directory.path());
        let generation = build(directory.path(), PARALLEL_WORKERS).await;
        let facts = ModuleResolverFacts {
            facts: generation.facts(),
        };
        let owner = facts.symbol("src/ambiguous.ts", "useAmbiguous");
        let reference = facts.reference(&owner, "choose");
        assert!(reference.target_symbol_id.is_none());
        assert_eq!(
            reference.resolution_provenance,
            UNRESOLVED_IMPORT_PROVENANCE
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn bare_calls_do_not_resolve_to_sibling_class_methods() {
        let directory = tempdir()
            .unwrap_or_else(|error| panic!("could not create module resolver fixture: {error}"));
        write_module_project(directory.path());
        let generation = build(directory.path(), PARALLEL_WORKERS).await;
        let facts = ModuleResolverFacts {
            facts: generation.facts(),
        };
        let execute = facts.symbol("src/members.ts", "Worker::execute");
        let outer_run = facts.symbol("src/members.ts", "run");
        let reference = facts.reference(&execute, "run");
        assert_eq!(reference.target_symbol_id.as_ref(), Some(&outer_run));
        assert_eq!(reference.resolution_provenance, EXACT_SAME_FILE_PROVENANCE);
    }

    #[test]
    fn relative_module_paths_are_project_bounded_and_declaration_extensions_are_atomic() {
        assert_eq!(
            normalize_relative_module_path("src/nested/consumer.ts", "../api"),
            Some("src/api".to_owned())
        );
        assert_eq!(
            normalize_relative_module_path("consumer.ts", "./api"),
            Some("api".to_owned())
        );
        assert_eq!(
            normalize_relative_module_path("consumer.ts", "../api"),
            None
        );
        assert_eq!(
            normalize_relative_module_path("src/nested/consumer.ts", ".."),
            Some("src".to_owned())
        );
        assert_eq!(
            normalize_relative_module_path("src/consumer.ts", "package"),
            None
        );
        assert_eq!(strip_module_extension("src/api.d.ts"), Some("src/api"));
        assert_eq!(strip_module_extension("src/api.d.mts"), Some("src/api"));
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
    fn candidate_selection_polls_cancellation_within_one_reference() {
        let file_id = FileId::from_uuid_v8([TEST_FILE_ID_BYTE; DOCUMENT_UUID_BYTES]);
        let candidates = (0..INNER_CANCELLATION_CANDIDATE_COUNT)
            .map(|index| {
                let mut symbol_bytes = [TEST_SYMBOL_ID_BYTE; DOCUMENT_UUID_BYTES];
                symbol_bytes[DOCUMENT_UUID_BYTES - 1] = index;
                ResolutionCandidate {
                    file_id: file_id.clone(),
                    symbol_id: SymbolId::from_uuid_v8(symbol_bytes),
                    parent_symbol_id: None,
                    kind: SymbolKind::Function,
                    exported: true,
                    declaration_only: false,
                    top_level: true,
                }
            })
            .collect::<Vec<_>>();
        let polls = Cell::new(0_u64);
        let result = select_candidate(&candidates, |_| true, &mut || {
            let next = polls.get().saturating_add(1);
            polls.set(next);
            next >= INNER_CANCEL_AFTER_POLLS
        });
        assert!(matches!(result, Err(StageItemFailure)));
        assert_eq!(polls.get(), INNER_CANCEL_AFTER_POLLS);
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

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    async fn polyglot_and_module_forms_produce_resolved_nonempty_graphs() {
        let directory = match tempdir() {
            Ok(directory) => directory,
            Err(error) => panic!("could not create polyglot pipeline fixture: {error}"),
        };
        write_polyglot_project(directory.path());
        let generation = build(directory.path(), PARALLEL_WORKERS).await;
        let facts = ModuleResolverFacts {
            facts: generation.facts(),
        };

        assert_polyglot_languages(generation.facts());
        assert_polyglot_resolved_references(&facts);

        assert_polyglot_export_edges(&facts);
        assert_polyglot_rejections(&facts);
        assert_polyglot_files_are_nonempty(generation.facts());
    }

    fn assert_polyglot_languages(facts: &CanonicalGenerationFacts) {
        let languages = facts
            .files()
            .iter()
            .map(|file| file.language.as_str())
            .collect::<BTreeSet<_>>();
        assert_eq!(
            languages,
            BTreeSet::from(["go", "javascript", "python", "rust", "typescript"])
        );
    }

    fn assert_polyglot_resolved_references(facts: &ModuleResolverFacts<'_>) {
        for expected in POLYGLOT_RESOLVED_REFERENCES {
            let caller = facts.symbol(expected.caller_path, expected.caller_name);
            let target = facts.symbol(expected.target_path, expected.target_name);
            let reference = facts.reference(&caller, expected.reference_name);
            let label = format!("{}:{}", expected.caller_path, expected.reference_name);
            assert_eq!(
                reference.target_symbol_id.as_ref(),
                Some(&target),
                "{label}"
            );
            assert_eq!(
                reference.resolution_provenance, expected.provenance,
                "{label}"
            );
        }
    }

    fn assert_polyglot_export_edges(facts: &ModuleResolverFacts<'_>) {
        assert_source_reexport_edge(facts);
        assert_local_export_edge(facts);
        assert_commonjs_declaration_edge(facts);
    }

    fn assert_source_reexport_edge(facts: &ModuleResolverFacts<'_>) {
        let renamed = facts.symbol("barrel.ts", "renamed");
        let core = facts.symbol("core.ts", "core");
        let reference = facts.reference(&renamed, "core");
        assert_eq!(reference.target_symbol_id.as_ref(), Some(&core));
        assert_eq!(reference.resolution_provenance, IMPORT_BINDING_PROVENANCE);
    }

    fn assert_local_export_edge(facts: &ModuleResolverFacts<'_>) {
        let public_internal = facts.symbol("local_alias.ts", "publicInternal");
        let internal = facts.symbol("local_alias.ts", "internal");
        let reference = facts.reference(&public_internal, "internal");
        assert_eq!(reference.target_symbol_id.as_ref(), Some(&internal));
        assert_eq!(reference.resolution_provenance, EXACT_SAME_FILE_PROVENANCE);
    }

    fn assert_commonjs_declaration_edge(facts: &ModuleResolverFacts<'_>) {
        let target = facts.symbol("cjs_helper.js", "cjsHelper");
        let reference = facts.import_declaration_reference("cjs_destructured.cjs", "cjsHelper");
        assert_eq!(reference.target_symbol_id.as_ref(), Some(&target));
        assert_eq!(reference.resolution_provenance, IMPORT_BINDING_PROVENANCE);
    }

    fn assert_polyglot_rejections(facts: &ModuleResolverFacts<'_>) {
        let bare_go_call = facts.symbol("go_bare.go", "BareGoCall");
        for name in ["Run", "ForeignOnly", "ExternalOnly", "fixture"] {
            let reference = facts.reference(&bare_go_call, name);
            assert!(reference.target_symbol_id.is_none(), "{name}");
            assert_eq!(
                reference.resolution_provenance, UNRESOLVED_PROVENANCE,
                "{name}"
            );
        }
        let cross_language = facts.symbol("cross_language.ts", "crossLanguage");
        let reference = facts.reference(&cross_language, "python_helper");
        assert!(reference.target_symbol_id.is_none());
        assert_eq!(
            reference.resolution_provenance,
            UNRESOLVED_IMPORT_PROVENANCE
        );
        let rust_rejected = facts.symbol("lib.rs", "rust_rejected");
        for name in [
            "rust_helper::hidden",
            "rust_helper::nested_only",
            "rust_helper::orphan_method",
            "rust_helper::inner",
            "conflict::conflict_helper",
            "index_only::index_helper",
        ] {
            let reference = facts.reference(&rust_rejected, name);
            assert!(reference.target_symbol_id.is_none(), "{name}");
            assert_eq!(
                reference.resolution_provenance, UNRESOLVED_IMPORT_PROVENANCE,
                "{name}"
            );
        }
        let use_fake = facts.symbol("use_fake.ts", "useFake");
        let reference = facts.reference(&use_fake, "fake");
        assert!(reference.target_symbol_id.is_none());
        assert_eq!(
            reference.resolution_provenance,
            UNRESOLVED_IMPORT_PROVENANCE
        );
        let dynamic_require = facts.symbol("dynamic_require.cjs", "dynamicUse");
        let reference = facts.reference(&dynamic_require, "require");
        assert!(reference.target_symbol_id.is_none());
        assert_eq!(reference.resolution_provenance, UNRESOLVED_PROVENANCE);
    }

    fn assert_polyglot_files_are_nonempty(facts: &CanonicalGenerationFacts) {
        for (path, _) in POLYGLOT_FIXTURES {
            let file = facts
                .files()
                .iter()
                .find(|file| file.normalized_path == path)
                .unwrap_or_else(|| panic!("polyglot file was not indexed: {path}"));
            assert!(
                facts
                    .symbols()
                    .iter()
                    .any(|symbol| symbol.file_id == file.file_id),
                "{path}"
            );
        }
    }

    fn write_polyglot_project(root: &std::path::Path) {
        for directory in POLYGLOT_DIRECTORIES {
            assert!(fs::create_dir(root.join(directory)).is_ok(), "{directory}");
        }
        for (path, source) in POLYGLOT_FIXTURES {
            assert!(fs::write(root.join(path), source).is_ok(), "{path}");
        }
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
