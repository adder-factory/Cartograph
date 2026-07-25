use std::collections::{BTreeMap, BTreeSet};

use cartograph_db::{
    CurrentSourceRangeLookup, CurrentSymbolRecord, RenameReferenceSite, StorageError,
};
use cartograph_domain::{ContentDigest, NormalizedPath, ProjectId, SourceManifestDigestBuilder};
use cartograph_extract::{SourceDiscoveryOptions, SourceReadOptions, SourceRoot};
use futures_util::{StreamExt, stream};
use serde::Serialize;
use thiserror::Error;

use crate::{ProjectCancellation, ProjectRuntime, discovery_limits, utf8_boundary};

const MAXIMUM_RENAME_SITES: u16 = 500;
const MAXIMUM_TEXTUAL_MENTIONS: u16 = 500;
const DEFAULT_MAXIMUM_MENTION_FILE_BYTES: u64 = 1024 * 1024;
const MENTION_SNIPPET_BYTES: usize = 200;
const ENCLOSING_LOOKUP_LIMIT: u16 = 20;
const ENCLOSING_LOOKUP_CONCURRENCY: usize = 8;

/// Validated exact-reference and textual-mention bounds for a rename plan.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RenamePlanOptions {
    reference_limit: u16,
    mention_limit: u16,
    maximum_mention_file_bytes: u64,
}

impl RenamePlanOptions {
    pub const fn new(reference_limit: u16, mention_limit: u16) -> Result<Self, RenamePlanError> {
        if reference_limit == 0
            || reference_limit > MAXIMUM_RENAME_SITES
            || mention_limit > MAXIMUM_TEXTUAL_MENTIONS
        {
            return Err(RenamePlanError::InvalidOptions);
        }
        Ok(Self {
            reference_limit,
            mention_limit,
            maximum_mention_file_bytes: DEFAULT_MAXIMUM_MENTION_FILE_BYTES,
        })
    }
}

/// Exact graph reference enriched with a fresh one-based source line.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameReferenceEvidence {
    path: String,
    line: u32,
    owner_symbol_id: Option<String>,
    start_byte: u64,
    end_byte: u64,
    reference_kind: String,
    confidence: f32,
    provenance: String,
    represented_site: String,
}

/// Review-only word-boundary mention outside the declaration/reference rows.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTextualMention {
    path: String,
    line: u32,
    text: String,
    enclosing_symbol_id: Option<String>,
    enclosing_qualified_name: Option<String>,
    enclosing_symbol_kind: Option<String>,
    confidence: &'static str,
}

/// Complete bounded plan. It never edits source.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenamePlan {
    definition: CurrentSymbolRecord,
    source_revision: ContentDigest,
    exact_reference_count: u64,
    exact_references_truncated: bool,
    exact_references: Vec<RenameReferenceEvidence>,
    textual_mention_count: u64,
    textual_mentions_truncated: bool,
    textual_mentions: Vec<RenameTextualMention>,
    skipped_large_files: u64,
    edits_applied: bool,
}

/// Credential-safe rename planning failures.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum RenamePlanError {
    #[error("rename plan options are invalid")]
    InvalidOptions,
    #[error("rename graph evidence is unavailable")]
    StorageUnavailable,
    #[error("rename source evidence is unavailable")]
    SourceUnavailable,
    #[error("source or generation changed during rename planning")]
    SourceChanged,
    #[error("rename planning was cancelled")]
    Cancelled,
}

