use std::collections::BTreeSet;

use cartograph_domain::{FileParseStatus, ReferenceKind, SourceLanguage, SymbolKind};

use crate::{ExtractError, ImportBindingKind, SymbolExportFlags};

use super::{
    CustomBuilder, CustomImportInput, CustomReferenceInput, CustomSymbolInput, SymbolOptions,
    bounded_string, looks_sensitive, poll_cancellation,
};

const MAX_FACTS_PER_LINE: usize = 512;
const MAX_SCRIPT_LINES: usize = 200_000;

#[derive(Clone, Copy)]
struct ScriptSlice {
    start: usize,
    end: usize,
    container_complete: bool,
}

struct MaskedSource {
    text: String,
    complete: bool,
    balanced: bool,
}

struct DeclarationFact {
    kind: SymbolKind,
    name: String,
    start: usize,
    end: usize,
}

struct ReferenceFact {
    kind: ReferenceKind,
    name: String,
    start: usize,
    end: usize,
}

struct ModuleFact {
    module: String,
    start: usize,
    end: usize,
}

#[derive(Clone, Copy)]
struct LineScanInput<'source> {
    language: SourceLanguage,
    base_offset: usize,
    masked: &'source str,
}

struct LineFacts {
    declaration: Option<DeclarationFact>,
    module: Option<ModuleFact>,
    references: Vec<ReferenceFact>,
}

#[derive(Clone, Copy)]
struct IntrinsicFileInput {
    language: SourceLanguage,
    script: ScriptSlice,
}

#[derive(Clone, Copy)]
struct RawDeclarationInput<'line, 'name> {
    line: &'line str,
    name: &'name str,
    kind: SymbolKind,
    trimmed_start: usize,
}

#[derive(Clone, Copy)]
struct ModuleScanInput<'code, 'source> {
    language: SourceLanguage,
    code: &'code str,
    original: &'source str,
    absolute_start: usize,
}

#[derive(Clone, Copy)]
struct ReferenceScanInput<'code, 'source, 'declaration> {
    language: SourceLanguage,
    code: &'code str,
    original: &'source str,
    absolute_start: usize,
    declaration: Option<&'declaration DeclarationFact>,
}

#[derive(Clone, Copy)]
struct ParenthesizedCallInput<'line, 'declaration> {
    line: &'line str,
    absolute_start: usize,
    declaration: Option<&'declaration DeclarationFact>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum AdditionalLineComment {
    None,
    Dash,
    Hash,
    Bang,
    Semicolon,
}

pub(super) const fn supports(language: SourceLanguage) -> bool {
    language.is_game_scripting() && !matches!(language, SourceLanguage::Rhai)
}

pub(super) fn extract(
    builder: &mut CustomBuilder<'_, '_>,
) -> Result<FileParseStatus, ExtractError> {
    let language = builder.snapshot.language();
    if !supports(language) {
        return Err(ExtractError::UnsupportedLanguage);
    }
    builder.check_cancelled()?;
    let script = script_slice(language, builder.source());
    let source = builder
        .source()
        .get(script.start..script.end)
        .ok_or(ExtractError::InvalidSpan)?;
    let masked = mask_source(source, comment_syntax(language), builder.cancelled)?;
    let mut seen_symbols = BTreeSet::new();
    add_intrinsic_file_declaration(
        builder,
        IntrinsicFileInput { language, script },
        &mut seen_symbols,
    )?;
    scan_lines(
        builder,
        LineScanInput {
            language,
            base_offset: script.start,
            masked: &masked.text,
        },
        &mut seen_symbols,
    )?;
    Ok(
        if script.container_complete && masked.complete && masked.balanced {
            FileParseStatus::Parsed
        } else {
            FileParseStatus::Partial
        },
    )
}

