use std::fmt;

use num_traits::ToPrimitive as _;
use serde::{
    Deserialize, Deserializer,
    de::{IgnoredAny, MapAccess, SeqAccess, Visitor},
};

#[cfg(test)]
use super::SOURCE_JSON_EXPANSION_FACTOR;
use super::{
    LegacyEdgeMetadata, MAXIMUM_LEGACY_ARRAY_ITEMS, MAXIMUM_LEGACY_ERROR_ITEMS,
    MAXIMUM_LEGACY_JSON_DEPTH, MAXIMUM_LEGACY_NAME_BYTES, V1PostgresImportError, invalid_source,
};

macro_rules! drain_seq {
    ($sequence:ident) => {
        while $sequence.next_element::<IgnoredAny>()?.is_some() {}
    };
}

macro_rules! drain_map {
    ($map:ident) => {
        while $map.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
    };
}

macro_rules! tolerant_non_array_visits {
    ($type:ident) => {
        fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            drain_map!(map);
            Ok($type::default())
        }
    };
}

macro_rules! tolerant_scalar_and_container_visits {
    ($type:ident) => {
        fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            drain_seq!(sequence);
            Ok($type::default())
        }
        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            drain_map!(map);
            Ok($type::default())
        }
    };
}

macro_rules! tolerant_non_integer_visits {
    ($type:ident) => {
        fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            drain_seq!(sequence);
            Ok($type::default())
        }
        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            drain_map!(map);
            Ok($type::default())
        }
    };
}

macro_rules! tolerant_non_number_visits {
    ($type:ident) => {
        fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok($type::default())
        }
        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            drain_seq!(sequence);
            Ok($type::default())
        }
        fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
        where
            A: MapAccess<'de>,
        {
            drain_map!(map);
            Ok($type::default())
        }
    };
}

macro_rules! invalid_extraction_error_visits {
    () => {
        fn visit_bool<E>(self, _value: bool) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_i64<E>(self, _value: i64) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_u64<E>(self, _value: u64) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_f64<E>(self, _value: f64) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_str<E>(self, _value: &str) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_string<E>(self, _value: String) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_unit<E>(self) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_none<E>(self) -> Result<Self::Value, E> {
            Ok(ExtractionErrorValidity(false))
        }
        fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
        where
            A: SeqAccess<'de>,
        {
            drain_seq!(sequence);
            Ok(ExtractionErrorValidity(false))
        }
    };
}

pub(super) fn parse_legacy_edge_metadata(
    raw: Option<&str>,
) -> Result<LegacyEdgeMetadata, V1PostgresImportError> {
    let Some(raw) = raw.filter(|value| json_nesting_within_limit(value)) else {
        return Ok(LegacyEdgeMetadata::default());
    };
    let Ok(parsed) = serde_json::from_str::<RawEdgeMetadata>(raw) else {
        return Ok(LegacyEdgeMetadata::default());
    };
    if parsed.extra_lines.overflow || parsed.def_use_lines.overflow {
        return Err(V1PostgresImportError::SourceLimit);
    }
    let provenance = [
        ("resolvedBy", parsed.resolved_by),
        ("synthesizedBy", parsed.synthesized_by),
        ("hook", parsed.hook),
    ]
    .into_iter()
    .find_map(|(field, value)| {
        value.and_then(|value| {
            validate_metadata_text(&value, "edge_provenance")
                .is_ok()
                .then(|| format!("{field}:{value}"))
        })
    });
    let numeric_confidence = parsed
        .confidence
        .filter(|value| value.is_finite() && (0.0..=1.0).contains(value))
        .and_then(|value| value.to_f32());
    let parsed_site_count = parsed
        .site_count
        .and_then(|value| u32::try_from(value).ok())
        .filter(|value| *value > 0);
    let site_count = parsed_site_count.unwrap_or(1);
    let mut extra_lines = if parsed_site_count.is_some() {
        parsed.extra_lines.into_valid()
    } else {
        Vec::new()
    };
    if extra_lines.len() >= usize::try_from(site_count).unwrap_or(usize::MAX) {
        extra_lines.clear();
    }
    let def_use_name = parsed.name.and_then(|value| {
        validate_metadata_text(&value, "def_use_name")
            .is_ok()
            .then_some(value)
    });
    Ok(LegacyEdgeMetadata {
        provenance,
        numeric_confidence,
        site_count,
        extra_lines,
        def_use_name,
        def_use_lines: parsed.def_use_lines.into_valid(),
    })
}