impl ProjectRuntime {
    /// Build a fresh exact-reference plus textual-mention plan without editing files.
    pub async fn plan_rename(
        &self,
        project_id: ProjectId,
        definition: CurrentSymbolRecord,
        options: RenamePlanOptions,
        cancellation: ProjectCancellation,
    ) -> Result<RenamePlan, RenamePlanError> {
        let before = self
            .database()
            .project_snapshot_by_root(self.root_identity())
            .await
            .map_err(|_| RenamePlanError::StorageUnavailable)?
            .ok_or(RenamePlanError::SourceChanged)?;
        let current = before
            .current
            .as_ref()
            .ok_or(RenamePlanError::SourceChanged)?;
        if before.project_id != project_id || definition.generation_id() != &current.generation_id {
            return Err(RenamePlanError::SourceChanged);
        }
        let generation_id = current.generation_id.clone();
        let expected_revision = current.source_revision.clone();
        let references = self
            .database()
            .current_rename_reference_evidence(&project_id, definition.symbol_id())
            .await
            .map_err(|_| RenamePlanError::StorageUnavailable)?;
        let exact_reference_count = u64::try_from(references.len()).unwrap_or(u64::MAX);
        let permit = tokio::select! {
            biased;
            () = cancellation.cancelled() => return Err(RenamePlanError::Cancelled),
            result = self.source_scan_permits.clone().acquire_owned() => {
                result.map_err(|_| RenamePlanError::SourceUnavailable)?
            }
        };
        let root = self.root.clone();
        let definition_path = definition.path().as_str().to_owned();
        let definition_line = definition.start_line();
        let symbol_name = simple_symbol_name(definition.qualified_name()).to_owned();
        let worker_cancellation = cancellation.clone();
        let mut scan = tokio::task::spawn_blocking(move || {
            let _permit = permit;
            scan_rename_source(
                &root,
                &symbol_name,
                &definition_path,
                definition_line,
                references,
                options,
                || worker_cancellation.is_cancelled(),
            )
        })
        .await
        .map_err(|_| RenamePlanError::SourceUnavailable)??;
        if cancellation.is_cancelled() {
            return Err(RenamePlanError::Cancelled);
        }
        let observed = self
            .scan_source(None, cancellation.clone())
            .await
            .map_err(|_| RenamePlanError::SourceUnavailable)?;
        if observed.digest.as_str() != expected_revision {
            return Err(RenamePlanError::SourceChanged);
        }
        scan.source_revision = observed.digest;
        let mentions = attach_enclosing_symbols(
            self,
            &project_id,
            &generation_id,
            scan.mentions,
            cancellation.clone(),
        )
        .await?;
        let after = self
            .database()
            .project_snapshot_by_root(self.root_identity())
            .await
            .map_err(|_| RenamePlanError::StorageUnavailable)?;
        let unchanged = after.as_ref().is_some_and(|snapshot| {
            snapshot.project_id == project_id
                && snapshot.current.as_ref().is_some_and(|current| {
                    current.generation_id == generation_id
                        && current.source_revision == expected_revision
                })
        });
        if !unchanged {
            return Err(RenamePlanError::SourceChanged);
        }
        let mut exact_references = scan.references;
        exact_references.truncate(usize::from(options.reference_limit));
        Ok(RenamePlan {
            definition,
            source_revision: scan.source_revision,
            exact_reference_count,
            exact_references_truncated: exact_reference_count > u64::from(options.reference_limit),
            exact_references,
            textual_mention_count: scan.mention_count,
            textual_mentions_truncated: scan.mention_count > u64::from(options.mention_limit),
            textual_mentions: mentions,
            skipped_large_files: scan.skipped_large_files,
            edits_applied: false,
        })
    }
}

struct RenameSourceScan {
    source_revision: ContentDigest,
    references: Vec<RenameReferenceEvidence>,
    mentions: Vec<RawMention>,
    mention_count: u64,
    skipped_large_files: u64,
}

#[derive(Clone)]
struct RawMention {
    path: String,
    line: u32,
    text: String,
}

