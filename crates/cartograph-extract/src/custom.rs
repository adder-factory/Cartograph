use std::collections::{BTreeMap, BTreeSet};

use cartograph_domain::{
    ContentDigest, FileParseStatus, ReferenceKind, SourceLanguage, SourcePosition, SourceSpan,
    SymbolId, SymbolKind, Visibility,
};
use serde_json::Value;

use crate::{
    Containment, ExtractError, ExtractedFile, ExtractedImportBinding, ExtractedReference,
    ExtractedSymbol, ImportBindingKind, SourceSnapshot,
    budget::{
        ExtractionBudget, containment_budget_bytes, import_binding_budget_bytes,
        reference_budget_bytes, symbol_budget_bytes,
    },
    identity::SymbolIdentity,
};

const CUSTOM_DIGEST_CONTEXT: &str = "cartograph.v2.custom-structural-digest.2026-07-24";
const MAX_REFERENCE_NAME_BYTES: usize = 4_096;

pub(crate) fn extract(
    snapshot: &SourceSnapshot,
    cancelled: &mut dyn FnMut() -> bool,
) -> Result<ExtractedFile, ExtractError> {
    let mut builder = CustomBuilder::new(snapshot, cancelled)?;
    match snapshot.language() {
        SourceLanguage::Properties => extract_properties(&mut builder)?,
        SourceLanguage::Toml => {}
        SourceLanguage::Liquid => extract_liquid(&mut builder)?,
        SourceLanguage::Svelte | SourceLanguage::Vue => extract_component_file(&mut builder)?,
        SourceLanguage::Aura | SourceLanguage::Visualforce => {
            extract_salesforce_markup(&mut builder)?;
        }
        SourceLanguage::Vb6 => extract_vb6(&mut builder)?,
        SourceLanguage::Xml => extract_xml(&mut builder)?,
        SourceLanguage::Bg3Anubis => extract_anubis(&mut builder)?,
        SourceLanguage::Bg3Stats => extract_bg3_stats(&mut builder)?,
        SourceLanguage::Osiris => extract_osiris(&mut builder)?,
        SourceLanguage::Bg3Resource => extract_bg3_resource(&mut builder)?,
        _ => return Err(ExtractError::UnsupportedLanguage),
    }
    builder.finish()
}

#[derive(Default)]
struct SymbolOptions {
    signature: Option<String>,
    body_search_text: String,
    declaration_only: bool,
    exported: bool,
    default_export: bool,
    async_symbol: bool,
    static_member: bool,
    visibility: Option<Visibility>,
    parent: Option<SymbolId>,
}

struct CustomBuilder<'source, 'cancel> {
    snapshot: &'source SourceSnapshot,
    cancelled: &'cancel mut dyn FnMut() -> bool,
    lines: LineMap,
    budget: ExtractionBudget,
    identities: SymbolIdentity<'source>,
    symbols: Vec<ExtractedSymbol>,
    containments: Vec<Containment>,
    references: Vec<ExtractedReference>,
    import_bindings: Vec<ExtractedImportBinding>,
}

impl<'source, 'cancel> CustomBuilder<'source, 'cancel> {
    fn new(
        snapshot: &'source SourceSnapshot,
        cancelled: &'cancel mut dyn FnMut() -> bool,
    ) -> Result<Self, ExtractError> {
        Ok(Self {
            snapshot,
            cancelled,
            lines: LineMap::new(snapshot.source())?,
            budget: ExtractionBudget::new(snapshot)?,
            identities: SymbolIdentity::new(snapshot.path()),
            symbols: Vec::new(),
            containments: Vec::new(),
            references: Vec::new(),
            import_bindings: Vec::new(),
        })
    }

    fn check_cancelled(&mut self) -> Result<(), ExtractError> {
        if (self.cancelled)() {
            Err(ExtractError::Cancelled)
        } else {
            Ok(())
        }
    }

    fn source(&self) -> &'source str {
        self.snapshot.source()
    }

    fn path(&self) -> &str {
        self.snapshot.path().as_str()
    }

    fn span(&self, start: usize, end: usize) -> Result<SourceSpan, ExtractError> {
        self.lines.span(start, end, self.source().len())
    }

    fn add_symbol(
        &mut self,
        kind: SymbolKind,
        name: &str,
        qualified_name: String,
        start: usize,
        end: usize,
        options: SymbolOptions,
    ) -> Result<SymbolId, ExtractError> {
        if name.is_empty() || qualified_name.is_empty() {
            return Err(ExtractError::InvalidSpan);
        }
        self.check_cancelled()?;
        let span = self.span(start, end)?;
        let id = self.identities.next(kind, &qualified_name)?;
        let structural_digest = custom_digest(kind, &qualified_name, &options.body_search_text);
        let clone_shape_digest = structural_digest.clone();
        let symbol = ExtractedSymbol {
            id: id.clone(),
            kind,
            name: bounded_string(name)?,
            qualified_name,
            span,
            signature: options.signature,
            docstring: None,
            body_search_text: options.body_search_text,
            body_search_truncated: false,
            health: crate::SymbolHealthMetrics::default(),
            declaration_only: options.declaration_only,
            exported: options.exported,
            default_export: options.default_export,
            async_symbol: options.async_symbol,
            static_member: options.static_member,
            visibility: options.visibility,
            structural_digest,
            clone_shape_digest,
            clone_token_profile: None,
        };
        self.budget.reserve_fact(
            symbol_budget_bytes(&symbol),
            [
                symbol.name.as_str(),
                symbol.qualified_name.as_str(),
                symbol.signature.as_deref().unwrap_or(""),
                symbol.body_search_text.as_str(),
            ],
        )?;
        if let Some(parent) = options.parent {
            let containment = Containment {
                parent,
                child: id.clone(),
            };
            self.budget
                .reserve_fact(containment_budget_bytes(&containment), std::iter::empty())?;
            self.containments.push(containment);
        }
        self.symbols.push(symbol);
        Ok(id)
    }

    fn add_reference(
        &mut self,
        owner: Option<SymbolId>,
        name: &str,
        kind: ReferenceKind,
        start: usize,
        end: usize,
    ) -> Result<(), ExtractError> {
        self.add_reference_with_resolution(owner, name, None, kind, start, end)
    }

    fn add_reference_with_resolution(
        &mut self,
        owner: Option<SymbolId>,
        name: &str,
        resolution_name: Option<&str>,
        kind: ReferenceKind,
        start: usize,
        end: usize,
    ) -> Result<(), ExtractError> {
        let Some(name) = normalize_reference(name) else {
            return Ok(());
        };
        let resolution_name = resolution_name.and_then(normalize_reference);
        let reference = ExtractedReference {
            owner,
            name,
            resolution_name,
            kind,
            span: self.span(start, end)?,
        };
        self.budget.reserve_fact(
            reference_budget_bytes(&reference),
            [
                reference.name.as_str(),
                reference.resolution_name.as_deref().unwrap_or(""),
            ],
        )?;
        self.references.push(reference);
        Ok(())
    }

    fn add_import(
        &mut self,
        owner: Option<SymbolId>,
        module: &str,
        imported: &str,
        local: &str,
        start: usize,
        end: usize,
    ) -> Result<(), ExtractError> {
        self.add_reference(owner, module, ReferenceKind::Imports, start, end)?;
        let binding = ExtractedImportBinding {
            kind: ImportBindingKind::Named,
            module_specifier: bounded_string(module)?,
            imported_name: bounded_string(imported)?,
            local_name: bounded_string(local)?,
            span: self.span(start, end)?,
        };
        self.budget.reserve_fact(
            import_binding_budget_bytes(&binding),
            [
                binding.module_specifier.as_str(),
                binding.imported_name.as_str(),
                binding.local_name.as_str(),
            ],
        )?;
        self.import_bindings.push(binding);
        Ok(())
    }

    fn finish(self) -> Result<ExtractedFile, ExtractError> {
        let output_limit = self.budget.output_limit();
        let file = ExtractedFile {
            file_id: self.snapshot.file_id().clone(),
            path: self.snapshot.path().clone(),
            language: self.snapshot.language(),
            content_hash: self.snapshot.content_hash().clone(),
            byte_size: self.snapshot.byte_size(),
            line_count: self.snapshot.line_count(),
            parse_status: FileParseStatus::Parsed,
            symbols: self.symbols,
            containments: self.containments,
            references: self.references,
            import_bindings: self.import_bindings,
            has_inline_tests: false,
            test_search_text: String::new(),
            test_search_truncated: false,
            diagnostics: Vec::new(),
        };
        if file.modeled_retained_bytes() > output_limit {
            return Err(ExtractError::OutputLimit);
        }
        Ok(file)
    }
}

struct LineMap {
    starts: Vec<usize>,
}

impl LineMap {
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
        let start = self.position(start)?;
        let end = self.position(end)?;
        SourceSpan::new(start, end).map_err(|_| ExtractError::InvalidSpan)
    }

    fn position(&self, byte: usize) -> Result<SourcePosition, ExtractError> {
        let line_index = self.starts.partition_point(|start| *start <= byte) - 1;
        let line =
            u32::try_from(line_index.saturating_add(1)).map_err(|_| ExtractError::InvalidSpan)?;
        let column = u32::try_from(byte.saturating_sub(self.starts[line_index]))
            .map_err(|_| ExtractError::InvalidSpan)?;
        let byte = u64::try_from(byte).map_err(|_| ExtractError::InvalidSpan)?;
        SourcePosition::new(byte, line, column).map_err(|_| ExtractError::InvalidSpan)
    }
}

fn custom_digest(kind: SymbolKind, qualified_name: &str, safe_structure: &str) -> ContentDigest {
    let mut hasher = blake3::Hasher::new_derive_key(CUSTOM_DIGEST_CONTEXT);
    for field in [kind.as_str(), qualified_name, safe_structure] {
        hasher.update(&u64::try_from(field.len()).unwrap_or(u64::MAX).to_le_bytes());
        hasher.update(field.as_bytes());
    }
    ContentDigest::from_bytes(*hasher.finalize().as_bytes())
}

fn bounded_string(value: &str) -> Result<String, ExtractError> {
    if value.len() > MAX_REFERENCE_NAME_BYTES {
        return Err(ExtractError::OutputLimit);
    }
    let mut output = String::new();
    output
        .try_reserve_exact(value.len())
        .map_err(|_| ExtractError::OutputLimit)?;
    output.push_str(value);
    Ok(output)
}

fn normalize_reference(raw: &str) -> Option<String> {
    let value = raw.trim().trim_matches(|ch| matches!(ch, '\'' | '"' | '`'));
    if value.is_empty()
        || value.len() > MAX_REFERENCE_NAME_BYTES
        || value.bytes().any(|byte| byte.is_ascii_control())
        || looks_sensitive(value)
    {
        return None;
    }
    bounded_string(value).ok()
}

