use cartograph_agent::{PipelineFailureReason, PipelineStage, ProjectError};

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
        (stage, PipelineFailureReason::DeadlineExceeded) => pipeline_deadline_code(stage),
        (stage, PipelineFailureReason::ProgressStalled) => pipeline_progress_stalled_code(stage),
        (PipelineStage::Parse, PipelineFailureReason::GenerationCapacityExceeded) => {
            "parse_generation_capacity_exceeded"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionNestingLimitExceeded) => {
            "parse_extraction_nesting_limit_exceeded"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionOutputLimitExceeded) => {
            "parse_extraction_output_limit_exceeded"
        }
        (PipelineStage::Resolve, PipelineFailureReason::GenerationCapacityExceeded) => {
            "resolve_generation_capacity_exceeded"
        }
        (PipelineStage::Reduce, PipelineFailureReason::GenerationCapacityExceeded) => {
            "reduce_generation_capacity_exceeded"
        }
        (PipelineStage::Reduce, PipelineFailureReason::ReferenceNameTooLong) => {
            "reduce_reference_name_too_long"
        }
        _ => pipeline_stage_failure_code(stage),
    }
}

pub(crate) const fn project_index_failure_code(error: ProjectError) -> Option<&'static str> {
    match error {
        ProjectError::BeginGenerationFailed => Some("generation_start_failed"),
        ProjectError::SourceScanFailed => Some("source_scan_failed"),
        ProjectError::IndexFailed => Some("index_failed"),
        ProjectError::IndexStageFailed { stage } => Some(pipeline_stage_failure_code(stage)),
        ProjectError::IndexStageFailedWithReason { stage, reason } => {
            Some(pipeline_failure_reason_code(stage, reason))
        }
        ProjectError::IndexLeaseFailed => Some("lease_failed"),
        ProjectError::IndexPublicationFailed => Some("publication_failed"),
        ProjectError::IndexCleanupFailed => Some("index_cleanup_failed"),
        ProjectError::ScipOverlayInvalid => Some("scip_overlay_invalid"),
        ProjectError::RequestCancelled => Some("request_cancelled"),
        _ => None,
    }
}

pub(crate) fn direct_index_failure_message(error: ProjectError) -> String {
    project_index_failure_code(error).map_or_else(
        || error.to_string(),
        |code| format!("{error} (reason: {code})"),
    )
}

const fn pipeline_deadline_code(stage: PipelineStage) -> &'static str {
    match stage {
        PipelineStage::Discover => "discover_deadline_exceeded",
        PipelineStage::Read => "read_deadline_exceeded",
        PipelineStage::Parse => "parse_deadline_exceeded",
        PipelineStage::Resolve => "resolve_deadline_exceeded",
        PipelineStage::Overlay => "overlay_deadline_exceeded",
        PipelineStage::Reduce => "reduce_deadline_exceeded",
        PipelineStage::Copy => "copy_deadline_exceeded",
        PipelineStage::RelationalMerge => "relational_merge_deadline_exceeded",
        PipelineStage::Bm25 => "bm25_deadline_exceeded",
        PipelineStage::Vector => "vector_deadline_exceeded",
        PipelineStage::Publish => "publication_deadline_exceeded",
    }
}

const fn pipeline_progress_stalled_code(stage: PipelineStage) -> &'static str {
    match stage {
        PipelineStage::Discover => "discover_progress_stalled",
        PipelineStage::Read => "read_progress_stalled",
        PipelineStage::Parse => "parse_progress_stalled",
        PipelineStage::Resolve => "resolve_progress_stalled",
        PipelineStage::Overlay => "overlay_progress_stalled",
        PipelineStage::Reduce => "reduce_progress_stalled",
        PipelineStage::Copy => "copy_progress_stalled",
        PipelineStage::RelationalMerge => "relational_merge_progress_stalled",
        PipelineStage::Bm25 => "bm25_progress_stalled",
        PipelineStage::Vector => "vector_progress_stalled",
        PipelineStage::Publish => "publication_progress_stalled",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_cli_progress_stall_message_includes_the_qualified_stable_code() {
        let error = ProjectError::IndexStageFailedWithReason {
            stage: PipelineStage::Resolve,
            reason: PipelineFailureReason::ProgressStalled,
        };
        let message = direct_index_failure_message(error);
        assert!(message.contains("resolve/progress_stalled"));
        assert!(message.ends_with("(reason: resolve_progress_stalled)"));
    }
}