fn scan_lines(
    builder: &mut CustomBuilder<'_, '_>,
    input: LineScanInput<'_>,
    seen_symbols: &mut BTreeSet<(SymbolKind, String)>,
) -> Result<(), ExtractError> {
    let mut relative_start = 0_usize;
    let mut lines = 0_usize;
    for chunk in input.masked.split_inclusive('\n') {
        lines = lines.saturating_add(1);
        if lines > MAX_SCRIPT_LINES {
            return Err(ExtractError::OutputLimit);
        }
        builder.check_cancelled()?;
        let absolute_start = input.base_offset.saturating_add(relative_start);
        let absolute_end = absolute_start.saturating_add(chunk.len());
        let original = builder
            .source()
            .get(absolute_start..absolute_end)
            .ok_or(ExtractError::InvalidSpan)?;
        let declaration = declaration_fact(input.language, chunk, absolute_start)?;
        let module_input = ModuleScanInput {
            language: input.language,
            code: chunk,
            original,
            absolute_start,
        };
        let module = module_fact(module_input)?;
        let references = reference_facts(ReferenceScanInput {
            language: input.language,
            code: chunk,
            original,
            absolute_start,
            declaration: declaration.as_ref(),
        })?;
        apply_line_facts(
            builder,
            LineFacts {
                declaration,
                module,
                references,
            },
            seen_symbols,
        )?;
        relative_start = relative_start.saturating_add(chunk.len());
    }
    Ok(())
}

fn apply_line_facts(
    builder: &mut CustomBuilder<'_, '_>,
    facts: LineFacts,
    seen_symbols: &mut BTreeSet<(SymbolKind, String)>,
) -> Result<(), ExtractError> {
    if let Some(fact) = facts.declaration {
        let key = (fact.kind, bounded_string(&fact.name)?);
        if seen_symbols.insert(key) {
            let qualified_name = bounded_string(&fact.name)?;
            builder.add_symbol(
                CustomSymbolInput::new(fact.kind, &fact.name, qualified_name)
                    .at(fact.start, fact.end)
                    .with_options(SymbolOptions {
                        export: SymbolExportFlags::named(true),
                        ..SymbolOptions::default()
                    }),
            )?;
        }
    }
    if let Some(fact) = facts.module {
        builder.add_import(
            &CustomImportInput::new(None, &fact.module)
                .binding("*", "*")
                .with_kind(ImportBindingKind::Namespace)
                .at(fact.start, fact.end),
        )?;
    }
    for fact in facts.references {
        builder.add_reference(
            CustomReferenceInput::new(None, &fact.name, fact.kind).at(fact.start, fact.end),
        )?;
    }
    Ok(())
}

fn add_intrinsic_file_declaration(
    builder: &mut CustomBuilder<'_, '_>,
    input: IntrinsicFileInput,
    seen_symbols: &mut BTreeSet<(SymbolKind, String)>,
) -> Result<(), ExtractError> {
    if input.language != SourceLanguage::MinecraftFunction || input.script.start == input.script.end
    {
        return Ok(());
    }
    let name = minecraft_function_name(builder.path())?;
    let end = builder
        .source()
        .get(input.script.start..input.script.end)
        .and_then(|source| source.chars().next())
        .map_or(input.script.start, |character| {
            input.script.start.saturating_add(character.len_utf8())
        });
    if end == input.script.start {
        return Ok(());
    }
    seen_symbols.insert((SymbolKind::Function, bounded_string(&name)?));
    builder.add_symbol(
        CustomSymbolInput::new(SymbolKind::Function, &name, bounded_string(&name)?)
            .at(input.script.start, end)
            .with_options(SymbolOptions {
                export: SymbolExportFlags::named(true),
                ..SymbolOptions::default()
            }),
    )?;
    Ok(())
}

fn minecraft_function_name(path: &str) -> Result<String, ExtractError> {
    let without_extension = path.strip_suffix(".mcfunction").unwrap_or(path);
    let normalized = without_extension.replace("/functions/", ":");
    let name = normalized
        .strip_prefix("data/")
        .unwrap_or(normalized.as_str())
        .replace('/', ".");
    bounded_string(&name)
}

fn script_slice(language: SourceLanguage, source: &str) -> ScriptSlice {
    if language != SourceLanguage::Pico8 {
        return ScriptSlice {
            start: 0,
            end: source.len(),
            container_complete: true,
        };
    }
    let Some(marker) = source.find("__lua__") else {
        return ScriptSlice {
            start: 0,
            end: source.len(),
            container_complete: false,
        };
    };
    let start = source[marker..].find('\n').map_or(source.len(), |newline| {
        marker.saturating_add(newline).saturating_add(1)
    });
    let tail = source.get(start..).unwrap_or_default();
    let end = tail
        .match_indices("\n__")
        .next()
        .map_or(source.len(), |(offset, _)| {
            start.saturating_add(offset).saturating_add(1)
        });
    ScriptSlice {
        start,
        end,
        container_complete: start < source.len(),
    }
}

