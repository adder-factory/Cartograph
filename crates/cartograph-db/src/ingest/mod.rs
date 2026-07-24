mod copy;
mod digest;
mod model;
mod validate;

pub use model::{
    CanonicalGenerationFacts, CanonicalSearchDocument, EdgeInput, FileInput, GenerationFacts,
    GenerationMemoryMeasurement, GenerationMemoryModelError, ReferenceInput, SearchDocumentInput,
    SymbolInput,
};
pub use validate::{
    GenerationValidationError, GenerationValidationLimits, GenerationValidationReport,
    validate_generation_facts,
};

pub(crate) use copy::{CopyGenerationContext, copy_generation_facts};
