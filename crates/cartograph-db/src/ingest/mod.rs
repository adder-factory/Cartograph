mod copy;
mod digest;
mod model;
mod validate;

pub use model::{
    CanonicalGenerationFacts, CanonicalSearchDocument, EdgeInput, FileInput, GenerationFacts,
    GenerationMemoryMeasurement, GenerationMemoryModelError, NumericalSiteInput, ReferenceInput,
    ReferenceSpanPrecision, SearchDocumentInput, SymbolInput,
};
pub use validate::{
    GenerationValidationError, GenerationValidationLimits, GenerationValidationReport,
    validate_generation_facts,
};

pub(crate) use validate::{
    canonical_stored_metadata, validate_generation_facts_for_v1_import, validate_spill_fact_batch,
};

pub(crate) use copy::{
    CopyGenerationAttempt, CopyGenerationContext, CopyGenerationRequest, CopyTableDurations,
    CountedCopyRequest, CountedTextCopy, TextRow, copy_generation_facts,
};
pub(crate) use digest::LogicalDigestBuilder;
pub(crate) use model::ValidatedFactTables;
