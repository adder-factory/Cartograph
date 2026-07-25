use std::collections::BTreeSet;

use cartograph_domain::{
    ReferenceKind, SourceLanguage, SourcePosition, SourceSpan, SymbolId, SymbolKind,
};
use tree_sitter::Node;

use crate::{
    EMBEDDED_SQL_RESOLUTION_PREFIX, ExtractError, ExtractedReference,
    walk::{
        ExtractionBuilder,
        syntax::{descendants_including_root, named_children},
    },
};

const MAX_AST_DEPTH: usize = 256;
const MAX_AST_VISITS: usize = 500_000;
const MAX_LITERAL_BYTES: usize = 1024 * 1024;
const MAX_TOKENS_PER_LITERAL: usize = 65_536;
const MAX_REFERENCES_PER_FILE: usize = 4_096;
const MAX_IDENTIFIER_PARTS: usize = 3;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum SqlOperation {
    Read,
    Write,
    Ddl,
}

impl SqlOperation {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Ddl => "ddl",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TokenKind {
    Word,
    QuotedIdentifier,
    Dot,
}

#[derive(Clone, Copy, Debug)]
struct Token {
    kind: TokenKind,
    source_start: usize,
    source_end: usize,
    value_start: usize,
    value_end: usize,
}

impl Token {
    fn value(self, source: &str) -> &str {
        source
            .get(self.value_start..self.value_end)
            .unwrap_or_default()
    }

    fn is_keyword(self, source: &str, keyword: &str) -> bool {
        self.kind == TokenKind::Word && self.value(source).eq_ignore_ascii_case(keyword)
    }

    const fn identifier(self) -> bool {
        matches!(self.kind, TokenKind::Word | TokenKind::QuotedIdentifier)
    }
}

struct SqlHit {
    name: String,
    operation: SqlOperation,
    start: usize,
    end: usize,
}

#[derive(Default)]
struct ScanBudget {
    visits: usize,
    references: usize,
}

impl ScanBudget {
    fn observe(
        &mut self,
        builder: &mut ExtractionBuilder<'_, '_>,
        depth: usize,
    ) -> Result<(), ExtractError> {
        if depth > MAX_AST_DEPTH {
            return Err(ExtractError::NestingLimit);
        }
        self.visits = self
            .visits
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.visits > MAX_AST_VISITS {
            return Err(ExtractError::OutputLimit);
        }
        if self.visits.is_multiple_of(256) {
            builder.context.ensure_active()?;
        }
        Ok(())
    }

    fn admit_reference(&mut self) -> Result<(), ExtractError> {
        self.references = self
            .references
            .checked_add(1)
            .ok_or(ExtractError::OutputLimit)?;
        if self.references > MAX_REFERENCES_PER_FILE {
            Err(ExtractError::OutputLimit)
        } else {
            Ok(())
        }
    }
}

struct LineIndex {
    starts: Vec<usize>,
}

impl LineIndex {
    fn new(source: &str) -> Result<Self, ExtractError> {
        let line_count = source
            .bytes()
            .filter(|byte| *byte == b'\n')
            .count()
            .saturating_add(1);
        let mut starts = Vec::new();
        starts
            .try_reserve_exact(line_count)
            .map_err(|_| ExtractError::OutputLimit)?;
        starts.push(0);
        for (index, byte) in source.bytes().enumerate() {
            if byte == b'\n' {
                starts.push(index.saturating_add(1));
            }
        }
        Ok(Self { starts })
    }

    fn span(
        &self,
        start: usize,
        end: usize,
        source_len: usize,
    ) -> Result<SourceSpan, ExtractError> {
        if start >= end || end > source_len {
            return Err(ExtractError::InvalidSpan);
        }
        SourceSpan::new(self.position(start)?, self.position(end)?)
            .map_err(|_| ExtractError::InvalidSpan)
    }