fn declaration_fact(
    language: SourceLanguage,
    line: &str,
    absolute_start: usize,
) -> Result<Option<DeclarationFact>, ExtractError> {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let line_offset = line.find(trimmed).unwrap_or(0);
    let lower = trimmed.to_ascii_lowercase();
    let fact = specific_declaration(language, trimmed, &lower)
        .or_else(|| type_declaration(language, trimmed, &lower))
        .or_else(|| function_declaration(language, trimmed, &lower));
    fact.map(|(kind, name)| {
        declaration_from_name(RawDeclarationInput {
            line,
            name,
            kind,
            trimmed_start: absolute_start.saturating_add(line_offset),
        })
    })
    .transpose()
}

fn declaration_from_name(
    input: RawDeclarationInput<'_, '_>,
) -> Result<DeclarationFact, ExtractError> {
    let name = clean_name(input.name).ok_or(ExtractError::InvalidSpan)?;
    let line_offset = input.line.find(name).ok_or(ExtractError::InvalidSpan)?;
    let line_trimmed_offset = input.line.find(input.line.trim()).unwrap_or(0);
    let relative = line_offset.saturating_sub(line_trimmed_offset);
    let start = input.trimmed_start.saturating_add(relative);
    Ok(DeclarationFact {
        kind: input.kind,
        name: bounded_string(name)?,
        start,
        end: start.saturating_add(name.len()),
    })
}

fn specific_declaration<'line>(
    language: SourceLanguage,
    line: &'line str,
    lower: &str,
) -> Option<(SymbolKind, &'line str)> {
    specific_declaration_a(language, line, lower)
        .or_else(|| specific_declaration_b(language, line, lower))
}

fn specific_declaration_a<'line>(
    language: SourceLanguage,
    line: &'line str,
    lower: &str,
) -> Option<(SymbolKind, &'line str)> {
    match language {
        SourceLanguage::ChoiceScript => {
            marker_name(line, lower, "*label ").map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::ByondDm => {
            byond_proc_name(line, lower).map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::GdScript => {
            marker_name(line, lower, "class_name ").map(|name| (SymbolKind::Class, name))
        }
        SourceLanguage::HaloScript => {
            halo_script_name(line, lower).map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::Inform6 => {
            inform6_routine_name(line).map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::Inform7 => {
            inform7_phrase_name(line, lower).map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::Ink => ink_knot_name(line).map(|name| (SymbolKind::Function, name)),
        SourceLanguage::Jass => {
            marker_name(line, lower, "library ").map(|name| (SymbolKind::Module, name))
        }
        SourceLanguage::MiniScript => {
            assignment_function_name(line, lower).map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::Papyrus => {
            marker_name(line, lower, "scriptname ").map(|name| (SymbolKind::Class, name))
        }
        _ => None,
    }
}

fn specific_declaration_b<'line>(
    language: SourceLanguage,
    line: &'line str,
    lower: &str,
) -> Option<(SymbolKind, &'line str)> {
    match language {
        SourceLanguage::ParadoxScript => {
            assignment_block_name(line).map(|name| (SymbolKind::Resource, name))
        }
        SourceLanguage::QuakeC => {
            quake_function_name(line).map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::Renpy => {
            marker_name(line, lower, "label ").map(|name| (SymbolKind::Function, name))
        }
        SourceLanguage::Sqf => assignment_block_name(line).map(|name| (SymbolKind::Function, name)),
        SourceLanguage::Sqs => line
            .strip_prefix('#')
            .and_then(clean_name)
            .map(|name| (SymbolKind::Function, name)),
        SourceLanguage::Tads => tads_object_name(line).map(|name| (SymbolKind::Resource, name)),
        SourceLanguage::Twee => line
            .strip_prefix("::")
            .and_then(clean_name)
            .map(|name| (SymbolKind::Resource, name)),
        SourceLanguage::ValveQc => {
            valve_resource_name(line, lower).map(|name| (SymbolKind::Resource, name))
        }
        SourceLanguage::WurstScript => {
            marker_name(line, lower, "package ").map(|name| (SymbolKind::Module, name))
        }
        SourceLanguage::YarnSpinner => {
            marker_name(line, lower, "title:").map(|name| (SymbolKind::Function, name))
        }
        _ => None,
    }
}

fn type_declaration<'line>(
    language: SourceLanguage,
    line: &'line str,
    lower: &str,
) -> Option<(SymbolKind, &'line str)> {
    let candidates = [
        ("class ", SymbolKind::Class),
        ("actor ", SymbolKind::Class),
        ("interface ", SymbolKind::Interface),
        ("struct ", SymbolKind::Struct),
        ("enum ", SymbolKind::Enum),
        ("state ", SymbolKind::Class),
        ("namespace ", SymbolKind::Namespace),
    ];
    for (marker, kind) in candidates {
        if let Some(name) = marker_name(line, lower, marker) {
            return Some((kind, name));
        }
    }
    if matches!(language, SourceLanguage::Daedalus)
        && let Some(name) = marker_name(line, lower, "instance ")
    {
        return Some((SymbolKind::Resource, name));
    }
    None
}

fn function_declaration<'line>(
    language: SourceLanguage,
    line: &'line str,
    lower: &str,
) -> Option<(SymbolKind, &'line str)> {
    if let Some(name) = function_keyword_name(line, lower) {
        return Some((SymbolKind::Function, name));
    }
    for marker in ["func ", "fn ", "def ", "event ", "delegate "] {
        if let Some(name) = marker_name(line, lower, marker) {
            return Some((SymbolKind::Function, name));
        }
    }
    let open = line.find('(')?;
    let close = line[open..]
        .find(')')
        .map(|offset| open.saturating_add(offset))?;
    let declaration_shape = line[close..].contains('{')
        || line[close..].contains('=')
        || matches!(language, SourceLanguage::Verse) && line[close..].contains(':');
    if !declaration_shape {
        return None;
    }
    let name = token_before(line, open)?;
    (!call_keyword(name)).then_some((SymbolKind::Function, name))
}

fn function_keyword_name<'line>(line: &'line str, lower: &str) -> Option<&'line str> {
    let marker = "function ";
    let offset = lower.find(marker)?.saturating_add(marker.len());
    let tail = line.get(offset..)?;
    let first = clean_name(tail)?;
    let open = tail.find('(');
    let before_parenthesis = open.and_then(|end| token_before(tail, end));
    if before_parenthesis.is_some_and(|name| name != first) && type_keyword(first) {
        before_parenthesis
    } else {
        Some(first)
    }
}

fn type_keyword(name: &str) -> bool {
    [
        "auto", "bool", "entity", "float", "int", "object", "string", "void",
    ]
    .into_iter()
    .any(|keyword| name.eq_ignore_ascii_case(keyword))
}

fn marker_name<'line>(line: &'line str, lower: &str, marker: &str) -> Option<&'line str> {
    let offset = lower.find(marker)?.saturating_add(marker.len());
    line.get(offset..).and_then(clean_name)
}

