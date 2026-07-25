use std::ops::ControlFlow;

use cartograph_domain::{FileParseStatus, SourceLanguage};
use thiserror::Error;
use tree_sitter::{ParseOptions, Parser, Point, Query};

use crate::{
    ExtractedFile, ExtractionStrategy, LanguageSpec, SourceSnapshot, custom, framework, tags,
    test_names, walk,
};

/// Reusable one-language native parser. Create one per bounded worker.
pub struct NativeExtractor {
    language: SourceLanguage,
    strategy: ExtractionStrategy,
    tags_query: Option<&'static Query>,
    parser: Option<Parser>,
}

impl NativeExtractor {
    /// Load one production-admitted native grammar and reject ABI mismatch.
    pub fn new(language: SourceLanguage) -> Result<Self, ExtractError> {
        if !language.is_native_indexable() {
            return Err(ExtractError::UnsupportedLanguage);
        }
        Self::new_for_capability_validation(language)
    }

    /// Load an implemented extractor before production admission.
    ///
    /// This constructor exists so a language family can be tested and reviewed without making
    /// it importable or indexable. Production discovery and indexing must use [`Self::new`]; the
    /// registry admits a mode only after extraction, cross-file resolution, publication, and
    /// retrieval gates all pass.
    pub fn new_for_capability_validation(language: SourceLanguage) -> Result<Self, ExtractError> {
        let spec = LanguageSpec::for_language(language);
        if !spec.strategy().is_executable() {
            return Err(ExtractError::UnsupportedLanguage);
        }
        let (tags_query, parser) = if spec.strategy() == ExtractionStrategy::CustomStructural {
            (None, None)
        } else {
            let grammar = spec
                .grammar()
                .ok_or(ExtractError::UnsupportedLanguage)?
                .language();
            let tags_query = if spec.strategy() == ExtractionStrategy::TagsQuery {
                Some(tags::query_for(language, &grammar)?)
            } else {
                None
            };
            let mut parser = Parser::new();
            parser
                .set_language(&grammar)
                .map_err(|_| ExtractError::GrammarUnavailable)?;
            (tags_query, Some(parser))
        };
        Ok(Self {
            language,
            strategy: spec.strategy(),
            tags_query,
            parser,
        })
    }

    /// Extract one immutable snapshot without an external cancellation probe.
    pub fn extract(&mut self, snapshot: &SourceSnapshot) -> Result<ExtractedFile, ExtractError> {
        self.extract_with_cancellation(snapshot, || false)
    }

    /// Extract one snapshot while polling a supervisor-owned cancellation probe.
    pub fn extract_with_cancellation(
        &mut self,
        snapshot: &SourceSnapshot,
        mut cancelled: impl FnMut() -> bool,
    ) -> Result<ExtractedFile, ExtractError> {
        if snapshot.language() != self.language {
            return Err(ExtractError::LanguageMismatch);
        }
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        if self.strategy == ExtractionStrategy::CustomStructural {
            let extracted = custom::extract(snapshot, &mut cancelled)?;
            let extracted = framework::enrich(snapshot, extracted, &mut cancelled)?;
            return test_names::enrich(snapshot, extracted);
        }

        let source = snapshot.source().as_bytes();
        let mut interrupted = false;
        let tree = {
            let mut input = |offset: usize, _position: Point| match source.get(offset..) {
                Some(remaining) => remaining,
                None => &[],
            };
            let mut progress = |_state: &tree_sitter::ParseState| {
                if cancelled() {
                    interrupted = true;
                    ControlFlow::Break(())
                } else {
                    ControlFlow::Continue(())
                }
            };
            let options = ParseOptions::new().progress_callback(&mut progress);
            self.parser
                .as_mut()
                .ok_or(ExtractError::GrammarUnavailable)?
                .parse_with_options(&mut input, None, Some(options))
        };
        let Some(tree) = tree else {
            self.parser
                .as_mut()
                .ok_or(ExtractError::GrammarUnavailable)?
                .reset();
            return if interrupted {
                Err(ExtractError::Cancelled)
            } else {
                Err(ExtractError::ParserStopped)
            };
        };
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }

        let root = tree.root_node();
        let parse_status = if root.has_error() {
            FileParseStatus::Partial
        } else {
            FileParseStatus::Parsed
        };
        if self.strategy == ExtractionStrategy::TagsQuery {
            let extracted = tags::extract(
                snapshot,
                root,
                parse_status,
                self.tags_query.ok_or(ExtractError::GrammarUnavailable)?,
                &mut cancelled,
            )?;
            let extracted = framework::enrich(snapshot, extracted, &mut cancelled)?;
            return test_names::enrich(snapshot, extracted);
        }
        let extracted = walk::extract(
            snapshot,
            walk::WalkInput::new(root, parse_status),
            &mut cancelled,
        )?;
        let extracted = framework::enrich(snapshot, extracted, &mut cancelled)?;
        test_names::enrich(snapshot, extracted)
    }
}

/// Credential-safe native grammar, cancellation, or source-boundary failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum ExtractError {
    /// No executable extractor exists, or production admission has not been granted.
    #[error("source language is not available through this native extractor entry point")]
    UnsupportedLanguage,
    /// The reusable parser was called with a snapshot for another grammar.
    #[error("native parser language does not match the source snapshot")]
    LanguageMismatch,
    /// A statically linked grammar was incompatible with the parser ABI.
    #[error("native grammar is unavailable")]
    GrammarUnavailable,
    /// Tree-sitter stopped without a supervisor cancellation request.
    #[error("native parser stopped before producing a syntax tree")]
    ParserStopped,
    /// The supervisor requested cancellation before extraction completed.
    #[error("native extraction was cancelled")]
    Cancelled,
    /// A parser offset could not fit the durable source-span contract.
    #[error("native parser produced an invalid source span")]
    InvalidSpan,
    /// A source syntax tree exceeded the defensive nesting ceiling.
    #[error("native source nesting exceeds the extraction limit")]
    NestingLimit,
    /// Extracted facts exceeded the per-file fact, string, or modeled-output bound.
    #[error("native extraction output exceeds the configured bound")]
    OutputLimit,
}