fn scan_rename_source<Cancel>(
    root: &std::path::Path,
    symbol_name: &str,
    definition_path: &str,
    definition_line: u32,
    references: Vec<RenameReferenceSite>,
    options: RenamePlanOptions,
    mut cancelled: Cancel,
) -> Result<RenameSourceScan, RenamePlanError>
where
    Cancel: FnMut() -> bool,
{
    let source_policy =
        crate::project_source_policy(root).map_err(|_| RenamePlanError::SourceUnavailable)?;
    let maximum_source_bytes = source_policy
        .maximum_file_bytes
        .unwrap_or(crate::DEFAULT_MAX_SOURCE_BYTES);
    let source_root = SourceRoot::open_with_policy(root, source_policy.discovery)
        .map_err(|_| RenamePlanError::SourceUnavailable)?;
    let discovery = discovery_limits().map_err(|_| RenamePlanError::SourceUnavailable)?;
    let read_limits = crate::source_limits_with_max(maximum_source_bytes)
        .map_err(|_| RenamePlanError::SourceUnavailable)?;
    let files = source_root
        .discover_with_cancellation(SourceDiscoveryOptions::new(discovery, &mut cancelled))
        .map_err(map_source_error)?;
    let mut references_by_path = BTreeMap::<String, Vec<RenameReferenceSite>>::new();
    for reference in references {
        references_by_path
            .entry(reference.path().to_owned())
            .or_default()
            .push(reference);
    }
    let mut digest = SourceManifestDigestBuilder::new(files.len())
        .map_err(|_| RenamePlanError::SourceUnavailable)?;
    let mut exact = Vec::new();
    let mut mentions = Vec::new();
    let mut mention_count = 0_u64;
    let mut skipped_large_files = 0_u64;
    for file in &files {
        if cancelled() {
            return Err(RenamePlanError::Cancelled);
        }
        let snapshot = source_root
            .read_with_cancellation(
                file.path(),
                SourceReadOptions::new(read_limits, &mut cancelled),
            )
            .map_err(map_source_error)?;
        digest
            .push(file.path(), snapshot.content_hash())
            .map_err(|_| RenamePlanError::SourceUnavailable)?;
        let mut exact_lines = BTreeSet::new();
        if let Some(file_references) = references_by_path.remove(file.path().as_str()) {
            for reference in file_references {
                let start = usize::try_from(reference.start_byte())
                    .map_err(|_| RenamePlanError::SourceChanged)?;
                let end = usize::try_from(reference.end_byte())
                    .map_err(|_| RenamePlanError::SourceChanged)?;
                let represented_site = snapshot
                    .source()
                    .get(start..end)
                    .ok_or(RenamePlanError::SourceChanged)?;
                let line = one_based_line(snapshot.source(), start)?;
                exact_lines.insert(line);
                exact.push(RenameReferenceEvidence {
                    path: file.path().as_str().to_owned(),
                    line,
                    owner_symbol_id: reference.owner_symbol_id().map(str::to_owned),
                    start_byte: reference.start_byte(),
                    end_byte: reference.end_byte(),
                    reference_kind: reference.reference_kind().to_owned(),
                    confidence: reference.confidence(),
                    provenance: reference.provenance().to_owned(),
                    represented_site: bounded_text(represented_site.trim(), MENTION_SNIPPET_BYTES),
                });
            }
        }
        if options.mention_limit == 0 || file.byte_size() > options.maximum_mention_file_bytes {
            if file.byte_size() > options.maximum_mention_file_bytes {
                skipped_large_files = skipped_large_files.saturating_add(1);
            }
            continue;
        }
        for (index, line) in snapshot.source().lines().enumerate() {
            if !line_has_identifier(line, symbol_name) {
                continue;
            }
            let line_number = u32::try_from(index)
                .ok()
                .and_then(|line| line.checked_add(1))
                .ok_or(RenamePlanError::SourceUnavailable)?;
            if (file.path().as_str() == definition_path && line_number == definition_line)
                || exact_lines.contains(&line_number)
            {
                continue;
            }
            mention_count = mention_count.saturating_add(1);
            if mentions.len() < usize::from(options.mention_limit) {
                mentions.push(RawMention {
                    path: file.path().as_str().to_owned(),
                    line: line_number,
                    text: bounded_text(line.trim(), MENTION_SNIPPET_BYTES),
                });
            }
        }
    }
    if !references_by_path.is_empty() {
        return Err(RenamePlanError::SourceChanged);
    }
    Ok(RenameSourceScan {
        source_revision: digest
            .finish()
            .map_err(|_| RenamePlanError::SourceUnavailable)?,
        references: exact,
        mentions,
        mention_count,
        skipped_large_files,
    })
}