fn assignment_function_name<'line>(line: &'line str, lower: &str) -> Option<&'line str> {
    let equals = lower.find("= function")?;
    line.get(..equals).and_then(token_before_end)
}

fn byond_proc_name<'line>(line: &'line str, lower: &str) -> Option<&'line str> {
    ["/proc/", "/verb/"]
        .into_iter()
        .find_map(|marker| marker_name(line, lower, marker))
}

fn assignment_block_name(line: &str) -> Option<&str> {
    let equals = line.find('=')?;
    line.get(equals.saturating_add(1)..)
        .is_some_and(|tail| tail.trim_start().starts_with('{'))
        .then(|| line.get(..equals).and_then(token_before_end))
        .flatten()
}

fn halo_script_name<'line>(line: &'line str, lower: &str) -> Option<&'line str> {
    let body = lower.strip_prefix("(script ")?;
    let name = body.split_whitespace().nth(2)?;
    let offset = lower.find(name)?;
    line.get(offset..).and_then(clean_name)
}

fn inform6_routine_name(line: &str) -> Option<&str> {
    line.strip_prefix('[').and_then(clean_name)
}

fn inform7_phrase_name<'line>(line: &'line str, lower: &str) -> Option<&'line str> {
    if lower.starts_with("to ") {
        return line.get(3..).and_then(clean_name);
    }
    lower
        .starts_with("this is the ")
        .then(|| line.get(12..).and_then(clean_name))
        .flatten()
}

fn ink_knot_name(line: &str) -> Option<&str> {
    let body = line.trim_matches('=').trim();
    (!body.is_empty() && line.trim_start().starts_with('=')).then_some(body)
}

fn quake_function_name(line: &str) -> Option<&str> {
    let close = line.find(") ").or_else(|| line.find("\t)"))?;
    let equals = line[close..].find('=')?.saturating_add(close);
    line.get(close.saturating_add(1)..equals)
        .and_then(token_before_end)
}

