use cartograph_agent::{PipelineFailureReason, PipelineStage, ProjectError};

/// Stable machine-readable codes one pipeline stage can report.
struct StageCodes {
    failed: &'static str,
    deadline_exceeded: &'static str,
    progress_stalled: &'static str,
}

/// Every stage's code family in one place, so a new stage cannot be added to
/// one lookup and forgotten in another.
const STAGE_CODES: [(PipelineStage, StageCodes); 11] = [
    (
        PipelineStage::Discover,
        StageCodes {
            failed: "discover_failed",
            deadline_exceeded: "discover_deadline_exceeded",
            progress_stalled: "discover_progress_stalled",
        },
    ),
    (
        PipelineStage::Read,
        StageCodes {
            failed: "read_failed",
            deadline_exceeded: "read_deadline_exceeded",
            progress_stalled: "read_progress_stalled",
        },
    ),
    (
        PipelineStage::Parse,
        StageCodes {
            failed: "parse_failed",
            deadline_exceeded: "parse_deadline_exceeded",
            progress_stalled: "parse_progress_stalled",
        },
    ),
    (
        PipelineStage::Resolve,
        StageCodes {
            failed: "resolve_failed",
            deadline_exceeded: "resolve_deadline_exceeded",
            progress_stalled: "resolve_progress_stalled",
        },
    ),
    (
        PipelineStage::Overlay,
        StageCodes {
            failed: "overlay_failed",
            deadline_exceeded: "overlay_deadline_exceeded",
            progress_stalled: "overlay_progress_stalled",
        },
    ),
    (
        PipelineStage::Reduce,
        StageCodes {
            failed: "reduce_failed",
            deadline_exceeded: "reduce_deadline_exceeded",
            progress_stalled: "reduce_progress_stalled",
        },
    ),
    (
        PipelineStage::Copy,
        StageCodes {
            failed: "copy_failed",
            deadline_exceeded: "copy_deadline_exceeded",
            progress_stalled: "copy_progress_stalled",
        },
    ),
    (
        PipelineStage::RelationalMerge,
        StageCodes {
            failed: "relational_merge_failed",
            deadline_exceeded: "relational_merge_deadline_exceeded",
            progress_stalled: "relational_merge_progress_stalled",
        },
    ),
    (
        PipelineStage::Bm25,
        StageCodes {
            failed: "bm25_failed",
            deadline_exceeded: "bm25_deadline_exceeded",
            progress_stalled: "bm25_progress_stalled",
        },
    ),
    (
        PipelineStage::Vector,
        StageCodes {
            failed: "vector_failed",
            deadline_exceeded: "vector_deadline_exceeded",
            progress_stalled: "vector_progress_stalled",
        },
    ),
    (
        PipelineStage::Publish,
        StageCodes {
            failed: "publication_failed",
            deadline_exceeded: "publication_deadline_exceeded",
            progress_stalled: "publication_progress_stalled",
        },
    ),
];

const fn stage_codes(stage: PipelineStage) -> &'static StageCodes {
    let mut index = 0;
    while index < STAGE_CODES.len() {
        let (candidate, ref codes) = STAGE_CODES[index];
        if candidate as u8 == stage as u8 {
            return codes;
        }
        index += 1;
    }
    // Every stage is listed above; the table is exhaustive by construction.
    &STAGE_CODES[0].1
}

pub(crate) const fn pipeline_stage_failure_code(stage: PipelineStage) -> &'static str {
    stage_codes(stage).failed
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
        (PipelineStage::Reduce, PipelineFailureReason::CanonicalFieldRejected(_)) => {
            "reduce_canonical_field_rejected"
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
    stage_codes(stage).deadline_exceeded
}

const fn pipeline_progress_stalled_code(stage: PipelineStage) -> &'static str {
    stage_codes(stage).progress_stalled
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