fn looks_sensitive(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if [
        "sk_live_",
        "sk_test_",
        "ghp_",
        "github_pat_",
        "xoxb_",
        "xoxp_",
        "akia",
        "asia",
    ]
    .into_iter()
    .any(|prefix| lower.starts_with(prefix))
    {
        return true;
    }
    let sensitive_word = lower
        .split(|character: char| !character.is_ascii_alphanumeric())
        .any(|token| {
            matches!(
                token,
                "password"
                    | "passwd"
                    | "secret"
                    | "token"
                    | "apikey"
                    | "privatekey"
                    | "clientsecret"
                    | "credential"
                    | "credentials"
            )
        });
    let high_entropy = value.len() >= 24
        && value.bytes().any(|byte| byte.is_ascii_lowercase())
        && value.bytes().any(|byte| byte.is_ascii_uppercase())
        && value.bytes().any(|byte| byte.is_ascii_digit());
    sensitive_word || high_entropy
}

fn basename_stem(path: &str) -> &str {
    let filename = path.rsplit('/').next().unwrap_or(path);
    filename
        .rfind('.')
        .map_or(filename, |extension| &filename[..extension])
}

fn is_identifier_start(byte: u8) -> bool {
    byte == b'_' || byte.is_ascii_alphabetic()
}

fn is_identifier_body(byte: u8) -> bool {
    is_identifier_start(byte) || byte.is_ascii_digit() || byte == b'$'
}

fn identifiers(value: &str) -> Vec<(usize, &str)> {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if !is_identifier_start(bytes[cursor]) {
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 1;
        while cursor < bytes.len() && is_identifier_body(bytes[cursor]) {
            cursor += 1;
        }
        output.push((start, &value[start..cursor]));
    }
    output
}

fn first_identifier(value: &str) -> Option<(usize, &str)> {
    identifiers(value).into_iter().next()
}

fn word_after<'a>(value: &'a str, keyword: &str) -> Option<(usize, &'a str)> {
    let trimmed = value.trim_start();
    let indent = value.len().saturating_sub(trimmed.len());
    let suffix = trimmed.get(keyword.len()..)?;
    if !trimmed[..keyword.len()].eq_ignore_ascii_case(keyword)
        || suffix
            .as_bytes()
            .first()
            .is_some_and(|byte| is_identifier_body(*byte))
    {
        return None;
    }
    let (offset, word) = first_identifier(suffix)?;
    Some((indent + keyword.len() + offset, word))
}

fn quoted_values(value: &str) -> Vec<(usize, &str)> {
    let bytes = value.as_bytes();
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if !matches!(bytes[cursor], b'\'' | b'"') {
            cursor += 1;
            continue;
        }
        let quote = bytes[cursor];
        let start = cursor.saturating_add(1);
        cursor = start;
        while cursor < bytes.len() {
            if bytes[cursor] == b'\\' {
                cursor = cursor.saturating_add(2);
                continue;
            }
            if bytes[cursor] == quote {
                output.push((start, &value[start..cursor]));
                cursor += 1;
                break;
            }
            cursor += 1;
        }
    }
    output
}

fn line_ranges(source: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut offset = 0_usize;
    source.split_inclusive('\n').map(move |raw| {
        let start = offset;
        offset = offset.saturating_add(raw.len());
        let line = raw
            .strip_suffix('\n')
            .unwrap_or(raw)
            .strip_suffix('\r')
            .unwrap_or_else(|| raw.strip_suffix('\n').unwrap_or(raw));
        (start, line)
    })
}

fn extract_properties(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    for (line_start, line) in line_ranges(source) {
        builder.check_cancelled()?;
        let Some((key_start, key_end, key)) = properties_key(line) else {
            continue;
        };
        let owner = builder.add_symbol(
            SymbolKind::Constant,
            &key,
            key.clone(),
            line_start + key_start,
            line_start + key_end,
            SymbolOptions {
                body_search_text: key.clone(),
                exported: true,
                visibility: Some(Visibility::Public),
                ..SymbolOptions::default()
            },
        )?;
        let value = &line[key_end..];
        for (offset, reference) in interpolation_references(value) {
            builder.add_reference(
                Some(owner.clone()),
                reference,
                ReferenceKind::References,
                line_start + key_end + offset,
                line_start + key_end + offset + reference.len(),
            )?;
        }
    }
    Ok(())
}

fn properties_key(line: &str) -> Option<(usize, usize, String)> {
    let bytes = line.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() && matches!(bytes[cursor], b' ' | b'\t' | 0x0c) {
        cursor += 1;
    }
    if cursor == bytes.len() || matches!(bytes[cursor], b'#' | b'!') {
        return None;
    }
    let start = cursor;
    let mut key = String::new();
    while cursor < bytes.len() {
        match bytes[cursor] {
            b'\\' if cursor + 1 < bytes.len() => {
                let escaped = bytes[cursor + 1];
                if matches!(escaped, b'=' | b':' | b'\\' | b' ' | b'\t') {
                    key.push(char::from(escaped));
                } else {
                    key.push('\\');
                    key.push(char::from(escaped));
                }
                cursor += 2;
            }
            b'=' | b':' | b' ' | b'\t' | 0x0c => break,
            byte if byte.is_ascii() => {
                key.push(char::from(byte));
                cursor += 1;
            }
            _ => {
                let character = line[cursor..].chars().next()?;
                key.push(character);
                cursor += character.len_utf8();
            }
        }
    }
    (!key.is_empty() && cursor < bytes.len()).then_some((start, cursor, key))
}

fn interpolation_references(value: &str) -> Vec<(usize, &str)> {
    let mut output = Vec::new();
    let mut cursor = 0;
    while let Some(relative) = value[cursor..].find("${") {
        let open = cursor + relative;
        let content_start = open + 2;
        let Some(close_relative) = value[content_start..].find('}') else {
            break;
        };
        let close = content_start + close_relative;
        let name = value[content_start..close].trim();
        let leading =
            value[content_start..close].len() - value[content_start..close].trim_start().len();
        if is_qualified_name(name) {
            output.push((content_start + leading, name));
        }
        cursor = close + 1;
    }
    output
}

fn is_qualified_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_REFERENCE_NAME_BYTES
        && value.bytes().all(|byte| {
            is_identifier_body(byte) || matches!(byte, b'.' | b':' | b'/' | b'-' | b'#')
        })
}

fn extract_liquid(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    let mut cursor = 0;
    while let Some(relative) = source[cursor..].find("{%") {
        builder.check_cancelled()?;
        let open = cursor + relative;
        let Some(close_relative) = source[open + 2..].find("%}") else {
            break;
        };
        let close = open + 2 + close_relative + 2;
        let raw = source[open + 2..close - 2]
            .trim_matches(|character: char| character.is_whitespace() || character == '-');
        extract_liquid_tag(builder, raw, open, close)?;
        cursor = close;
    }
    extract_liquid_output_references(builder)
}

fn extract_liquid_tag(
    builder: &mut CustomBuilder<'_, '_>,
    raw: &str,
    start: usize,
    end: usize,
) -> Result<(), ExtractError> {
    let Some((_, command)) = first_identifier(raw) else {
        return Ok(());
    };
    let command_end = raw.find(command).unwrap_or(0) + command.len();
    let remainder = &raw[command_end..];
    match command {
        "render" | "include" | "section" => {
            let Some((_, partner)) = quoted_values(remainder).into_iter().next() else {
                return Ok(());
            };
            if !is_qualified_name(partner) {
                return Ok(());
            }
            let folder = if command == "section" {
                "sections"
            } else {
                "snippets"
            };
            let module = format!("{folder}/{partner}.liquid");
            let qualified = format!("{}::{command}:{partner}", builder.path());
            let id = builder.add_symbol(
                if command == "section" {
                    SymbolKind::Component
                } else {
                    SymbolKind::Import
                },
                partner,
                qualified,
                start,
                end,
                SymbolOptions {
                    body_search_text: format!("{command} {partner}"),
                    ..SymbolOptions::default()
                },
            )?;
            builder.add_import(Some(id), &module, partner, partner, start, end)?;
        }
        "assign" | "capture" => {
            let Some((_, name)) = first_identifier(remainder) else {
                return Ok(());
            };
            let qualified = format!("{}::{name}", builder.path());
            builder.add_symbol(
                SymbolKind::Variable,
                name,
                qualified,
                start,
                end,
                SymbolOptions {
                    body_search_text: format!("{command} {name}"),
                    ..SymbolOptions::default()
                },
            )?;
        }
        "block" => {
            let Some((_, name)) = first_identifier(remainder) else {
                return Ok(());
            };
            builder.add_symbol(
                SymbolKind::Component,
                name,
                format!("{}::block:{name}", builder.path()),
                start,
                end,
                SymbolOptions {
                    body_search_text: format!("block {name}"),
                    ..SymbolOptions::default()
                },
            )?;
        }
        "schema" => {
            builder.add_symbol(
                SymbolKind::Resource,
                "schema",
                format!("{}::schema", builder.path()),
                start,
                end,
                SymbolOptions {
                    body_search_text: "schema".to_owned(),
                    ..SymbolOptions::default()
                },
            )?;
        }
        _ => {}
    }
    Ok(())
}

fn extract_liquid_output_references(
    builder: &mut CustomBuilder<'_, '_>,
) -> Result<(), ExtractError> {
    let source = builder.source();
    let mut cursor = 0;
    let mut seen = BTreeSet::new();
    while let Some(relative) = source[cursor..].find("{{") {
        let open = cursor + relative;
        let Some(close_relative) = source[open + 2..].find("}}") else {
            break;
        };
        let close = open + 2 + close_relative;
        let expression = &source[open + 2..close];
        for (relative_offset, name) in identifiers(expression) {
            if liquid_keyword(name) || !seen.insert((open, name)) {
                continue;
            }
            let start = open + 2 + relative_offset;
            builder.add_reference(
                None,
                name,
                ReferenceKind::References,
                start,
                start + name.len(),
            )?;
        }
        cursor = close + 2;
    }
    Ok(())
}

fn liquid_keyword(name: &str) -> bool {
    matches!(
        name,
        "and" | "or" | "contains" | "true" | "false" | "nil" | "null" | "blank" | "empty"
    )
}

#[derive(Clone, Copy)]
struct MarkupTag<'source> {
    name: &'source str,
    raw: &'source str,
    start: usize,
    end: usize,
    closing: bool,
    self_closing: bool,
}