fn tads_object_name(line: &str) -> Option<&str> {
    let colon = line.find(':')?;
    let tail = line.get(colon.saturating_add(1)..)?.trim_start();
    ["room", "thing", "actor", "object"]
        .into_iter()
        .any(|kind| tail.to_ascii_lowercase().starts_with(kind))
        .then(|| line.get(..colon).and_then(token_before_end))
        .flatten()
}

fn valve_resource_name<'line>(line: &'line str, lower: &str) -> Option<&'line str> {
    ["$sequence ", "$body ", "$bodygroup "]
        .into_iter()
        .find_map(|marker| marker_name(line, lower, marker))
}

fn module_fact(input: ModuleScanInput<'_, '_>) -> Result<Option<ModuleFact>, ExtractError> {
    let lower = input.code.to_ascii_lowercase();
    if !has_module_marker(input.language, &lower) {
        return Ok(None);
    }
    let candidate = quoted_or_bracketed_module(input.original)
        .or_else(|| unquoted_module(input.language, input.original, &lower));
    let Some((module, offset)) = candidate else {
        return Ok(None);
    };
    let module = module.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(character, ';' | ',' | ')' | '}' | '<' | '>' | '\'' | '"')
    });
    if module.is_empty() || looks_sensitive(module) {
        return Ok(None);
    }
    Ok(Some(ModuleFact {
        module: bounded_string(module)?,
        start: input.absolute_start.saturating_add(offset),
        end: input
            .absolute_start
            .saturating_add(offset)
            .saturating_add(module.len()),
    }))
}

fn has_module_marker(language: SourceLanguage, lower: &str) -> bool {
    let generic = [
        "#include", "$include", "include ", "import ", "preload(", "load(", "exec(", "execvm ",
        "runpath(", "dofile(", "require(", "using {",
    ]
    .into_iter()
    .any(|marker| lower.contains(marker));
    generic
        || language == SourceLanguage::ChoiceScript
            && lower.trim_start().starts_with("*gosub_scene ")
        || language == SourceLanguage::Ink && lower.trim_start().starts_with("include ")
}

fn quoted_or_bracketed_module(original: &str) -> Option<(&str, usize)> {
    for (open, close) in [('"', '"'), ('\'', '\''), ('<', '>'), ('{', '}')] {
        let Some(opening) = original.find(open) else {
            continue;
        };
        let start = opening.saturating_add(open.len_utf8());
        let tail = original.get(start..)?;
        if let Some(length) = tail.find(close) {
            return Some((tail.get(..length)?, start));
        }
    }
    None
}

fn unquoted_module<'line>(
    language: SourceLanguage,
    original: &'line str,
    lower: &str,
) -> Option<(&'line str, usize)> {
    let marker = if language == SourceLanguage::ChoiceScript {
        "*gosub_scene "
    } else if language == SourceLanguage::Ink {
        "include "
    } else if lower.contains("import ") {
        "import "
    } else if lower.contains("include ") {
        "include "
    } else {
        return None;
    };
    let offset = lower.find(marker)?.saturating_add(marker.len());
    let value = original.get(offset..)?.trim_start();
    let leading = original.get(offset..)?.len().saturating_sub(value.len());
    let module = value.split_whitespace().next()?;
    Some((module, offset.saturating_add(leading)))
}

fn reference_facts(
    input: ReferenceScanInput<'_, '_, '_>,
) -> Result<Vec<ReferenceFact>, ExtractError> {
    let mut facts = Vec::new();
    facts
        .try_reserve(8)
        .map_err(|_| ExtractError::OutputLimit)?;
    if let Some(fact) = explicit_reference(input)? {
        facts.push(fact);
    }
    add_parenthesized_calls(
        ParenthesizedCallInput {
            line: input.code,
            absolute_start: input.absolute_start,
            declaration: input.declaration,
        },
        &mut facts,
    )?;
    Ok(facts)
}

