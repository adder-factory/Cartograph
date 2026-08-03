use cartograph_domain::{FileParseStatus, ReferenceKind, SymbolId, SymbolKind, Visibility};

use crate::{ExtractError, ImportBindingKind, SymbolExportFlags};

use super::{
    CustomBuilder, CustomImportInput, CustomReferenceInput, CustomSymbolInput, SymbolOptions,
    bounded_string, looks_sensitive, poll_cancellation,
};

const MAX_RHAI_TOKENS: usize = 200_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum RhaiTokenKind {
    Identifier,
    StringLiteral,
    CharacterLiteral,
    TemplateLiteral,
    LeftParen,
    RightParen,
    LeftBrace,
    RightBrace,
    LeftBracket,
    RightBracket,
    Comma,
    Semicolon,
    ColonColon,
    Dot,
    Other,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RhaiToken {
    kind: RhaiTokenKind,
    start: usize,
    end: usize,
}

impl RhaiToken {
    fn text(self, source: &str) -> &str {
        source.get(self.start..self.end).unwrap_or_default()
    }

    fn string_value(self, source: &str) -> Option<&str> {
        if self.kind != RhaiTokenKind::StringLiteral || self.end <= self.start.saturating_add(1) {
            return None;
        }
        let value_start = self.start.saturating_add(1);
        let value_end = self.end.checked_sub(1)?;
        source.get(value_start..value_end)
    }
}

struct RhaiTokenStream {
    tokens: Vec<RhaiToken>,
    complete: bool,
}

struct RhaiSyntaxAnalysis {
    brace_depths: Vec<usize>,
    balanced: bool,
}

struct RhaiFunction {
    id: SymbolId,
    name: String,
    body_start: usize,
    body_end: usize,
}

struct ParsedRhaiFunction {
    private: bool,
    name: RhaiToken,
    parameters: Vec<RhaiToken>,
    start: usize,
    end: usize,
    body_start: usize,
    body_end: usize,
    closing_token: usize,
}

#[derive(Clone, Copy)]
struct RhaiExport<'source> {
    local: &'source str,
    exported: &'source str,
    token: RhaiToken,
}

#[derive(Clone, Copy)]
struct RhaiParameterInput<'parsed, 'source, 'name, 'id> {
    parsed: &'parsed ParsedRhaiFunction,
    source: &'source str,
    function_name: &'name str,
    function_id: &'id SymbolId,
}

#[derive(Clone, Copy)]
struct RhaiVariableInput<'tokens, 'depths, 'functions, 'exports, 'source> {
    tokens: &'tokens [RhaiToken],
    brace_depths: &'depths [usize],
    functions: &'functions [RhaiFunction],
    exports: &'exports [RhaiExport<'source>],
}

#[derive(Clone, Copy)]
struct RhaiImportSymbolInput<'module, 'owner, 'source> {
    alias: RhaiToken,
    module: &'module str,
    at_module_root: bool,
    owner: Option<&'owner RhaiFunction>,
    source: &'source str,
}

#[derive(Clone, Copy)]
struct RhaiCollectionInput<'source, 'tokens, 'depths, 'functions> {
    source: &'source str,
    tokens: &'tokens [RhaiToken],
    brace_depths: &'depths [usize],
    functions: &'functions [RhaiFunction],
}

#[derive(Clone, Copy)]
struct RhaiImportInput<'tokens, 'depths, 'functions> {
    tokens: &'tokens [RhaiToken],
    brace_depths: &'depths [usize],
    functions: &'functions [RhaiFunction],
}

#[derive(Clone, Copy)]
struct RhaiDelimiterPair {
    open: RhaiTokenKind,
    close: RhaiTokenKind,
}