fn markup_tags(source: &str) -> Vec<MarkupTag<'_>> {
    let bytes = source.as_bytes();
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        let Some(relative) = source[cursor..].find('<') else {
            break;
        };
        let start = cursor + relative;
        if source[start..].starts_with("<!--") {
            cursor = source[start + 4..]
                .find("-->")
                .map_or(source.len(), |close| start + 4 + close + 3);
            continue;
        }
        let mut end = start + 1;
        let mut quote = None;
        while end < bytes.len() {
            let byte = bytes[end];
            if let Some(active) = quote {
                if byte == active {
                    quote = None;
                }
            } else if matches!(byte, b'\'' | b'"') {
                quote = Some(byte);
            } else if byte == b'>' {
                break;
            }
            end += 1;
        }
        if end >= bytes.len() {
            break;
        }
        let raw = &source[start + 1..end];
        let trimmed = raw.trim();
        let closing = trimmed.starts_with('/');
        let name_source = trimmed.trim_start_matches('/').trim_start();
        if !name_source.starts_with(['!', '?']) {
            let name_end = name_source
                .find(|character: char| character.is_whitespace() || character == '/')
                .unwrap_or(name_source.len());
            if name_end > 0 {
                output.push(MarkupTag {
                    name: &name_source[..name_end],
                    raw,
                    start,
                    end: end + 1,
                    closing,
                    self_closing: !closing && trimmed.ends_with('/'),
                });
            }
        }
        cursor = end + 1;
    }
    output
}

fn tag_attribute<'source>(tag: MarkupTag<'source>, key: &str) -> Option<(usize, &'source str)> {
    let bytes = tag.raw.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        while cursor < bytes.len() && (bytes[cursor].is_ascii_whitespace() || bytes[cursor] == b'/')
        {
            cursor += 1;
        }
        let name_start = cursor;
        while cursor < bytes.len()
            && (is_identifier_body(bytes[cursor])
                || matches!(bytes[cursor], b':' | b'.' | b'-' | b'@'))
        {
            cursor += 1;
        }
        if name_start == cursor {
            cursor += 1;
            continue;
        }
        let name = &tag.raw[name_start..cursor];
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        if cursor >= bytes.len() || bytes[cursor] != b'=' {
            continue;
        }
        cursor += 1;
        while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
            cursor += 1;
        }
        let quote = bytes.get(cursor).copied();
        if !matches!(quote, Some(b'\'' | b'"')) {
            continue;
        }
        cursor += 1;
        let value_start = cursor;
        while cursor < bytes.len() && Some(bytes[cursor]) != quote {
            cursor += 1;
        }
        if name.eq_ignore_ascii_case(key) {
            return Some((tag.start + 1 + value_start, &tag.raw[value_start..cursor]));
        }
        cursor = cursor.saturating_add(1);
    }
    None
}

fn tag_name_eq(tag: MarkupTag<'_>, expected: &str) -> bool {
    tag.name.eq_ignore_ascii_case(expected)
}

fn find_matching_close(tags: &[MarkupTag<'_>], opening_index: usize) -> Option<(usize, usize)> {
    let opening = tags[opening_index];
    if opening.self_closing {
        return Some((opening_index, opening.end));
    }
    let mut depth = 0_usize;
    for (index, tag) in tags.iter().enumerate().skip(opening_index + 1) {
        if !tag.name.eq_ignore_ascii_case(opening.name) {
            continue;
        }
        if tag.closing {
            if depth == 0 {
                return Some((index, tag.start));
            }
            depth = depth.saturating_sub(1);
        } else if !tag.self_closing {
            depth = depth.saturating_add(1);
        }
    }
    None
}

fn extract_component_file(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    if builder.source().is_empty() {
        return Ok(());
    }
    let component_name = basename_stem(builder.path()).to_owned();
    let component_span_end = builder
        .source()
        .find('\n')
        .map_or(builder.source().len(), |index| index.saturating_add(1))
        .max(1);
    let component = builder.add_symbol(
        SymbolKind::Component,
        &component_name,
        component_name.clone(),
        0,
        component_span_end,
        SymbolOptions {
            body_search_text: format!("component {component_name}"),
            exported: true,
            default_export: true,
            visibility: Some(Visibility::Public),
            ..SymbolOptions::default()
        },
    )?;
    let source = builder.source();
    let tags = markup_tags(source);
    for (index, tag) in tags.iter().copied().enumerate() {
        builder.check_cancelled()?;
        if !tag.closing && tag_name_eq(tag, "script") {
            let script_start = tag.end;
            let script_end = find_matching_close(&tags, index)
                .map_or(source.len(), |(_, close_start)| close_start);
            if script_start < script_end {
                extract_embedded_script(builder, component.clone(), script_start, script_end)?;
            }
        }
        if !tag.closing && starts_uppercase_ascii(tag.name) {
            builder.add_reference(
                Some(component.clone()),
                tag.name,
                ReferenceKind::References,
                tag.start + 1,
                tag.start + 1 + tag.name.len(),
            )?;
        }
        if !tag.closing {
            extract_template_attribute_calls(builder, component.clone(), tag)?;
        }
    }
    let excluded = component_non_template_ranges(&tags);
    extract_template_expression_calls(builder, component, &excluded)
}

fn component_non_template_ranges(tags: &[MarkupTag<'_>]) -> Vec<std::ops::Range<usize>> {
    tags.iter()
        .copied()
        .enumerate()
        .filter(|(_, tag)| {
            !tag.closing && (tag_name_eq(*tag, "script") || tag_name_eq(*tag, "style"))
        })
        .filter_map(|(index, tag)| {
            find_matching_close(tags, index)
                .map(|(close_index, _)| tag.start..tags[close_index].end)
        })
        .collect()
}

fn extract_embedded_script(
    builder: &mut CustomBuilder<'_, '_>,
    component: SymbolId,
    start: usize,
    end: usize,
) -> Result<(), ExtractError> {
    let source = builder.source();
    for (line_relative, line) in line_ranges(&source[start..end]) {
        builder.check_cancelled()?;
        let absolute = start + line_relative;
        let clean = mask_literals_and_comments(line);
        let trimmed = clean.trim_start();
        let indent = clean.len().saturating_sub(trimmed.len());
        let original_trimmed = line.trim_start();
        if let Some(import) = parse_script_import(original_trimmed) {
            let name_start = absolute + indent + import.local_offset;
            if framework_virtual_module(builder.snapshot.language(), import.module) {
                let module_start = absolute + import.module_offset;
                builder.add_symbol(
                    SymbolKind::Resource,
                    import.module,
                    format!(
                        "{}::framework-module::{}",
                        basename_stem(builder.path()),
                        import.module
                    ),
                    module_start,
                    module_start + import.module.len(),
                    SymbolOptions {
                        body_search_text: format!("framework virtual module {}", import.module),
                        parent: Some(component.clone()),
                        ..SymbolOptions::default()
                    },
                )?;
            }
            let symbol = builder.add_symbol(
                SymbolKind::Import,
                import.local,
                format!("{}::{}", basename_stem(builder.path()), import.local),
                name_start,
                name_start + import.local.len(),
                SymbolOptions {
                    body_search_text: format!("import {}", import.local),
                    parent: Some(component.clone()),
                    ..SymbolOptions::default()
                },
            )?;
            builder.add_import(
                Some(symbol),
                import.module,
                import.imported,
                import.local,
                absolute + import.module_offset,
                absolute + import.module_offset + import.module.len(),
            )?;
            continue;
        }
        if let Some(declaration) = parse_script_declaration(trimmed) {
            let name_start = absolute + indent + declaration.name_offset;
            let kind = declaration.kind;
            builder.add_symbol(
                kind,
                declaration.name,
                format!("{}::{}", basename_stem(builder.path()), declaration.name),
                name_start,
                name_start + declaration.name.len(),
                SymbolOptions {
                    body_search_text: format!("{} {}", kind.as_str(), declaration.name),
                    exported: declaration.exported,
                    default_export: declaration.default_export,
                    async_symbol: declaration.async_symbol,
                    visibility: declaration.exported.then_some(Visibility::Public),
                    parent: Some(component.clone()),
                    ..SymbolOptions::default()
                },
            )?;
        }
        for (relative, call) in function_like_names(&clean) {
            if script_call_skip(call) || declaration_name_on_line(trimmed, call) {
                continue;
            }
            let call_start = absolute + relative;
            builder.add_reference(
                Some(component.clone()),
                call,
                ReferenceKind::Calls,
                call_start,
                call_start + call.len(),
            )?;
        }
        if builder.snapshot.language() == SourceLanguage::Svelte {
            extract_svelte_store_references(builder, component.clone(), &clean, absolute)?;
        }
    }
    Ok(())
}

fn framework_virtual_module(language: SourceLanguage, module: &str) -> bool {
    let prefixes: &[&str] = match language {
        SourceLanguage::Svelte => &[
            "$app/navigation",
            "$app/stores",
            "$app/environment",
            "$app/forms",
            "$app/paths",
            "$env/static/private",
            "$env/static/public",
            "$env/dynamic/private",
            "$env/dynamic/public",
        ],
        SourceLanguage::Vue => &["#imports", "#components", "#app", "#build", "#head"],
        _ => return false,
    };
    prefixes.iter().any(|prefix| {
        module == *prefix
            || module
                .strip_prefix(*prefix)
                .is_some_and(|tail| tail.starts_with('/'))
    })
}

struct ScriptImport<'source> {
    local: &'source str,
    imported: &'source str,
    module: &'source str,
    local_offset: usize,
    module_offset: usize,
}

fn parse_script_import(line: &str) -> Option<ScriptImport<'_>> {
    if !line.starts_with("import ") {
        return None;
    }
    let module = quoted_values(line).into_iter().last()?;
    let before_from = line["import ".len()..module.0.saturating_sub(1)].trim();
    let (_, local) = first_identifier(before_from)?;
    let imported = if before_from.starts_with('{') {
        local
    } else if before_from.starts_with('*') {
        "*"
    } else {
        "default"
    };
    if module.1.is_empty()
        || module.1.bytes().any(|byte| byte.is_ascii_whitespace())
        || looks_sensitive(module.1)
    {
        return None;
    }
    Some(ScriptImport {
        local,
        imported,
        module: module.1,
        local_offset: "import ".len() + line["import ".len()..].find(local)?,
        module_offset: module.0,
    })
}

struct ScriptDeclaration<'source> {
    kind: SymbolKind,
    name: &'source str,
    name_offset: usize,
    exported: bool,
    default_export: bool,
    async_symbol: bool,
}