fn explicit_reference(
    input: ReferenceScanInput<'_, '_, '_>,
) -> Result<Option<ReferenceFact>, ExtractError> {
    let trimmed = input.code.trim();
    let lower = trimmed.to_ascii_lowercase();
    let candidate = explicit_reference_candidate_a(input, trimmed, &lower)
        .or_else(|| explicit_reference_candidate_b(input, trimmed, &lower));
    let Some((name, offset)) = candidate else {
        return Ok(None);
    };
    let name = clean_reference(name);
    if name.is_empty() || looks_sensitive(name) {
        return Ok(None);
    }
    Ok(Some(ReferenceFact {
        kind: ReferenceKind::Calls,
        name: bounded_string(name)?,
        start: input.absolute_start.saturating_add(offset),
        end: input
            .absolute_start
            .saturating_add(offset)
            .saturating_add(name.len()),
    }))
}

fn explicit_reference_candidate_a<'line>(
    input: ReferenceScanInput<'line, 'line, '_>,
    line: &'line str,
    lower: &str,
) -> Option<(&'line str, usize)> {
    match input.language {
        SourceLanguage::ChoiceScript => command_target(line, lower, &["*goto ", "*gosub "]),
        SourceLanguage::HaloScript => s_expression_target(line, lower, &["wake", "sleep_until"]),
        SourceLanguage::Inform7 => command_target(line, lower, &["follow ", "abide by "]),
        SourceLanguage::Ink => arrow_target(line),
        SourceLanguage::MinecraftFunction => command_target(line, lower, &["function "]),
        SourceLanguage::ParadoxScript => paradox_reference(line, lower),
        _ => None,
    }
}

fn explicit_reference_candidate_b<'line>(
    input: ReferenceScanInput<'line, 'line, '_>,
    line: &'line str,
    lower: &str,
) -> Option<(&'line str, usize)> {
    match input.language {
        SourceLanguage::Renpy => command_target(line, lower, &["jump ", "call "]),
        SourceLanguage::Sqf => command_target(line, lower, &["call ", "spawn "]),
        SourceLanguage::Sqs => quoted_command_target(input.original, "goto"),
        SourceLanguage::Twee => twee_target(line),
        SourceLanguage::YarnSpinner => yarn_target(line, lower),
        _ => None,
    }
}

fn command_target<'line>(
    line: &'line str,
    lower: &str,
    markers: &[&str],
) -> Option<(&'line str, usize)> {
    for marker in markers {
        if let Some(offset) = lower.find(marker) {
            let start = offset.saturating_add(marker.len());
            let name = line.get(start..)?.split_whitespace().next()?;
            return Some((name, start));
        }
    }
    None
}

fn s_expression_target<'line>(
    line: &'line str,
    lower: &str,
    operations: &[&str],
) -> Option<(&'line str, usize)> {
    let body = lower.strip_prefix('(')?;
    let operation = body.split_whitespace().next()?;
    if !operations.contains(&operation) {
        return None;
    }
    let operation_offset = lower.find(operation)?;
    let tail_start = operation_offset.saturating_add(operation.len());
    let tail = line.get(tail_start..)?.trim_start();
    let leading = line.get(tail_start..)?.len().saturating_sub(tail.len());
    Some((
        tail.split_whitespace().next()?,
        tail_start.saturating_add(leading),
    ))
}

fn arrow_target(line: &str) -> Option<(&str, usize)> {
    let offset = line.find("->")?.saturating_add(2);
    let tail = line.get(offset..)?.trim_start();
    let leading = line.get(offset..)?.len().saturating_sub(tail.len());
    Some((
        tail.split_whitespace().next()?,
        offset.saturating_add(leading),
    ))
}

fn paradox_reference<'line>(line: &'line str, lower: &str) -> Option<(&'line str, usize)> {
    let equals = lower.find("= yes").or_else(|| lower.find("= no"))?;
    let name = line.get(..equals).and_then(token_before_end)?;
    let offset = line.find(name)?;
    Some((name, offset))
}

fn quoted_command_target<'line>(
    original: &'line str,
    command: &str,
) -> Option<(&'line str, usize)> {
    let lower = original.to_ascii_lowercase();
    lower.contains(command).then_some(())?;
    quoted_or_bracketed_module(original)
}

fn twee_target(line: &str) -> Option<(&str, usize)> {
    let start = line.find("[[")?.saturating_add(2);
    let end = line.get(start..)?.find("]]")?.saturating_add(start);
    let body = line.get(start..end)?;
    let target = body.rsplit_once("->").map_or(body, |(_, value)| value);
    let offset = line.find(target)?;
    Some((target, offset))
}