    fn position(&self, byte: usize) -> Result<SourcePosition, ExtractError> {
        let line_index = self.starts.partition_point(|start| *start <= byte) - 1;
        SourcePosition::new(
            u64::try_from(byte).map_err(|_| ExtractError::InvalidSpan)?,
            u32::try_from(line_index.saturating_add(1)).map_err(|_| ExtractError::InvalidSpan)?,
            u32::try_from(byte.saturating_sub(self.starts[line_index]))
                .map_err(|_| ExtractError::InvalidSpan)?,
        )
        .map_err(|_| ExtractError::InvalidSpan)
    }
}

pub(super) fn enrich(
    builder: &mut ExtractionBuilder<'_, '_>,
    root: Node<'_>,
) -> Result<(), ExtractError> {
    if !supported_language(builder.context.snapshot.language()) {
        return Ok(());
    }
    let lines = LineIndex::new(builder.context.source())?;
    let mut budget = ScanBudget::default();
    scan_literals(builder, root, 0, &lines, &mut budget)
}

fn supported_language(language: SourceLanguage) -> bool {
    matches!(
        language,
        SourceLanguage::TypeScript
            | SourceLanguage::JavaScript
            | SourceLanguage::Tsx
            | SourceLanguage::Jsx
            | SourceLanguage::Python
            | SourceLanguage::Go
            | SourceLanguage::Rust
            | SourceLanguage::Java
            | SourceLanguage::Kotlin
            | SourceLanguage::CSharp
            | SourceLanguage::Php
            | SourceLanguage::Ruby
            | SourceLanguage::Sql
    )
}

fn scan_literals(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    depth: usize,
    lines: &LineIndex,
    budget: &mut ScanBudget,
) -> Result<(), ExtractError> {
    budget.observe(builder, depth)?;
    let language = builder.context.snapshot.language();
    if string_literal_node(node, language)
        && !node
            .parent()
            .is_some_and(|parent| string_literal_node(parent, language))
        && !contains_dynamic_fragment(node)
    {
        scan_literal(builder, node, lines, budget)?;
        return Ok(());
    }
    for child in named_children(node) {
        scan_literals(builder, child, depth.saturating_add(1), lines, budget)?;
    }
    Ok(())
}

fn string_literal_node(node: Node<'_>, language: SourceLanguage) -> bool {
    let kind = node.kind();
    matches!(
        kind,
        "string"
            | "string_literal"
            | "raw_string_literal"
            | "interpreted_string_literal"
            | "template_string"
            | "line_string_literal"
            | "multi_line_string_literal"
            | "heredoc_body"
            | "nowdoc_body"
    ) || (language == SourceLanguage::Sql && kind == "literal")
        || (kind.contains("string")
            && !kind.contains("interpolation")
            && !kind.contains("fragment")
            && !kind.contains("escape"))
}

fn contains_dynamic_fragment(node: Node<'_>) -> bool {
    descendants_including_root(node).any(|current| {
        let kind = current.kind();
        kind.contains("interpolation")
            || kind.contains("substitution")
            || kind.contains("format_expression")
            || kind.contains("embedded_expression")
    })
}

fn scan_literal(
    builder: &mut ExtractionBuilder<'_, '_>,
    node: Node<'_>,
    lines: &LineIndex,
    budget: &mut ScanBudget,
) -> Result<(), ExtractError> {
    let raw = builder.context.text(node);
    let Some((content_start, content_end)) = literal_content_bounds(raw) else {
        return Ok(());
    };
    let Some(content) = raw.get(content_start..content_end) else {
        return Ok(());
    };
    if content.len() > MAX_LITERAL_BYTES {
        return Err(ExtractError::OutputLimit);
    }
    if content.contains("${") {
        return Ok(());
    }
    let tokens = tokenize(content)?;
    if tokens.is_empty() || !has_sql_anchor(&tokens, content) {
        return Ok(());
    }
    let hits = collect_hits(&tokens, content)?;
    let owner = owner_for_node(builder, node);
    let source_len = builder.context.source().len();
    let base = node
        .start_byte()
        .checked_add(content_start)
        .ok_or(ExtractError::InvalidSpan)?;
    for hit in hits {
        builder.context.ensure_active()?;
        budget.admit_reference()?;
        let start = base
            .checked_add(hit.start)
            .ok_or(ExtractError::InvalidSpan)?;
        let end = base.checked_add(hit.end).ok_or(ExtractError::InvalidSpan)?;
        let resolution_name = resolution_name(builder, hit.operation, &hit.name)?;
        builder.emit_reference(ExtractedReference {
            owner: owner.clone(),
            name: hit.name,
            resolution_name: Some(resolution_name),
            kind: ReferenceKind::References,
            span: lines.span(start, end, source_len)?,
        })?;
    }
    Ok(())
}

fn literal_content_bounds(raw: &str) -> Option<(usize, usize)> {
    if raw.is_empty() {
        return None;
    }
    let bytes = raw.as_bytes();
    let first = bytes
        .iter()
        .position(|byte| matches!(byte, b'\'' | b'"' | b'`'));
    let Some(first) = first else {
        return Some((0, raw.len()));
    };
    let delimiter = bytes[first];
    let triple = bytes
        .get(first..first.saturating_add(3))
        .is_some_and(|value| value == [delimiter, delimiter, delimiter]);
    let width = if triple { 3 } else { 1 };
    let start = first.checked_add(width)?;
    let end = if triple {
        bytes
            .windows(3)
            .rposition(|window| window == [delimiter, delimiter, delimiter])?
    } else {
        bytes.iter().rposition(|byte| *byte == delimiter)?
    };
    (start <= end).then_some((start, end))
}

fn tokenize(source: &str) -> Result<Vec<Token>, ExtractError> {
    let bytes = source.as_bytes();
    let mut tokens = Vec::new();
    tokens
        .try_reserve(64)
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut index = 0_usize;
    while index < bytes.len() {
        if tokens.len() >= MAX_TOKENS_PER_LITERAL {
            return Err(ExtractError::OutputLimit);
        }
        let byte = bytes[index];
        if byte.is_ascii_whitespace() || matches!(byte, b',' | b';' | b'(' | b')') {
            index = index.saturating_add(1);
            continue;
        }
        if byte == b'-' && bytes.get(index.saturating_add(1)) == Some(&b'-') {
            index = skip_line_comment(bytes, index.saturating_add(2));
            continue;
        }
        if byte == b'/' && bytes.get(index.saturating_add(1)) == Some(&b'*') {
            index = skip_block_comment(bytes, index.saturating_add(2));
            continue;
        }
        if byte == b'.' {
            tokens.push(Token {
                kind: TokenKind::Dot,
                source_start: index,
                source_end: index.saturating_add(1),
                value_start: index,
                value_end: index.saturating_add(1),
            });
            index = index.saturating_add(1);
            continue;
        }
        if byte == b'\'' {
            index = skip_quoted(bytes, index, b'\'', b'\'');
            continue;
        }
        if matches!(byte, b'"' | b'`' | b'[') {
            let close = if byte == b'[' { b']' } else { byte };
            let end = quoted_end(bytes, index, byte, close);
            if end > index.saturating_add(1) {
                tokens.push(Token {
                    kind: TokenKind::QuotedIdentifier,
                    source_start: index,
                    source_end: end,
                    value_start: index.saturating_add(1),
                    value_end: end.saturating_sub(1),
                });
            }
            index = end;
            continue;
        }
        if identifier_start(byte) {
            let start = index;
            index = index.saturating_add(1);
            while bytes
                .get(index)
                .is_some_and(|byte| identifier_continue(*byte))
            {
                index = index.saturating_add(1);
            }
            tokens.push(Token {
                kind: TokenKind::Word,
                source_start: start,
                source_end: index,
                value_start: start,
                value_end: index,
            });
            continue;
        }
        index = index.saturating_add(1);
    }
    Ok(tokens)
}

fn skip_line_comment(bytes: &[u8], mut index: usize) -> usize {
    while bytes.get(index).is_some_and(|byte| *byte != b'\n') {
        index = index.saturating_add(1);
    }
    index
}

fn skip_block_comment(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() {
        if bytes.get(index) == Some(&b'*') && bytes.get(index.saturating_add(1)) == Some(&b'/') {
            return index.saturating_add(2);
        }
        index = index.saturating_add(1);
    }
    index
}

fn skip_quoted(bytes: &[u8], start: usize, open: u8, close: u8) -> usize {
    quoted_end(bytes, start, open, close)
}

fn quoted_end(bytes: &[u8], start: usize, _open: u8, close: u8) -> usize {
    let mut index = start.saturating_add(1);
    while index < bytes.len() {
        if bytes[index] == close {
            if bytes.get(index.saturating_add(1)) == Some(&close) {
                index = index.saturating_add(2);
                continue;
            }
            return index.saturating_add(1);
        }
        index = index.saturating_add(1);
    }
    bytes.len()
}

fn identifier_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic()
}