fn parse_script_declaration(line: &str) -> Option<ScriptDeclaration<'_>> {
    let mut remainder = line;
    let mut offset = 0;
    let exported = remainder.starts_with("export ");
    if exported {
        remainder = &remainder["export ".len()..];
        offset += "export ".len();
    }
    let default_export = remainder.starts_with("default ");
    if default_export {
        remainder = &remainder["default ".len()..];
        offset += "default ".len();
    }
    let async_symbol = remainder.starts_with("async ");
    if async_symbol {
        remainder = &remainder["async ".len()..];
        offset += "async ".len();
    }
    let (keyword, kind) = [
        ("function", SymbolKind::Function),
        ("class", SymbolKind::Class),
        ("interface", SymbolKind::Interface),
        ("type", SymbolKind::TypeAlias),
        ("const", SymbolKind::Constant),
        ("let", SymbolKind::Variable),
        ("var", SymbolKind::Variable),
    ]
    .into_iter()
    .find(|(keyword, _)| {
        remainder.starts_with(keyword)
            && remainder
                .as_bytes()
                .get(keyword.len())
                .is_some_and(u8::is_ascii_whitespace)
    })?;
    let suffix = &remainder[keyword.len()..];
    let (name_offset, name) = first_identifier(suffix)?;
    Some(ScriptDeclaration {
        kind,
        name,
        name_offset: offset + keyword.len() + name_offset,
        exported,
        default_export,
        async_symbol,
    })
}

fn mask_literals_and_comments(line: &str) -> String {
    let bytes = line.as_bytes();
    let mut output = String::with_capacity(line.len());
    let mut cursor = 0;
    let mut quote = None;
    while cursor < bytes.len() {
        let byte = bytes[cursor];
        if let Some(active) = quote {
            if byte == b'\\' {
                output.push(' ');
                cursor += 1;
                if cursor < bytes.len() {
                    output.push(' ');
                    cursor += 1;
                }
                continue;
            }
            output.push(if byte == active {
                char::from(byte)
            } else {
                ' '
            });
            if byte == active {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
            output.push(char::from(byte));
            cursor += 1;
            continue;
        }
        if byte == b'/' && bytes.get(cursor + 1) == Some(&b'/') {
            output.extend(std::iter::repeat_n(' ', bytes.len() - cursor));
            break;
        }
        output.push(char::from(byte));
        cursor += 1;
    }
    output
}

fn function_like_names(value: &str) -> Vec<(usize, &str)> {
    identifiers(value)
        .into_iter()
        .filter(|(offset, name)| {
            (*offset == 0 || value.as_bytes()[offset - 1] != b'$')
                && value.as_bytes()[offset + name.len()..]
                    .iter()
                    .copied()
                    .find(|byte| !byte.is_ascii_whitespace())
                    == Some(b'(')
        })
        .collect()
}

fn script_call_skip(name: &str) -> bool {
    matches!(
        name,
        "if" | "for"
            | "while"
            | "switch"
            | "catch"
            | "function"
            | "defineProps"
            | "defineEmits"
            | "defineExpose"
            | "defineOptions"
            | "defineModel"
            | "defineSlots"
            | "withDefaults"
            | "$props"
            | "$state"
            | "$derived"
            | "$effect"
            | "$bindable"
            | "$inspect"
            | "$host"
            | "$snippet"
    )
}

fn declaration_name_on_line(line: &str, name: &str) -> bool {
    parse_script_declaration(line).is_some_and(|declaration| declaration.name == name)
}

fn starts_uppercase_ascii(value: &str) -> bool {
    value.as_bytes().first().is_some_and(u8::is_ascii_uppercase)
}

fn extract_template_attribute_calls(
    builder: &mut CustomBuilder<'_, '_>,
    owner: SymbolId,
    tag: MarkupTag<'_>,
) -> Result<(), ExtractError> {
    for key in ["@click", "v-on:click", "on:click", "onclick", "action"] {
        let Some((offset, expression)) = tag_attribute(tag, key) else {
            continue;
        };
        let calls = function_like_names(expression);
        for (relative, name) in &calls {
            if script_call_skip(name) {
                continue;
            }
            let start = offset + relative;
            builder.add_reference(
                Some(owner.clone()),
                name,
                ReferenceKind::Calls,
                start,
                start + name.len(),
            )?;
        }
        if calls.is_empty()
            && let Some((relative, name)) = first_identifier(expression)
            && !script_call_skip(name)
        {
            let start = offset + relative;
            builder.add_reference(
                Some(owner.clone()),
                name,
                ReferenceKind::Calls,
                start,
                start + name.len(),
            )?;
        }
    }
    Ok(())
}

fn extract_template_expression_calls(
    builder: &mut CustomBuilder<'_, '_>,
    owner: SymbolId,
    excluded: &[std::ops::Range<usize>],
) -> Result<(), ExtractError> {
    let source = builder.source();
    let delimiters = if builder.snapshot.language() == SourceLanguage::Vue {
        ("{{", "}}")
    } else {
        ("{", "}")
    };
    let mut cursor = 0;
    while let Some(relative) = source[cursor..].find(delimiters.0) {
        let open = cursor + relative;
        if excluded
            .iter()
            .any(|range| range.start <= open && open < range.end)
        {
            cursor = open.saturating_add(delimiters.0.len());
            continue;
        }
        let content_start = open + delimiters.0.len();
        let Some(close_relative) = source[content_start..].find(delimiters.1) else {
            break;
        };
        let close = content_start + close_relative;
        let expression = &source[content_start..close];
        if !expression.trim_start().starts_with(['#', '/', ':', '@']) {
            if builder.snapshot.language() == SourceLanguage::Svelte {
                extract_svelte_store_references(
                    builder,
                    owner.clone(),
                    &mask_literals_and_comments(expression),
                    content_start,
                )?;
            }
            for (relative_offset, name) in function_like_names(expression) {
                if script_call_skip(name) {
                    continue;
                }
                let start = content_start + relative_offset;
                builder.add_reference(
                    Some(owner.clone()),
                    name,
                    ReferenceKind::Calls,
                    start,
                    start + name.len(),
                )?;
            }
        }
        cursor = close + delimiters.1.len();
    }
    Ok(())
}

fn extract_svelte_store_references(
    builder: &mut CustomBuilder<'_, '_>,
    owner: SymbolId,
    source: &str,
    source_offset: usize,
) -> Result<(), ExtractError> {
    let bytes = source.as_bytes();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if bytes[cursor] != b'$'
            || bytes.get(cursor + 1) == Some(&b'$')
            || !bytes
                .get(cursor + 1)
                .is_some_and(|byte| is_identifier_start(*byte))
        {
            cursor = cursor.saturating_add(1);
            continue;
        }
        let start = cursor;
        cursor = cursor.saturating_add(2);
        while cursor < bytes.len() && is_identifier_body(bytes[cursor]) {
            cursor = cursor.saturating_add(1);
        }
        let source_name = &source[start..cursor];
        if matches!(
            source_name,
            "$state"
                | "$derived"
                | "$effect"
                | "$props"
                | "$bindable"
                | "$inspect"
                | "$host"
                | "$snippet"
        ) {
            continue;
        }
        builder.add_reference_with_resolution(
            Some(owner.clone()),
            source_name,
            Some(&source_name[1..]),
            ReferenceKind::References,
            source_offset + start,
            source_offset + cursor,
        )?;
    }
    Ok(())
}

fn extract_salesforce_markup(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    if builder.source().is_empty() {
        return Ok(());
    }
    let language = builder.snapshot.language();
    let name = basename_stem(builder.path()).to_owned();
    let extension = builder
        .path()
        .rsplit('.')
        .next()
        .unwrap_or_default()
        .to_owned();
    let component_kind =
        if language == SourceLanguage::Aura && !matches!(extension.as_str(), "cmp" | "app") {
            SymbolKind::Resource
        } else {
            SymbolKind::Component
        };
    let end = builder
        .source()
        .find('\n')
        .map_or(builder.source().len(), |index| index.saturating_add(1))
        .max(1);
    let component = builder.add_symbol(
        component_kind,
        &name,
        name.clone(),
        0,
        end,
        SymbolOptions {
            body_search_text: format!("salesforce {} {name}", language.as_str()),
            exported: true,
            visibility: Some(Visibility::Public),
            ..SymbolOptions::default()
        },
    )?;
    if language == SourceLanguage::Visualforce && extension.eq_ignore_ascii_case("page") {
        let route = format!("/apex/{name}");
        builder.add_symbol(
            SymbolKind::Route,
            &route,
            route.clone(),
            0,
            end,
            SymbolOptions {
                body_search_text: format!("route {route}"),
                exported: true,
                visibility: Some(Visibility::Public),
                parent: Some(component.clone()),
                ..SymbolOptions::default()
            },
        )?;
    }
    let source = builder.source();
    for tag in markup_tags(source) {
        builder.check_cancelled()?;
        if tag.closing {
            continue;
        }
        if tag.name.eq_ignore_ascii_case("aura:attribute") {
            let Some((name_offset, field_name)) = tag_attribute(tag, "name") else {
                continue;
            };
            let field = builder.add_symbol(
                SymbolKind::Field,
                field_name,
                format!("{name}::{field_name}"),
                name_offset,
                name_offset + field_name.len(),
                SymbolOptions {
                    body_search_text: format!("field {field_name}"),
                    parent: Some(component.clone()),
                    ..SymbolOptions::default()
                },
            )?;
            if let Some((type_offset, type_name)) = tag_attribute(tag, "type") {
                let reference = type_name.trim_end_matches("[]");
                if is_qualified_name(reference) {
                    builder.add_reference(
                        Some(field),
                        reference,
                        ReferenceKind::TypeOf,
                        type_offset,
                        type_offset + reference.len(),
                    )?;
                }
            }
        }
        if tag.name.len() > 2
            && tag
                .name
                .get(..2)
                .is_some_and(|prefix| prefix.eq_ignore_ascii_case("c:"))
        {
            let raw_name = &tag.name[2..];
            let reference = salesforce_component_name(raw_name);
            builder.add_reference(
                Some(component.clone()),
                &reference,
                ReferenceKind::References,
                tag.start + 3,
                tag.start + 3 + raw_name.len(),
            )?;
        }
        for key in ["controller", "extensions"] {
            let Some((offset, value)) = tag_attribute(tag, key) else {
                continue;
            };
            for candidate in value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
            {
                if is_qualified_name(candidate) {
                    let relative = value.find(candidate).unwrap_or(0);
                    builder.add_reference(
                        Some(component.clone()),
                        candidate,
                        ReferenceKind::References,
                        offset + relative,
                        offset + relative + candidate.len(),
                    )?;
                }
            }
        }
    }
    extract_salesforce_expression_refs(builder, component, source, 0)
}

