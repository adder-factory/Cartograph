use std::collections::BTreeSet;

use cartograph_domain::SourceLanguage;

use crate::{ExtractError, framework::FrameworkBuilder};

const MAX_RECEIVERS: usize = 256;
const MAX_ROUTES: usize = 4_096;
const MAX_ROUTE_BYTES: usize = 1_024;

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
    ) || !(source.contains("new Hono") || source.contains("new OpenAPIHono"))
    {
        return Ok(());
    }
    let receivers = collect_receivers(builder, source)?;
    if receivers.is_empty() {
        return Ok(());
    }
    let mut routes = Vec::new();
    routes
        .try_reserve_exact(MAX_ROUTES)
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut mounts = Vec::new();
    mounts
        .try_reserve_exact(MAX_RECEIVERS)
        .map_err(|_| ExtractError::OutputLimit)?;
    for receiver in &receivers {
        scan_receiver_calls(builder, source, receiver, &mut routes, &mut mounts)?;
    }
    for route in &routes {
        builder.add_route(
            &route.method,
            route.path,
            route.path_start,
            route.path_end,
            false,
            route.handler,
        )?;
    }
    for mount in mounts {
        for route in &routes {
            if route.receiver != mount.child {
                continue;
            }
            let Some(path) = join_paths(mount.prefix, route.path) else {
                continue;
            };
            builder.add_route(
                &route.method,
                &path,
                mount.prefix_start,
                mount.prefix_end,
                false,
                route.handler,
            )?;
        }
    }
    Ok(())
}

fn collect_receivers<'source>(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &'source str,
) -> Result<BTreeSet<&'source str>, ExtractError> {
    let mut receivers = BTreeSet::new();
    for marker in ["new Hono", "new OpenAPIHono"] {
        let mut cursor = 0_usize;
        while receivers.len() < MAX_RECEIVERS
            && let Some(relative) = source[cursor..].find(marker)
        {
            builder.check_cancelled()?;
            let constructor = cursor + relative;
            if constructor > 0 && identifier_byte(source.as_bytes()[constructor - 1]) {
                cursor = constructor + marker.len();
                continue;
            }
            let boundary = source[..constructor]
                .rfind(['\n', ';'])
                .map_or(0, |offset| offset + 1);
            let statement = &source[boundary..constructor];
            let Some(equals) = statement.rfind('=') else {
                cursor = constructor + marker.len();
                continue;
            };
            if !statement[equals + 1..].trim().is_empty() {
                cursor = constructor + marker.len();
                continue;
            }
            let declaration = statement[..equals].trim();
            if let Some((_, receiver)) = identifiers(declaration).last() {
                receivers.insert(receiver);
            }
            cursor = constructor + marker.len();
        }
    }
    Ok(receivers)
}

fn scan_receiver_calls<'source>(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &'source str,
    receiver: &'source str,
    routes: &mut Vec<HonoRoute<'source>>,
    mounts: &mut Vec<HonoMount<'source>>,
) -> Result<(), ExtractError> {
    let marker = format!("{receiver}.");
    let mut cursor = 0_usize;
    while let Some(relative) = source[cursor..].find(&marker) {
        builder.check_cancelled()?;
        let call_start = cursor + relative;
        if call_start > 0 && identifier_byte(source.as_bytes()[call_start - 1]) {
            cursor = call_start + marker.len();
            continue;
        }
        let method_start = call_start + marker.len();
        let Some((method_end, method)) = identifier_at(source, method_start) else {
            cursor = method_start;
            continue;
        };
        let open = skip_ascii_whitespace(source, method_end);
        if source.as_bytes().get(open) != Some(&b'(') {
            cursor = method_end;
            continue;
        }
        let Some(close) = matching_delimiter(source, open, b'(', b')') else {
            cursor = open + 1;
            continue;
        };
        if direct_method(method) {
            if let Some(path) = quoted_argument(source, open + 1, close) {
                push_route(
                    routes,
                    HonoRoute {
                        receiver,
                        method: method.to_ascii_uppercase(),
                        path: path.value,
                        path_start: path.start,
                        path_end: path.end,
                        handler: handler_after_argument(source, path.quote_end + 1, close),
                    },
                )?;
            }
        } else if method == "on" {
            if let Some(method_arg) = quoted_argument(source, open + 1, close)
                && let Some(comma) = next_top_level_comma(source, method_arg.quote_end + 1, close)
                && let Some(path) = quoted_argument(source, comma + 1, close)
            {
                push_route(
                    routes,
                    HonoRoute {
                        receiver,
                        method: method_arg.value.to_ascii_uppercase(),
                        path: path.value,
                        path_start: path.start,
                        path_end: path.end,
                        handler: handler_after_argument(source, path.quote_end + 1, close),
                    },
                )?;
            }
        } else if method == "route"
            && let Some(prefix) = quoted_argument(source, open + 1, close)
            && let Some(comma) = next_top_level_comma(source, prefix.quote_end + 1, close)
        {
            let child_start = skip_ascii_whitespace(source, comma + 1);
            if let Some((_, child)) = identifier_at(source, child_start) {
                if mounts.len() >= MAX_RECEIVERS {
                    return Err(ExtractError::OutputLimit);
                }
                mounts.push(HonoMount {
                    prefix: prefix.value,
                    prefix_start: prefix.start,
                    prefix_end: prefix.end,
                    child,
                });
            }
        }
        cursor = close + 1;
    }
    Ok(())
}