/// Extract bounded Rhai declarations, imports, exports, and calls without executing scripts.
pub(super) fn extract(
    builder: &mut CustomBuilder<'_, '_>,
) -> Result<FileParseStatus, ExtractError> {
    let source = builder.snapshot.source();
    let stream = tokenize(source, builder.cancelled)?;
    let syntax = analyze_syntax(&stream.tokens)?;
    let functions = extract_functions(builder, &stream.tokens, &syntax.brace_depths)?;
    let exports = collect_exports(RhaiCollectionInput {
        source,
        tokens: &stream.tokens,
        brace_depths: &syntax.brace_depths,
        functions: &functions,
    })?;
    add_export_references(builder, &exports)?;
    extract_variables(
        builder,
        RhaiVariableInput {
            tokens: &stream.tokens,
            brace_depths: &syntax.brace_depths,
            functions: &functions,
            exports: &exports,
        },
    )?;
    extract_imports(
        builder,
        RhaiImportInput {
            tokens: &stream.tokens,
            brace_depths: &syntax.brace_depths,
            functions: &functions,
        },
    )?;
    extract_calls(builder, &stream.tokens, &functions)?;
    Ok(if stream.complete && syntax.balanced {
        FileParseStatus::Parsed
    } else {
        FileParseStatus::Partial
    })
}

fn tokenize(
    source: &str,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<RhaiTokenStream, ExtractError> {
    let mut tokens = Vec::new();
    let mut cursor = 0;
    let mut complete = true;
    let mut next_poll = 0;
    while cursor < source.len() {
        poll_cancellation(cancelled, cursor, &mut next_poll)?;
        let bytes = source.as_bytes();
        if bytes[cursor].is_ascii_whitespace() {
            cursor = cursor.saturating_add(1);
            continue;
        }
        if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'/') {
            cursor = scan_line_comment(source, cursor, cancelled)?;
            continue;
        }
        if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'*') {
            let (end, closed) = scan_block_comment(source, cursor, cancelled)?;
            cursor = end;
            complete &= closed;
            continue;
        }
        if matches!(bytes[cursor], b'\'' | b'"' | b'`') {
            let (token, closed) = scan_literal(source, cursor, cancelled)?;
            cursor = token.end;
            push_token(&mut tokens, token)?;
            complete &= closed;
            continue;
        }
        let character = source[cursor..]
            .chars()
            .next()
            .ok_or(ExtractError::InvalidSpan)?;
        if rhai_identifier_start(character) {
            let end = scan_identifier(source, cursor);
            push_token(
                &mut tokens,
                RhaiToken {
                    kind: RhaiTokenKind::Identifier,
                    start: cursor,
                    end,
                },
            )?;
            cursor = end;
            continue;
        }
        let (kind, width) = punctuation(source, cursor, character);
        let end = cursor.saturating_add(width);
        push_token(
            &mut tokens,
            RhaiToken {
                kind,
                start: cursor,
                end,
            },
        )?;
        cursor = end;
    }
    Ok(RhaiTokenStream { tokens, complete })
}