fn identifier_continue(byte: u8) -> bool {
    matches!(byte, b'_' | b'$' | b'-') || byte.is_ascii_alphanumeric()
}

fn has_sql_anchor(tokens: &[Token], source: &str) -> bool {
    tokens.iter().any(|token| {
        [
            "select", "insert", "update", "delete", "merge", "create", "alter", "drop", "truncate",
            "with",
        ]
        .iter()
        .any(|keyword| token.is_keyword(source, keyword))
    })
}

fn collect_hits(tokens: &[Token], source: &str) -> Result<Vec<SqlHit>, ExtractError> {
    let mut hits = Vec::new();
    hits.try_reserve(8).map_err(|_| ExtractError::OutputLimit)?;
    let mut seen = BTreeSet::new();
    for (index, token) in tokens.iter().copied().enumerate() {
        let target = if token.is_keyword(source, "from") || token.is_keyword(source, "join") {
            Some((SqlOperation::Read, index.saturating_add(1)))
        } else if token.is_keyword(source, "insert")
            && keyword_at(tokens, source, index.saturating_add(1), "into")
        {
            Some((SqlOperation::Write, index.saturating_add(2)))
        } else if token.is_keyword(source, "update") {
            Some((SqlOperation::Write, index.saturating_add(1)))
        } else if (token.is_keyword(source, "delete")
            && keyword_at(tokens, source, index.saturating_add(1), "from"))
            || (token.is_keyword(source, "merge")
                && keyword_at(tokens, source, index.saturating_add(1), "into"))
        {
            Some((SqlOperation::Write, index.saturating_add(2)))
        } else if token.is_keyword(source, "alter")
            || token.is_keyword(source, "truncate")
            || token.is_keyword(source, "drop")
        {
            ddl_target(tokens, source, index.saturating_add(1))
        } else if token.is_keyword(source, "create") {
            create_target(tokens, source, index.saturating_add(1))
        } else {
            None
        };
        let Some((operation, start)) = target else {
            continue;
        };
        let Some((name, span_start, span_end)) = parse_identifier(tokens, source, start)? else {
            continue;
        };
        if reserved_name(name.rsplit('.').next().unwrap_or(&name)) {
            continue;
        }
        let identity = (name.to_ascii_lowercase(), operation);
        if seen.insert(identity) {
            hits.push(SqlHit {
                name,
                operation,
                start: span_start,
                end: span_end,
            });
        }
    }
    Ok(hits)
}

