use serde_json::Value;

#[derive(Clone, Copy, Debug)]
struct ObjectRange {
    open: usize,
    close: usize,
}

#[derive(Clone, Copy, Debug)]
struct PropertyRange {
    key_start: usize,
    value_start: usize,
    value_end: usize,
    trailing_comma: Option<usize>,
    previous_comma: Option<usize>,
}

pub(super) fn parse(text: &str) -> Option<Value> {
    let without_comments = strip_comments(text)?;
    let normalized = remove_trailing_commas(&without_comments);
    serde_json::from_str(&normalized).ok()
}

pub(super) fn upsert(text: &str, wrapper: &str, entry: &Value) -> Option<String> {
    let root = root_object(text)?;
    let rendered = serde_json::to_string_pretty(entry).ok()?;
    let wrapper_property = find_property(text, root, wrapper);
    let Some(wrapper_property) = wrapper_property else {
        let property = format_property(wrapper, &serde_json::json!({"cartograph": entry}), "  ")?;
        return insert_property(text, root, &property);
    };
    let servers = value_object(text, wrapper_property)?;
    let cartograph = find_property(text, servers, "cartograph");
    let Some(cartograph) = cartograph else {
        let property = format_property("cartograph", entry, "    ")?;
        return insert_property(text, servers, &property);
    };
    let replacement = indent_json(&rendered, "    ");
    Some(format!(
        "{}{}{}",
        &text[..cartograph.value_start],
        replacement,
        &text[cartograph.value_end..]
    ))
}

pub(super) fn remove(text: &str, wrapper: &str) -> Option<String> {
    let root = root_object(text)?;
    let Some(wrapper_property) = find_property(text, root, wrapper) else {
        return Some(text.to_owned());
    };
    let servers = value_object(text, wrapper_property)?;
    let Some(cartograph) = find_property(text, servers, "cartograph") else {
        return Some(text.to_owned());
    };
    Some(remove_property(text, cartograph))
}

pub(super) fn fresh(wrapper: &str, entry: &Value) -> Option<String> {
    let root = serde_json::json!({wrapper: {"cartograph": entry}});
    serde_json::to_string_pretty(&root)
        .ok()
        .map(|rendered| format!("{rendered}\n"))
}

fn root_object(text: &str) -> Option<ObjectRange> {
    let start = skip_trivia(text, 0);
    if text.as_bytes().get(start).copied() != Some(b'{') {
        return None;
    }
    let close = matching_close(text, start)?;
    (skip_trivia(text, close.saturating_add(1)) == text.len())
        .then_some(ObjectRange { open: start, close })
}

fn value_object(text: &str, property: PropertyRange) -> Option<ObjectRange> {
    let open = skip_trivia(text, property.value_start);
    if text.as_bytes().get(open).copied() != Some(b'{') {
        return None;
    }
    let close = matching_close(text, open)?;
    (close < property.value_end).then_some(ObjectRange { open, close })
}

fn find_property(text: &str, object: ObjectRange, wanted: &str) -> Option<PropertyRange> {
    let mut cursor = object.open.saturating_add(1);
    let mut previous_comma = None;
    while cursor < object.close {
        cursor = skip_trivia(text, cursor);
        if cursor >= object.close {
            return None;
        }
        if text.as_bytes().get(cursor).copied() == Some(b',') {
            previous_comma = Some(cursor);
            cursor = cursor.saturating_add(1);
            continue;
        }
        let (key, key_end) = read_string(text, cursor)?;
        let colon = skip_trivia(text, key_end);
        if text.as_bytes().get(colon).copied() != Some(b':') {
            return None;
        }
        let value_start = skip_trivia(text, colon.saturating_add(1));
        let value_end = skip_value(text, value_start, object.close)?;
        let after_value = skip_trivia(text, value_end);
        let trailing_comma =
            (text.as_bytes().get(after_value).copied() == Some(b',')).then_some(after_value);
        let range = PropertyRange {
            key_start: cursor,
            value_start,
            value_end,
            trailing_comma,
            previous_comma,
        };
        if key == wanted {
            return Some(range);
        }
        cursor = trailing_comma.map_or(after_value, |comma| comma.saturating_add(1));
    }
    None
}

