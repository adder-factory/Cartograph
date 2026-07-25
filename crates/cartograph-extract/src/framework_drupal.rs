use std::collections::BTreeSet;

use cartograph_domain::{ReferenceKind, SourceLanguage, SymbolId, SymbolKind};

use crate::{
    ExtractError,
    framework::{FrameworkBuilder, LandmarkInput},
};

const MAX_SIGNAL_BYTES: usize = 4_096;
const MAX_TAGS_PER_FILE: usize = 4_096;

pub(crate) fn scan(
    builder: &mut FrameworkBuilder<'_, '_>,
    masked_source: &str,
) -> Result<(), ExtractError> {
    match builder.language() {
        SourceLanguage::Yaml if is_services_path(builder.path()) => {
            scan_services(builder, masked_source)
        }
        SourceLanguage::Php => {
            scan_hook_contracts(builder)?;
            scan_plugins(builder, masked_source)
        }
        _ => Ok(()),
    }
}

fn is_services_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.ends_with(".services.yml") || lower.ends_with(".services.yaml")
}

struct ServiceState {
    id: String,
    symbol_id: SymbolId,
    indent: usize,
}

fn scan_services(builder: &mut FrameworkBuilder<'_, '_>, source: &str) -> Result<(), ExtractError> {
    let mut in_services = false;
    let mut services_indent = 0_usize;
    let mut service_indent = None;
    let mut current = None;
    let mut section: Option<(&str, usize)> = None;
    let mut tag_facts = BTreeSet::new();
    for (line_start, line) in physical_lines(source) {
        builder.check_cancelled()?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let indent = line.len().saturating_sub(line.trim_start().len());
        if !in_services {
            if trimmed == "services:" {
                in_services = true;
                services_indent = indent;
            }
            continue;
        }
        if indent <= services_indent && !trimmed.starts_with(['-', '{', '[']) {
            break;
        }
        if let Some((id, key_start, key_end)) = yaml_mapping_key(line)
            && indent > services_indent
            && service_indent.is_none_or(|expected| indent == expected)
        {
            service_indent.get_or_insert(indent);
            if id.starts_with('_') {
                current = None;
                section = None;
                continue;
            }
            let identity = format!("drupal-service::{id}");
            let symbol_id = builder.add_landmark_with_id(LandmarkInput {
                kind: SymbolKind::Resource,
                name: id.to_owned(),
                identity,
                start: line_start + key_start,
                end: line_start + key_end,
                body_search_text: format!("drupal service {id}"),
                target: None,
            })?;
            current = symbol_id.map(|symbol_id| ServiceState {
                id: id.to_owned(),
                symbol_id,
                indent,
            });
            section = None;
            continue;
        }
        let Some(service) = current.as_ref() else {
            continue;
        };
        if indent <= service.indent {
            current = None;
            section = None;
            continue;
        }
        if let Some((key, _, _)) = yaml_mapping_key(line) {
            section = Some((key, indent));
        }
        scan_service_direct_references(builder, service, line_start, line)?;
        if section.is_some_and(|(name, section_indent)| name == "tags" && indent > section_indent)
            && let Some((tag, start, end)) = yaml_value_for_key(line, "name")
        {
            tag_facts.insert((
                service.id.clone(),
                tag.to_owned(),
                true,
                line_start + start,
                line_start + end,
            ));
        }
        if let Some((tag, start, end)) = tagged_iterator(line) {
            tag_facts.insert((
                service.id.clone(),
                tag.to_owned(),
                false,
                line_start + start,
                line_start + end,
            ));
        }
    }
    if tag_facts.len() > MAX_TAGS_PER_FILE {
        return Err(ExtractError::OutputLimit);
    }
    for (service_id, tag, provider, start, end) in tag_facts {
        builder.add_landmark(LandmarkInput {
            kind: SymbolKind::Resource,
            name: format!("drupal-tag:{tag}"),
            identity: format!(
                "drupal-tag-{}::{tag}::{service_id}",
                if provider { "provider" } else { "consumer" }
            ),
            start,
            end,
            body_search_text: format!(
                "drupal service tag {} {tag} {service_id}",
                if provider { "provides" } else { "consumes" }
            ),
            target: None,
        })?;
    }
    Ok(())
}

