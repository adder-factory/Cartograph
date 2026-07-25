use crate::model::ScipError;

const PACKAGE_FIELD_COUNT: usize = 4;
const MAXIMUM_DESCRIPTOR_COUNT: usize = 512;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DescriptorSuffix {
    Namespace,
    Type,
    Term,
    Method,
    TypeParameter,
    Parameter,
    Meta,
    Macro,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Descriptor {
    pub(crate) name: String,
    pub(crate) suffix: DescriptorSuffix,
    pub(crate) disambiguator: String,
}

impl Descriptor {
    pub(crate) fn new(name: impl Into<String>, suffix: DescriptorSuffix) -> Self {
        Self {
            name: name.into(),
            suffix,
            disambiguator: String::new(),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ScipPackage<'a> {
    pub(crate) manager: &'a str,
    pub(crate) name: &'a str,
    pub(crate) version: &'a str,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ParsedSymbol {
    pub(crate) descriptors: Vec<Descriptor>,
}

pub(crate) fn build_symbol_string(
    scheme: &str,
    package: &ScipPackage<'_>,
    descriptors: &[Descriptor],
) -> Result<String, ScipError> {
    if descriptors.is_empty() || descriptors.len() > MAXIMUM_DESCRIPTOR_COUNT {
        return Err(ScipError::InvalidData);
    }
    let mut symbol = String::new();
    push_package_part(&mut symbol, scheme)?;
    symbol.push(' ');
    push_package_part(&mut symbol, package.manager)?;
    symbol.push(' ');
    push_package_part(&mut symbol, package.name)?;
    symbol.push(' ');
    push_package_part(&mut symbol, package.version)?;
    symbol.push(' ');
    for descriptor in descriptors {
        push_descriptor(&mut symbol, descriptor)?;
    }
    Ok(symbol)
}

pub(crate) fn append_meta_descriptor(symbol: &mut String, value: &str) -> Result<(), ScipError> {
    push_descriptor(
        symbol,
        &Descriptor::new(value.to_owned(), DescriptorSuffix::Meta),
    )
}

pub(crate) fn parse_scip_symbol(symbol: &str) -> Option<ParsedSymbol> {
    if symbol.starts_with("local ") || symbol.is_empty() {
        return None;
    }
    let mut position = 0_usize;
    for _ in 0..PACKAGE_FIELD_COUNT {
        position = consume_package_part(symbol, position)?;
    }
    let descriptors = parse_descriptors(symbol.get(position..)?)?;
    Some(ParsedSymbol { descriptors })
}

pub(crate) fn descriptors_to_qualified_name(descriptors: &[Descriptor]) -> String {
    let first_non_namespace = descriptors
        .iter()
        .position(|descriptor| descriptor.suffix != DescriptorSuffix::Namespace)
        .unwrap_or(descriptors.len().saturating_sub(1));
    descriptors[first_non_namespace..]
        .iter()
        .filter(|descriptor| descriptor.suffix != DescriptorSuffix::Meta)
        .map(|descriptor| descriptor.name.as_str())
        .collect::<Vec<_>>()
        .join("::")
}

fn push_package_part(output: &mut String, value: &str) -> Result<(), ScipError> {
    let value = if value.is_empty() { "." } else { value };
    if value.contains('\0') {
        return Err(ScipError::InvalidData);
    }
    for character in value.chars() {
        output.push(character);
        if character == ' ' {
            output.push(' ');
        }
    }
    Ok(())
}

fn push_descriptor(output: &mut String, descriptor: &Descriptor) -> Result<(), ScipError> {
    if descriptor.name.contains('\0') {
        return Err(ScipError::InvalidData);
    }
    let name = escaped_name(&descriptor.name);
    match descriptor.suffix {
        DescriptorSuffix::Namespace => {
            output.push_str(&name);
            output.push('/');
        }
        DescriptorSuffix::Type => {
            output.push_str(&name);
            output.push('#');
        }
        DescriptorSuffix::Term => {
            output.push_str(&name);
            output.push('.');
        }
        DescriptorSuffix::Method => {
            output.push_str(&name);
            output.push('(');
            output.push_str(&descriptor.disambiguator);
            output.push_str(").");
        }
        DescriptorSuffix::TypeParameter => {
            output.push('[');
            output.push_str(&name);
            output.push(']');
        }
        DescriptorSuffix::Parameter => {
            output.push('(');
            output.push_str(&name);
            output.push(')');
        }
        DescriptorSuffix::Meta => {
            output.push_str(&name);
            output.push(':');
        }
        DescriptorSuffix::Macro => {
            output.push_str(&name);
            output.push('!');
        }
    }
    Ok(())
}

fn escaped_name(name: &str) -> String {
    if !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'+' | b'$' | b'-'))
    {
        return name.to_owned();
    }
    let mut escaped = String::with_capacity(name.len().saturating_add(2));
    escaped.push('`');
    for character in name.chars() {
        escaped.push(character);
        if character == '`' {
            escaped.push('`');
        }
    }
    escaped.push('`');
    escaped
}

fn consume_package_part(symbol: &str, mut position: usize) -> Option<usize> {
    let bytes = symbol.as_bytes();
    let mut saw_value = false;
    while position < bytes.len() {
        if bytes[position] != b' ' {
            saw_value = true;
            position = position.checked_add(1)?;
            continue;
        }
        if bytes.get(position.checked_add(1)?) == Some(&b' ') {
            saw_value = true;
            position = position.checked_add(2)?;
            continue;
        }
        return saw_value.then_some(position.checked_add(1)?);
    }
    None
}

fn parse_descriptors(input: &str) -> Option<Vec<Descriptor>> {
    let mut descriptors = Vec::new();
    let mut position = 0_usize;
    while position < input.len() {
        if descriptors.len() >= MAXIMUM_DESCRIPTOR_COUNT {
            return None;
        }
        let byte = *input.as_bytes().get(position)?;
        if matches!(byte, b'(' | b'[') {
            let (descriptor, next) = parse_bracket_descriptor(input, position, byte)?;
            descriptors.push(descriptor);
            position = next;
            continue;
        }
        let (name, after_name) = parse_name(input, position)?;
        let suffix = *input.as_bytes().get(after_name)?;
        if suffix == b'(' {
            let close = input
                .get(after_name + 1..)?
                .find(").")
                .map(|value| value + after_name + 1)?;
            let disambiguator = input.get(after_name + 1..close)?.to_owned();
            descriptors.push(Descriptor {
                name,
                suffix: DescriptorSuffix::Method,
                disambiguator,
            });
            position = close.checked_add(2)?;
            continue;
        }
        let suffix = match suffix {
            b'/' => DescriptorSuffix::Namespace,
            b'#' => DescriptorSuffix::Type,
            b'.' => DescriptorSuffix::Term,
            b':' => DescriptorSuffix::Meta,
            b'!' => DescriptorSuffix::Macro,
            _ => return None,
        };
        descriptors.push(Descriptor {
            name,
            suffix,
            disambiguator: String::new(),
        });
        position = after_name.checked_add(1)?;
    }
    (!descriptors.is_empty()).then_some(descriptors)
}

fn parse_bracket_descriptor(
    input: &str,
    position: usize,
    opening: u8,
) -> Option<(Descriptor, usize)> {
    let closing = if opening == b'(' { b')' } else { b']' };
    let (name, after_name) = parse_name(input, position.checked_add(1)?)?;
    (*input.as_bytes().get(after_name)? == closing).then_some((
        Descriptor {
            name,
            suffix: if opening == b'(' {
                DescriptorSuffix::Parameter
            } else {
                DescriptorSuffix::TypeParameter
            },
            disambiguator: String::new(),
        },
        after_name.checked_add(1)?,
    ))
}

fn parse_name(input: &str, position: usize) -> Option<(String, usize)> {
    if input.as_bytes().get(position) == Some(&b'`') {
        let mut name = String::new();
        let mut cursor = position.checked_add(1)?;
        while cursor < input.len() {
            let character = input.get(cursor..)?.chars().next()?;
            if character == '`' {
                let next = cursor.checked_add(1)?;
                if input.as_bytes().get(next) == Some(&b'`') {
                    name.push('`');
                    cursor = next.checked_add(1)?;
                    continue;
                }
                return Some((name, next));
            }
            name.push(character);
            cursor = cursor.checked_add(character.len_utf8())?;
        }
        return None;
    }
    let mut cursor = position;
    while let Some(byte) = input.as_bytes().get(cursor) {
        if !(byte.is_ascii_alphanumeric() || matches!(*byte, b'_' | b'+' | b'$' | b'-')) {
            break;
        }
        cursor = cursor.checked_add(1)?;
    }
    (cursor > position).then(|| (input[position..cursor].to_owned(), cursor))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn symbol_round_trip_preserves_escaped_names_and_qualified_name() {
        let descriptors = vec![
            Descriptor::new("src/a b.rs", DescriptorSuffix::Namespace),
            Descriptor::new("outer", DescriptorSuffix::Type),
            Descriptor::new("do`work", DescriptorSuffix::Method),
        ];
        let symbol = build_symbol_string(
            "cartograph",
            &ScipPackage {
                manager: "cartograph",
                name: "my project",
                version: "1",
            },
            &descriptors,
        )
        .unwrap_or_else(|error| panic!("symbol encode failed: {error}"));
        let parsed = parse_scip_symbol(&symbol)
            .unwrap_or_else(|| panic!("symbol parse failed for {symbol}"));
        assert_eq!(
            descriptors_to_qualified_name(&parsed.descriptors),
            "outer::do`work"
        );
    }
}
