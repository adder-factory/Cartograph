use cartograph_domain::{SourceLanguage, SymbolKind};

use crate::{ExtractError, framework::FrameworkBuilder};

const MAX_ANNOTATION_BYTES: usize = 4_096;
const MAX_ROUTE_BYTES: usize = 1_024;

pub(crate) fn scan(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
) -> Result<(), ExtractError> {
    match builder.language() {
        SourceLanguage::Java | SourceLanguage::Kotlin | SourceLanguage::Scala
            if source.contains("Mapping") =>
        {
            scan_spring(builder, source)
        }
        SourceLanguage::CSharp
            if source.contains("[Route")
                || source.contains("[Http")
                || source.contains("MapGet") =>
        {
            scan_aspnet(builder, source)
        }
        _ => Ok(()),
    }
}

fn scan_spring(builder: &mut FrameworkBuilder<'_, '_>, source: &str) -> Result<(), ExtractError> {
    for class_index in 0..builder.original_symbol_count() {
        builder.check_cancelled()?;
        let Some(class) = original_declaration(builder, class_index, SymbolKind::Class) else {
            continue;
        };
        let class_context = declaration_context(source, class.start, class.end);
        let class_mapping = annotation_argument(class_context, "@RequestMapping");
        let base = class_mapping
            .as_ref()
            .map_or("", |argument| argument.value_or_empty());
        for method_index in 0..builder.original_symbol_count() {
            let Some(method) = original_callable(builder, method_index) else {
                continue;
            };
            if method.start < class.start || method.end > class.end {
                continue;
            }
            let method_context = declaration_context(source, method.start, method.end);
            let Some(mapping) = spring_mapping(method_context) else {
                continue;
            };
            let Some(path) = join_path(base, mapping.argument.value_or_empty()) else {
                continue;
            };
            let (name_start, name_end) = symbol_name_span(source, &method);
            let (start, end) = mapping
                .argument
                .span()
                .or_else(|| class_mapping.as_ref().and_then(AnnotationArgument::span))
                .unwrap_or((name_start, name_end));
            builder.add_route(
                mapping.method,
                &path,
                start,
                end,
                false,
                Some((&method.name, name_start, name_end)),
            )?;
        }
    }
    Ok(())
}

fn scan_aspnet(builder: &mut FrameworkBuilder<'_, '_>, source: &str) -> Result<(), ExtractError> {
    for class_index in 0..builder.original_symbol_count() {
        builder.check_cancelled()?;
        let Some(class) = original_declaration(builder, class_index, SymbolKind::Class) else {
            continue;
        };
        let class_context = declaration_context(source, class.start, class.end);
        let Some(class_route) = annotation_argument(class_context, "[Route") else {
            continue;
        };
        if matches!(class_route, AnnotationArgument::Dynamic) {
            continue;
        }
        let controller = class.name.strip_suffix("Controller").unwrap_or(&class.name);
        let Some(base) =
            replace_route_token(class_route.value_or_empty(), "controller", controller)
        else {
            continue;
        };
        for method_index in 0..builder.original_symbol_count() {
            let Some(method) = original_callable(builder, method_index) else {
                continue;
            };
            if method.start < class.start || method.end > class.end {
                continue;
            }
            let method_context = declaration_context(source, method.start, method.end);
            let Some(http) = aspnet_http_mapping(method_context) else {
                continue;
            };
            let route_override = annotation_argument(method_context, "[Route");
            let selected = match route_override.as_ref() {
                Some(AnnotationArgument::Dynamic) => continue,
                Some(argument) => argument,
                None => &http.argument,
            };
            if matches!(selected, AnnotationArgument::Dynamic) {
                continue;
            }
            let Some(subpath) =
                replace_route_token(selected.value_or_empty(), "action", &method.name)
            else {
                continue;
            };
            let (effective_base, effective_subpath) =
                if let Some(absolute) = subpath.strip_prefix("~/") {
                    ("", absolute)
                } else if subpath.starts_with('/') {
                    ("", subpath.as_str())
                } else {
                    (base.as_str(), subpath.as_str())
                };
            let Some(path) = join_path(effective_base, effective_subpath) else {
                continue;
            };
            let (name_start, name_end) = symbol_name_span(source, &method);
            let (start, end) = selected
                .span()
                .or_else(|| class_route.span())
                .unwrap_or((name_start, name_end));
            builder.add_route(
                http.method,
                &path,
                start,
                end,
                false,
                Some((&method.name, name_start, name_end)),
            )?;
        }
    }
    Ok(())
}