fn scan_service_direct_references(
    builder: &mut FrameworkBuilder<'_, '_>,
    service: &ServiceState,
    line_start: usize,
    line: &str,
) -> Result<(), ExtractError> {
    for key in ["class", "alias", "parent"] {
        if let Some((value, start, end)) = yaml_value_for_key(line, key) {
            add_service_reference(
                builder,
                service,
                value,
                line_start + start,
                line_start + end,
            )?;
        }
    }
    if let Some((factory, start, end)) = yaml_value_for_key(line, "factory") {
        let target = factory
            .strip_prefix("@?")
            .or_else(|| factory.strip_prefix('@'))
            .map(str::to_owned)
            .or_else(|| factory.split_once("::").map(|(class, _)| class.to_owned()));
        if let Some(target) = target {
            let target_len = target.len().min(end.saturating_sub(start));
            add_service_reference(
                builder,
                service,
                &target,
                line_start + start,
                line_start + start + target_len,
            )?;
        }
    }
    let mut cursor = 0_usize;
    while let Some(relative) = line[cursor..].find('@') {
        let marker = cursor + relative;
        if line.as_bytes().get(marker + 1) == Some(&b'@') {
            cursor = marker + 2;
            continue;
        }
        let name_start = marker
            + if line.as_bytes().get(marker + 1) == Some(&b'?') {
                2
            } else {
                1
            };
        let end = service_identifier_end(line, name_start);
        if end > name_start {
            add_service_reference(
                builder,
                service,
                &line[name_start..end],
                line_start + name_start,
                line_start + end,
            )?;
        }
        cursor = end.max(marker + 1);
    }
    Ok(())
}

fn add_service_reference(
    builder: &mut FrameworkBuilder<'_, '_>,
    service: &ServiceState,
    value: &str,
    start: usize,
    end: usize,
) -> Result<(), ExtractError> {
    let value = value.trim();
    if value.is_empty() || value.len() > MAX_SIGNAL_BYTES || start >= end {
        return Ok(());
    }
    builder.add_reference_with_resolution(
        Some(service.symbol_id.clone()),
        value,
        None,
        ReferenceKind::References,
        start,
        end,
    )
}

fn scan_hook_contracts(builder: &mut FrameworkBuilder<'_, '_>) -> Result<(), ExtractError> {
    let lower_path = builder.path().to_ascii_lowercase();
    if ![".module", ".install", ".theme", ".inc"]
        .iter()
        .any(|extension| lower_path.ends_with(extension))
    {
        return Ok(());
    }
    let module = builder
        .path()
        .rsplit('/')
        .next()
        .and_then(|base| base.split('.').next())
        .unwrap_or_default()
        .replace('-', "_");
    let source = builder.source();
    for index in 0..builder.original_symbol_count() {
        builder.check_cancelled()?;
        let Some((name, start, end)) = builder.original_symbol(index).and_then(|symbol| {
            matches!(symbol.kind, SymbolKind::Function | SymbolKind::Module).then(|| {
                Some((
                    symbol.name.clone(),
                    usize::try_from(symbol.span.start_byte()).ok()?,
                    usize::try_from(symbol.span.end_byte()).ok()?,
                ))
            })?
        }) else {
            continue;
        };
        let prefix_start = start.saturating_sub(MAX_SIGNAL_BYTES);
        let prefix = &source[prefix_start..start];
        let documented = documented_hook(prefix);
        let inferred = name
            .strip_prefix(&module)
            .and_then(|suffix| suffix.strip_prefix('_'))
            .filter(|suffix| !suffix.is_empty())
            .map(|suffix| format!("hook_{suffix}"));
        let Some(contract) = documented.or(inferred) else {
            continue;
        };
        let (name_start, name_end) = source[start..end]
            .find(&name)
            .map_or((start, end), |offset| {
                (start + offset, start + offset + name.len())
            });
        builder.add_landmark(LandmarkInput {
            kind: SymbolKind::Resource,
            name: contract.clone(),
            identity: format!("drupal-hook-contract::{contract}::{name}"),
            start: name_start,
            end: name_end,
            body_search_text: format!("drupal hook contract {contract} implementation {name}"),
            target: Some((&name, None, name_start, name_end)),
        })?;
    }
    Ok(())
}