fn salesforce_component_name(raw: &str) -> String {
    raw.split(['-', '_'])
        .filter(|part| !part.is_empty())
        .map(|part| {
            let mut chars = part.chars();
            chars.next().map_or_else(String::new, |first| {
                first.to_uppercase().chain(chars).collect()
            })
        })
        .collect()
}

fn extract_salesforce_expression_refs(
    builder: &mut CustomBuilder<'_, '_>,
    owner: SymbolId,
    source: &str,
    base: usize,
) -> Result<(), ExtractError> {
    let mut cursor = 0;
    while let Some(relative) = source[cursor..].find("{!") {
        let open = cursor + relative;
        let Some(close_relative) = source[open + 2..].find('}') else {
            break;
        };
        let close = open + 2 + close_relative;
        let expression = source[open + 2..close].trim();
        let expression_leading =
            source[open + 2..close].len() - source[open + 2..close].trim_start().len();
        let candidate = expression
            .strip_prefix("c.")
            .or_else(|| expression.strip_prefix("controller."))
            .unwrap_or(expression);
        if let Some((relative_name, name)) = first_identifier(candidate) {
            let candidate_start = expression.find(candidate).unwrap_or(0);
            let start = base + open + 2 + expression_leading + candidate_start + relative_name;
            builder.add_reference(
                Some(owner.clone()),
                name,
                ReferenceKind::Calls,
                start,
                start + name.len(),
            )?;
        }
        cursor = close + 1;
    }
    Ok(())
}

#[derive(Clone)]
struct VbScope {
    id: SymbolId,
    qualified_name: String,
    block: VbBlock,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum VbBlock {
    Container,
    Routine,
    Struct,
    Enum,
}

fn extract_vb6(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    if builder.source().is_empty() {
        return Ok(());
    }
    if builder.path().to_ascii_lowercase().ends_with(".vbp") {
        return extract_vb6_project(builder);
    }
    let source = builder.source();
    let (container_name, container_offset) =
        vb6_container_name(source).unwrap_or_else(|| (basename_stem(builder.path()).to_owned(), 0));
    let extension = builder.path().rsplit('.').next().unwrap_or_default();
    let container_kind = if matches!(extension, "frm" | "ctl" | "dob" | "dsr" | "pag") {
        SymbolKind::Component
    } else if extension.eq_ignore_ascii_case("cls") {
        SymbolKind::Class
    } else {
        SymbolKind::Module
    };
    let container_end = (container_offset + container_name.len())
        .min(source.len())
        .max(1);
    let container = builder.add_symbol(
        container_kind,
        &container_name,
        container_name.clone(),
        container_offset.min(container_end - 1),
        container_end,
        SymbolOptions {
            body_search_text: format!("{} {container_name}", container_kind.as_str()),
            exported: true,
            visibility: Some(Visibility::Public),
            ..SymbolOptions::default()
        },
    )?;
    let mut scopes = vec![VbScope {
        id: container,
        qualified_name: container_name,
        block: VbBlock::Container,
    }];
    for (line_start, raw_line) in line_ranges(source) {
        builder.check_cancelled()?;
        let line = vb6_strip_comment(raw_line).trim();
        if line.is_empty()
            || line.to_ascii_lowercase().starts_with("attribute vb_")
            || line.to_ascii_lowercase().starts_with("version ")
        {
            continue;
        }
        if let Some(block) = vb6_end_block(line) {
            while scopes.len() > 1 {
                if scopes.pop().is_some_and(|scope| scope.block == block) {
                    break;
                }
            }
            continue;
        }
        if let Some(declaration) =
            vb6_declaration(line, scopes.last().map(|scope| scope.block), container_kind)
        {
            let offset = raw_line.find(declaration.name).unwrap_or(0);
            let start = line_start + offset;
            let parent = scopes.last().cloned();
            let qualified = parent.as_ref().map_or_else(
                || declaration.name.to_owned(),
                |scope| format!("{}::{}", scope.qualified_name, declaration.name),
            );
            let id = builder.add_symbol(
                declaration.kind,
                declaration.name,
                qualified.clone(),
                start,
                start + declaration.name.len(),
                SymbolOptions {
                    body_search_text: format!("{} {}", declaration.kind.as_str(), declaration.name),
                    exported: declaration.visibility == Some(Visibility::Public),
                    visibility: declaration.visibility,
                    static_member: declaration.static_member,
                    parent: parent.map(|scope| scope.id),
                    ..SymbolOptions::default()
                },
            )?;
            if let Some(block) = declaration.block {
                scopes.push(VbScope {
                    id,
                    qualified_name: qualified,
                    block,
                });
            }
            continue;
        }
        let Some(routine) = scopes
            .iter()
            .rev()
            .find(|scope| scope.block == VbBlock::Routine)
            .cloned()
        else {
            continue;
        };
        if let Some((offset, name)) = vb6_call(line) {
            let raw_offset = raw_line.find(line).unwrap_or(0) + offset;
            builder.add_reference(
                Some(routine.id),
                name,
                ReferenceKind::Calls,
                line_start + raw_offset,
                line_start + raw_offset + name.len(),
            )?;
        }
    }
    Ok(())
}

fn extract_vb6_project(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    for (line_start, raw_line) in line_ranges(source) {
        let line = raw_line.trim();
        let Some(separator) = line.find('=') else {
            continue;
        };
        let key = line[..separator].trim().to_ascii_lowercase();
        if !matches!(
            key.as_str(),
            "module" | "class" | "form" | "usercontrol" | "userdocument" | "designer"
        ) {
            continue;
        }
        let value = line[separator + 1..].trim();
        let name = value
            .split(';')
            .next_back()
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .unwrap_or(value);
        if name.is_empty() {
            continue;
        }
        let offset = raw_line.find(name).unwrap_or(0);
        let id = builder.add_symbol(
            SymbolKind::Import,
            name,
            format!("{}::{name}", builder.path()),
            line_start + offset,
            line_start + offset + name.len(),
            SymbolOptions {
                body_search_text: format!("import {name}"),
                ..SymbolOptions::default()
            },
        )?;
        builder.add_import(
            Some(id),
            value,
            name,
            name,
            line_start + offset,
            line_start + offset + name.len(),
        )?;
    }
    Ok(())
}

fn vb6_container_name(source: &str) -> Option<(String, usize)> {
    for (line_start, line) in line_ranges(source) {
        let trimmed = line.trim();
        if trimmed
            .to_ascii_lowercase()
            .starts_with("attribute vb_name")
        {
            let (_, name) = quoted_values(trimmed).into_iter().next()?;
            return Some((name.to_owned(), line_start + line.find(name)?));
        }
        let words = identifiers(trimmed);
        if words.len() >= 3
            && words[0].1.eq_ignore_ascii_case("begin")
            && words[1].1.eq_ignore_ascii_case("vb")
        {
            let name = words.last()?.1;
            return Some((name.to_owned(), line_start + line.find(name)?));
        }
    }
    None
}

struct VbDeclaration<'source> {
    kind: SymbolKind,
    name: &'source str,
    block: Option<VbBlock>,
    visibility: Option<Visibility>,
    static_member: bool,
}

fn vb6_declaration(
    line: &str,
    parent: Option<VbBlock>,
    container_kind: SymbolKind,
) -> Option<VbDeclaration<'_>> {
    let tokens = identifiers(line);
    let mut index = 0;
    let visibility = tokens
        .get(index)
        .and_then(|(_, token)| vb6_visibility(token));
    if visibility.is_some() {
        index += 1;
    }
    let static_member = tokens
        .get(index)
        .is_some_and(|(_, token)| token.eq_ignore_ascii_case("static"));
    if static_member {
        index += 1;
    }
    let keyword = tokens.get(index)?.1;
    let lower = keyword.to_ascii_lowercase();
    match lower.as_str() {
        "sub" | "function" => Some(VbDeclaration {
            kind: if container_kind == SymbolKind::Module {
                SymbolKind::Function
            } else {
                SymbolKind::Method
            },
            name: tokens.get(index + 1)?.1,
            block: Some(VbBlock::Routine),
            visibility,
            static_member,
        }),
        "property" => Some(VbDeclaration {
            kind: SymbolKind::Property,
            name: tokens.get(index + 2)?.1,
            block: Some(VbBlock::Routine),
            visibility,
            static_member,
        }),
        "type" => Some(VbDeclaration {
            kind: SymbolKind::Struct,
            name: tokens.get(index + 1)?.1,
            block: Some(VbBlock::Struct),
            visibility,
            static_member,
        }),
        "enum" => Some(VbDeclaration {
            kind: SymbolKind::Enum,
            name: tokens.get(index + 1)?.1,
            block: Some(VbBlock::Enum),
            visibility,
            static_member,
        }),
        "const" => Some(VbDeclaration {
            kind: SymbolKind::Constant,
            name: tokens.get(index + 1)?.1,
            block: None,
            visibility,
            static_member,
        }),
        "dim" | "public" | "private" | "friend" => Some(VbDeclaration {
            kind: if parent == Some(VbBlock::Routine) {
                SymbolKind::Variable
            } else {
                SymbolKind::Field
            },
            name: tokens.get(index + 1)?.1,
            block: None,
            visibility,
            static_member,
        }),
        _ if visibility.is_some() => Some(VbDeclaration {
            kind: if parent == Some(VbBlock::Routine) {
                SymbolKind::Variable
            } else {
                SymbolKind::Field
            },
            name: tokens.get(index)?.1,
            block: None,
            visibility,
            static_member,
        }),
        _ if parent == Some(VbBlock::Enum) => Some(VbDeclaration {
            kind: SymbolKind::EnumMember,
            name: tokens.get(index)?.1,
            block: None,
            visibility: None,
            static_member: false,
        }),
        _ if parent == Some(VbBlock::Struct) => Some(VbDeclaration {
            kind: SymbolKind::Field,
            name: tokens.get(index)?.1,
            block: None,
            visibility: None,
            static_member: false,
        }),
        _ => None,
    }
}

fn vb6_visibility(value: &str) -> Option<Visibility> {
    if value.eq_ignore_ascii_case("private") {
        Some(Visibility::Private)
    } else if value.eq_ignore_ascii_case("friend") {
        Some(Visibility::Internal)
    } else if value.eq_ignore_ascii_case("public") || value.eq_ignore_ascii_case("global") {
        Some(Visibility::Public)
    } else {
        None
    }
}

fn vb6_end_block(line: &str) -> Option<VbBlock> {
    let words = identifiers(line);
    if words.first()?.1.eq_ignore_ascii_case("end") {
        let keyword = words.get(1)?.1;
        if keyword.eq_ignore_ascii_case("type") {
            Some(VbBlock::Struct)
        } else if keyword.eq_ignore_ascii_case("enum") {
            Some(VbBlock::Enum)
        } else if matches!(
            keyword.to_ascii_lowercase().as_str(),
            "sub" | "function" | "property"
        ) {
            Some(VbBlock::Routine)
        } else {
            None
        }
    } else {
        None
    }
}

