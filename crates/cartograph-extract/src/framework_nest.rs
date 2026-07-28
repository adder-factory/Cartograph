use cartograph_domain::{SourceLanguage, SymbolKind};

use crate::{
    ExtractError,
    framework::{
        DelimiterInput, FrameworkBuilder, LandmarkInput, javascript_identifier_at as identifier_at,
        join_route_paths, matching_delimiter, skip_ascii_whitespace,
    },
};

const MAX_DECORATOR_SCAN_BYTES: usize = 4_096;
const MAX_METHOD_DECORATORS: usize = 32;
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
    ) || !(source.contains("@Controller")
        || source.contains("@Resolver")
        || source.contains("@WebSocketGateway"))
    {
        return Ok(());
    }
    let mut cursor = 0_usize;
    while let Some(relative) = source[cursor..].find("class") {
        builder.check_cancelled()?;
        let keyword = cursor + relative;
        if !keyword_boundary(source, keyword, "class") {
            cursor = keyword + "class".len();
            continue;
        }
        let class_name_start = skip_ascii_whitespace(source, keyword + "class".len());
        let Some((class_name_end, class_name)) = identifier_at(source, class_name_start) else {
            cursor = keyword + "class".len();
            continue;
        };
        let Some(open) = source[class_name_end..]
            .find('{')
            .map(|offset| class_name_end + offset)
        else {
            cursor = class_name_end;
            continue;
        };
        let Some(close) = matching_brace(source, open) else {
            cursor = open + 1;
            continue;
        };
        let prefix_start = declaration_prefix_start(source, keyword);
        let prefix = &source[prefix_start..keyword];
        let controller = find_decorator(prefix, prefix_start, "Controller");
        let resolver = find_decorator(prefix, prefix_start, "Resolver");
        let gateway = find_decorator(prefix, prefix_start, "WebSocketGateway");
        if controller.is_none() && resolver.is_none() && gateway.is_none() {
            cursor = close + 1;
            continue;
        }
        let controller_path = controller
            .as_ref()
            .map(decorator_static_argument)
            .unwrap_or(StaticArgument::Empty);
        scan_class_methods(
            builder,
            source,
            ClassRouteContext {
                class_name,
                body_start: open + 1,
                body_end: close,
                controller: controller.is_some(),
                controller_path,
                resolver: resolver.is_some(),
                gateway: gateway.is_some(),
            },
        )?;
        cursor = close + 1;
    }
    Ok(())
}

struct ClassRouteContext<'source> {
    class_name: &'source str,
    body_start: usize,
    body_end: usize,
    controller: bool,
    controller_path: StaticArgument<'source>,
    resolver: bool,
    gateway: bool,
}

fn scan_class_methods(
    builder: &mut FrameworkBuilder<'_, '_>,
    source: &str,
    context: ClassRouteContext<'_>,
) -> Result<(), ExtractError> {
    let mut cursor = context.body_start;
    while cursor < context.body_end {
        builder.check_cancelled()?;
        let Some(relative) = source[cursor..context.body_end].find('@') else {
            break;
        };
        let decorator_start = cursor + relative;
        let (decorators, after_decorators) =
            consecutive_decorators(source, decorator_start, context.body_end)?;
        if decorators.is_empty() {
            cursor = decorator_start + 1;
            continue;
        }
        let Some(method) = method_after_decorators(source, after_decorators, context.body_end)
        else {
            cursor = after_decorators.max(decorator_start + 1);
            continue;
        };
        for decorator in &decorators {
            if let Some(method_name) = http_method(decorator.name) {
                if context.controller {
                    add_http_route(
                        builder,
                        HttpRouteInput {
                            context: &context,
                            decorator,
                            method: &method,
                            http_method: method_name,
                        },
                    )?;
                }
            } else if let Some(label) = graphql_label(decorator.name) {
                if context.resolver {
                    add_named_route(
                        builder,
                        NamedRouteInput {
                            context: &context,
                            decorator,
                            method: &method,
                            label,
                            value: method.name,
                        },
                    )?;
                }
            } else if let Some(label) = rpc_label(decorator.name)
                && (context.controller || context.gateway)
                && let StaticArgument::Literal { value, .. } = decorator_static_argument(decorator)
            {
                add_named_route(
                    builder,
                    NamedRouteInput {
                        context: &context,
                        decorator,
                        method: &method,
                        label,
                        value,
                    },
                )?;
            }
        }
        cursor = method
            .body_end
            .unwrap_or(method.name_end)
            .max(after_decorators);
    }
    Ok(())
}