struct Mapping<'source> {
    method: &'static str,
    argument: AnnotationArgument<'source>,
}

fn spring_mapping(context: DeclarationContext<'_>) -> Option<Mapping<'_>> {
    for (annotation, method) in [
        ("@GetMapping", "GET"),
        ("@PostMapping", "POST"),
        ("@PutMapping", "PUT"),
        ("@PatchMapping", "PATCH"),
        ("@DeleteMapping", "DELETE"),
    ] {
        if let Some(argument) = annotation_argument(context, annotation) {
            return Some(Mapping { method, argument });
        }
    }
    let argument = annotation_argument(context, "@RequestMapping")?;
    let method = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]
        .into_iter()
        .find(|method| {
            context
                .iter()
                .any(|slice| slice.text.contains(&format!("RequestMethod.{method}")))
        })
        .unwrap_or("ANY");
    Some(Mapping { method, argument })
}

fn aspnet_http_mapping(context: DeclarationContext<'_>) -> Option<Mapping<'_>> {
    for (annotation, method) in [
        ("[HttpGet", "GET"),
        ("[HttpPost", "POST"),
        ("[HttpPut", "PUT"),
        ("[HttpPatch", "PATCH"),
        ("[HttpDelete", "DELETE"),
        ("[HttpHead", "HEAD"),
        ("[HttpOptions", "OPTIONS"),
    ] {
        if let Some(argument) = annotation_argument(context, annotation) {
            return Some(Mapping { method, argument });
        }
    }
    None
}

#[derive(Clone)]
struct OriginalDeclaration {
    name: String,
    start: usize,
    end: usize,
}

fn original_declaration(
    builder: &FrameworkBuilder<'_, '_>,
    index: usize,
    kind: SymbolKind,
) -> Option<OriginalDeclaration> {
    let symbol = builder.original_symbol(index)?;
    if symbol.kind != kind {
        return None;
    }
    Some(OriginalDeclaration {
        name: symbol.name.clone(),
        start: usize::try_from(symbol.span.start_byte()).ok()?,
        end: usize::try_from(symbol.span.end_byte()).ok()?,
    })
}

fn original_callable(
    builder: &FrameworkBuilder<'_, '_>,
    index: usize,
) -> Option<OriginalDeclaration> {
    let symbol = builder.original_symbol(index)?;
    if !matches!(symbol.kind, SymbolKind::Method | SymbolKind::Function) {
        return None;
    }
    Some(OriginalDeclaration {
        name: symbol.name.clone(),
        start: usize::try_from(symbol.span.start_byte()).ok()?,
        end: usize::try_from(symbol.span.end_byte()).ok()?,
    })
}

#[derive(Clone)]
enum AnnotationArgument<'source> {
    Empty,
    Literal {
        value: &'source str,
        start: usize,
        end: usize,
    },
    Dynamic,
}

impl<'source> AnnotationArgument<'source> {
    fn value_or_empty(&self) -> &'source str {
        match self {
            Self::Literal { value, .. } => value,
            Self::Empty | Self::Dynamic => "",
        }
    }

    const fn span(&self) -> Option<(usize, usize)> {
        match self {
            Self::Literal { start, end, .. } => Some((*start, *end)),
            Self::Empty | Self::Dynamic => None,
        }
    }
}

fn annotation_argument<'source>(
    context: DeclarationContext<'source>,
    marker: &str,
) -> Option<AnnotationArgument<'source>> {
    for slice in context {
        let text = slice.text;
        let mut cursor = 0_usize;
        while let Some(relative) = text[cursor..].find(marker) {
            let start = cursor + relative;
            if start > 0 && identifier_byte(text.as_bytes()[start - 1]) {
                cursor = start + marker.len();
                continue;
            }
            let after = skip_ascii_whitespace(text, start + marker.len());
            let closing = if marker.starts_with('[') { b']' } else { b')' };
            if marker.starts_with('[') && text.as_bytes().get(after) == Some(&b']') {
                return Some(AnnotationArgument::Empty);
            }
            if text.as_bytes().get(after) != Some(&b'(') {
                return Some(AnnotationArgument::Empty);
            }
            let close = matching_delimiter(text, after, b'(', b')')?;
            let argument = &text[after + 1..close];
            if argument.trim().is_empty() {
                return Some(AnnotationArgument::Empty);
            }
            if let Some(quoted) = first_quoted(argument, slice.offset + after + 1) {
                return Some(AnnotationArgument::Literal {
                    value: quoted.value,
                    start: quoted.start,
                    end: quoted.end,
                });
            }
            if closing == b']' || close < text.len() {
                return Some(AnnotationArgument::Dynamic);
            }
        }
    }
    None
}

