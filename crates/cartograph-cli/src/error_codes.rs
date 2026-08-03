use cartograph_agent::{PipelineFailureReason, PipelineStage};

pub(crate) const fn pipeline_stage_failure_code(stage: PipelineStage) -> &'static str {
    match stage {
        PipelineStage::Discover => "discover_failed",
        PipelineStage::Read => "read_failed",
        PipelineStage::Parse => "parse_failed",
        PipelineStage::Resolve => "resolve_failed",
        PipelineStage::Overlay => "overlay_failed",
        PipelineStage::Reduce => "reduce_failed",
        PipelineStage::Copy => "copy_failed",
        PipelineStage::RelationalMerge => "relational_merge_failed",
        PipelineStage::Bm25 => "bm25_failed",
        PipelineStage::Vector => "vector_failed",
        PipelineStage::Publish => "publication_failed",
    }
}

pub(crate) const fn pipeline_failure_reason_code(
    stage: PipelineStage,
    reason: PipelineFailureReason,
) -> &'static str {
    match (stage, reason) {
        (PipelineStage::Reduce, PipelineFailureReason::ReferenceNameTooLong) => {
            "reduce_reference_name_too_long"
        }
        _ => pipeline_stage_failure_code(stage),
    }
}