fn documented_hook(prefix: &str) -> Option<String> {
    let doc_end = prefix.rfind("*/")?;
    if !prefix[doc_end + 2..].trim().is_empty() {
        return None;
    }
    let doc_start = prefix[..doc_end].rfind("/**")?;
    let prefix = &prefix[doc_start..doc_end + 2];
    let marker = "@implements";
    let start = prefix.rfind(marker)? + marker.len();
    let suffix = prefix[start..].trim_start();
    let hook_start = suffix.find("hook_")?;
    let hook = &suffix[hook_start..service_identifier_end(suffix, hook_start)];
    (!hook.is_empty()).then(|| hook.to_owned())
}

fn scan_plugins(
    builder: &mut FrameworkBuilder<'_, '_>,
    masked_source: &str,
) -> Result<(), ExtractError> {
    let raw_source = builder.source();
    for index in 0..builder.original_symbol_count() {
        builder.check_cancelled()?;
        let Some((class_name, start, end)) = builder.original_symbol(index).and_then(|symbol| {
            matches!(symbol.kind, SymbolKind::Class | SymbolKind::Module).then(|| {
                Some((
                    symbol.name.clone(),
                    usize::try_from(symbol.span.start_byte()).ok()?,
                    usize::try_from(symbol.span.end_byte()).ok()?,
                ))
            })?
        }) else {
            continue;
        };
        let class_marker = format!("class {class_name}");
        let Some(class_relative) = raw_source[start..end].find(&class_marker) else {
            continue;
        };
        let class_name_start = start + class_relative + "class ".len();
        let class_span = (class_name_start, class_name_start + class_name.len());
        let window_start = class_name_start.saturating_sub(MAX_SIGNAL_BYTES);
        let window_end = class_span.1;
        let raw_window = &raw_source[window_start..window_end];
        let masked_window = &masked_source[window_start..window_end];
        let annotation = plugin_annotation(raw_window);
        let attribute = plugin_attribute(masked_window);
        let Some((plugin_type, id, relative_start, relative_end)) = annotation
            .into_iter()
            .chain(attribute)
            .max_by_key(|(_, _, start, _)| *start)
        else {
            continue;
        };
        builder.add_landmark(LandmarkInput {
            kind: SymbolKind::Resource,
            name: id.to_owned(),
            identity: format!("drupal-plugin::{plugin_type}::{id}"),
            start: window_start + relative_start,
            end: window_start + relative_end,
            body_search_text: format!("drupal plugin {plugin_type} {id} {class_name}"),
            target: Some((&class_name, None, class_span.0, class_span.1)),
        })?;
    }
    Ok(())
}

fn plugin_annotation(value: &str) -> Option<(&str, &str, usize, usize)> {
    plugin_signal(value, '@', '=')
}

fn plugin_attribute(value: &str) -> Option<(&str, &str, usize, usize)> {
    plugin_signal(value, '#', ':')
}

fn plugin_signal(value: &str, prefix: char, separator: char) -> Option<(&str, &str, usize, usize)> {
    for plugin_type in [
        "Block",
        "FieldType",
        "FieldWidget",
        "FieldFormatter",
        "ViewsField",
        "QueueWorker",
        "Action",
        "Condition",
        "MigrateProcessPlugin",
    ] {
        let marker = if prefix == '#' {
            format!("#[{plugin_type}")
        } else {
            format!("{prefix}{plugin_type}")
        };
        let Some(signal) = value.rfind(&marker) else {
            continue;
        };
        let body = &value[signal + marker.len()..];
        let id_key = body.find("id")?;
        let after_id = &body[id_key + 2..];
        let separator_offset = after_id.find(separator)? + id_key + 2;
        let quoted = quoted_after(body, separator_offset + 1)?;
        return Some((
            plugin_type,
            quoted.value,
            signal + marker.len() + quoted.start,
            signal + marker.len() + quoted.end,
        ));
    }
    None
}

