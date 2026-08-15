use cartograph_agent::{PipelineFailureReason, PipelineStage, ProjectError};
use serde::Serialize;

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

const fn pipeline_stage_failure_code(stage: PipelineStage) -> &'static str {
    stage_codes(stage).failed
}

const fn pipeline_failure_reason_code(
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
        (PipelineStage::Parse, PipelineFailureReason::SourceReadFailed) => {
            "parse_source_read_failed"
        }
        (PipelineStage::Parse, PipelineFailureReason::SourceChangedDuringParse) => {
            "parse_source_changed"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionUnsupportedLanguage) => {
            "parse_unsupported_language"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionLanguageMismatch) => {
            "parse_language_mismatch"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionGrammarUnavailable) => {
            "parse_grammar_unavailable"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionParserStopped) => {
            "parse_parser_stopped"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionCancelled) => {
            "parse_extraction_cancelled"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionInvalidSpan) => {
            "parse_invalid_span"
        }
        (PipelineStage::Parse, PipelineFailureReason::ExtractionInvalidNestingLimit) => {
            "parse_invalid_nesting_limit"
        }
        (PipelineStage::Parse, PipelineFailureReason::FileProcessingFailed) => {
            "parse_file_processing_failed"
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

/// Stable code for a failure of the index pipeline itself.
///
/// Callers layer their own surface-specific arms on top; the shared indexing
/// vocabulary lives here so the CLI and the MCP admin surface cannot drift.
pub(crate) const fn index_stage_failure_code(error: &ProjectError) -> Option<&'static str> {
    match error {
        ProjectError::BeginGenerationFailed => Some("generation_start_failed"),
        ProjectError::SourceScanFailed => Some("source_scan_failed"),
        ProjectError::SourceChangedDuringIndex => Some("source_changed_during_index"),
        ProjectError::IndexFailed => Some("index_failed"),
        ProjectError::IndexStageFailed { stage } => Some(pipeline_stage_failure_code(*stage)),
        ProjectError::IndexStageFailedWithReason { stage, reason } => {
            Some(pipeline_failure_reason_code(*stage, *reason))
        }
        ProjectError::IndexStageFileFailed { stage, failure } => {
            Some(pipeline_failure_reason_code(*stage, failure.reason()))
        }
        ProjectError::IndexLeaseFailed => Some("lease_failed"),
        ProjectError::IndexPublicationFailed => Some("publication_failed"),
        ProjectError::IndexCleanupFailed => Some("index_cleanup_failed"),
        ProjectError::ScipOverlayInvalid => Some("scip_overlay_invalid"),
        _ => None,
    }
}

pub(crate) const fn project_index_failure_code(error: &ProjectError) -> Option<&'static str> {
    match error {
        ProjectError::RequestCancelled => Some("request_cancelled"),
        other => index_stage_failure_code(other),
    }
}

pub(crate) fn direct_index_failure_message(error: &ProjectError) -> String {
    project_index_failure_code(error).map_or_else(
        || error.to_string(),
        |code| format!("{error} (reason: {code})"),
    )
}

#[derive(Serialize)]
struct DirectIndexFailureReport<'failure> {
    error: DirectIndexFailure<'failure>,
}

#[derive(Serialize)]
struct DirectIndexFailure<'failure> {
    code: &'static str,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    stage: Option<PipelineStage>,
    previous_generation_visible: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_failure: Option<DirectFileFailure<'failure>>,
}

#[derive(Serialize)]
struct DirectFileFailure<'failure> {
    path: &'failure str,
    reason: &'static str,
    description: &'static str,
}

/// Serialize one direct-index failure without adding the ordinary text prefix.
pub(crate) fn direct_index_failure_json(error: &ProjectError) -> Result<String, serde_json::Error> {
    let (stage, file_failure) = match error {
        ProjectError::IndexStageFailed { stage }
        | ProjectError::IndexStageFailedWithReason { stage, .. } => (Some(*stage), None),
        ProjectError::IndexStageFileFailed { stage, failure } => (
            Some(*stage),
            Some(DirectFileFailure {
                path: failure.path().as_str(),
                reason: failure.reason().as_str(),
                description: failure.reason().description(),
            }),
        ),
        _ => (None, None),
    };
    let previous_generation_visible = matches!(
        error,
        ProjectError::IndexFailed
            | ProjectError::IndexStageFailed { .. }
            | ProjectError::IndexStageFailedWithReason { .. }
            | ProjectError::IndexStageFileFailed { .. }
            | ProjectError::IndexLeaseFailed
            | ProjectError::IndexPublicationFailed
    );
    serde_json::to_string_pretty(&DirectIndexFailureReport {
        error: DirectIndexFailure {
            code: project_index_failure_code(error).unwrap_or("index_failed"),
            message: error.to_string(),
            stage,
            previous_generation_visible,
            file_failure,
        },
    })
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
    use cartograph_agent::PipelineFileFailure;
    use cartograph_domain::NormalizedPath;

    #[test]
    fn direct_cli_progress_stall_message_includes_the_qualified_stable_code() {
        let error = ProjectError::IndexStageFailedWithReason {
            stage: PipelineStage::Resolve,
            reason: PipelineFailureReason::ProgressStalled,
        };
        let message = direct_index_failure_message(&error);
        assert!(message.contains("resolve/progress_stalled"));
        assert!(message.ends_with("(reason: resolve_progress_stalled)"));
    }

    #[test]
    fn direct_cli_file_failure_is_structured_relative_and_terminal_safe() {
        let path = NormalizedPath::parse("src/broken\nfile.rs")
            .unwrap_or_else(|error| panic!("fixture path was invalid: {error}"));
        let error = ProjectError::IndexStageFileFailed {
            stage: PipelineStage::Parse,
            failure: PipelineFileFailure::new(
                path,
                PipelineFailureReason::SourceChangedDuringParse,
            ),
        };

        let message = direct_index_failure_message(&error);
        assert_eq!(message.lines().count(), 1);
        assert!(message.contains("src/broken\\nfile.rs"));
        assert!(message.ends_with("(reason: parse_source_changed)"));

        let encoded = direct_index_failure_json(&error).unwrap_or_else(|serialization| {
            panic!("failure JSON was unavailable: {serialization}")
        });
        let report: serde_json::Value = serde_json::from_str(&encoded)
            .unwrap_or_else(|serialization| panic!("failure JSON was invalid: {serialization}"));
        assert_eq!(report["error"]["code"], "parse_source_changed");
        assert_eq!(report["error"]["stage"], "parse");
        assert_eq!(report["error"]["previous_generation_visible"], true);
        assert_eq!(
            report["error"]["file_failure"]["path"],
            "src/broken\nfile.rs"
        );
        assert_eq!(
            report["error"]["file_failure"]["reason"],
            "source_changed_during_parse"
        );
        assert!(
            report["error"]["file_failure"]["description"]
                .as_str()
                .is_some_and(|description| description.contains("manifest entry"))
        );
    }
}