fn vb6_call(line: &str) -> Option<(usize, &str)> {
    let line = line.trim_start();
    let (offset, name) = if let Some(call) = word_after(line, "Call") {
        call
    } else {
        function_like_names(line).into_iter().next()?
    };
    (!matches!(
        name.to_ascii_lowercase().as_str(),
        "if" | "for" | "while" | "debug" | "print" | "open" | "close" | "redim"
    ))
    .then_some((offset, name))
}

fn vb6_strip_comment(line: &str) -> &str {
    line.find('\'').map_or(line, |comment| &line[..comment])
}

fn extract_xml(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    let tags = markup_tags(source);
    if let Some((_, mapper)) = tags
        .iter()
        .copied()
        .enumerate()
        .find(|(_, tag)| !tag.closing && tag_name_eq(*tag, "mapper"))
        && let Some((namespace_offset, namespace)) = tag_attribute(mapper, "namespace")
    {
        return extract_mybatis_mapper(builder, &tags, namespace, namespace_offset);
    }
    if tags
        .iter()
        .any(|tag| !tag.closing && tag_name_eq(*tag, "configuration"))
        && tags
            .iter()
            .any(|tag| !tag.closing && tag_name_eq(*tag, "mappers"))
    {
        return extract_mybatis_config(builder, &tags);
    }
    Ok(())
}

fn extract_mybatis_mapper(
    builder: &mut CustomBuilder<'_, '_>,
    tags: &[MarkupTag<'_>],
    namespace: &str,
    namespace_offset: usize,
) -> Result<(), ExtractError> {
    let simple_namespace = namespace.rsplit('.').next().unwrap_or(namespace);
    let module = builder.add_symbol(
        SymbolKind::Namespace,
        simple_namespace,
        namespace.to_owned(),
        namespace_offset,
        namespace_offset + namespace.len(),
        SymbolOptions {
            body_search_text: format!("mybatis mapper {simple_namespace}"),
            exported: true,
            visibility: Some(Visibility::Public),
            ..SymbolOptions::default()
        },
    )?;
    for (index, tag) in tags.iter().copied().enumerate() {
        builder.check_cancelled()?;
        if tag.closing {
            continue;
        }
        let is_statement =
            matches_ignore_ascii_case(tag.name, &["select", "insert", "update", "delete", "sql"]);
        let is_mapping = matches_ignore_ascii_case(tag.name, &["resultMap", "parameterMap"]);
        if !is_statement && !is_mapping {
            continue;
        }
        let Some((id_offset, id)) = tag_attribute(tag, "id") else {
            continue;
        };
        if !is_qualified_name(id) {
            continue;
        }
        let qualified = format!("{simple_namespace}::{id}");
        let owner = builder.add_symbol(
            if is_statement {
                SymbolKind::Method
            } else {
                SymbolKind::TypeAlias
            },
            id,
            qualified.clone(),
            id_offset,
            id_offset + id.len(),
            SymbolOptions {
                body_search_text: format!("mybatis {} {id}", tag.name),
                exported: is_statement,
                visibility: is_statement.then_some(Visibility::Public),
                parent: Some(module.clone()),
                ..SymbolOptions::default()
            },
        )?;
        if is_mapping && let Some((offset, target)) = tag_attribute(tag, "type") {
            builder.add_reference(
                Some(owner.clone()),
                target.rsplit('.').next().unwrap_or(target),
                ReferenceKind::TypeOf,
                offset,
                offset + target.len(),
            )?;
        }
        for key in ["resultMap", "parameterMap", "extends"] {
            if let Some((offset, value)) = tag_attribute(tag, key) {
                let reference = mybatis_qualified_reference(simple_namespace, value);
                builder.add_reference(
                    Some(owner.clone()),
                    &reference,
                    ReferenceKind::References,
                    offset,
                    offset + value.len(),
                )?;
            }
        }
        if let Some((_, body_end)) = find_matching_close(tags, index) {
            let body_start = tag.end;
            if body_start < body_end {
                extract_mybatis_body_refs(
                    builder,
                    owner,
                    simple_namespace,
                    id,
                    body_start,
                    body_end,
                )?;
            }
        }
    }
    Ok(())
}

fn extract_mybatis_body_refs(
    builder: &mut CustomBuilder<'_, '_>,
    owner: SymbolId,
    namespace: &str,
    statement: &str,
    start: usize,
    end: usize,
) -> Result<(), ExtractError> {
    let body = &builder.source()[start..end];
    for tag in markup_tags(body) {
        if tag.closing || !tag_name_eq(tag, "include") {
            continue;
        }
        if let Some((offset, refid)) = tag_attribute(tag, "refid") {
            let reference = mybatis_qualified_reference(namespace, refid);
            builder.add_reference(
                Some(owner.clone()),
                &reference,
                ReferenceKind::References,
                start + offset,
                start + offset + refid.len(),
            )?;
        }
    }
    let mut cursor = 0;
    let mut seen = BTreeSet::new();
    while let Some(relative) = body[cursor..].find("#{") {
        let open = cursor + relative;
        let content_start = open + 2;
        let Some(close_relative) = body[content_start..].find('}') else {
            break;
        };
        let close = content_start + close_relative;
        let raw = body[content_start..close]
            .split(',')
            .next()
            .unwrap_or_default();
        let parameter = raw.split('.').next().unwrap_or_default().trim();
        if is_qualified_name(parameter) && seen.insert(parameter.to_owned()) {
            let leading = raw.len() - raw.trim_start().len();
            let parameter_start = start + content_start + leading;
            builder.add_reference(
                Some(owner.clone()),
                &format!("{namespace}::{statement}::{parameter}"),
                ReferenceKind::References,
                parameter_start,
                parameter_start + parameter.len(),
            )?;
        }
        cursor = close + 1;
    }
    Ok(())
}

fn mybatis_qualified_reference(namespace: &str, raw: &str) -> String {
    let mut parts = raw.rsplitn(2, '.');
    let tail = parts.next().unwrap_or(raw);
    let owner = parts
        .next()
        .and_then(|prefix| prefix.rsplit('.').next())
        .unwrap_or(namespace);
    format!("{owner}::{tail}")
}

fn extract_mybatis_config(
    builder: &mut CustomBuilder<'_, '_>,
    tags: &[MarkupTag<'_>],
) -> Result<(), ExtractError> {
    for tag in tags.iter().copied() {
        builder.check_cancelled()?;
        if tag.closing {
            continue;
        }
        if tag_name_eq(tag, "mapper") {
            if let Some((offset, class)) = tag_attribute(tag, "class") {
                let name = class.rsplit('.').next().unwrap_or(class);
                builder.add_reference(
                    None,
                    name,
                    ReferenceKind::References,
                    offset,
                    offset + class.len(),
                )?;
            }
        } else if tag_name_eq(tag, "typeAlias")
            && let Some((offset, alias)) = tag_attribute(tag, "alias")
        {
            builder.add_symbol(
                SymbolKind::TypeAlias,
                alias,
                format!("{}::{alias}", builder.path()),
                offset,
                offset + alias.len(),
                SymbolOptions {
                    body_search_text: format!("mybatis type alias {alias}"),
                    exported: true,
                    visibility: Some(Visibility::Public),
                    ..SymbolOptions::default()
                },
            )?;
            if let Some((type_offset, target)) = tag_attribute(tag, "type") {
                builder.add_reference(
                    None,
                    target.rsplit('.').next().unwrap_or(target),
                    ReferenceKind::TypeOf,
                    type_offset,
                    type_offset + target.len(),
                )?;
            }
        }
    }
    Ok(())
}

fn matches_ignore_ascii_case(value: &str, candidates: &[&str]) -> bool {
    candidates
        .iter()
        .any(|candidate| value.eq_ignore_ascii_case(candidate))
}

fn extract_anubis(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    let mut root: Option<(SymbolId, String)> = None;
    let mut behavior: Option<(SymbolId, String)> = None;
    for (line_start, raw_line) in line_ranges(source) {
        builder.check_cancelled()?;
        let line = strip_line_comment(raw_line, "--").trim();
        if line.is_empty() {
            continue;
        }
        if let Some((name_offset, name, kind)) = anubis_root(line) {
            let raw_offset = raw_line.find(line).unwrap_or(0) + name_offset;
            let qualified = if kind == SymbolKind::Module {
                format!("game.states.{name}")
            } else {
                format!("game.configs.{name}")
            };
            let id = builder.add_symbol(
                kind,
                name,
                qualified.clone(),
                line_start + raw_offset,
                line_start + raw_offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("anubis {} {name}", kind.as_str()),
                    exported: true,
                    visibility: Some(Visibility::Public),
                    ..SymbolOptions::default()
                },
            )?;
            root = Some((id, qualified));
            behavior = None;
        } else if let Some((name_offset, name, shape)) = anubis_behavior(line) {
            let raw_offset = raw_line.find(line).unwrap_or(0) + name_offset;
            let parent = root.as_ref().map(|(id, _)| id.clone());
            let prefix = root
                .as_ref()
                .map_or_else(|| builder.path().to_owned(), |(_, name)| name.clone());
            let id = builder.add_symbol(
                SymbolKind::Method,
                name,
                format!("{prefix}::{name}"),
                line_start + raw_offset,
                line_start + raw_offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("anubis {shape} {name}"),
                    parent,
                    ..SymbolOptions::default()
                },
            )?;
            behavior = Some((id, name.to_owned()));
        } else if let Some((name_offset, name, label)) = anubis_handler(line) {
            let raw_offset = raw_line.find(line).unwrap_or(0) + name_offset;
            let parent = if label == "event" {
                root.as_ref().map(|(id, _)| id.clone())
            } else {
                behavior
                    .as_ref()
                    .map(|(id, _)| id.clone())
                    .or_else(|| root.as_ref().map(|(id, _)| id.clone()))
            };
            let prefix = root
                .as_ref()
                .map_or_else(|| builder.path().to_owned(), |(_, name)| name.clone());
            let display = format!("{label}:{name}");
            builder.add_symbol(
                SymbolKind::Method,
                &display,
                format!("{prefix}::{display}"),
                line_start + raw_offset,
                line_start + raw_offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("anubis {label} {name}"),
                    parent,
                    ..SymbolOptions::default()
                },
            )?;
        }
        let owner = behavior
            .as_ref()
            .map(|(id, _)| id.clone())
            .or_else(|| root.as_ref().map(|(id, _)| id.clone()));
        for (offset, call) in function_like_names(line) {
            if anubis_call_skip(call) {
                continue;
            }
            let raw_offset = raw_line.find(line).unwrap_or(0) + offset;
            builder.add_reference(
                owner.clone(),
                call,
                ReferenceKind::Calls,
                line_start + raw_offset,
                line_start + raw_offset + call.len(),
            )?;
        }
        for (offset, reference) in dotted_references(line) {
            let raw_offset = raw_line.find(line).unwrap_or(0) + offset;
            builder.add_reference(
                owner.clone(),
                reference,
                ReferenceKind::References,
                line_start + raw_offset,
                line_start + raw_offset + reference.len(),
            )?;
        }
    }
    Ok(())
}

