mod copy;
mod digest;
mod model;
mod validate;

pub use model::{
    CanonicalGenerationFacts, CanonicalSearchDocument, EdgeInput, FileInput, GenerationFacts,
    GenerationMemoryMeasurement, GenerationMemoryModelError, ReferenceInput,
    ReferenceSpanPrecision, SearchDocumentInput, SymbolInput,
};
pub use validate::{
    GenerationValidationError, GenerationValidationLimits, GenerationValidationReport,
    validate_generation_facts,
};

pub(crate) use copy::{
    CopyGenerationAttempt, CopyGenerationContext, CopyTableDurations, copy_generation_facts,
};