fn push_route<'source>(
    routes: &mut Vec<HonoRoute<'source>>,
    route: HonoRoute<'source>,
) -> Result<(), ExtractError> {
    if routes.len() >= MAX_ROUTES || route.path.len() > MAX_ROUTE_BYTES {
        return Err(ExtractError::OutputLimit);
    }
    routes.push(route);
    Ok(())
}

struct HonoRoute<'source> {
    receiver: &'source str,
    method: String,
    path: &'source str,
    path_start: usize,
    path_end: usize,
    handler: Option<(&'source str, usize, usize)>,
}

struct HonoMount<'source> {
    prefix: &'source str,
    prefix_start: usize,
    prefix_end: usize,
    child: &'source str,
}

fn direct_method(method: &str) -> bool {
    matches!(
        method,
        "get" | "post" | "put" | "patch" | "delete" | "options" | "all"
    )
}

fn handler_after_argument(source: &str, from: usize, close: usize) -> Option<(&str, usize, usize)> {
    let comma = next_top_level_comma(source, from, close)?;
    let start = skip_ascii_whitespace(source, comma + 1);
    let (end, handler) = identifier_at(source, start)?;
    (!matches!(handler, "async" | "function")).then_some((handler, start, end))
}

fn next_top_level_comma(source: &str, start: usize, end: usize) -> Option<usize> {
    let bytes = source.as_bytes();
    let mut cursor = start;
    let mut paren = 0_usize;
    let mut brace = 0_usize;
    let mut bracket = 0_usize;
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
            b'\'' | b'"' | b'`' => quote = Some(byte),
            b'(' => paren = paren.saturating_add(1),
            b')' => paren = paren.saturating_sub(1),
            b'{' => brace = brace.saturating_add(1),
            b'}' => brace = brace.saturating_sub(1),
            b'[' => bracket = bracket.saturating_add(1),
            b']' => bracket = bracket.saturating_sub(1),
            b',' if paren == 0 && brace == 0 && bracket == 0 => return Some(cursor),
            _ => {}
        }
        cursor += 1;
    }
    None
}

struct Quoted<'source> {
    value: &'source str,
    start: usize,
    end: usize,
    quote_end: usize,
}

fn quoted_argument(source: &str, from: usize, limit: usize) -> Option<Quoted<'_>> {
    let quote_start = skip_ascii_whitespace(source, from);
    let quote = *source.as_bytes().get(quote_start)?;
    if !matches!(quote, b'\'' | b'"' | b'`') {
        return None;
    }
    let start = quote_start + 1;
    let mut cursor = start;
    let mut escaped = false;
    while cursor < limit {
        let byte = source.as_bytes()[cursor];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return Some(Quoted {
                value: &source[start..cursor],
                start,
                end: cursor,
                quote_end: cursor,
            });
        }
        cursor += 1;
    }
    None
}

fn join_paths(prefix: &str, path: &str) -> Option<String> {
    if prefix.len().saturating_add(path.len()) > MAX_ROUTE_BYTES {
        return None;
    }
    let mut joined = String::new();
    joined
        .try_reserve(prefix.len().saturating_add(path.len()).saturating_add(1))
        .ok()?;
    for segment in prefix.split('/').chain(path.split('/')) {
        if segment.is_empty() {
            continue;
        }
        joined.push('/');
        joined.push_str(segment);
    }
    if joined.is_empty() {
        joined.push('/');
    }
    Some(joined)
}

fn identifiers(value: &str) -> impl Iterator<Item = (usize, &str)> {
    let bytes = value.as_bytes();
    let mut cursor = 0_usize;
    std::iter::from_fn(move || {
        while cursor < bytes.len()
            && !(bytes[cursor] == b'_'
                || bytes[cursor] == b'$'
                || bytes[cursor].is_ascii_alphabetic())
        {
            cursor += 1;
        }
        let start = cursor;
        let (end, name) = identifier_at(value, start)?;
        cursor = end;
        Some((start, name))
    })
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
