/// Apply one TypeScript-style wildcard substitution to a matched module tail.
///
/// Callers validate and bound the pattern source before reaching this shared
/// allocation helper. A substitution without a wildcard is returned unchanged.
#[must_use]
pub fn substitute_module_alias(substitution: &str, tail: &str) -> String {
    let Some(wildcard) = substitution.find('*') else {
        return substitution.to_owned();
    };
    format!(
        "{}{tail}{}",
        &substitution[..wildcard],
        &substitution[wildcard + 1..]
    )
}