fn anubis_root(line: &str) -> Option<(usize, &str, SymbolKind)> {
    for (prefix, kind) in [
        ("game.states.", SymbolKind::Module),
        ("game.configs.", SymbolKind::Resource),
    ] {
        let Some(prefix_start) = line.find(prefix) else {
            continue;
        };
        let start = prefix_start + prefix.len();
        let Some((_, name)) = first_identifier(&line[start..]) else {
            continue;
        };
        let after = &line[start + name.len()..];
        if after.contains("State") || after.contains("Config") {
            return Some((start, name, kind));
        }
    }
    None
}

fn anubis_behavior(line: &str) -> Option<(usize, &str, &str)> {
    let nodes = line.find("nodes")?;
    let after_nodes = &line[nodes + "nodes".len()..];
    let name = after_nodes
        .strip_prefix('.')
        .and_then(first_identifier)
        .map_or("nodes", |(_, name)| name);
    let name_start = if name == "nodes" {
        nodes
    } else {
        line[nodes..].find(name)? + nodes
    };
    let shape = ["Action", "Selector", "Proxy"]
        .into_iter()
        .find(|shape| line.contains(shape))?;
    Some((name_start, name, shape))
}

fn anubis_handler(line: &str) -> Option<(usize, &str, &str)> {
    if let Some(events) = line.find("events.") {
        let start = events + "events.".len();
        let (_, name) = first_identifier(&line[start..])?;
        return line.contains("function").then_some((start, name, "event"));
    }
    for callback in [
        "CanEnter",
        "Valid",
        "OnFinished",
        "OnLeave",
        "OnEnter",
        "OnUpdate",
        "OnFailed",
    ] {
        if let Some(start) = line.find(callback)
            && line[start + callback.len()..].contains("function")
        {
            return Some((start, callback, "callback"));
        }
    }
    None
}

fn anubis_call_skip(name: &str) -> bool {
    matches!(
        name,
        "if" | "function"
            | "State"
            | "Config"
            | "Action"
            | "Selector"
            | "Proxy"
            | "CanEnter"
            | "Valid"
            | "OnFinished"
            | "OnLeave"
            | "OnEnter"
            | "OnUpdate"
            | "OnFailed"
    )
}

fn dotted_references(line: &str) -> Vec<(usize, &str)> {
    let bytes = line.as_bytes();
    let mut output = Vec::new();
    let mut cursor = 0;
    while cursor < bytes.len() {
        if !is_identifier_start(bytes[cursor]) {
            cursor += 1;
            continue;
        }
        let start = cursor;
        cursor += 1;
        let mut dots = 0;
        while cursor < bytes.len()
            && (is_identifier_body(bytes[cursor]) || matches!(bytes[cursor], b'.' | b':' | b'-'))
        {
            if bytes[cursor] == b'.' {
                dots += 1;
            }
            cursor += 1;
        }
        if dots > 0 {
            output.push((start, &line[start..cursor]));
        }
    }
    output
}

fn extract_bg3_stats(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    let mut current = None;
    for (line_start, line) in line_ranges(source) {
        builder.check_cancelled()?;
        let words = identifiers(line);
        if words
            .first()
            .is_some_and(|(_, word)| word.eq_ignore_ascii_case("new"))
            && words.get(1).is_some_and(|(_, shape)| {
                matches!(
                    shape.to_ascii_lowercase().as_str(),
                    "entry" | "spellset" | "equipment" | "treasuretable"
                )
            })
            && let Some((offset, name)) = quoted_values(line).into_iter().next()
        {
            let shape = words[1].1;
            let id = builder.add_symbol(
                SymbolKind::Resource,
                name,
                format!("{}::{name}", builder.path()),
                line_start + offset,
                line_start + offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("bg3 {shape} {name}"),
                    exported: true,
                    visibility: Some(Visibility::Public),
                    ..SymbolOptions::default()
                },
            )?;
            current = Some(id);
            continue;
        }
        let Some(owner) = current.clone() else {
            continue;
        };
        let command = words.first().map(|(_, word)| word.to_ascii_lowercase());
        if matches!(command.as_deref(), Some("using" | "add"))
            && let Some((offset, value)) = quoted_values(line).into_iter().next()
            && is_qualified_name(value)
        {
            builder.add_reference(
                Some(owner),
                value,
                if command.as_deref() == Some("using") {
                    ReferenceKind::Extends
                } else {
                    ReferenceKind::References
                },
                line_start + offset,
                line_start + offset + value.len(),
            )?;
        } else if command.as_deref() == Some("data") {
            let values = quoted_values(line);
            if let Some((offset, value)) = values.get(1).copied() {
                for token in bg3_reference_tokens(value) {
                    let relative = value.find(token).unwrap_or(0);
                    builder.add_reference(
                        Some(owner.clone()),
                        token,
                        ReferenceKind::References,
                        line_start + offset + relative,
                        line_start + offset + relative + token.len(),
                    )?;
                }
            }
        }
    }
    Ok(())
}

fn bg3_reference_tokens(value: &str) -> Vec<&str> {
    value
        .split(|character: char| {
            !(character.is_ascii_alphanumeric()
                || matches!(character, '_' | '-' | '.' | ':' | '/' | '#'))
        })
        .filter(|token| {
            token.len() >= 3
                && is_qualified_name(token)
                && (token.contains(['_', '-', '.', ':', '/'])
                    || token.bytes().any(|byte| byte.is_ascii_digit()))
        })
        .collect()
}

fn extract_osiris(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    if builder.source().is_empty() {
        return Ok(());
    }
    let goal_name = basename_stem(builder.path()).to_owned();
    let goal = builder.add_symbol(
        SymbolKind::Module,
        &goal_name,
        goal_name.clone(),
        0,
        builder.source().len().min(goal_name.len().max(1)),
        SymbolOptions {
            body_search_text: format!("osiris goal {goal_name}"),
            exported: true,
            visibility: Some(Visibility::Public),
            ..SymbolOptions::default()
        },
    )?;
    let source = builder.source();
    let mut section: Option<(SymbolId, String)> = None;
    let mut current_rule: Option<SymbolId> = None;
    let mut pending_rule: Option<(&str, usize)> = None;
    let mut db_nodes = BTreeMap::<String, SymbolId>::new();
    for (line_start, raw_line) in line_ranges(source) {
        builder.check_cancelled()?;
        let line = strip_line_comment(raw_line, "//").trim();
        if line.is_empty() {
            continue;
        }
        if let Some(name) = osiris_section(line) {
            let offset = raw_line.find(name).unwrap_or(0);
            let id = builder.add_symbol(
                SymbolKind::Namespace,
                name,
                format!("{goal_name}::{name}"),
                line_start + offset,
                line_start + offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("osiris section {name}"),
                    parent: Some(goal.clone()),
                    ..SymbolOptions::default()
                },
            )?;
            section = Some((id, name.to_owned()));
            current_rule = None;
            pending_rule = None;
            continue;
        }
        if let Some(control) = ["IF", "PROC", "QRY"].into_iter().find(|control| {
            word_after(line, control).is_some() || line.eq_ignore_ascii_case(control)
        }) {
            pending_rule = Some((control, line_start));
            current_rule = None;
            continue;
        }
        if extract_osiris_declaration(builder, goal.clone(), line, raw_line, line_start)? {
            continue;
        }
        for (relative, predicate) in function_like_names(line) {
            if matches_ignore_ascii_case(predicate, &["IF", "AND", "NOT"]) {
                continue;
            }
            let raw_offset = raw_line.find(line).unwrap_or(0) + relative;
            if current_rule.is_none()
                && let Some((control, declaration_start)) = pending_rule.take()
            {
                let label = if control == "QRY" {
                    "query"
                } else if control == "PROC" {
                    "proc"
                } else {
                    "rule"
                };
                let owner = section
                    .as_ref()
                    .map(|(id, _)| id.clone())
                    .unwrap_or_else(|| goal.clone());
                current_rule = Some(builder.add_symbol(
                    SymbolKind::Method,
                    &format!("{label}:{predicate}"),
                    format!("{goal_name}::{label}:{}", declaration_start),
                    line_start + raw_offset,
                    line_start + raw_offset + predicate.len(),
                    SymbolOptions {
                        body_search_text: format!("osiris {label} {predicate}"),
                        parent: Some(owner),
                        ..SymbolOptions::default()
                    },
                )?);
                if control != "IF" {
                    continue;
                }
            }
            let owner = current_rule.clone().unwrap_or_else(|| goal.clone());
            if predicate.starts_with("DB_") {
                if !db_nodes.contains_key(predicate) {
                    let parent = section
                        .as_ref()
                        .map(|(id, _)| id.clone())
                        .unwrap_or_else(|| goal.clone());
                    let id = builder.add_symbol(
                        SymbolKind::Table,
                        predicate,
                        predicate.to_owned(),
                        line_start + raw_offset,
                        line_start + raw_offset + predicate.len(),
                        SymbolOptions {
                            body_search_text: format!("osiris db {predicate}"),
                            parent: Some(parent),
                            ..SymbolOptions::default()
                        },
                    )?;
                    db_nodes.insert(predicate.to_owned(), id);
                }
                builder.add_reference(
                    Some(owner),
                    predicate,
                    ReferenceKind::References,
                    line_start + raw_offset,
                    line_start + raw_offset + predicate.len(),
                )?;
            } else {
                builder.add_reference(
                    Some(owner),
                    predicate,
                    ReferenceKind::Calls,
                    line_start + raw_offset,
                    line_start + raw_offset + predicate.len(),
                )?;
            }
        }
        let string_owner = current_rule.clone().unwrap_or_else(|| goal.clone());
        for (offset, value) in quoted_values(line) {
            for token in bg3_reference_tokens(value) {
                let relative = value.find(token).unwrap_or(0);
                let raw_offset = raw_line.find(line).unwrap_or(0) + offset + relative;
                builder.add_reference(
                    Some(string_owner.clone()),
                    token,
                    ReferenceKind::References,
                    line_start + raw_offset,
                    line_start + raw_offset + token.len(),
                )?;
            }
        }
    }
    Ok(())
}

