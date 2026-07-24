use std::collections::VecDeque;

use cartograph_domain::{ContentDigest, SourcePosition, SourceSpan, Visibility};
use tree_sitter::{Node, TreeCursor};

use crate::{
    DiagnosticCode, ExtractError, ExtractionDiagnostic, budget::ensure_fact_string_length,
};

const MAX_DIAGNOSTICS: usize = 32;
const MAX_BODY_SEARCH_BYTES: usize = 16 * 1024;
const BODY_SEARCH_PREFIX_BYTES: usize = MAX_BODY_SEARCH_BYTES / 2;
const HASH_CHUNK_BYTES: usize = 64 * 1024;
const TEXT_POLL_STRIDE: usize = 4096;

pub(super) fn span_for(node: Node<'_>) -> Result<SourceSpan, ExtractError> {
    let start = node.start_position();
    let end = node.end_position();
    let start_line = u32::try_from(start.row)
        .ok()
        .and_then(|line| line.checked_add(1))
        .ok_or(ExtractError::InvalidSpan)?;
    let end_line = u32::try_from(end.row)
        .ok()
        .and_then(|line| line.checked_add(1))
        .ok_or(ExtractError::InvalidSpan)?;
    let start = SourcePosition::new(
        u64::try_from(node.start_byte()).map_err(|_| ExtractError::InvalidSpan)?,
        start_line,
        u32::try_from(start.column).map_err(|_| ExtractError::InvalidSpan)?,
    )
    .map_err(|_| ExtractError::InvalidSpan)?;
    let end = SourcePosition::new(
        u64::try_from(node.end_byte()).map_err(|_| ExtractError::InvalidSpan)?,
        end_line,
        u32::try_from(end.column).map_err(|_| ExtractError::InvalidSpan)?,
    )
    .map_err(|_| ExtractError::InvalidSpan)?;
    SourceSpan::new(start, end).map_err(|_| ExtractError::InvalidSpan)
}

