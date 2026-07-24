use std::ops::ControlFlow;

use cartograph_domain::{FileParseStatus, SourceLanguage};
use thiserror::Error;
use tree_sitter::{Language, ParseOptions, Parser, Point};

use crate::{ExtractedFile, SourceSnapshot, walk};

/// Reusable one-language native parser. Create one per bounded worker.
pub struct NativeExtractor {
    language: SourceLanguage,
    parser: Parser,
}

impl NativeExtractor {
    /// Load one statically linked native grammar and reject ABI mismatch.
    pub fn new(language: SourceLanguage) -> Result<Self, ExtractError> {
        let grammar: Language = match language {
            SourceLanguage::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            SourceLanguage::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            SourceLanguage::JavaScript | SourceLanguage::Jsx => {
                tree_sitter_javascript::LANGUAGE.into()
            }
            SourceLanguage::Rust => tree_sitter_rust::LANGUAGE.into(),
            SourceLanguage::Python => tree_sitter_python::LANGUAGE.into(),
            SourceLanguage::Go => tree_sitter_go::LANGUAGE.into(),
        };
        let mut parser = Parser::new();
        parser
            .set_language(&grammar)
            .map_err(|_| ExtractError::GrammarUnavailable)?;
        Ok(Self { language, parser })
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
                .parse_with_options(&mut input, None, Some(options))
        };
        let Some(tree) = tree else {
            self.parser.reset();
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
        walk::extract(
            snapshot,
            walk::WalkInput::new(root, parse_status),
            &mut cancelled,
        )
    }
}

/// Credential-safe native grammar, cancellation, or source-boundary failure.
#[derive(Clone, Copy, Debug, Error, PartialEq, Eq)]
pub enum ExtractError {
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