fn scan_line_comment(
    source: &str,
    start: usize,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<usize, ExtractError> {
    let mut cursor = start.saturating_add(2);
    let mut next_poll = cursor;
    while cursor < source.len() && source.as_bytes()[cursor] != b'\n' {
        poll_cancellation(cancelled, cursor, &mut next_poll)?;
        cursor = cursor.saturating_add(1);
    }
    Ok(cursor)
}

fn scan_block_comment(
    source: &str,
    start: usize,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<(usize, bool), ExtractError> {
    let bytes = source.as_bytes();
    let mut cursor = start.saturating_add(2);
    let mut depth = 1_usize;
    let mut next_poll = cursor;
    while cursor < bytes.len() {
        poll_cancellation(cancelled, cursor, &mut next_poll)?;
        if bytes[cursor] == b'/' && bytes.get(cursor + 1) == Some(&b'*') {
            depth = depth.saturating_add(1);
            cursor = cursor.saturating_add(2);
        } else if bytes[cursor] == b'*' && bytes.get(cursor + 1) == Some(&b'/') {
            depth = depth.saturating_sub(1);
            cursor = cursor.saturating_add(2);
            if depth == 0 {
                return Ok((cursor, true));
            }
        } else {
            cursor = cursor.saturating_add(1);
        }
    }
    Ok((cursor, false))
}

fn scan_literal(
    source: &str,
    start: usize,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<(RhaiToken, bool), ExtractError> {
    let bytes = source.as_bytes();
    let quote = bytes[start];
    let mut cursor = start.saturating_add(1);
    let mut next_poll = cursor;
    while cursor < bytes.len() {
        poll_cancellation(cancelled, cursor, &mut next_poll)?;
        if bytes[cursor] == b'\\' {
            cursor = cursor.saturating_add(2).min(bytes.len());
            continue;
        }
        if bytes[cursor] == quote {
            cursor = cursor.saturating_add(1);
            return Ok((literal_token(quote, start, cursor), true));
        }
        cursor = cursor.saturating_add(1);
    }
    Ok((literal_token(quote, start, cursor), false))
}

fn literal_token(quote: u8, start: usize, end: usize) -> RhaiToken {
    let kind = match quote {
        b'"' => RhaiTokenKind::StringLiteral,
        b'\'' => RhaiTokenKind::CharacterLiteral,
        _ => RhaiTokenKind::TemplateLiteral,
    };
    RhaiToken { kind, start, end }
}

fn scan_identifier(source: &str, start: usize) -> usize {
    let mut cursor = start;
    for character in source[start..].chars() {
        let allowed = if cursor == start {
            rhai_identifier_start(character)
        } else {
            rhai_identifier_continue(character)
        };
        if !allowed {
            break;
        }
        cursor = cursor.saturating_add(character.len_utf8());
    }
    cursor
}

fn rhai_identifier_start(character: char) -> bool {
    character == '_' || unicode_ident::is_xid_start(character)
}

fn rhai_identifier_continue(character: char) -> bool {
    character == '_' || unicode_ident::is_xid_continue(character)
}

fn punctuation(source: &str, cursor: usize, character: char) -> (RhaiTokenKind, usize) {
    let bytes = source.as_bytes();
    if bytes[cursor] == b':' && bytes.get(cursor + 1) == Some(&b':') {
        return (RhaiTokenKind::ColonColon, 2);
    }
    let kind = match bytes[cursor] {
        b'(' => RhaiTokenKind::LeftParen,
        b')' => RhaiTokenKind::RightParen,
        b'{' => RhaiTokenKind::LeftBrace,
        b'}' => RhaiTokenKind::RightBrace,
        b'[' => RhaiTokenKind::LeftBracket,
        b']' => RhaiTokenKind::RightBracket,
        b',' => RhaiTokenKind::Comma,
        b';' => RhaiTokenKind::Semicolon,
        b'.' => RhaiTokenKind::Dot,
        _ => RhaiTokenKind::Other,
    };
    (kind, character.len_utf8())
}

fn push_token(tokens: &mut Vec<RhaiToken>, token: RhaiToken) -> Result<(), ExtractError> {
    if tokens.len() >= MAX_RHAI_TOKENS {
        return Err(ExtractError::OutputLimit);
    }
    tokens
        .try_reserve(1)
        .map_err(|_| ExtractError::OutputLimit)?;
    tokens.push(token);
    Ok(())
}

fn analyze_syntax(tokens: &[RhaiToken]) -> Result<RhaiSyntaxAnalysis, ExtractError> {
    let mut stack = Vec::new();
    let mut brace_depth = 0_usize;
    let mut brace_depths = Vec::new();
    brace_depths
        .try_reserve_exact(tokens.len())
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut balanced = true;
    for token in tokens {
        brace_depths.push(brace_depth);
        match token.kind {
            RhaiTokenKind::LeftParen | RhaiTokenKind::LeftBrace | RhaiTokenKind::LeftBracket => {
                stack
                    .try_reserve(1)
                    .map_err(|_| ExtractError::OutputLimit)?;
                stack.push(token.kind);
                if token.kind == RhaiTokenKind::LeftBrace {
                    brace_depth = brace_depth.saturating_add(1);
                }
            }
            RhaiTokenKind::RightParen | RhaiTokenKind::RightBrace | RhaiTokenKind::RightBracket => {
                let open = stack.pop();
                balanced &= delimiters_match(open, token.kind);
                if token.kind == RhaiTokenKind::RightBrace {
                    brace_depth = brace_depth.saturating_sub(1);
                }
            }
            _ => {}
        }
    }
    balanced &= stack.is_empty();
    Ok(RhaiSyntaxAnalysis {
        brace_depths,
        balanced,
    })
}

fn delimiters_match(open: Option<RhaiTokenKind>, close: RhaiTokenKind) -> bool {
    matches!(
        (open, close),
        (Some(RhaiTokenKind::LeftParen), RhaiTokenKind::RightParen)
            | (Some(RhaiTokenKind::LeftBrace), RhaiTokenKind::RightBrace)
            | (
                Some(RhaiTokenKind::LeftBracket),
                RhaiTokenKind::RightBracket
            )
    )
}

fn extract_functions(
    builder: &mut CustomBuilder<'_, '_>,
    tokens: &[RhaiToken],
    brace_depths: &[usize],
) -> Result<Vec<RhaiFunction>, ExtractError> {
    let source = builder.source();
    let mut functions = Vec::new();
    let mut cursor = 0;
    while cursor < tokens.len() {
        builder.check_cancelled()?;
        if brace_depths.get(cursor).copied() != Some(0) {
            cursor = cursor.saturating_add(1);
            continue;
        }
        let Some(parsed) = parse_function(tokens, cursor, source) else {
            cursor = cursor.saturating_add(1);
            continue;
        };
        let function = add_function(builder, &parsed, source)?;
        functions
            .try_reserve(1)
            .map_err(|_| ExtractError::OutputLimit)?;
        functions.push(function);
        cursor = parsed.closing_token.saturating_add(1);
    }
    Ok(functions)
}

fn parse_function(
    tokens: &[RhaiToken],
    start_index: usize,
    source: &str,
) -> Option<ParsedRhaiFunction> {
    let (private, function_index) = if token_is_word(tokens.get(start_index), source, "private") {
        if !token_is_word(tokens.get(start_index.saturating_add(1)), source, "fn") {
            return None;
        }
        (true, start_index.saturating_add(1))
    } else if token_is_word(tokens.get(start_index), source, "fn") {
        (false, start_index)
    } else {
        return None;
    };
    let name_index = function_index.saturating_add(1);
    let open_parameters = function_index.saturating_add(2);
    if tokens.get(name_index).map(|token| token.kind) != Some(RhaiTokenKind::Identifier)
        || tokens.get(open_parameters).map(|token| token.kind) != Some(RhaiTokenKind::LeftParen)
    {
        return None;
    }
    let close_parameters = find_matching(
        tokens,
        open_parameters,
        RhaiDelimiterPair {
            open: RhaiTokenKind::LeftParen,
            close: RhaiTokenKind::RightParen,
        },
    )?;
    let body_open = close_parameters.saturating_add(1);
    if tokens.get(body_open).map(|token| token.kind) != Some(RhaiTokenKind::LeftBrace) {
        return None;
    }
    let body_close = find_matching(
        tokens,
        body_open,
        RhaiDelimiterPair {
            open: RhaiTokenKind::LeftBrace,
            close: RhaiTokenKind::RightBrace,
        },
    )?;
    let parameters = parse_parameters(tokens, open_parameters + 1, close_parameters)?;
    Some(ParsedRhaiFunction {
        private,
        name: tokens[name_index],
        parameters,
        start: tokens[start_index].start,
        end: tokens[body_close].end,
        body_start: tokens[body_open].end,
        body_end: tokens[body_close].start,
        closing_token: body_close,
    })
}

fn find_matching(
    tokens: &[RhaiToken],
    open_index: usize,
    delimiters: RhaiDelimiterPair,
) -> Option<usize> {
    let mut depth = 0_usize;
    for (index, token) in tokens.iter().enumerate().skip(open_index) {
        if token.kind == delimiters.open {
            depth = depth.saturating_add(1);
        } else if token.kind == delimiters.close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}

fn parse_parameters(tokens: &[RhaiToken], start: usize, end: usize) -> Option<Vec<RhaiToken>> {
    let mut parameters = Vec::new();
    let mut expect_parameter = true;
    for token in tokens.get(start..end)? {
        if expect_parameter && token.kind == RhaiTokenKind::Identifier {
            parameters.try_reserve(1).ok()?;
            parameters.push(*token);
            expect_parameter = false;
        } else if !expect_parameter && token.kind == RhaiTokenKind::Comma {
            expect_parameter = true;
        } else {
            return None;
        }
    }
    Some(parameters)
}

fn add_function(
    builder: &mut CustomBuilder<'_, '_>,
    parsed: &ParsedRhaiFunction,
    source: &str,
) -> Result<RhaiFunction, ExtractError> {
    let name = parsed.name.text(source);
    let signature = rhai_signature(name, &parsed.parameters, source)?;
    let id = builder.add_symbol(
        CustomSymbolInput::new(SymbolKind::Function, name, bounded_string(name)?)
            .at(parsed.start, parsed.end)
            .with_options(SymbolOptions {
                signature: Some(bounded_string(&signature)?),
                body_search_text: signature,
                export: SymbolExportFlags::named(!parsed.private),
                visibility: Some(if parsed.private {
                    Visibility::Private
                } else {
                    Visibility::Public
                }),
                ..SymbolOptions::default()
            }),
    )?;
    add_parameters(
        builder,
        RhaiParameterInput {
            parsed,
            source,
            function_name: name,
            function_id: &id,
        },
    )?;
    Ok(RhaiFunction {
        id,
        name: bounded_string(name)?,
        body_start: parsed.body_start,
        body_end: parsed.body_end,
    })
}

fn rhai_signature(
    name: &str,
    parameters: &[RhaiToken],
    source: &str,
) -> Result<String, ExtractError> {
    let parameter_bytes = parameters
        .iter()
        .map(|parameter| parameter.end.saturating_sub(parameter.start))
        .sum::<usize>();
    let capacity = name
        .len()
        .saturating_add(parameter_bytes)
        .saturating_add(parameters.len().saturating_mul(2))
        .saturating_add(5);
    let mut signature = String::new();
    signature
        .try_reserve_exact(capacity)
        .map_err(|_| ExtractError::OutputLimit)?;
    signature.push_str("fn ");
    signature.push_str(name);
    signature.push('(');
    for (index, parameter) in parameters.iter().enumerate() {
        if index > 0 {
            signature.push_str(", ");
        }
        signature.push_str(parameter.text(source));
    }
    signature.push(')');
    Ok(signature)
}

fn add_parameters(
    builder: &mut CustomBuilder<'_, '_>,
    input: RhaiParameterInput<'_, '_, '_, '_>,
) -> Result<(), ExtractError> {
    for parameter in &input.parsed.parameters {
        let name = parameter.text(input.source);
        builder.add_symbol(
            CustomSymbolInput::new(
                SymbolKind::Parameter,
                name,
                format!("{}::{name}", input.function_name),
            )
            .at(parameter.start, parameter.end)
            .with_options(SymbolOptions {
                body_search_text: format!("parameter {name}"),
                parent: Some(input.function_id.clone()),
                ..SymbolOptions::default()
            }),
        )?;
    }
    Ok(())
}

fn collect_exports<'source>(
    input: RhaiCollectionInput<'source, '_, '_, '_>,
) -> Result<Vec<RhaiExport<'source>>, ExtractError> {
    let mut exports = Vec::new();
    for (index, token) in input.tokens.iter().enumerate() {
        if input.brace_depths.get(index).copied() != Some(0)
            || owner_for_offset(input.functions, token.start).is_some()
            || !token_is_word(input.tokens.get(index), input.source, "export")
        {
            continue;
        }
        let Some(export) = parse_export(input.tokens, index, input.source) else {
            continue;
        };
        exports
            .try_reserve(1)
            .map_err(|_| ExtractError::OutputLimit)?;
        exports.push(export);
    }
    Ok(exports)
}

fn parse_export<'source>(
    tokens: &[RhaiToken],
    index: usize,
    source: &'source str,
) -> Option<RhaiExport<'source>> {
    let mut name_index = index.checked_add(1)?;
    if token_is_word(tokens.get(name_index), source, "const")
        || token_is_word(tokens.get(name_index), source, "let")
    {
        name_index = name_index.checked_add(1)?;
    }
    let name = *tokens.get(name_index)?;
    if name.kind != RhaiTokenKind::Identifier {
        return None;
    }
    let local = name.text(source);
    let exported = if token_is_word(tokens.get(name_index.saturating_add(1)), source, "as") {
        let alias = *tokens.get(name_index.saturating_add(2))?;
        (alias.kind == RhaiTokenKind::Identifier).then(|| alias.text(source))?
    } else {
        local
    };
    Some(RhaiExport {
        local,
        exported,
        token: name,
    })
}