fn read_string(text: &str, start: usize) -> Option<(String, usize)> {
    if text.as_bytes().get(start).copied() != Some(b'"') {
        return None;
    }
    let end = string_end(text, start)?;
    let key = serde_json::from_str::<String>(&text[start..end]).ok()?;
    Some((key, end))
}

fn skip_value(text: &str, start: usize, limit: usize) -> Option<usize> {
    match text.as_bytes().get(start).copied()? {
        b'"' => string_end(text, start),
        b'{' | b'[' => matching_close(text, start).map(|end| end.saturating_add(1)),
        _ => {
            let mut cursor = start;
            while cursor < limit && !matches!(text.as_bytes()[cursor], b',' | b'}' | b']') {
                cursor = cursor.saturating_add(1);
            }
            (cursor > start).then_some(cursor)
        }
    }
}

fn matching_close(text: &str, start: usize) -> Option<usize> {
    let (open, close) = match text.as_bytes().get(start).copied()? {
        b'{' => (b'{', b'}'),
        b'[' => (b'[', b']'),
        _ => return None,
    };
    let mut depth = 0_u32;
    let mut cursor = start;
    while cursor < text.len() {
        if text.as_bytes()[cursor] == b'"' {
            cursor = string_end(text, cursor)?;
            continue;
        }
        if text.as_bytes()[cursor] == b'/'
            && let Some(next) = comment_end(text, cursor)
        {
            cursor = next;
            continue;
        }
        if text.as_bytes()[cursor] == open {
            depth = depth.saturating_add(1);
        } else if text.as_bytes()[cursor] == close {
            depth = depth.checked_sub(1)?;
            if depth == 0 {
                return Some(cursor);
            }
        }
        cursor = cursor.saturating_add(1);
    }
    None
}

fn string_end(text: &str, start: usize) -> Option<usize> {
    let mut cursor = start.saturating_add(1);
    while cursor < text.len() {
        match text.as_bytes()[cursor] {
            b'\\' => cursor = cursor.saturating_add(2),
            b'"' => return Some(cursor.saturating_add(1)),
            _ => cursor = cursor.saturating_add(1),
        }
    }
    None
}

fn skip_trivia(text: &str, start: usize) -> usize {
    let mut cursor = start;
    while cursor < text.len() {
        if text.as_bytes()[cursor].is_ascii_whitespace() {
            cursor = cursor.saturating_add(1);
            continue;
        }
        if let Some(next) = comment_end(text, cursor) {
            cursor = next;
            continue;
        }
        break;
    }
    cursor
}

fn comment_end(text: &str, start: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if bytes.get(start).copied() != Some(b'/') {
        return None;
    }
    match bytes.get(start.saturating_add(1)).copied() {
        Some(b'/') => {
            let mut cursor = start.saturating_add(2);
            while cursor < bytes.len() && bytes[cursor] != b'\n' {
                cursor = cursor.saturating_add(1);
            }
            Some(cursor)
        }
        Some(b'*') => {
            let mut cursor = start.saturating_add(2);
            while cursor.saturating_add(1) < bytes.len() {
                if bytes[cursor] == b'*' && bytes[cursor + 1] == b'/' {
                    return Some(cursor.saturating_add(2));
                }
                cursor = cursor.saturating_add(1);
            }
            Some(bytes.len())
        }
        _ => None,
    }
}

fn strip_comments(text: &str) -> Option<String> {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0_usize;
    while cursor < text.len() {
        if text.as_bytes()[cursor] == b'"' {
            let end = string_end(text, cursor)?;
            output.push_str(&text[cursor..end]);
            cursor = end;
            continue;
        }
        if let Some(end) = comment_end(text, cursor) {
            for byte in &text.as_bytes()[cursor..end] {
                output.push(if *byte == b'\n' { '\n' } else { ' ' });
            }
            cursor = end;
            continue;
        }
        let character = text[cursor..].chars().next()?;
        output.push(character);
        cursor = cursor.saturating_add(character.len_utf8());
    }
    Some(output)
}

