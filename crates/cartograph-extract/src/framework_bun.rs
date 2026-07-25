use cartograph_domain::SourceLanguage;

use crate::{ExtractError, framework::FrameworkBuilder};

const METHODS: [&str; 7] = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

pub(crate) fn scan(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
) -> Result<(), ExtractError> {
    if !matches!(
        builder.language(),
        SourceLanguage::TypeScript
            | SourceLanguage::Tsx
            | SourceLanguage::JavaScript
            | SourceLanguage::Jsx
    ) || !source.contains("Bun.serve")
    {
        return Ok(());
    }
    let mut cursor = 0_usize;
    while let Some(relative) = source[cursor..].find("Bun.serve") {
        builder.check_cancelled()?;
        let call = cursor + relative;
        if call > 0 && identifier_byte(source.as_bytes()[call - 1]) {
            cursor = call + "Bun.serve".len();
            continue;
        }
        let open_paren = skip_ascii_whitespace(source, call + "Bun.serve".len());
        if source.as_bytes().get(open_paren) != Some(&b'(') {
            cursor = call + "Bun.serve".len();
            continue;
        }
        let Some(close_paren) = matching_delimiter(source, open_paren, b'(', b')') else {
            cursor = open_paren + 1;
            continue;
        };
        let config_open = skip_ascii_whitespace(source, open_paren + 1);
        if source.as_bytes().get(config_open) != Some(&b'{') {
            cursor = close_paren + 1;
            continue;
        }
        let Some(config_close) = matching_delimiter(source, config_open, b'{', b'}') else {
            cursor = close_paren + 1;
            continue;
        };
        if config_close > close_paren {
            cursor = close_paren + 1;
            continue;
        }
        if let Some(routes_open) = top_level_routes_object(source, config_open + 1, config_close)
            && let Some(routes_close) = matching_delimiter(source, routes_open, b'{', b'}')
            && routes_close <= config_close
        {
            scan_route_entries(builder, source, routes_open + 1, routes_close)?;
        }
        cursor = close_paren + 1;
    }
    Ok(())
}

fn top_level_routes_object(source: &str, start: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut cursor = start;
    let mut depth = 0_usize;
    let mut quote = None;
    let mut escaped = false;
    while cursor < end {
        let byte = bytes[cursor];
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            cursor += 1;
            continue;
        }
        match byte {
            b'\'' | b'"' | b'`' => {
                quote = Some(byte);
                cursor += 1;
            }
            b'{' | b'[' | b'(' => {
                depth = depth.saturating_add(1);
                cursor += 1;
            }
            b'}' | b']' | b')' => {
                depth = depth.saturating_sub(1);
                cursor += 1;
            }
            byte if depth == 0 && (byte == b'_' || byte.is_ascii_alphabetic()) => {
                let (name_end, name) = identifier_at(source, cursor)?;
                let colon = skip_ascii_whitespace(source, name_end);
                if name == "routes" && bytes.get(colon) == Some(&b':') {
                    let value = skip_ascii_whitespace(source, colon + 1);
                    if bytes.get(value) == Some(&b'{') {
                        return Some(value);
                    }
                }
                cursor = name_end;
            }
            _ => cursor += 1,
        }
    }
    None
}

fn scan_route_entries(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
    start: usize,
    end: usize,
) -> Result<(), ExtractError> {
    let bytes = source.as_bytes();
    let mut cursor = start;
    let mut depth = 0_usize;
    while cursor < end {
        builder.check_cancelled()?;
        let byte = bytes[cursor];
        if matches!(byte, b'{' | b'[' | b'(') {
            depth = depth.saturating_add(1);
            cursor += 1;
            continue;
        }
        if matches!(byte, b'}' | b']' | b')') {
            depth = depth.saturating_sub(1);
            cursor += 1;
            continue;
        }
        if depth != 0 || !matches!(byte, b'\'' | b'"' | b'`') {
            cursor += 1;
            continue;
        }
        let Some(path) = quoted_at(source, cursor, end) else {
            return Ok(());
        };
        let colon = skip_ascii_whitespace(source, path.quote_end + 1);
        if !path.value.starts_with('/') || bytes.get(colon) != Some(&b':') {
            cursor = path.quote_end + 1;
            continue;
        }
        let value = skip_ascii_whitespace(source, colon + 1);
        if bytes.get(value) == Some(&b'{') {
            let Some(map_close) = matching_delimiter(source, value, b'{', b'}') else {
                return Ok(());
            };
            if map_close > end {
                return Ok(());
            }
            scan_method_map(builder, source, &path, value + 1, map_close)?;
            cursor = map_close + 1;
        } else {
            let handler = direct_handler(source, value, end);
            builder.add_route("ANY", path.value, path.start, path.end, false, handler)?;
            cursor = value.saturating_add(1);
        }
    }
    Ok(())
}