pub(super) fn parse_legacy_string_array(
    raw: Option<&str>,
    field: &'static str,
) -> Result<Vec<String>, V1PostgresImportError> {
    let Some(raw) = raw.filter(|value| json_nesting_within_limit(value)) else {
        return Ok(Vec::new());
    };
    let Ok(parsed) = serde_json::from_str::<BoundedStringArray>(raw) else {
        return Ok(Vec::new());
    };
    if parsed.overflow {
        return Err(V1PostgresImportError::SourceLimit);
    }
    if !parsed.valid
        || parsed
            .values
            .iter()
            .any(|value| validate_metadata_text(value, field).is_err())
    {
        return Ok(Vec::new());
    }
    Ok(parsed.values)
}

pub(super) fn parse_legacy_u32_array(
    raw: Option<&str>,
    _field: &'static str,
) -> Result<Vec<u32>, V1PostgresImportError> {
    let Some(raw) = raw.filter(|value| json_nesting_within_limit(value)) else {
        return Ok(Vec::new());
    };
    let Ok(parsed) = serde_json::from_str::<BoundedU32Array>(raw) else {
        return Ok(Vec::new());
    };
    if parsed.overflow {
        Err(V1PostgresImportError::SourceLimit)
    } else {
        Ok(parsed.into_valid())
    }
}

pub(super) fn has_valid_extraction_errors(raw: Option<&str>) -> bool {
    let Some(raw) = raw.filter(|value| json_nesting_within_limit(value)) else {
        return false;
    };
    serde_json::from_str::<ExtractionErrorArray>(raw)
        .is_ok_and(|parsed| parsed.valid && !parsed.overflow && parsed.items > 0)
}

fn validate_metadata_text(value: &str, field: &'static str) -> Result<(), V1PostgresImportError> {
    if value.trim().is_empty()
        || value.len() > MAXIMUM_LEGACY_NAME_BYTES
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        Err(invalid_source(field))
    } else {
        Ok(())
    }
}

fn json_nesting_within_limit(raw: &str) -> bool {
    let mut nesting = JsonNesting::default();
    raw.bytes().all(|byte| nesting.observe(byte)) && nesting.is_complete()
}

#[derive(Default)]
struct JsonNesting {
    depth: usize,
    in_string: bool,
    escaped: bool,
}

impl JsonNesting {
    fn observe(&mut self, byte: u8) -> bool {
        if self.in_string {
            self.observe_string_byte(byte);
            true
        } else {
            self.observe_structure_byte(byte)
        }
    }

    fn observe_string_byte(&mut self, byte: u8) {
        if self.escaped {
            self.escaped = false;
        } else if byte == b'\\' {
            self.escaped = true;
        } else if byte == b'"' {
            self.in_string = false;
        }
    }

    fn observe_structure_byte(&mut self, byte: u8) -> bool {
        match byte {
            b'"' => self.in_string = true,
            b'{' | b'[' => return self.increment_depth(),
            b'}' | b']' => return self.decrement_depth(),
            _ => {}
        }
        true
    }

    fn increment_depth(&mut self) -> bool {
        let Some(depth) = self.depth.checked_add(1) else {
            return false;
        };
        if depth > MAXIMUM_LEGACY_JSON_DEPTH {
            return false;
        }
        self.depth = depth;
        true
    }

    fn decrement_depth(&mut self) -> bool {
        let Some(depth) = self.depth.checked_sub(1) else {
            return false;
        };
        self.depth = depth;
        true
    }

    const fn is_complete(&self) -> bool {
        self.depth == 0 && !self.in_string && !self.escaped
    }
}

#[derive(Default)]
struct RawEdgeMetadata {
    resolved_by: Option<String>,
    synthesized_by: Option<String>,
    hook: Option<String>,
    confidence: Option<f64>,
    site_count: Option<u64>,
    extra_lines: BoundedU32Array,
    name: Option<String>,
    def_use_lines: BoundedU32Array,
}

impl<'de> Deserialize<'de> for RawEdgeMetadata {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_map(RawEdgeMetadataVisitor)
    }
}

struct RawEdgeMetadataVisitor;

impl<'de> Visitor<'de> for RawEdgeMetadataVisitor {
    type Value = RawEdgeMetadata;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a legacy edge metadata object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut parsed = RawEdgeMetadata::default();
        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "resolvedBy" => parsed.resolved_by = map.next_value::<OptionalText>()?.0,
                "synthesizedBy" => parsed.synthesized_by = map.next_value::<OptionalText>()?.0,
                "hook" => parsed.hook = map.next_value::<OptionalText>()?.0,
                "confidence" => parsed.confidence = map.next_value::<OptionalF64>()?.0,
                "siteCount" => parsed.site_count = map.next_value::<OptionalU64>()?.0,
                "extraLines" => parsed.extra_lines = map.next_value()?,
                "name" => parsed.name = map.next_value::<OptionalText>()?.0,
                "useLines" => parsed.def_use_lines = map.next_value()?,
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(parsed)
    }
}