fn remove_trailing_commas(text: &str) -> String {
    let mut output = String::with_capacity(text.len());
    let mut cursor = 0_usize;
    while cursor < text.len() {
        if text.as_bytes()[cursor] == b'"'
            && let Some(end) = string_end(text, cursor)
        {
            output.push_str(&text[cursor..end]);
            cursor = end;
            continue;
        }
        if text.as_bytes()[cursor] == b',' {
            let mut lookahead = cursor.saturating_add(1);
            while lookahead < text.len() && text.as_bytes()[lookahead].is_ascii_whitespace() {
                lookahead = lookahead.saturating_add(1);
            }
            if matches!(text.as_bytes().get(lookahead), Some(b'}' | b']')) {
                cursor = cursor.saturating_add(1);
                continue;
            }
        }
        let Some(character) = text[cursor..].chars().next() else {
            break;
        };
        output.push(character);
        cursor = cursor.saturating_add(character.len_utf8());
    }
    output
}

fn format_property(key: &str, value: &Value, indent: &str) -> Option<String> {
    let rendered = serde_json::to_string_pretty(value).ok()?;
    Some(format!(
        "{indent}{}: {}",
        serde_json::to_string(key).ok()?,
        indent_json(&rendered, indent)
    ))
}

fn indent_json(rendered: &str, indent: &str) -> String {
    rendered
        .lines()
        .enumerate()
        .map(|(index, line)| {
            if index == 0 {
                line.to_owned()
            } else {
                format!("{indent}{line}")
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn insert_property(text: &str, object: ObjectRange, property: &str) -> Option<String> {
    let prior = previous_significant(text, object.close.checked_sub(1)?)?;
    if prior < object.open {
        return None;
    }
    let separator = if text.as_bytes()[prior] == b'{' || text.as_bytes()[prior] == b',' {
        ""
    } else {
        ","
    };
    Some(format!(
        "{}{}{}\n{}{}",
        &text[..prior.saturating_add(1)],
        separator,
        &text[prior.saturating_add(1)..object.close],
        property,
        &text[object.close..]
    ))
}

fn previous_significant(text: &str, start: usize) -> Option<usize> {
    let stripped = strip_comments(text)?;
    let bytes = stripped.as_bytes();
    let mut cursor = start.min(bytes.len().saturating_sub(1));
    loop {
        if !bytes[cursor].is_ascii_whitespace() {
            return Some(cursor);
        }
        cursor = cursor.checked_sub(1)?;
    }
}

fn remove_property(text: &str, property: PropertyRange) -> String {
    if let Some(comma) = property.trailing_comma {
        return format!("{}{}", &text[..property.key_start], &text[comma + 1..]);
    }
    if let Some(comma) = property.previous_comma {
        return format!("{}{}", &text[..comma], &text[property.value_end..]);
    }
    format!(
        "{}{}",
        &text[..property.key_start],
        &text[property.value_end..]
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targeted_upsert_and_remove_preserve_jsonc_comments() {
        let prior = r#"{
  // retained
  "mcpServers": {
    "other": { "command": "x" },
  },
  "sentinel": true,
}
"#;
        let entry = serde_json::json!({"command":"cartograph","args":["serve","--mcp"]});
        let installed =
            upsert(prior, "mcpServers", &entry).unwrap_or_else(|| panic!("JSONC upsert failed"));
        assert!(installed.contains("// retained"));
        assert!(installed.contains("\"other\": { \"command\": \"x\" }"));
        assert_eq!(
            parse(&installed).and_then(|value| value.pointer("/mcpServers/cartograph").cloned()),
            Some(entry)
        );

        let removed =
            remove(&installed, "mcpServers").unwrap_or_else(|| panic!("JSONC removal failed"));
        assert!(removed.contains("// retained"));
        assert!(removed.contains("\"other\": { \"command\": \"x\" }"));
        assert!(
            parse(&removed)
                .and_then(|value| value.pointer("/mcpServers/cartograph").cloned())
                .is_none()
        );
    }
}