fn scan_method_map(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
    path: &Quoted<'_>,
    start: usize,
    end: usize,
) -> Result<(), ExtractError> {
    let bytes = source.as_bytes();
    let first = skip_ascii_whitespace(source, start);
    let Some((first_end, first_method)) = identifier_at(source, first) else {
        return Ok(());
    };
    if !METHODS.contains(&first_method)
        || bytes.get(skip_ascii_whitespace(source, first_end)) != Some(&b':')
    {
        return Ok(());
    }
    let mut cursor = start;
    let mut depth = 0_usize;
    while cursor < end {
        builder.check_cancelled()?;
        match bytes[cursor] {
            b'{' | b'[' | b'(' => {
                depth = depth.saturating_add(1);
                cursor += 1;
            }
            b'}' | b']' | b')' => {
                depth = depth.saturating_sub(1);
                cursor += 1;
            }
            byte if depth == 0 && (byte == b'_' || byte.is_ascii_alphabetic()) => {
                let (method_end, method) =
                    identifier_at(source, cursor).ok_or(ExtractError::InvalidSpan)?;
                let colon = skip_ascii_whitespace(source, method_end);
                if METHODS.contains(&method) && bytes.get(colon) == Some(&b':') {
                    let value = skip_ascii_whitespace(source, colon + 1);
                    let handler = direct_handler(source, value, end);
                    builder.add_route(method, path.value, path.start, path.end, false, handler)?;
                }
                cursor = method_end;
            }
            b'\'' | b'"' | b'`' => {
                cursor = quoted_at(source, cursor, end).map_or(end, |quoted| quoted.quote_end + 1);
            }
            _ => cursor += 1,
        }
    }
    Ok(())
}

fn direct_handler(source: &str, start: usize, limit: usize) -> Option<(&str, usize, usize)> {
    let start = skip_ascii_whitespace(source, start);
    let (end, name) = identifier_at(source, start)?;
    (!matches!(name, "async" | "function" | "new") && end <= limit).then_some((name, start, end))
}

struct Quoted<'source> {
    value: &'source str,
    start: usize,
    end: usize,
    quote_end: usize,
}

fn quoted_at(value: &str, quote_start: usize, limit: usize) -> Option<Quoted<'_>> {
    let quote = *value.as_bytes().get(quote_start)?;
    if !matches!(quote, b'\'' | b'"' | b'`') {
        return None;
    }
    let start = quote_start + 1;
    let mut cursor = start;
    let mut escaped = false;
    while cursor < limit {
        let byte = value.as_bytes()[cursor];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return Some(Quoted {
                value: &value[start..cursor],
                start,
                end: cursor,
                quote_end: cursor,
            });
        }
        cursor += 1;
    }
    None
}

fn identifier_byte(byte: u8) -> bool {
    byte == b'_' || byte == b'$' || byte.is_ascii_alphanumeric()
}

fn identifier_at(value: &str, start: usize) -> Option<(usize, &str)> {
    let first = *value.as_bytes().get(start)?;
    if !(first == b'_' || first == b'$' || first.is_ascii_alphabetic()) {
        return None;
    }
    let mut end = start + 1;
    while value
        .as_bytes()
        .get(end)
        .is_some_and(|byte| identifier_byte(*byte))
    {
        end += 1;
    }
    Some((end, &value[start..end]))
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

fn matching_delimiter(value: &str, open: usize, opening: u8, closing: u8) -> Option<usize> {
    let mut depth = 0_usize;
    let mut quote = None;
    let mut escaped = false;
    for (index, byte) in value.as_bytes().iter().copied().enumerate().skip(open) {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
            continue;
        }
        if matches!(byte, b'\'' | b'"' | b'`') {
            quote = Some(byte);
        } else if byte == opening {
            depth = depth.saturating_add(1);
        } else if byte == closing {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(index);
            }
        }
    }
    None
}