pub(super) fn callable_signature(
    node: Node<'_>,
    source: &str,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<Option<String>, ExtractError> {
    let Some(parameters) = node
        .child_by_field_name("parameters")
        .or_else(|| node.child_by_field_name("parameter"))
    else {
        return Ok(None);
    };
    if cancelled() {
        return Err(ExtractError::Cancelled);
    }
    ensure_fact_string_length(
        parameters
            .end_byte()
            .saturating_sub(parameters.start_byte()),
    )?;
    let parameter_text = text_for(source, parameters).trim();
    let parenthesized = parameters.kind() == "required_parameter";
    let prefix_bytes = usize::from(parenthesized);
    let mut required = parameter_text
        .len()
        .checked_add(prefix_bytes.saturating_mul(2))
        .ok_or(ExtractError::OutputLimit)?;
    let return_text = if let Some(return_type) = node
        .child_by_field_name("return_type")
        .or_else(|| node.child_by_field_name("result"))
    {
        let length = return_type
            .end_byte()
            .saturating_sub(return_type.start_byte());
        ensure_fact_string_length(length)?;
        (!text_for(source, return_type)
            .trim()
            .trim_start_matches(':')
            .trim()
            .is_empty())
        .then_some(return_type)
    } else {
        None
    };
    if let Some(return_type) = return_text {
        let return_length = text_for(source, return_type)
            .trim()
            .trim_start_matches(':')
            .trim()
            .len();
        required = required
            .checked_add(2)
            .and_then(|length| length.checked_add(return_length))
            .ok_or(ExtractError::OutputLimit)?;
    }
    ensure_fact_string_length(required)?;
    let mut signature = String::new();
    signature
        .try_reserve(required)
        .map_err(|_| ExtractError::OutputLimit)?;
    if parenthesized {
        signature.push('(');
        signature.push_str(parameter_text);
        signature.push(')');
    } else {
        signature.push_str(parameter_text);
    }
    if let Some(return_type) = return_text {
        let return_text = text_for(source, return_type)
            .trim()
            .trim_start_matches(':')
            .trim();
        if !return_text.is_empty() {
            signature.push_str(": ");
            signature.push_str(return_text);
        }
    }
    Ok(Some(signature))
}

pub(super) fn starts_uppercase(name: &str) -> bool {
    name.chars().next().is_some_and(char::is_uppercase)
}

#[derive(Default)]
pub(super) struct BodySearchText {
    pub(super) text: String,
    pub(super) truncated: bool,
}

pub(super) fn body_search_text(
    root: Node<'_>,
    source: &str,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<BodySearchText, ExtractError> {
    let mut prefix = String::new();
    let mut tail: VecDeque<&str> = VecDeque::new();
    let mut tail_bytes = 0_usize;
    let mut using_tail = false;
    let mut truncated = false;
    for node in descendants_including_root(root) {
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        let token = if is_search_identifier(node.kind()) {
            text_for(source, node)
        } else if is_search_keyword(node.kind()) {
            node.kind()
        } else {
            continue;
        };
        if token.is_empty() {
            continue;
        }

        let prefix_separator = usize::from(!prefix.is_empty());
        let fits_prefix = !using_tail
            && prefix
                .len()
                .checked_add(prefix_separator)
                .and_then(|length| length.checked_add(token.len()))
                .is_some_and(|required| required <= BODY_SEARCH_PREFIX_BYTES);
        if fits_prefix {
            prefix
                .try_reserve(prefix_separator.saturating_add(token.len()))
                .map_err(|_| ExtractError::OutputLimit)?;
            if prefix_separator != 0 {
                prefix.push(' ');
            }
            prefix.push_str(token);
            continue;
        }
        using_tail = true;

        let prefix_tail_separator = usize::from(!prefix.is_empty());
        let tail_capacity = MAX_BODY_SEARCH_BYTES
            .saturating_sub(prefix.len())
            .saturating_sub(prefix_tail_separator);
        if token.len() > tail_capacity {
            truncated = true;
            continue;
        }
        while tail_bytes.saturating_add(
            token
                .len()
                .checked_add(usize::from(!tail.is_empty()))
                .ok_or(ExtractError::OutputLimit)?,
        ) > tail_capacity
        {
            let Some(removed) = tail.pop_front() else {
                return Err(ExtractError::OutputLimit);
            };
            tail_bytes = tail_bytes
                .saturating_sub(removed.len())
                .saturating_sub(usize::from(!tail.is_empty()));
            truncated = true;
        }
        let token_bytes = token
            .len()
            .checked_add(usize::from(!tail.is_empty()))
            .ok_or(ExtractError::OutputLimit)?;
        tail.try_reserve(1).map_err(|_| ExtractError::OutputLimit)?;
        tail.push_back(token);
        tail_bytes = tail_bytes
            .checked_add(token_bytes)
            .ok_or(ExtractError::OutputLimit)?;
    }

    let mut text = prefix;
    text.try_reserve(usize::from(!text.is_empty() && !tail.is_empty()).saturating_add(tail_bytes))
        .map_err(|_| ExtractError::OutputLimit)?;
    for token in tail {
        if !text.is_empty() {
            text.push(' ');
        }
        text.push_str(token);
    }
    Ok(BodySearchText { text, truncated })
}

fn is_search_identifier(kind: &str) -> bool {
    matches!(
        kind,
        "identifier"
            | "field_identifier"
            | "jsx_identifier"
            | "package_identifier"
            | "private_property_identifier"
            | "property_identifier"
            | "shorthand_property_identifier"
            | "shorthand_property_identifier_pattern"
            | "statement_identifier"
            | "type_identifier"
    )
}

fn is_search_keyword(kind: &str) -> bool {
    matches!(
        kind,
        "async"
            | "await"
            | "break"
            | "case"
            | "catch"
            | "continue"
            | "else"
            | "finally"
            | "for"
            | "if"
            | "new"
            | "return"
            | "switch"
            | "throw"
            | "try"
            | "while"
            | "yield"
    )
}

pub(super) fn contains_jsx(
    root: Node<'_>,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<bool, ExtractError> {
    for node in descendants_including_root(root) {
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        if matches!(
            node.kind(),
            "jsx_element" | "jsx_opening_element" | "jsx_self_closing_element"
        ) {
            return Ok(true);
        }
    }
    Ok(false)
}

pub(super) fn is_call_or_construction_target(node: Node<'_>) -> bool {
    let Some(parent) = node.parent() else {
        return false;
    };
    let target = match parent.kind() {
        "call_expression" | "call" => parent.child_by_field_name("function"),
        "new_expression" => parent.child_by_field_name("constructor"),
        _ => None,
    };
    target.is_some_and(|target| {
        target.start_byte() == node.start_byte() && target.end_byte() == node.end_byte()
    })
}

pub(super) fn export_flags(node: Node<'_>) -> (bool, bool) {
    let mut current = node.parent();
    while let Some(parent) = current {
        if parent.kind() == "export_statement" {
            return (true, has_child_kind(parent, "default"));
        }
        if is_export_scope_boundary(parent.kind()) {
            return (false, false);
        }
        current = parent.parent();
    }
    (false, false)
}

fn is_export_scope_boundary(kind: &str) -> bool {
    matches!(
        kind,
        "arrow_function"
            | "abstract_method_signature"
            | "function_expression"
            | "function_declaration"
            | "function_signature"
            | "interface_body"
            | "interface_declaration"
            | "method_definition"
            | "method_signature"
            | "class_declaration"
            | "class_body"
    )
}

pub(super) fn visibility(node: Node<'_>, source: &str) -> Option<Visibility> {
    children(node)
        .find(|child| child.kind() == "accessibility_modifier")
        .and_then(|child| match text_for(source, child).trim() {
            "public" => Some(Visibility::Public),
            "private" => Some(Visibility::Private),
            "protected" => Some(Visibility::Protected),
            "internal" => Some(Visibility::Internal),
            _ => None,
        })
}

pub(super) fn has_child_kind(node: Node<'_>, kind: &str) -> bool {
    children(node).any(|child| child.kind() == kind)
}

pub(super) fn reference_type_node(node: Node<'_>) -> Option<Node<'_>> {
    match node.kind() {
        "type_identifier" | "identifier" | "member_expression" | "nested_type_identifier" => {
            Some(node)
        }
        "generic_type" => node
            .child_by_field_name("name")
            .or_else(|| node.named_child(0)),
        _ => None,
    }
}

pub(super) fn structural_digest(
    root: Node<'_>,
    source: &str,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<ContentDigest, ExtractError> {
    let mut hasher = blake3::Hasher::new_derive_key("cartograph.v2.structural-digest.2026-07-22");
    for node in descendants_including_root(root) {
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        if node.kind() == "comment" {
            continue;
        }
        hash_field(&mut hasher, node.kind().as_bytes());
        let mut child_count = 0_usize;
        for child in children(node) {
            if cancelled() {
                return Err(ExtractError::Cancelled);
            }
            if child.kind() != "comment" {
                child_count = child_count.saturating_add(1);
            }
        }
        hash_field(&mut hasher, &encoded_length(child_count));
        if child_count == 0 {
            hash_cancellable_field(&mut hasher, text_for(source, node).as_bytes(), cancelled)?;
        }
    }
    Ok(ContentDigest::from_bytes(*hasher.finalize().as_bytes()))
}

fn hash_field(hasher: &mut blake3::Hasher, field: &[u8]) {
    hasher.update(&encoded_length(field.len()));
    hasher.update(field);
}

fn hash_cancellable_field(
    hasher: &mut blake3::Hasher,
    field: &[u8],
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<(), ExtractError> {
    hasher.update(&encoded_length(field.len()));
    for chunk in field.chunks(HASH_CHUNK_BYTES) {
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        hasher.update(chunk);
    }
    Ok(())
}

fn encoded_length(length: usize) -> [u8; std::mem::size_of::<u64>()] {
    u64::try_from(length).unwrap_or(u64::MAX).to_le_bytes()
}

pub(super) fn jsdoc(
    node: Node<'_>,
    source: &str,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<Option<String>, ExtractError> {
    let anchor = node
        .parent()
        .filter(|parent| parent.kind() == "export_statement")
        .unwrap_or(node);
    let Some(comment) = anchor.prev_named_sibling() else {
        return Ok(None);
    };
    if comment.kind() != "comment" {
        return Ok(None);
    }
    if cancelled() {
        return Err(ExtractError::Cancelled);
    }
    let raw_comment = text_for(source, comment);
    if !raw_comment.starts_with("/**") || !raw_comment.ends_with("*/") {
        return Ok(None);
    }
    ensure_fact_string_length(raw_comment.len())?;
    let Some(gap) = source.get(comment.end_byte()..anchor.start_byte()) else {
        return Ok(None);
    };
    if ensure_fact_string_length(gap.len()).is_err() {
        return Ok(None);
    }
    for (index, character) in gap.chars().enumerate() {
        if index % TEXT_POLL_STRIDE == 0 && cancelled() {
            return Err(ExtractError::Cancelled);
        }
        if !character.is_whitespace() {
            return Ok(None);
        }
    }
    normalize_jsdoc(raw_comment)
}

fn normalize_jsdoc(raw: &str) -> Result<Option<String>, ExtractError> {
    let Some(body) = raw
        .trim()
        .strip_prefix("/**")
        .and_then(|body| body.strip_suffix("*/"))
    else {
        return Ok(None);
    };
    let mut lines = Vec::new();
    for line in body.lines() {
        lines
            .try_reserve(1)
            .map_err(|_| ExtractError::OutputLimit)?;
        let trimmed = line.trim().strip_prefix('*').unwrap_or(line.trim()).trim();
        lines.push(trimmed);
    }
    let Some(first) = lines.iter().position(|line| !line.is_empty()) else {
        return Ok(None);
    };
    let Some(last) = lines.iter().rposition(|line| !line.is_empty()) else {
        return Ok(None);
    };
    let mut normalized = String::new();
    normalized
        .try_reserve(body.len())
        .map_err(|_| ExtractError::OutputLimit)?;
    for (index, line) in lines[first..=last].iter().enumerate() {
        if index > 0 {
            normalized.push('\n');
        }
        normalized.push_str(line);
    }
    Ok(Some(normalized))
}

pub(super) fn unquote(raw: &str) -> &str {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 2
        && matches!(
            (bytes.first(), bytes.last()),
            (Some(b'\''), Some(b'\'')) | (Some(b'"'), Some(b'"'))
        )
    {
        return &trimmed[1..trimmed.len() - 1];
    }
    trimmed
}

pub(super) fn collect_diagnostics(
    root: Node<'_>,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<Vec<ExtractionDiagnostic>, ExtractError> {
    let mut diagnostics = Vec::new();
    for node in descendants_including_root(root) {
        if cancelled() {
            return Err(ExtractError::Cancelled);
        }
        if node.is_error() || node.is_missing() {
            diagnostics.push(ExtractionDiagnostic {
                code: DiagnosticCode::SyntaxError,
                span: span_for(node).ok(),
            });
            if diagnostics.len() == MAX_DIAGNOSTICS {
                break;
            }
        }
    }
    Ok(diagnostics)
}

pub(super) fn descendants_including_root(node: Node<'_>) -> Descendants<'_> {
    Descendants::new(node, true)
}

pub(super) fn descendants(node: Node<'_>) -> Descendants<'_> {
    Descendants::new(node, false)
}

pub(super) fn children(node: Node<'_>) -> DirectChildren<'_> {
    DirectChildren::new(node, false)
}

pub(super) fn named_children(node: Node<'_>) -> DirectChildren<'_> {
    DirectChildren::new(node, true)
}

pub(super) struct DirectChildren<'tree> {
    cursor: TreeCursor<'tree>,
    started: bool,
    named_only: bool,
    finished: bool,
}

impl<'tree> DirectChildren<'tree> {
    fn new(node: Node<'tree>, named_only: bool) -> Self {
        Self {
            cursor: node.walk(),
            started: false,
            named_only,
            finished: false,
        }
    }
}

impl<'tree> Iterator for DirectChildren<'tree> {
    type Item = Node<'tree>;

    fn next(&mut self) -> Option<Self::Item> {
        while !self.finished {
            let advanced = if self.started {
                self.cursor.goto_next_sibling()
            } else {
                self.started = true;
                self.cursor.goto_first_child()
            };
            if !advanced {
                self.finished = true;
                return None;
            }
            let node = self.cursor.node();
            if !self.named_only || node.is_named() {
                return Some(node);
            }
        }
        None
    }
}

pub(super) struct Descendants<'tree> {
    cursor: TreeCursor<'tree>,
    depth: usize,
    include_root: bool,
    started: bool,
    finished: bool,
}

impl<'tree> Descendants<'tree> {
    fn new(node: Node<'tree>, include_root: bool) -> Self {
        Self {
            cursor: node.walk(),
            depth: 0,
            include_root,
            started: false,
            finished: false,
        }
    }
}

impl<'tree> Iterator for Descendants<'tree> {
    type Item = Node<'tree>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.finished {
            return None;
        }
        if !self.started {
            self.started = true;
            if self.include_root {
                return Some(self.cursor.node());
            }
        }
        if self.cursor.goto_first_child() {
            self.depth = self.depth.saturating_add(1);
            return Some(self.cursor.node());
        }
        loop {
            if self.depth == 0 {
                self.finished = true;
                return None;
            }
            if self.cursor.goto_next_sibling() {
                return Some(self.cursor.node());
            }
            if !self.cursor.goto_parent() {
                self.finished = true;
                return None;
            }
            self.depth = self.depth.saturating_sub(1);
        }
    }
}

fn text_for<'source>(source: &'source str, node: Node<'_>) -> &'source str {
    source
        .get(node.start_byte()..node.end_byte())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use tree_sitter::Parser;

    use super::structural_digest;
    use crate::ExtractError;

    const FLAT_DECLARATIONS: usize = 10_000;
    const FLAT_CANCEL_AFTER_POLLS: usize = 64;
    const FLAT_EXPECTED_POLLS: usize = FLAT_CANCEL_AFTER_POLLS + 1;
    const LARGE_TEMPLATE_BYTES: usize = 2 * 1024 * 1024;
    const LARGE_CANCEL_AFTER_POLLS: usize = 20;
    const LARGE_EXPECTED_POLLS: usize = LARGE_CANCEL_AFTER_POLLS + 1;

    #[test]
    fn flat_tree_digest_polls_cancellation_without_collecting_the_tree() {
        let source = (0..FLAT_DECLARATIONS)
            .map(|index| format!("const value_{index} = {index};\n"))
            .collect::<String>();
        let mut parser = Parser::new();
        let language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
        if let Err(error) = parser.set_language(&language) {
            panic!("test grammar setup failed: {error}");
        }
        let tree = match parser.parse(&source, None) {
            Some(tree) => tree,
            None => panic!("test parser did not produce a tree"),
        };
        let mut polls = 0_usize;
        let result = structural_digest(tree.root_node(), &source, &mut || {
            polls = polls.saturating_add(1);
            polls > FLAT_CANCEL_AFTER_POLLS
        });

        assert!(matches!(result, Err(ExtractError::Cancelled)));
        assert_eq!(polls, FLAT_EXPECTED_POLLS);
    }

    #[test]
    fn one_large_template_leaf_polls_cancellation_between_hash_chunks() {
        let source = format!("const value = `{}`;", "x".repeat(LARGE_TEMPLATE_BYTES));
        let mut parser = Parser::new();
        let language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
        if let Err(error) = parser.set_language(&language) {
            panic!("test grammar setup failed: {error}");
        }
        let tree = match parser.parse(&source, None) {
            Some(tree) => tree,
            None => panic!("test parser did not produce a tree"),
        };
        let mut polls = 0_usize;
        let result = structural_digest(tree.root_node(), &source, &mut || {
            polls = polls.saturating_add(1);
            polls > LARGE_CANCEL_AFTER_POLLS
        });

        assert!(matches!(result, Err(ExtractError::Cancelled)));
        assert_eq!(polls, LARGE_EXPECTED_POLLS);
    }
}