fn yarn_target<'line>(line: &'line str, lower: &str) -> Option<(&'line str, usize)> {
    let marker = "<<jump ";
    let start = lower.find(marker)?.saturating_add(marker.len());
    let end = line.get(start..)?.find(">>")?.saturating_add(start);
    Some((line.get(start..end)?.trim(), start))
}

fn add_parenthesized_calls(
    input: ParenthesizedCallInput<'_, '_>,
    facts: &mut Vec<ReferenceFact>,
) -> Result<(), ExtractError> {
    let bytes = input.line.as_bytes();
    let mut cursor = 0_usize;
    while cursor < bytes.len() {
        let Some(character) = input
            .line
            .get(cursor..)
            .and_then(|tail| tail.chars().next())
        else {
            break;
        };
        if !identifier_start(character) {
            cursor = cursor.saturating_add(character.len_utf8());
            continue;
        }
        let start = cursor;
        cursor = scan_identifier(input.line, cursor);
        let name = input.line.get(start..cursor).unwrap_or_default();
        let next = input
            .line
            .get(cursor..)
            .unwrap_or_default()
            .trim_start_matches(char::is_whitespace);
        let declaration_name = input.declaration.map(|fact| fact.name.as_str());
        if next.starts_with('(')
            && !call_keyword(name)
            && declaration_name != Some(name)
            && facts.len() < MAX_FACTS_PER_LINE
        {
            facts.push(ReferenceFact {
                kind: ReferenceKind::Calls,
                name: bounded_string(name)?,
                start: input.absolute_start.saturating_add(start),
                end: input.absolute_start.saturating_add(cursor),
            });
        }
    }
    Ok(())
}

fn clean_reference(value: &str) -> &str {
    value.trim_matches(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                ';' | ':' | ',' | '.' | ')' | ']' | '}' | '"' | '\''
            )
    })
}

fn clean_name(value: &str) -> Option<&str> {
    let value = value.trim_start_matches(|character: char| {
        !(character == '_' || character == '$' || character.is_alphanumeric())
    });
    let end = value
        .char_indices()
        .find_map(|(offset, character)| {
            (!(character == '_' || character == '$' || character.is_alphanumeric()))
                .then_some(offset)
        })
        .unwrap_or(value.len());
    let name = value.get(..end)?;
    (!name.is_empty()).then_some(name)
}

fn token_before(line: &str, end: usize) -> Option<&str> {
    line.get(..end).and_then(token_before_end)
}

fn token_before_end(value: &str) -> Option<&str> {
    let value = value.trim_end_matches(|character: char| {
        !(character == '_' || character == '$' || character.is_alphanumeric())
    });
    let start = value
        .char_indices()
        .rev()
        .find_map(|(offset, character)| {
            (!(character == '_' || character == '$' || character.is_alphanumeric()))
                .then_some(offset.saturating_add(character.len_utf8()))
        })
        .unwrap_or(0);
    let name = value.get(start..)?;
    (!name.is_empty()).then_some(name)
}

fn call_keyword(name: &str) -> bool {
    [
        "catch", "class", "do", "else", "enum", "for", "foreach", "function", "if", "new",
        "return", "script", "state", "struct", "switch", "while",
    ]
    .into_iter()
    .any(|keyword| name.eq_ignore_ascii_case(keyword))
}

fn identifier_start(character: char) -> bool {
    character == '_' || character == '$' || character.is_alphabetic()
}

fn identifier_continue(character: char) -> bool {
    identifier_start(character) || character.is_numeric()
}

fn scan_identifier(source: &str, start: usize) -> usize {
    let mut end = start;
    for (offset, character) in source.get(start..).unwrap_or_default().char_indices() {
        if !identifier_continue(character) {
            break;
        }
        end = start
            .saturating_add(offset)
            .saturating_add(character.len_utf8());
    }
    end
}

fn comment_syntax(language: SourceLanguage) -> AdditionalLineComment {
    if language == SourceLanguage::Pico8 {
        AdditionalLineComment::Dash
    } else if matches!(
        language,
        SourceLanguage::Boo
            | SourceLanguage::ChoiceScript
            | SourceLanguage::GdScript
            | SourceLanguage::MinecraftFunction
            | SourceLanguage::Renpy
    ) {
        AdditionalLineComment::Hash
    } else if language == SourceLanguage::Inform6 {
        AdditionalLineComment::Bang
    } else if matches!(language, SourceLanguage::HaloScript | SourceLanguage::Sqs) {
        AdditionalLineComment::Semicolon
    } else {
        AdditionalLineComment::None
    }
}