struct HttpRouteInput<'input, 'source> {
    context: &'input ClassRouteContext<'source>,
    decorator: &'input Decorator<'source>,
    method: &'input Method<'source>,
    http_method: &'static str,
}

fn add_http_route(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: HttpRouteInput<'_, '_>,
) -> Result<(), ExtractError> {
    let HttpRouteInput {
        context,
        decorator,
        method,
        http_method,
    } = input;
    let method_path = decorator_static_argument(decorator);
    let (StaticArgument::Empty | StaticArgument::Literal { .. }) = context.controller_path else {
        return Ok(());
    };
    let (StaticArgument::Empty | StaticArgument::Literal { .. }) = method_path else {
        return Ok(());
    };
    let base = context.controller_path.value_or_empty();
    let subpath = method_path.value_or_empty();
    let Some(path) = join_route_paths(base, subpath) else {
        return Ok(());
    };
    let (start, end) = method_path
        .span()
        .or_else(|| context.controller_path.span())
        .unwrap_or((method.name_start, method.name_end));
    builder.add_landmark(LandmarkInput {
        kind: SymbolKind::Route,
        name: format!("{http_method} {path}"),
        identity: format!(
            "nestjs-http::{class_name}::{http_method}::{path}::{handler}",
            class_name = context.class_name,
            handler = method.name,
        ),
        start,
        end,
        body_search_text: format!(
            "nestjs controller route {http_method} {path} {} {}",
            context.class_name, method.name
        ),
        target: Some((method.name, None, method.name_start, method.name_end)),
    })
}

struct NamedRouteInput<'input, 'source> {
    context: &'input ClassRouteContext<'source>,
    decorator: &'input Decorator<'source>,
    method: &'input Method<'source>,
    label: &'input str,
    value: &'input str,
}

fn add_named_route(
    builder: &mut FrameworkBuilder<'_, '_>,
    input: NamedRouteInput<'_, '_>,
) -> Result<(), ExtractError> {
    let NamedRouteInput {
        context,
        decorator,
        method,
        label,
        value,
    } = input;
    if value.len() > MAX_ROUTE_BYTES {
        return Ok(());
    }
    let (start, end) = decorator
        .literal
        .as_ref()
        .map(|literal| (literal.start, literal.end))
        .unwrap_or((method.name_start, method.name_end));
    let name = if value.is_empty() {
        label.to_owned()
    } else {
        format!("{label} {value}")
    };
    builder.add_landmark(LandmarkInput {
        kind: SymbolKind::Route,
        name: name.clone(),
        identity: format!(
            "nestjs-named::{class_name}::{label}::{value}::{handler}",
            class_name = context.class_name,
            handler = method.name,
        ),
        start,
        end,
        body_search_text: format!(
            "nestjs framework route {name} {} {}",
            context.class_name, method.name
        ),
        target: Some((method.name, None, method.name_start, method.name_end)),
    })
}

fn http_method(name: &str) -> Option<&'static str> {
    match name {
        "Get" => Some("GET"),
        "Post" => Some("POST"),
        "Put" => Some("PUT"),
        "Patch" => Some("PATCH"),
        "Delete" => Some("DELETE"),
        "Head" => Some("HEAD"),
        "Options" => Some("OPTIONS"),
        "All" => Some("ALL"),
        _ => None,
    }
}