fn create_target(
    tokens: &[Token],
    source: &str,
    mut index: usize,
) -> Option<(SqlOperation, usize)> {
    if keyword_at(tokens, source, index, "or")
        && keyword_at(tokens, source, index.saturating_add(1), "replace")
    {
        index = index.saturating_add(2);
    }
    if keyword_at(tokens, source, index, "temp") || keyword_at(tokens, source, index, "temporary") {
        index = index.saturating_add(1);
    }
    ddl_target(tokens, source, index)
}

fn ddl_target(tokens: &[Token], source: &str, index: usize) -> Option<(SqlOperation, usize)> {
    if keyword_at(tokens, source, index, "table") || keyword_at(tokens, source, index, "view") {
        let mut target = index.saturating_add(1);
        if keyword_at(tokens, source, target, "if") {
            target = target.saturating_add(1);
            if keyword_at(tokens, source, target, "not") {
                target = target.saturating_add(1);
            }
            if keyword_at(tokens, source, target, "exists") {
                target = target.saturating_add(1);
            }
        }
        Some((SqlOperation::Ddl, target))
    } else {
        None
    }
}

fn keyword_at(tokens: &[Token], source: &str, index: usize, keyword: &str) -> bool {
    tokens
        .get(index)
        .is_some_and(|token| token.is_keyword(source, keyword))
}