#[derive(Default)]
struct BoundedStringArray {
    values: Vec<String>,
    valid: bool,
    overflow: bool,
}

impl<'de> Deserialize<'de> for BoundedStringArray {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BoundedStringArrayVisitor)
    }
}

struct BoundedStringArrayVisitor;

impl<'de> Visitor<'de> for BoundedStringArrayVisitor {
    type Value = BoundedStringArray;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded string array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut parsed = BoundedStringArray {
            valid: true,
            ..BoundedStringArray::default()
        };
        while let Some(value) = sequence.next_element::<OptionalText>()? {
            if parsed.values.len() >= MAXIMUM_LEGACY_ARRAY_ITEMS {
                parsed.overflow = true;
                continue;
            }
            match value.0 {
                Some(value) => parsed.values.push(value),
                None => parsed.valid = false,
            }
        }
        Ok(parsed)
    }

    tolerant_non_array_visits!(BoundedStringArray);
}

#[derive(Default)]
struct BoundedU32Array {
    values: Vec<u32>,
    valid: bool,
    overflow: bool,
}

impl BoundedU32Array {
    fn into_valid(self) -> Vec<u32> {
        if self.valid { self.values } else { Vec::new() }
    }
}

impl<'de> Deserialize<'de> for BoundedU32Array {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(BoundedU32ArrayVisitor)
    }
}

struct BoundedU32ArrayVisitor;

impl<'de> Visitor<'de> for BoundedU32ArrayVisitor {
    type Value = BoundedU32Array;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded unsigned integer array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut parsed = BoundedU32Array {
            valid: true,
            ..BoundedU32Array::default()
        };
        let mut items = 0_usize;
        while let Some(value) = sequence.next_element::<OptionalU64>()? {
            items = items.saturating_add(1);
            if items > MAXIMUM_LEGACY_ARRAY_ITEMS {
                parsed.overflow = true;
                continue;
            }
            match value.0.and_then(|value| u32::try_from(value).ok()) {
                Some(value) => parsed.values.push(value),
                None => parsed.valid = false,
            }
        }
        Ok(parsed)
    }

    tolerant_non_array_visits!(BoundedU32Array);
}

#[derive(Default)]
struct OptionalText(Option<String>);

impl<'de> Deserialize<'de> for OptionalText {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(OptionalTextVisitor)
    }
}

struct OptionalTextVisitor;

impl<'de> Visitor<'de> for OptionalTextVisitor {
    type Value = OptionalText;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
        Ok(OptionalText(Some(value.to_owned())))
    }

    fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
        Ok(OptionalText(Some(value)))
    }

    tolerant_scalar_and_container_visits!(OptionalText);
}

#[derive(Default)]
struct OptionalU64(Option<u64>);

impl<'de> Deserialize<'de> for OptionalU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(OptionalU64Visitor)
    }
}

struct OptionalU64Visitor;

impl<'de> Visitor<'de> for OptionalU64Visitor {
    type Value = OptionalU64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        Ok(OptionalU64(Some(value)))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        Ok(OptionalU64(u64::try_from(value).ok()))
    }

    tolerant_non_integer_visits!(OptionalU64);
}

#[derive(Default)]
struct OptionalF64(Option<f64>);

impl<'de> Deserialize<'de> for OptionalF64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(OptionalF64Visitor)
    }
}

struct OptionalF64Visitor;

impl<'de> Visitor<'de> for OptionalF64Visitor {
    type Value = OptionalF64;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("any JSON value")
    }

    fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
        let exact = value
            .to_f64()
            .filter(|converted| converted.to_u64() == Some(value));
        Ok(OptionalF64(exact))
    }

    fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
        let exact = value
            .to_f64()
            .filter(|converted| converted.to_i64() == Some(value));
        Ok(OptionalF64(exact))
    }

    fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E> {
        Ok(OptionalF64(Some(value)))
    }

    tolerant_non_number_visits!(OptionalF64);
}

#[derive(Default)]
struct ExtractionErrorArray {
    items: usize,
    valid: bool,
    overflow: bool,
}

impl<'de> Deserialize<'de> for ExtractionErrorArray {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_seq(ExtractionErrorArrayVisitor)
    }
}

