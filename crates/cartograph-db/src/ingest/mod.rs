mod copy;
mod digest;
mod model;
mod validate;

pub use model::{
    EdgeInput, FileInput, GenerationFacts, ReferenceInput, SearchDocumentInput, SymbolInput,
};

pub(crate) use copy::{CopyGenerationContext, copy_generation_facts};
pub(crate) use model::ValidatedGenerationFacts;
pub(crate) use validate::validate_and_reduce;