struct Quoted<'source> {
    value: &'source str,
    start: usize,
    end: usize,
}

fn first_quoted(value: &str, offset: usize) -> Option<Quoted<'_>> {
    let mut cursor = 0_usize;
    while cursor < value.len() && !matches!(value.as_bytes()[cursor], b'\'' | b'"') {
        cursor += 1;
    }
    let quote = *value.as_bytes().get(cursor)?;
    let start = cursor + 1;
    cursor = start;
    let mut escaped = false;
    while cursor < value.len() {
        let byte = value.as_bytes()[cursor];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return Some(Quoted {
                value: &value[start..cursor],
                start: offset + start,
                end: offset + cursor,
            });
        }
        cursor += 1;
    }
    None
}

#[derive(Clone, Copy)]
struct ContextSlice<'source> {
    text: &'source str,
    offset: usize,
}

type DeclarationContext<'source> = [ContextSlice<'source>; 2];

fn declaration_context(source: &str, start: usize, end: usize) -> DeclarationContext<'_> {
    let bounded_start = start.saturating_sub(MAX_ANNOTATION_BYTES);
    let before = &source[bounded_start..start];
    let boundary = before.rfind(['}', ';', '{']).map_or(0, |offset| offset + 1);
    let prefix = &before[boundary..];
    let bounded_end = end.min(start.saturating_add(MAX_ANNOTATION_BYTES));
    let inline_end = first_unquoted_brace(&source[start..bounded_end])
        .map_or(bounded_end, |offset| start + offset);
    [
        ContextSlice {
            text: prefix,
            offset: bounded_start + boundary,
        },
        ContextSlice {
            text: &source[start..inline_end],
            offset: start,
        },
    ]
}

fn first_unquoted_brace(value: &str) -> Option<usize> {
    let mut quote = None;
    let mut escaped = false;
    for (index, byte) in value.bytes().enumerate() {
        if let Some(active_quote) = quote {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == active_quote {
                quote = None;
            }
        } else if matches!(byte, b'\'' | b'"') {
            quote = Some(byte);
        } else if byte == b'{' {
            return Some(index);
        }
    }
    None
}

fn symbol_name_span(source: &str, symbol: &OriginalDeclaration) -> (usize, usize) {
    let bounded_end = symbol
        .end
        .min(symbol.start.saturating_add(MAX_ANNOTATION_BYTES));
    source[symbol.start..bounded_end].find(&symbol.name).map_or(
        (symbol.start, symbol.end),
        |offset| {
            (
                symbol.start + offset,
                symbol.start + offset + symbol.name.len(),
            )
        },
    )
}

fn replace_route_token(value: &str, token: &str, replacement: &str) -> Option<String> {
    if value.len().saturating_add(replacement.len()) > MAX_ROUTE_BYTES {
        return None;
    }
    let lower = value.to_ascii_lowercase();
    let marker = format!("[{token}]");
    let Some(index) = lower.find(&marker) else {
        return Some(value.to_owned());
    };
    let mut output = String::new();
    output
        .try_reserve(value.len().saturating_add(replacement.len()))
        .ok()?;
    output.push_str(&value[..index]);
    output.push_str(replacement);
    output.push_str(&value[index + marker.len()..]);
    Some(output)
}

fn join_path(base: &str, subpath: &str) -> Option<String> {
    if base.len().saturating_add(subpath.len()) > MAX_ROUTE_BYTES {
        return None;
    }
    let mut path = String::new();
    path.try_reserve(base.len().saturating_add(subpath.len()).saturating_add(1))
        .ok()?;
    for segment in base.split('/').chain(subpath.split('/')) {
        let segment = segment.trim();
        if segment.is_empty() {
            continue;
        }
        path.push('/');
        path.push_str(segment);
    }
    if path.is_empty() {
        path.push('/');
    }
    Some(path)
}

fn identifier_byte(byte: u8) -> bool {
    byte == b'_' || byte == b'$' || byte.is_ascii_alphanumeric()
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
        if matches!(byte, b'\'' | b'"') {
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