fn mask_source(
    source: &str,
    comments: AdditionalLineComment,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<MaskedSource, ExtractError> {
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact(source.len())
        .map_err(|_| ExtractError::OutputLimit)?;
    bytes.extend_from_slice(source.as_bytes());
    let original = source.as_bytes();
    let mut cursor = 0_usize;
    let mut next_poll = 0_usize;
    let mut complete = true;
    while cursor < original.len() {
        poll_cancellation(cancelled, cursor, &mut next_poll)?;
        if let Some(width) = line_comment_width(original, cursor, comments) {
            let end = original[cursor.saturating_add(width)..]
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(original.len(), |offset| {
                    cursor.saturating_add(width).saturating_add(offset)
                });
            blank_range(&mut bytes, cursor, end);
            cursor = end;
            continue;
        }
        if original[cursor] == b'/' && original.get(cursor.saturating_add(1)) == Some(&b'*') {
            let (end, closed) = block_comment_end(original, cursor);
            blank_range(&mut bytes, cursor, end);
            complete &= closed;
            cursor = end;
            continue;
        }
        if matches!(original[cursor], b'"' | b'\'' | b'`') {
            let (end, closed) = quoted_end(original, cursor, original[cursor]);
            blank_range(&mut bytes, cursor, end);
            complete &= closed;
            cursor = end;
            continue;
        }
        cursor = cursor.saturating_add(1);
    }
    let text = String::from_utf8(bytes).map_err(|_| ExtractError::InvalidSpan)?;
    let balanced = delimiters_balanced(&text);
    Ok(MaskedSource {
        text,
        complete,
        balanced,
    })
}

fn line_comment_width(bytes: &[u8], cursor: usize, syntax: AdditionalLineComment) -> Option<usize> {
    if bytes[cursor] == b'/' && bytes.get(cursor.saturating_add(1)) == Some(&b'/') {
        return Some(2);
    }
    if syntax == AdditionalLineComment::Dash
        && bytes[cursor] == b'-'
        && bytes.get(cursor.saturating_add(1)) == Some(&b'-')
    {
        return Some(2);
    }
    if syntax == AdditionalLineComment::Hash && bytes[cursor] == b'#' {
        return Some(1);
    }
    if syntax == AdditionalLineComment::Bang && bytes[cursor] == b'!' {
        return Some(1);
    }
    if syntax == AdditionalLineComment::Semicolon && bytes[cursor] == b';' {
        return Some(1);
    }
    None
}

fn block_comment_end(bytes: &[u8], start: usize) -> (usize, bool) {
    let mut cursor = start.saturating_add(2);
    let mut depth = 1_usize;
    while cursor < bytes.len() {
        if bytes[cursor] == b'/' && bytes.get(cursor.saturating_add(1)) == Some(&b'*') {
            depth = depth.saturating_add(1);
            cursor = cursor.saturating_add(2);
        } else if bytes[cursor] == b'*' && bytes.get(cursor.saturating_add(1)) == Some(&b'/') {
            depth = depth.saturating_sub(1);
            cursor = cursor.saturating_add(2);
            if depth == 0 {
                return (cursor, true);
            }
        } else {
            cursor = cursor.saturating_add(1);
        }
    }
    (bytes.len(), false)
}

fn quoted_end(bytes: &[u8], start: usize, quote: u8) -> (usize, bool) {
    let mut cursor = start.saturating_add(1);
    let mut escaped = false;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        cursor = cursor.saturating_add(1);
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return (cursor, true);
        }
    }
    (bytes.len(), false)
}

fn blank_range(bytes: &mut [u8], start: usize, end: usize) {
    for byte in bytes.get_mut(start..end).unwrap_or_default() {
        if *byte != b'\n' && *byte != b'\r' {
            *byte = b' ';
        }
    }
}

fn delimiters_balanced(source: &str) -> bool {
    let mut braces = 0_i64;
    let mut parentheses = 0_i64;
    let mut brackets = 0_i64;
    for byte in source.bytes() {
        match byte {
            b'{' => braces += 1,
            b'}' => braces -= 1,
            b'(' => parentheses += 1,
            b')' => parentheses -= 1,
            b'[' => brackets += 1,
            b']' => brackets -= 1,
            _ => {}
        }
        if braces < 0 || parentheses < 0 || brackets < 0 {
            return false;
        }
    }
    braces == 0 && parentheses == 0 && brackets == 0
}