struct ExtractionErrorArrayVisitor;

impl<'de> Visitor<'de> for ExtractionErrorArrayVisitor {
    type Value = ExtractionErrorArray;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a bounded extraction-error array")
    }

    fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut parsed = ExtractionErrorArray {
            valid: true,
            ..ExtractionErrorArray::default()
        };
        while let Some(item) = sequence.next_element::<ExtractionErrorValidity>()? {
            parsed.items = parsed.items.saturating_add(1);
            parsed.overflow |= parsed.items > MAXIMUM_LEGACY_ERROR_ITEMS;
            parsed.valid &= item.0;
        }
        Ok(parsed)
    }
}

struct ExtractionErrorValidity(bool);

impl<'de> Deserialize<'de> for ExtractionErrorValidity {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_any(ExtractionErrorVisitor)
    }
}

struct ExtractionErrorVisitor;

impl<'de> Visitor<'de> for ExtractionErrorVisitor {
    type Value = ExtractionErrorValidity;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("an extraction-error object")
    }

    fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
    where
        A: MapAccess<'de>,
    {
        let mut message = None;
        let mut severity = None;
        let mut file_path = None;
        let mut code = None;
        let mut line = None;
        let mut column = None;
        while let Some(field) = map.next_key::<String>()? {
            match field.as_str() {
                "message" => message = Some(map.next_value::<OptionalText>()?.0.is_some()),
                "severity" => {
                    severity = Some(matches!(
                        map.next_value::<OptionalText>()?.0.as_deref(),
                        Some("error" | "warning")
                    ));
                }
                "filePath" => file_path = Some(map.next_value::<OptionalText>()?.0.is_some()),
                "code" => code = Some(map.next_value::<OptionalText>()?.0.is_some()),
                "line" => {
                    line = Some(
                        map.next_value::<OptionalF64>()?
                            .0
                            .is_some_and(f64::is_finite),
                    );
                }
                "column" => {
                    column = Some(
                        map.next_value::<OptionalF64>()?
                            .0
                            .is_some_and(f64::is_finite),
                    );
                }
                _ => {
                    map.next_value::<IgnoredAny>()?;
                }
            }
        }
        Ok(ExtractionErrorValidity(
            message == Some(true)
                && severity == Some(true)
                && file_path.unwrap_or(true)
                && code.unwrap_or(true)
                && line.unwrap_or(true)
                && column.unwrap_or(true),
        ))
    }

    invalid_extraction_error_visits!();
}

#[cfg(test)]
mod tests {
    use std::mem::size_of;

    use super::*;

    #[test]
    fn near_limit_arrays_parse_directly_within_the_admitted_expansion() {
        let candidates = format!(
            "[{}]",
            std::iter::repeat_n("\"x\"", MAXIMUM_LEGACY_ARRAY_ITEMS)
                .collect::<Vec<_>>()
                .join(",")
        );
        let parsed = parse_legacy_string_array(Some(&candidates), "candidate")
            .unwrap_or_else(|error| panic!("near-limit candidates were rejected: {error}"));
        let retained = candidates.len()
            + parsed.capacity() * size_of::<String>()
            + parsed.iter().map(String::capacity).sum::<usize>();
        assert_eq!(parsed.len(), MAXIMUM_LEGACY_ARRAY_ITEMS);
        assert!(
            retained
                <= candidates.len()
                    * usize::try_from(SOURCE_JSON_EXPANSION_FACTOR).unwrap_or(usize::MAX)
        );

        let overflow = format!("{candidates},\"x\"]").replacen(']', "", 1);
        assert_eq!(
            parse_legacy_string_array(Some(&overflow), "candidate"),
            Err(V1PostgresImportError::SourceLimit)
        );
    }

    #[test]
    fn extraction_errors_have_explicit_item_and_nesting_bounds() {
        let nested = format!(
            "[{{\"message\":\"m\",\"severity\":\"error\",\"unknown\":{}}}]",
            "[".repeat(MAXIMUM_LEGACY_JSON_DEPTH) + &"]".repeat(MAXIMUM_LEGACY_JSON_DEPTH)
        );
        assert!(!has_valid_extraction_errors(Some(&nested)));

        let item = r#"{"message":"m","severity":"warning"}"#;
        let too_many = format!(
            "[{}]",
            std::iter::repeat_n(item, MAXIMUM_LEGACY_ERROR_ITEMS + 1)
                .collect::<Vec<_>>()
                .join(",")
        );
        assert!(!has_valid_extraction_errors(Some(&too_many)));
    }
}