fn graphql_label(name: &str) -> Option<&'static str> {
    match name {
        "Query" => Some("GraphQL Query"),
        "Mutation" => Some("GraphQL Mutation"),
        "Subscription" => Some("GraphQL Subscription"),
        _ => None,
    }
}

fn rpc_label(name: &str) -> Option<&'static str> {
    match name {
        "MessagePattern" => Some("MessagePattern"),
        "EventPattern" => Some("EventPattern"),
        "SubscribeMessage" => Some("WebSocket"),
        _ => None,
    }
}

#[derive(Clone, Copy)]
enum StaticArgument<'source> {
    Empty,
    Literal {
        value: &'source str,
        start: usize,
        end: usize,
    },
    Dynamic,
}

impl<'source> StaticArgument<'source> {
    const fn value_or_empty(self) -> &'source str {
        match self {
            Self::Literal { value, .. } => value,
            Self::Empty | Self::Dynamic => "",
        }
    }

    const fn span(self) -> Option<(usize, usize)> {
        match self {
            Self::Literal { start, end, .. } => Some((start, end)),
            Self::Empty | Self::Dynamic => None,
        }
    }
}

fn decorator_static_argument<'source>(decorator: &Decorator<'source>) -> StaticArgument<'source> {
    if decorator.argument.trim().is_empty() {
        StaticArgument::Empty
    } else if let Some(literal) = decorator.literal.as_ref()
        && decorator
            .argument
            .trim_start()
            .starts_with(['\'', '"', '`'])
    {
        StaticArgument::Literal {
            value: literal.value,
            start: literal.start,
            end: literal.end,
        }
    } else {
        StaticArgument::Dynamic
    }
}

struct Decorator<'source> {
    name: &'source str,
    argument: &'source str,
    literal: Option<Quoted<'source>>,
    end: usize,
}

struct Quoted<'source> {
    value: &'source str,
    start: usize,
    end: usize,
}

fn find_decorator<'source>(
    source: &'source str,
    source_offset: usize,
    expected: &str,
) -> Option<Decorator<'source>> {
    let marker = format!("@{expected}");
    let mut cursor = 0_usize;
    let mut selected = None;
    while let Some(relative) = source[cursor..].find(&marker) {
        let start = cursor + relative;
        let name_start = start + 1;
        let (name_end, name) = identifier_at(source, name_start)?;
        if name != expected {
            cursor = name_end;
            continue;
        }
        selected = parse_decorator(source, source_offset, start);
        cursor = selected
            .as_ref()
            .map_or(name_end, |value| value.end - source_offset);
    }
    selected
}

fn consecutive_decorators(
    source: &str,
    start: usize,
    limit: usize,
) -> Result<(Vec<Decorator<'_>>, usize), ExtractError> {
    let mut decorators = Vec::new();
    decorators
        .try_reserve_exact(MAX_METHOD_DECORATORS)
        .map_err(|_| ExtractError::OutputLimit)?;
    let mut cursor = start;
    while decorators.len() < MAX_METHOD_DECORATORS {
        cursor = skip_ascii_whitespace(source, cursor);
        if cursor >= limit || source.as_bytes().get(cursor) != Some(&b'@') {
            break;
        }
        let Some(decorator) = parse_decorator(&source[..limit], 0, cursor) else {
            break;
        };
        cursor = decorator.end;
        decorators.push(decorator);
    }
    Ok((decorators, cursor))
}