fn yaml_mapping_key(line: &str) -> Option<(&str, usize, usize)> {
    let content_start = line.len().saturating_sub(line.trim_start().len());
    let content = &line[content_start..];
    if content.starts_with('-') {
        return None;
    }
    let colon = content.find(':')?;
    let raw = content[..colon].trim();
    if raw.is_empty() || raw.contains(['{', '[', ',']) {
        return None;
    }
    let value = unquote(raw);
    let relative = content.find(value)?;
    Some((
        value,
        content_start + relative,
        content_start + relative + value.len(),
    ))
}

fn yaml_value_for_key<'line>(
    line: &'line str,
    expected: &str,
) -> Option<(&'line str, usize, usize)> {
    let content = line
        .trim_start()
        .trim_start_matches('-')
        .trim_start()
        .trim_start_matches('{')
        .trim_start();
    let key = content.split_once(':')?.0.trim();
    if key != expected {
        return None;
    }
    let raw = content
        .split_once(':')?
        .1
        .trim()
        .trim_end_matches([',', ']', '}'])
        .trim();
    if raw.is_empty() {
        return None;
    }
    let value = unquote(raw);
    let start = line.find(value)?;
    Some((value, start, start + value.len()))
}

fn tagged_iterator(line: &str) -> Option<(&str, usize, usize)> {
    let marker = line.find("!tagged")?;
    let suffix = &line[marker..];
    let after_kind = suffix.find(char::is_whitespace)?;
    let value_start = marker + after_kind;
    let start = skip_ascii_whitespace(line, value_start);
    if line.as_bytes().get(start) == Some(&b'{') {
        return yaml_value_for_key(line, "tag");
    }
    let end = service_identifier_end(line, start);
    (end > start).then_some((&line[start..end], start, end))
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('\'')
        .and_then(|value| value.strip_suffix('\''))
        .or_else(|| {
            value
                .strip_prefix('"')
                .and_then(|value| value.strip_suffix('"'))
        })
        .unwrap_or(value)
}

fn service_identifier_end(value: &str, mut cursor: usize) -> usize {
    while value.as_bytes().get(cursor).is_some_and(|byte| {
        byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'.' | b'-' | b'\\' | b':' | b'/')
    }) {
        cursor += 1;
    }
    cursor
}

struct Quoted<'source> {
    value: &'source str,
    start: usize,
    end: usize,
}

fn quoted_after(value: &str, from: usize) -> Option<Quoted<'_>> {
    let mut cursor = from;
    while cursor < value.len() && !matches!(value.as_bytes()[cursor], b'\'' | b'"') {
        cursor += 1;
    }
    let quote = *value.as_bytes().get(cursor)?;
    let start = cursor + 1;
    cursor = start;
    while cursor < value.len() {
        if value.as_bytes()[cursor] == quote {
            return Some(Quoted {
                value: &value[start..cursor],
                start,
                end: cursor,
            });
        }
        cursor += 1;
    }
    None
}

fn skip_ascii_whitespace(value: &str, mut cursor: usize) -> usize {
    while value
        .as_bytes()
        .get(cursor)
        .is_some_and(u8::is_ascii_whitespace)
    {
        cursor += 1;
    }
    cursor
}

fn physical_lines(source: &str) -> impl Iterator<Item = (usize, &str)> {
    source.split_inclusive('\n').scan(0_usize, |offset, line| {
        let start = *offset;
        *offset = offset.saturating_add(line.len());
        Some((start, line.trim_end_matches(['\n', '\r'])))
    })
}