fn add_export_references(
    builder: &mut CustomBuilder<'_, '_>,
    exports: &[RhaiExport<'_>],
) -> Result<(), ExtractError> {
    for export in exports {
        builder.check_cancelled()?;
        builder.add_reference_with_resolution(
            CustomReferenceInput::new(None, export.local, ReferenceKind::Exports)
                .with_resolution(export.exported)
                .at(export.token.start, export.token.end),
        )?;
    }
    Ok(())
}

fn extract_variables(
    builder: &mut CustomBuilder<'_, '_>,
    input: RhaiVariableInput<'_, '_, '_, '_, '_>,
) -> Result<(), ExtractError> {
    let source = builder.source();
    for (index, token) in input.tokens.iter().enumerate() {
        builder.check_cancelled()?;
        let (kind, keyword) = if token_is_word(input.tokens.get(index), source, "const") {
            (SymbolKind::Constant, "const")
        } else if token_is_word(input.tokens.get(index), source, "let") {
            (SymbolKind::Variable, "let")
        } else {
            continue;
        };
        let Some(name_token) = input.tokens.get(index.saturating_add(1)).copied() else {
            continue;
        };
        if name_token.kind != RhaiTokenKind::Identifier || name_token.text(source) == "_" {
            continue;
        }
        let owner = owner_for_offset(input.functions, token.start);
        let name = name_token.text(source);
        let at_module_root = input.brace_depths.get(index).copied() == Some(0) && owner.is_none();
        let exported = at_module_root && input.exports.iter().any(|export| export.local == name);
        let qualified_name = owner.map_or_else(
            || name.to_owned(),
            |function| format!("{}::{name}", function.name),
        );
        builder.add_symbol(
            CustomSymbolInput::new(kind, name, qualified_name)
                .at(name_token.start, name_token.end)
                .with_options(SymbolOptions {
                    body_search_text: format!("{keyword} {name}"),
                    export: SymbolExportFlags::named(exported),
                    visibility: exported.then_some(Visibility::Public),
                    parent: owner.map(|function| function.id.clone()),
                    ..SymbolOptions::default()
                }),
        )?;
    }
    Ok(())
}

fn extract_imports(
    builder: &mut CustomBuilder<'_, '_>,
    input: RhaiImportInput<'_, '_, '_>,
) -> Result<(), ExtractError> {
    let source = builder.source();
    for (index, token) in input.tokens.iter().enumerate() {
        builder.check_cancelled()?;
        if !token_is_word(input.tokens.get(index), source, "import") {
            continue;
        }
        let Some(module_token) = input.tokens.get(index.saturating_add(1)).copied() else {
            continue;
        };
        let Some(module) = safe_module_literal(module_token, source) else {
            continue;
        };
        let owner = owner_for_offset(input.functions, token.start);
        let alias = import_alias(input.tokens, index, source);
        let import_owner = if let Some(alias_token) = alias {
            Some(add_import_symbol(
                builder,
                RhaiImportSymbolInput {
                    alias: alias_token,
                    module,
                    at_module_root: input.brace_depths.get(index).copied() == Some(0),
                    owner,
                    source,
                },
            )?)
        } else {
            owner.map(|function| function.id.clone())
        };
        let module_start = module_token.start.saturating_add(1);
        builder.add_reference(
            CustomReferenceInput::new(import_owner.clone(), module, ReferenceKind::Imports)
                .at(module_start, module_start.saturating_add(module.len())),
        )?;
        if let Some(alias_token) = alias {
            let alias_name = alias_token.text(source);
            builder.add_import_binding(
                &CustomImportInput::new(import_owner, module)
                    .with_kind(ImportBindingKind::Namespace)
                    .binding("*", alias_name)
                    .at(alias_token.start, alias_token.end),
            )?;
        }
    }
    Ok(())
}

fn import_alias(tokens: &[RhaiToken], index: usize, source: &str) -> Option<RhaiToken> {
    let as_index = index.checked_add(2)?;
    if !token_is_word(tokens.get(as_index), source, "as") {
        return None;
    }
    let alias = *tokens.get(as_index.checked_add(1)?)?;
    (alias.kind == RhaiTokenKind::Identifier).then_some(alias)
}

fn safe_module_literal(token: RhaiToken, source: &str) -> Option<&str> {
    let value = token.string_value(source)?;
    module_literal_is_safe(value).then_some(value)
}

fn module_literal_is_safe(value: &str) -> bool {
    module_literal_has_safe_shape(value)
        && !value.chars().any(char::is_control)
        && !value.bytes().any(|byte| byte.is_ascii_whitespace())
        && !looks_sensitive(value)
}

fn module_literal_has_safe_shape(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 4_096
        && !value.starts_with('/')
        && !value.contains(['\\', '\0'])
}

fn add_import_symbol(
    builder: &mut CustomBuilder<'_, '_>,
    input: RhaiImportSymbolInput<'_, '_, '_>,
) -> Result<SymbolId, ExtractError> {
    let name = input.alias.text(input.source);
    let qualified_name = input.owner.map_or_else(
        || name.to_owned(),
        |function| format!("{}::{name}", function.name),
    );
    builder.add_symbol(
        CustomSymbolInput::new(SymbolKind::Import, name, qualified_name)
            .at(input.alias.start, input.alias.end)
            .with_options(SymbolOptions {
                body_search_text: format!("import {} as {name}", input.module),
                export: SymbolExportFlags::named(input.at_module_root),
                visibility: input.at_module_root.then_some(Visibility::Public),
                parent: input.owner.map(|function| function.id.clone()),
                ..SymbolOptions::default()
            }),
    )
}

fn extract_calls(
    builder: &mut CustomBuilder<'_, '_>,
    tokens: &[RhaiToken],
    functions: &[RhaiFunction],
) -> Result<(), ExtractError> {
    let source = builder.source();
    for (index, token) in tokens.iter().enumerate() {
        builder.check_cancelled()?;
        if token.kind != RhaiTokenKind::Identifier
            || tokens.get(index.saturating_add(1)).map(|next| next.kind)
                != Some(RhaiTokenKind::LeftParen)
            || rhai_call_is_declaration(tokens, index, source)
            || rhai_call_keyword(token.text(source))
        {
            continue;
        }
        let (name, start) = rhai_call_name(tokens, index, source)?;
        builder.add_reference(
            CustomReferenceInput::new(
                owner_for_offset(functions, token.start).map(|owner| owner.id.clone()),
                &name,
                ReferenceKind::Calls,
            )
            .at(start, token.end),
        )?;
    }
    Ok(())
}

fn rhai_call_is_declaration(tokens: &[RhaiToken], index: usize, source: &str) -> bool {
    index
        .checked_sub(1)
        .is_some_and(|previous| token_is_word(tokens.get(previous), source, "fn"))
}

fn rhai_call_keyword(name: &str) -> bool {
    matches!(
        name,
        "if" | "for" | "while" | "switch" | "catch" | "fn" | "let" | "const"
    )
}

fn rhai_call_name(
    tokens: &[RhaiToken],
    index: usize,
    source: &str,
) -> Result<(String, usize), ExtractError> {
    let mut first = index;
    while first >= 2
        && tokens[first - 1].kind == RhaiTokenKind::ColonColon
        && tokens[first - 2].kind == RhaiTokenKind::Identifier
    {
        first -= 2;
    }
    let capacity = tokens[first..=index]
        .iter()
        .map(|token| token.end.saturating_sub(token.start))
        .sum();
    let mut name = String::new();
    name.try_reserve_exact(capacity)
        .map_err(|_| ExtractError::OutputLimit)?;
    for token in &tokens[first..=index] {
        name.push_str(token.text(source));
    }
    Ok((name, tokens[first].start))
}

fn owner_for_offset(functions: &[RhaiFunction], offset: usize) -> Option<&RhaiFunction> {
    functions
        .iter()
        .find(|function| function.body_start <= offset && offset < function.body_end)
}

fn token_is_word(token: Option<&RhaiToken>, source: &str, word: &str) -> bool {
    token.is_some_and(|token| token.kind == RhaiTokenKind::Identifier && token.text(source) == word)
}