async fn attach_enclosing_symbols(
    runtime: &ProjectRuntime,
    project_id: &ProjectId,
    generation_id: &cartograph_domain::GenerationId,
    mentions: Vec<RawMention>,
    cancellation: ProjectCancellation,
) -> Result<Vec<RenameTextualMention>, RenamePlanError> {
    let database = runtime.database().clone();
    let project_id = project_id.clone();
    let generation_id = generation_id.clone();
    let mut resolved = stream::iter(mentions.into_iter().enumerate())
        .map(|(index, mention)| {
            let database = database.clone();
            let project_id = project_id.clone();
            let generation_id = generation_id.clone();
            let cancellation = cancellation.clone();
            async move {
                if cancellation.is_cancelled() {
                    return Err(RenamePlanError::Cancelled);
                }
                let path = NormalizedPath::parse(&mention.path)
                    .map_err(|_| RenamePlanError::SourceChanged)?;
                let symbols = database
                    .current_symbols_at_range(CurrentSourceRangeLookup::new(
                        &project_id,
                        &generation_id,
                        &path,
                        mention.line,
                        mention.line,
                        ENCLOSING_LOOKUP_LIMIT,
                    ))
                    .await
                    .map_err(map_storage_error)?;
                let enclosing = symbols
                    .iter()
                    .filter(|symbol| {
                        matches!(
                            symbol.symbol_kind(),
                            "function" | "method" | "class" | "interface" | "component"
                        )
                    })
                    .min_by_key(|symbol| symbol.end_line().saturating_sub(symbol.start_line()));
                Ok((
                    index,
                    RenameTextualMention {
                        path: mention.path,
                        line: mention.line,
                        text: mention.text,
                        enclosing_symbol_id: enclosing
                            .map(|symbol| symbol.symbol_id().as_str().to_owned()),
                        enclosing_qualified_name: enclosing
                            .map(|symbol| symbol.qualified_name().to_owned()),
                        enclosing_symbol_kind: enclosing
                            .map(|symbol| symbol.symbol_kind().to_owned()),
                        confidence: "textual_review_required",
                    },
                ))
            }
        })
        .buffer_unordered(ENCLOSING_LOOKUP_CONCURRENCY)
        .collect::<Vec<_>>()
        .await
        .into_iter()
        .collect::<Result<Vec<_>, RenamePlanError>>()?;
    resolved.sort_by_key(|(index, _)| *index);
    Ok(resolved.into_iter().map(|(_, mention)| mention).collect())
}

fn simple_symbol_name(qualified_name: &str) -> &str {
    let last = qualified_name
        .rsplit(['.', '#', '/'])
        .next()
        .unwrap_or(qualified_name);
    last.rsplit_once("::").map_or(last, |(_, name)| name)
}

fn line_has_identifier(line: &str, name: &str) -> bool {
    if name.is_empty() {
        return false;
    }
    line.match_indices(name).any(|(start, matched)| {
        let before = line[..start].chars().next_back();
        let after = line[start + matched.len()..].chars().next();
        before.is_none_or(|character| !identifier_character(character))
            && after.is_none_or(|character| !identifier_character(character))
    })
}

fn identifier_character(character: char) -> bool {
    character == '_' || character == '$' || character.is_alphanumeric()
}

fn one_based_line(source: &str, start: usize) -> Result<u32, RenamePlanError> {
    let prefix = source
        .as_bytes()
        .get(..start)
        .ok_or(RenamePlanError::SourceChanged)?;
    u32::try_from(prefix.iter().filter(|byte| **byte == b'\n').count())
        .ok()
        .and_then(|line| line.checked_add(1))
        .ok_or(RenamePlanError::SourceUnavailable)
}

fn bounded_text(value: &str, maximum: usize) -> String {
    let boundary = utf8_boundary(value, maximum);
    if boundary < value.len() {
        format!("{} …", &value[..boundary])
    } else {
        value.to_owned()
    }
}

fn map_storage_error(error: StorageError) -> RenamePlanError {
    match error {
        StorageError::CurrentGenerationChanged => RenamePlanError::SourceChanged,
        _ => RenamePlanError::StorageUnavailable,
    }
}

fn map_source_error<Error>(_error: Error) -> RenamePlanError {
    RenamePlanError::SourceUnavailable
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identifier_boundaries_support_unicode_and_dollar_names() {
        assert!(line_has_identifier("call Élément now", "Élément"));
        assert!(line_has_identifier("const value = data$;", "data$"));
        assert!(!line_has_identifier("database", "data"));
        assert!(!line_has_identifier("data2", "data"));
    }

    #[test]
    fn simple_names_handle_common_qualified_separators() {
        assert_eq!(simple_symbol_name("crate::module::parse"), "parse");
        assert_eq!(simple_symbol_name("Class.method"), "method");
        assert_eq!(simple_symbol_name("plain"), "plain");
    }
}