fn parse_identifier(
    tokens: &[Token],
    source: &str,
    start: usize,
) -> Result<Option<(String, usize, usize)>, ExtractError> {
    let Some(first) = tokens
        .get(start)
        .copied()
        .filter(|token| token.identifier())
    else {
        return Ok(None);
    };
    let mut parts = vec![first.value(source)];
    let mut end = first.source_end;
    let mut index = start.saturating_add(1);
    while parts.len() < MAX_IDENTIFIER_PARTS
        && tokens
            .get(index)
            .is_some_and(|token| token.kind == TokenKind::Dot)
        && tokens
            .get(index.saturating_add(1))
            .is_some_and(|token| token.identifier())
    {
        let Some(part) = tokens.get(index.saturating_add(1)).copied() else {
            break;
        };
        parts.push(part.value(source));
        end = part.source_end;
        index = index.saturating_add(2);
    }
    let length = parts
        .iter()
        .try_fold(parts.len().saturating_sub(1), |length, part| {
            length.checked_add(part.len())
        });
    let mut name = String::new();
    name.try_reserve(length.ok_or(ExtractError::OutputLimit)?)
        .map_err(|_| ExtractError::OutputLimit)?;
    for (index, part) in parts.iter().enumerate() {
        if index > 0 {
            name.push('.');
        }
        name.push_str(part.trim_matches('\\'));
    }
    Ok(Some((name, first.source_start, end)))
}

fn reserved_name(name: &str) -> bool {
    [
        "a", "an", "the", "where", "on", "group", "order", "limit", "using", "as", "select",
        "into", "values", "set", "and", "or", "not", "null", "true", "false",
    ]
    .iter()
    .any(|reserved| name.eq_ignore_ascii_case(reserved))
}

fn owner_for_node(builder: &ExtractionBuilder<'_, '_>, node: Node<'_>) -> Option<SymbolId> {
    let start = u64::try_from(node.start_byte()).ok()?;
    let end = u64::try_from(node.end_byte()).ok()?;
    builder
        .facts
        .symbols
        .iter()
        .filter(|symbol| {
            symbol.span.start_byte() <= start
                && end <= symbol.span.end_byte()
                && !matches!(symbol.kind, SymbolKind::File | SymbolKind::Import)
        })
        .min_by_key(|symbol| {
            symbol
                .span
                .end_byte()
                .saturating_sub(symbol.span.start_byte())
        })
        .map(|symbol| symbol.id.clone())
}

fn resolution_name(
    builder: &ExtractionBuilder<'_, '_>,
    operation: SqlOperation,
    table: &str,
) -> Result<String, ExtractError> {
    let length = EMBEDDED_SQL_RESOLUTION_PREFIX
        .len()
        .checked_add(operation.as_str().len())
        .and_then(|length| length.checked_add(2))
        .and_then(|length| length.checked_add(table.len()))
        .ok_or(ExtractError::OutputLimit)?;
    let mut name = String::new();
    name.try_reserve(length)
        .map_err(|_| ExtractError::OutputLimit)?;
    name.push_str(EMBEDDED_SQL_RESOLUTION_PREFIX);
    name.push_str(operation.as_str());
    name.push_str("::");
    name.push_str(table);
    builder.context.copy_text(&name)
}
