//! Native source discovery and extraction for Cartograph v2.

mod budget;
mod discovery;
mod identity;
mod model;
mod native;
mod reader;
mod snapshot;
mod walk;

pub use budget::{native_extraction_reservation, native_output_limit, native_read_reservation};
pub use discovery::{
    DiscoveredSource, DiscoveryLimits, DiscoveryLimitsError, SourceDiscoveryError,
    SourceDiscoveryOptions,
};
pub use model::{
    Containment, DiagnosticCode, ExtractedFile, ExtractedReference, ExtractedSymbol,
    ExtractionDiagnostic,
};
pub use native::{ExtractError, NativeExtractor};
pub use reader::{SourceReadError, SourceReadOptions, SourceRoot};
pub use snapshot::{
    SnapshotError, SourceLimits, SourceLimitsError, SourceSnapshot, is_test_source_path,
};