fn osiris_section(line: &str) -> Option<&str> {
    let normalized = line.trim_end_matches(':').trim();
    [
        "INIT",
        "INITSECTION",
        "KB",
        "KBSECTION",
        "EXIT",
        "EXITSECTION",
    ]
    .into_iter()
    .find(|candidate| normalized.eq_ignore_ascii_case(candidate))
    .map(|section| {
        if section.starts_with("INIT") {
            "INIT"
        } else if section.starts_with("KB") {
            "KB"
        } else {
            "EXIT"
        }
    })
}

fn extract_osiris_declaration(
    builder: &mut CustomBuilder<'_, '_>,
    goal: SymbolId,
    line: &str,
    raw_line: &str,
    line_start: usize,
) -> Result<bool, ExtractError> {
    if let Some(payload) = brace_payload(line, "alias_type") {
        if let Some((relative, name)) = first_identifier(payload) {
            let offset = raw_line.find(payload).unwrap_or(0) + relative;
            builder.add_symbol(
                SymbolKind::TypeAlias,
                name,
                name.to_owned(),
                line_start + offset,
                line_start + offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("osiris alias {name}"),
                    parent: Some(goal),
                    ..SymbolOptions::default()
                },
            )?;
        }
        return Ok(true);
    }
    if let Some(payload) = brace_payload(line, "enum_type") {
        let mut fields = payload.split(',').map(str::trim);
        if let Some(name) = fields.next().filter(|name| is_qualified_name(name)) {
            let offset = raw_line.find(name).unwrap_or(0);
            let enum_id = builder.add_symbol(
                SymbolKind::Enum,
                name,
                name.to_owned(),
                line_start + offset,
                line_start + offset + name.len(),
                SymbolOptions {
                    body_search_text: format!("osiris enum {name}"),
                    parent: Some(goal),
                    ..SymbolOptions::default()
                },
            )?;
            for member in fields.skip(2) {
                let member_name = member.split('=').next().unwrap_or_default().trim();
                if !is_qualified_name(member_name) {
                    continue;
                }
                let member_offset = raw_line.find(member_name).unwrap_or(offset);
                builder.add_symbol(
                    SymbolKind::EnumMember,
                    member_name,
                    format!("{name}.{member_name}"),
                    line_start + member_offset,
                    line_start + member_offset + member_name.len(),
                    SymbolOptions {
                        body_search_text: format!("enum member {member_name}"),
                        parent: Some(enum_id.clone()),
                        ..SymbolOptions::default()
                    },
                )?;
            }
        }
        return Ok(true);
    }
    let Some((_, command)) = first_identifier(line) else {
        return Ok(false);
    };
    if !matches_ignore_ascii_case(command, &["syscall", "sysquery", "call", "query", "event"]) {
        return Ok(false);
    }
    let Some((offset, name)) = word_after(line, command) else {
        return Ok(false);
    };
    let raw_offset = raw_line.find(line).unwrap_or(0) + offset;
    builder.add_symbol(
        SymbolKind::Function,
        name,
        name.to_owned(),
        line_start + raw_offset,
        line_start + raw_offset + name.len(),
        SymbolOptions {
            body_search_text: format!("osiris api {name}"),
            exported: true,
            visibility: Some(Visibility::Public),
            parent: Some(goal),
            ..SymbolOptions::default()
        },
    )?;
    Ok(true)
}

fn brace_payload<'source>(line: &'source str, command: &str) -> Option<&'source str> {
    let (_, found) = first_identifier(line)?;
    if !found.eq_ignore_ascii_case(command) {
        return None;
    }
    let open = line.find('{')?;
    let close = line.rfind('}')?;
    (close > open).then_some(&line[open + 1..close])
}

fn strip_line_comment<'source>(line: &'source str, marker: &str) -> &'source str {
    line.find(marker).map_or(line, |index| &line[..index])
}

fn extract_bg3_resource(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let trimmed = builder.source().trim_start();
    if (trimmed.starts_with('{') || trimmed.starts_with('['))
        && let Ok(value) = serde_json::from_str::<Value>(builder.source())
    {
        return extract_bg3_json(builder, &value, None);
    }
    extract_bg3_markup(builder)
}

fn extract_bg3_json(
    builder: &mut CustomBuilder<'_, '_>,
    value: &Value,
    parent: Option<SymbolId>,
) -> Result<(), ExtractError> {
    builder.check_cancelled()?;
    match value {
        Value::Array(items) => {
            for item in items {
                extract_bg3_json(builder, item, parent.clone())?;
            }
        }
        Value::Object(fields) => {
            let name = ["NameFS", "Name", "name", "UUID", "Guid", "id"]
                .into_iter()
                .find_map(|key| fields.get(key).and_then(Value::as_str))
                .filter(|name| !name.is_empty() && !looks_sensitive(name));
            let mut next_parent = parent.clone();
            if let Some(name) = name {
                let offset = builder.source().find(name).unwrap_or(0);
                if offset < builder.source().len() {
                    let id = builder.add_symbol(
                        SymbolKind::Resource,
                        name,
                        name.to_owned(),
                        offset,
                        (offset + name.len()).min(builder.source().len()),
                        SymbolOptions {
                            body_search_text: format!("bg3 resource {name}"),
                            exported: parent.is_none(),
                            visibility: parent.is_none().then_some(Visibility::Public),
                            parent: parent.clone(),
                            ..SymbolOptions::default()
                        },
                    )?;
                    next_parent = Some(id);
                }
            }
            for (key, child) in fields {
                if let Some(raw) = child.as_str()
                    && !matches!(
                        key.as_str(),
                        "NameFS" | "Name" | "name" | "UUID" | "Guid" | "id"
                    )
                {
                    let base = builder.source().find(raw).unwrap_or(0);
                    for token in bg3_reference_tokens(raw) {
                        let relative = raw.find(token).unwrap_or(0);
                        if base + relative + token.len() <= builder.source().len() {
                            builder.add_reference(
                                next_parent.clone(),
                                token,
                                ReferenceKind::References,
                                base + relative,
                                base + relative + token.len(),
                            )?;
                        }
                    }
                    continue;
                }
                extract_bg3_json(builder, child, next_parent.clone())?;
            }
        }
        Value::String(raw) => {
            let base = builder.source().find(raw).unwrap_or(0);
            for token in bg3_reference_tokens(raw) {
                let relative = raw.find(token).unwrap_or(0);
                if base + relative + token.len() <= builder.source().len() {
                    builder.add_reference(
                        parent.clone(),
                        token,
                        ReferenceKind::References,
                        base + relative,
                        base + relative + token.len(),
                    )?;
                }
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) => {}
    }
    Ok(())
}

fn extract_bg3_markup(builder: &mut CustomBuilder<'_, '_>) -> Result<(), ExtractError> {
    let source = builder.source();
    let tags = markup_tags(source);
    let mut regions = vec![(None, builder.path().to_owned())];
    for (index, tag) in tags.iter().copied().enumerate() {
        builder.check_cancelled()?;
        if tag_name_eq(tag, "region") {
            if tag.closing {
                if regions.len() > 1 {
                    regions.pop();
                }
            } else if let Some((offset, name)) = tag_attribute(tag, "id") {
                let parent = regions.last().and_then(|(id, _)| id.clone());
                let prefix = regions.last().map_or(builder.path(), |(_, name)| name);
                let qualified = format!("{prefix}::{name}");
                let id = builder.add_symbol(
                    SymbolKind::Namespace,
                    name,
                    qualified.clone(),
                    offset,
                    offset + name.len(),
                    SymbolOptions {
                        body_search_text: format!("bg3 region {name}"),
                        parent,
                        ..SymbolOptions::default()
                    },
                )?;
                if !tag.self_closing {
                    regions.push((Some(id), qualified));
                }
            }
            continue;
        }
        if tag_name_eq(tag, "content")
            && !tag.closing
            && let Some((offset, handle)) = tag_attribute(tag, "contentuid")
        {
            builder.add_symbol(
                SymbolKind::Resource,
                handle,
                handle.to_owned(),
                offset,
                offset + handle.len(),
                SymbolOptions {
                    body_search_text: format!("localized content {handle}"),
                    exported: true,
                    visibility: Some(Visibility::Public),
                    parent: regions.last().and_then(|(id, _)| id.clone()),
                    ..SymbolOptions::default()
                },
            )?;
            continue;
        }
        if tag.closing || !matches_ignore_ascii_case(tag.name, &["node", "stat_object"]) {
            continue;
        }
        let close =
            find_matching_close(&tags, index).map_or(tag.end, |(_, close_start)| close_start);
        let object_tags = tags
            .iter()
            .copied()
            .skip(index + 1)
            .take_while(|candidate| candidate.start < close);
        let mut fields = BTreeMap::<String, (usize, &str)>::new();
        for field in object_tags {
            if field.closing || !matches_ignore_ascii_case(field.name, &["attribute", "field"]) {
                continue;
            }
            let key = tag_attribute(
                field,
                if tag_name_eq(field, "field") {
                    "name"
                } else {
                    "id"
                },
            );
            let value = tag_attribute(field, "value").or_else(|| tag_attribute(field, "handle"));
            if let (Some((_, key)), Some((offset, value))) = (key, value) {
                fields.insert(key.to_owned(), (offset, value));
            }
        }
        let name = ["NameFS", "DisplayName", "Name", "UUID"]
            .into_iter()
            .find_map(|key| fields.get(key).copied())
            .or_else(|| tag_attribute(tag, "id"));
        let Some((name_offset, name)) =
            name.filter(|(_, name)| !name.is_empty() && !looks_sensitive(name))
        else {
            continue;
        };
        let prefix = regions.last().map_or(builder.path(), |(_, name)| name);
        let id = builder.add_symbol(
            SymbolKind::Resource,
            name,
            format!("{prefix}::{name}"),
            name_offset,
            name_offset + name.len(),
            SymbolOptions {
                body_search_text: format!("bg3 resource {name}"),
                exported: regions.len() == 1,
                visibility: (regions.len() == 1).then_some(Visibility::Public),
                parent: regions.last().and_then(|(id, _)| id.clone()),
                ..SymbolOptions::default()
            },
        )?;
        for (field, (offset, value)) in fields {
            if matches!(field.as_str(), "NameFS" | "DisplayName" | "Name") {
                continue;
            }
            for token in bg3_reference_tokens(value) {
                let relative = value.find(token).unwrap_or(0);
                builder.add_reference(
                    Some(id.clone()),
                    token,
                    ReferenceKind::References,
                    offset + relative,
                    offset + relative + token.len(),
                )?;
            }
        }
    }
    Ok(())
}