fn parse_decorator<'source>(
    source: &'source str,
    source_offset: usize,
    start: usize,
) -> Option<Decorator<'source>> {
    let (name_end, name) = identifier_at(source, start + 1)?;
    let open = skip_ascii_whitespace(source, name_end);
    if source.as_bytes().get(open) != Some(&b'(') {
        return Some(Decorator {
            name,
            argument: "",
            literal: None,
            end: source_offset + name_end,
        });
    }
    let close = matching_delimiter(DelimiterInput::parentheses(source, open))?;
    let argument = &source[open + 1..close];
    let literal = quoted_at_argument(argument, source_offset + open + 1);
    Some(Decorator {
        name,
        argument,
        literal,
        end: source_offset + close + 1,
    })
}

fn quoted_at_argument(argument: &str, offset: usize) -> Option<Quoted<'_>> {
    let leading = argument.len().saturating_sub(argument.trim_start().len());
    let quote = *argument.as_bytes().get(leading)?;
    if !matches!(quote, b'\'' | b'"' | b'`') {
        return None;
    }
    let start = leading + 1;
    let mut cursor = start;
    let mut escaped = false;
    while cursor < argument.len() {
        let byte = argument.as_bytes()[cursor];
        if escaped {
            escaped = false;
        } else if byte == b'\\' {
            escaped = true;
        } else if byte == quote {
            return Some(Quoted {
                value: &argument[start..cursor],
                start: offset + start,
                end: offset + cursor,
            });
        }
        cursor += 1;
    }
    None
}

struct Method<'source> {
    name: &'source str,
    name_start: usize,
    name_end: usize,
    body_end: Option<usize>,
}

fn method_after_decorators<'source>(
    source: &'source str,
    start: usize,
    class_end: usize,
) -> Option<Method<'source>> {
    let limit = class_end.min(start.saturating_add(MAX_DECORATOR_SCAN_BYTES));
    let mut cursor = start;
    while cursor < limit {
        let identifier_start = skip_to_identifier(source, cursor, limit)?;
        let (name_end, name) = identifier_at(source, identifier_start)?;
        let after = skip_ascii_whitespace(source, name_end);
        if source.as_bytes().get(after) == Some(&b'(')
            && !matches!(
                name,
                "if" | "for" | "while" | "switch" | "catch" | "constructor"
            )
        {
            let params_close = matching_delimiter(DelimiterInput::parentheses(source, after))?;
            let body_open = source[params_close + 1..limit]
                .find('{')
                .map(|offset| params_close + 1 + offset);
            let body_end = body_open
                .and_then(|open| matching_delimiter(DelimiterInput::braces(source, open)))
                .map(|close| close + 1);
            return Some(Method {
                name,
                name_start: identifier_start,
                name_end,
                body_end,
            });
        }
        cursor = name_end;
    }
    None
}

fn declaration_prefix_start(source: &str, declaration: usize) -> usize {
    let bounded = declaration.saturating_sub(MAX_DECORATOR_SCAN_BYTES);
    let prefix = &source[bounded..declaration];
    prefix
        .rfind(['}', ';'])
        .map_or(bounded, |offset| bounded + offset + 1)
}

fn keyword_boundary(source: &str, start: usize, keyword: &str) -> bool {
    source
        .as_bytes()
        .get(start.saturating_sub(1))
        .is_none_or(|byte| !identifier_byte(*byte))
        && source
            .as_bytes()
            .get(start + keyword.len())
            .is_none_or(|byte| !identifier_byte(*byte))
}

fn identifier_byte(byte: u8) -> bool {
    byte == b'_' || byte == b'$' || byte.is_ascii_alphanumeric()
}

fn skip_to_identifier(value: &str, mut cursor: usize, limit: usize) -> Option<usize> {
    while cursor < limit {
        let byte = value.as_bytes()[cursor];
        if byte == b'_' || byte == b'$' || byte.is_ascii_alphabetic() {
            return Some(cursor);
        }
        if matches!(byte, b';' | b'{' | b'}') {
            return None;
        }
        cursor += 1;
    }
    None
}

fn matching_brace(value: &str, open: usize) -> Option<usize> {
    matching_delimiter(DelimiterInput::braces(value, open))
}
