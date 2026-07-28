use std::collections::BTreeMap;

use crate::model::{
    CARTOGRAPH_EDGES_FIELD, CartographScipEdge, MAXIMUM_DOCUMENTS, MAXIMUM_OCCURRENCES,
    MAXIMUM_RELATIONSHIPS, MAXIMUM_SCIP_BYTES, MAXIMUM_STRING_BYTES, MAXIMUM_SYMBOLS,
    POSITION_ENCODING_UTF8, ScipDocument, ScipError, ScipIndex, ScipOccurrence, ScipRelationship,
    ScipSymbolInformation, TEXT_ENCODING_UTF8,
};

const WIRE_VARINT: u8 = 0;
const WIRE_I64: u8 = 1;
const WIRE_LEN: u8 = 2;
const WIRE_I32: u8 = 5;
const MAXIMUM_VARINT_BYTES: usize = 10;
const PROTOBUF_TAG_SHIFT: u32 = 3;
const PROTOBUF_WIRE_TYPE_MASK: u64 = 7;
const FIXED_64_BYTES: usize = 8;
const FIXED_32_BYTES: usize = 4;
const VARINT_VALUE_BITS: usize = 64;
const VARINT_PAYLOAD_BITS: usize = 7;
const VARINT_FINAL_SHIFT: usize = 63;
const VARINT_PAYLOAD_MASK: u8 = 0x7f;
const VARINT_CONTINUATION_BIT: u8 = 0x80;

const INDEX_METADATA: u32 = 1;
const INDEX_DOCUMENTS: u32 = 2;
const METADATA_TOOL_INFO: u32 = 2;
const METADATA_PROJECT_ROOT: u32 = 3;
const METADATA_TEXT_ENCODING: u32 = 4;
const TOOL_NAME: u32 = 1;
const TOOL_VERSION: u32 = 2;
const DOCUMENT_PATH: u32 = 1;
const DOCUMENT_OCCURRENCES: u32 = 2;
const DOCUMENT_SYMBOLS: u32 = 3;
const DOCUMENT_LANGUAGE: u32 = 4;
const DOCUMENT_POSITION_ENCODING: u32 = 6;
const SYMBOL_VALUE: u32 = 1;
const SYMBOL_DOCUMENTATION: u32 = 3;
const SYMBOL_RELATIONSHIPS: u32 = 4;
const SYMBOL_KIND: u32 = 5;
const SYMBOL_DISPLAY_NAME: u32 = 6;
const SYMBOL_ENCLOSING: u32 = 8;
const OCCURRENCE_RANGE: u32 = 1;
const OCCURRENCE_SYMBOL: u32 = 2;
const OCCURRENCE_ROLES: u32 = 3;
const OCCURRENCE_ENCLOSING_RANGE: u32 = 7;
const RELATIONSHIP_SYMBOL: u32 = 1;
const RELATIONSHIP_REFERENCE: u32 = 2;
const RELATIONSHIP_IMPLEMENTATION: u32 = 3;
const RELATIONSHIP_TYPE_DEFINITION: u32 = 4;
const RELATIONSHIP_DEFINITION: u32 = 5;
const CARTOGRAPH_EDGE_TARGET: u32 = 1;
const CARTOGRAPH_EDGE_KIND: u32 = 2;
const CARTOGRAPH_EDGE_SITE_COUNT: u32 = 3;
const CARTOGRAPH_EDGE_PROVENANCE: u32 = 4;
const CARTOGRAPH_EDGE_CONFIDENCE_BITS: u32 = 5;

enum WireValue<'a> {
    Varint(u64),
    Bytes(&'a [u8]),
}

type Message<'a> = BTreeMap<u32, Vec<WireValue<'a>>>;

struct Writer {
    bytes: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn varint(&mut self, mut value: u64) -> Result<(), ScipError> {
        loop {
            let payload = u8::try_from(value & u64::from(VARINT_PAYLOAD_MASK))
                .map_err(|_| ScipError::LimitExceeded)?;
            value >>= VARINT_PAYLOAD_BITS;
            self.push(if value == 0 {
                payload
            } else {
                payload | VARINT_CONTINUATION_BIT
            })?;
            if value == 0 {
                return Ok(());
            }
        }
    }

    fn push(&mut self, value: u8) -> Result<(), ScipError> {
        if self.bytes.len() >= MAXIMUM_SCIP_BYTES {
            return Err(ScipError::LimitExceeded);
        }
        self.bytes.push(value);
        Ok(())
    }

    fn tag(&mut self, field: u32, wire: u8) -> Result<(), ScipError> {
        if field == 0 {
            return Err(ScipError::InvalidData);
        }
        self.varint((u64::from(field) << 3) | u64::from(wire))
    }

    fn uint32(&mut self, field: u32, value: u32) -> Result<(), ScipError> {
        self.tag(field, WIRE_VARINT)?;
        self.varint(u64::from(value))
    }

    fn bool(&mut self, field: u32, value: bool) -> Result<(), ScipError> {
        self.uint32(field, u32::from(value))
    }

    fn string(&mut self, field: u32, value: &str) -> Result<(), ScipError> {
        if value.len() > MAXIMUM_STRING_BYTES || value.contains('\0') {
            return Err(ScipError::LimitExceeded);
        }
        self.bytes(field, value.as_bytes())
    }

    fn bytes(&mut self, field: u32, value: &[u8]) -> Result<(), ScipError> {
        let next = self
            .bytes
            .len()
            .checked_add(value.len())
            .ok_or(ScipError::LimitExceeded)?;
        if next > MAXIMUM_SCIP_BYTES {
            return Err(ScipError::LimitExceeded);
        }
        self.tag(field, WIRE_LEN)?;
        self.varint(u64::try_from(value.len()).map_err(|_| ScipError::LimitExceeded)?)?;
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn message(
        &mut self,
        field: u32,
        populate: impl FnOnce(&mut Self) -> Result<(), ScipError>,
    ) -> Result<(), ScipError> {
        let mut child = Self::new();
        populate(&mut child)?;
        self.bytes(field, &child.bytes)
    }

    fn packed_u32(&mut self, field: u32, values: &[u32]) -> Result<(), ScipError> {
        if values.is_empty() {
            return Ok(());
        }
        let mut child = Self::new();
        for value in values {
            child.varint(u64::from(*value))?;
        }
        self.bytes(field, &child.bytes)
    }
}

pub fn encode_scip_index(index: &ScipIndex) -> Result<Vec<u8>, ScipError> {
    validate_cardinality(index)?;
    let mut writer = Writer::new();
    writer.message(INDEX_METADATA, |metadata| {
        metadata.message(METADATA_TOOL_INFO, |tool| {
            if !index.tool_name.is_empty() {
                tool.string(TOOL_NAME, &index.tool_name)?;
            }
            if !index.tool_version.is_empty() {
                tool.string(TOOL_VERSION, &index.tool_version)?;
            }
            Ok(())
        })?;
        metadata.string(METADATA_PROJECT_ROOT, &index.project_root)?;
        metadata.uint32(METADATA_TEXT_ENCODING, TEXT_ENCODING_UTF8)
    })?;
    for document in &index.documents {
        writer.message(INDEX_DOCUMENTS, |writer| encode_document(writer, document))?;
    }
    Ok(writer.bytes)
}

fn encode_document(writer: &mut Writer, document: &ScipDocument) -> Result<(), ScipError> {
    writer.string(DOCUMENT_PATH, &document.relative_path)?;
    for occurrence in &document.occurrences {
        writer.message(DOCUMENT_OCCURRENCES, |writer| {
            writer.packed_u32(OCCURRENCE_RANGE, &occurrence.range)?;
            writer.string(OCCURRENCE_SYMBOL, &occurrence.symbol)?;
            if occurrence.symbol_roles != 0 {
                writer.uint32(OCCURRENCE_ROLES, occurrence.symbol_roles)?;
            }
            writer.packed_u32(OCCURRENCE_ENCLOSING_RANGE, &occurrence.enclosing_range)
        })?;
    }
    for symbol in &document.symbols {
        writer.message(DOCUMENT_SYMBOLS, |writer| encode_symbol(writer, symbol))?;
    }
    if !document.language.is_empty() {
        writer.string(DOCUMENT_LANGUAGE, &document.language)?;
    }
    writer.uint32(DOCUMENT_POSITION_ENCODING, POSITION_ENCODING_UTF8)
}

fn encode_symbol(writer: &mut Writer, symbol: &ScipSymbolInformation) -> Result<(), ScipError> {
    writer.string(SYMBOL_VALUE, &symbol.symbol)?;
    for documentation in &symbol.documentation {
        writer.string(SYMBOL_DOCUMENTATION, documentation)?;
    }
    for relationship in &symbol.relationships {
        writer.message(SYMBOL_RELATIONSHIPS, |writer| {
            writer.string(RELATIONSHIP_SYMBOL, &relationship.symbol)?;
            if relationship.is_reference {
                writer.bool(RELATIONSHIP_REFERENCE, true)?;
            }
            if relationship.is_implementation {
                writer.bool(RELATIONSHIP_IMPLEMENTATION, true)?;
            }
            if relationship.is_type_definition {
                writer.bool(RELATIONSHIP_TYPE_DEFINITION, true)?;
            }
            if relationship.is_definition {
                writer.bool(RELATIONSHIP_DEFINITION, true)?;
            }
            Ok(())
        })?;
    }
    if symbol.kind != 0 {
        writer.uint32(SYMBOL_KIND, symbol.kind)?;
    }
    if !symbol.display_name.is_empty() {
        writer.string(SYMBOL_DISPLAY_NAME, &symbol.display_name)?;
    }
    if !symbol.enclosing_symbol.is_empty() {
        writer.string(SYMBOL_ENCLOSING, &symbol.enclosing_symbol)?;
    }
    for edge in &symbol.cartograph_edges {
        writer.message(CARTOGRAPH_EDGES_FIELD, |writer| {
            writer.string(CARTOGRAPH_EDGE_TARGET, &edge.target_symbol)?;
            writer.string(CARTOGRAPH_EDGE_KIND, &edge.edge_kind)?;
            writer.uint32(CARTOGRAPH_EDGE_SITE_COUNT, edge.site_count)?;
            writer.string(CARTOGRAPH_EDGE_PROVENANCE, &edge.provenance)?;
            writer.uint32(CARTOGRAPH_EDGE_CONFIDENCE_BITS, edge.confidence_bits)
        })?;
    }
    Ok(())
}

pub fn decode_scip_index(bytes: &[u8]) -> Result<ScipIndex, ScipError> {
    if bytes.is_empty() || bytes.len() > MAXIMUM_SCIP_BYTES {
        return Err(ScipError::LimitExceeded);
    }
    let root = decode_message(bytes)?;
    let metadata = message(&root, INDEX_METADATA)?.unwrap_or_default();
    if uint32(&metadata, METADATA_TEXT_ENCODING)? != TEXT_ENCODING_UTF8 {
        return Err(ScipError::InvalidData);
    }
    let tool = message(&metadata, METADATA_TOOL_INFO)?.unwrap_or_default();
    let document_values = byte_values(&root, INDEX_DOCUMENTS)?;
    if document_values.len() > MAXIMUM_DOCUMENTS {
        return Err(ScipError::LimitExceeded);
    }
    let mut documents = Vec::with_capacity(document_values.len());
    let mut symbols = 0_usize;
    let mut occurrences = 0_usize;
    let mut relationships = 0_usize;
    for value in document_values {
        let decoded = decode_message(value)?;
        let document = decode_document(&decoded)?;
        symbols = symbols
            .checked_add(document.symbols.len())
            .ok_or(ScipError::LimitExceeded)?;
        occurrences = occurrences
            .checked_add(document.occurrences.len())
            .ok_or(ScipError::LimitExceeded)?;
        relationships = document
            .symbols
            .iter()
            .try_fold(relationships, |total, symbol| {
                total
                    .checked_add(symbol.relationships.len())
                    .and_then(|value| value.checked_add(symbol.cartograph_edges.len()))
                    .ok_or(ScipError::LimitExceeded)
            })?;
        if symbols > MAXIMUM_SYMBOLS
            || occurrences > MAXIMUM_OCCURRENCES
            || relationships > MAXIMUM_RELATIONSHIPS
        {
            return Err(ScipError::LimitExceeded);
        }
        documents.push(document);
    }
    Ok(ScipIndex {
        tool_name: string(&tool, TOOL_NAME)?,
        tool_version: string(&tool, TOOL_VERSION)?,
        project_root: string(&metadata, METADATA_PROJECT_ROOT)?,
        documents,
    })
}

fn decode_document(message: &Message<'_>) -> Result<ScipDocument, ScipError> {
    let position_encoding = uint32(message, DOCUMENT_POSITION_ENCODING)?;
    if !matches!(position_encoding, 0 | POSITION_ENCODING_UTF8) {
        return Err(ScipError::InvalidData);
    }
    let occurrences = byte_values(message, DOCUMENT_OCCURRENCES)?
        .into_iter()
        .map(|value| decode_message(value).and_then(|value| decode_occurrence(&value)))
        .collect::<Result<Vec<_>, _>>()?;
    let symbols = byte_values(message, DOCUMENT_SYMBOLS)?
        .into_iter()
        .map(|value| decode_message(value).and_then(|value| decode_symbol(&value)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ScipDocument {
        relative_path: string(message, DOCUMENT_PATH)?,
        language: string(message, DOCUMENT_LANGUAGE)?,
        occurrences,
        symbols,
    })
}

fn decode_occurrence(message: &Message<'_>) -> Result<ScipOccurrence, ScipError> {
    Ok(ScipOccurrence {
        range: packed_u32(message, OCCURRENCE_RANGE)?,
        symbol: string(message, OCCURRENCE_SYMBOL)?,
        symbol_roles: uint32(message, OCCURRENCE_ROLES)?,
        enclosing_range: packed_u32(message, OCCURRENCE_ENCLOSING_RANGE)?,
    })
}

fn decode_symbol(message: &Message<'_>) -> Result<ScipSymbolInformation, ScipError> {
    let relationships = byte_values(message, SYMBOL_RELATIONSHIPS)?
        .into_iter()
        .map(|value| decode_message(value).and_then(|value| decode_relationship(&value)))
        .collect::<Result<Vec<_>, _>>()?;
    let cartograph_edges = byte_values(message, CARTOGRAPH_EDGES_FIELD)?
        .into_iter()
        .map(|value| decode_message(value).and_then(|value| decode_cartograph_edge(&value)))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(ScipSymbolInformation {
        symbol: string(message, SYMBOL_VALUE)?,
        display_name: string(message, SYMBOL_DISPLAY_NAME)?,
        kind: uint32(message, SYMBOL_KIND)?,
        documentation: strings(message, SYMBOL_DOCUMENTATION)?,
        relationships,
        enclosing_symbol: string(message, SYMBOL_ENCLOSING)?,
        cartograph_edges,
    })
}

fn decode_relationship(message: &Message<'_>) -> Result<ScipRelationship, ScipError> {
    Ok(ScipRelationship {
        symbol: string(message, RELATIONSHIP_SYMBOL)?,
        is_reference: uint32(message, RELATIONSHIP_REFERENCE)? != 0,
        is_implementation: uint32(message, RELATIONSHIP_IMPLEMENTATION)? != 0,
        is_type_definition: uint32(message, RELATIONSHIP_TYPE_DEFINITION)? != 0,
        is_definition: uint32(message, RELATIONSHIP_DEFINITION)? != 0,
    })
}

fn decode_cartograph_edge(message: &Message<'_>) -> Result<CartographScipEdge, ScipError> {
    let site_count = uint32(message, CARTOGRAPH_EDGE_SITE_COUNT)?;
    if site_count == 0 {
        return Err(ScipError::InvalidData);
    }
    let confidence_bits = optional_uint32(message, CARTOGRAPH_EDGE_CONFIDENCE_BITS)?
        .unwrap_or_else(|| 1.0_f32.to_bits());
    let confidence = f32::from_bits(confidence_bits);
    if !confidence.is_finite() || !(0.0..=1.0).contains(&confidence) {
        return Err(ScipError::InvalidData);
    }
    Ok(CartographScipEdge {
        target_symbol: string(message, CARTOGRAPH_EDGE_TARGET)?,
        edge_kind: string(message, CARTOGRAPH_EDGE_KIND)?,
        site_count,
        provenance: string(message, CARTOGRAPH_EDGE_PROVENANCE)?,
        confidence_bits,
    })
}

fn validate_cardinality(index: &ScipIndex) -> Result<(), ScipError> {
    if index.documents.len() > MAXIMUM_DOCUMENTS {
        return Err(ScipError::LimitExceeded);
    }
    let mut symbols = 0_usize;
    let mut occurrences = 0_usize;
    let mut relationships = 0_usize;
    for document in &index.documents {
        symbols = symbols
            .checked_add(document.symbols.len())
            .ok_or(ScipError::LimitExceeded)?;
        occurrences = occurrences
            .checked_add(document.occurrences.len())
            .ok_or(ScipError::LimitExceeded)?;
        relationships = document
            .symbols
            .iter()
            .try_fold(relationships, |total, symbol| {
                total
                    .checked_add(symbol.relationships.len())
                    .and_then(|value| value.checked_add(symbol.cartograph_edges.len()))
                    .ok_or(ScipError::LimitExceeded)
            })?;
    }
    if symbols > MAXIMUM_SYMBOLS
        || occurrences > MAXIMUM_OCCURRENCES
        || relationships > MAXIMUM_RELATIONSHIPS
    {
        Err(ScipError::LimitExceeded)
    } else {
        Ok(())
    }
}

fn decode_message(bytes: &[u8]) -> Result<Message<'_>, ScipError> {
    let mut message = Message::new();
    let mut position = 0_usize;
    while position < bytes.len() {
        let (tag, next) = read_varint(bytes, position)?;
        position = next;
        let field =
            u32::try_from(tag >> PROTOBUF_TAG_SHIFT).map_err(|_| ScipError::InvalidWireData)?;
        let wire =
            u8::try_from(tag & PROTOBUF_WIRE_TYPE_MASK).map_err(|_| ScipError::InvalidWireData)?;
        if field == 0 {
            return Err(ScipError::InvalidWireData);
        }
        let value = match wire {
            WIRE_VARINT => {
                let (value, next) = read_varint(bytes, position)?;
                position = next;
                Some(WireValue::Varint(value))
            }
            WIRE_LEN => {
                let (length, next) = read_varint(bytes, position)?;
                let length = usize::try_from(length).map_err(|_| ScipError::LimitExceeded)?;
                position = next;
                let end = position
                    .checked_add(length)
                    .filter(|end| *end <= bytes.len())
                    .ok_or(ScipError::InvalidWireData)?;
                let value = &bytes[position..end];
                position = end;
                Some(WireValue::Bytes(value))
            }
            WIRE_I64 => {
                position = position
                    .checked_add(FIXED_64_BYTES)
                    .filter(|end| *end <= bytes.len())
                    .ok_or(ScipError::InvalidWireData)?;
                None
            }
            WIRE_I32 => {
                position = position
                    .checked_add(FIXED_32_BYTES)
                    .filter(|end| *end <= bytes.len())
                    .ok_or(ScipError::InvalidWireData)?;
                None
            }
            _ => return Err(ScipError::InvalidWireData),
        };
        if let Some(value) = value {
            message.entry(field).or_default().push(value);
        }
    }
    Ok(message)
}

fn read_varint(bytes: &[u8], start: usize) -> Result<(u64, usize), ScipError> {
    let mut value = 0_u64;
    let mut position = start;
    for shift in (0..VARINT_VALUE_BITS)
        .step_by(VARINT_PAYLOAD_BITS)
        .take(MAXIMUM_VARINT_BYTES)
    {
        let byte = *bytes.get(position).ok_or(ScipError::InvalidWireData)?;
        position = position.checked_add(1).ok_or(ScipError::InvalidWireData)?;
        let payload = u64::from(byte & VARINT_PAYLOAD_MASK);
        if shift == VARINT_FINAL_SHIFT && payload > 1 {
            return Err(ScipError::InvalidWireData);
        }
        value |= payload << shift;
        if byte & VARINT_CONTINUATION_BIT == 0 {
            return Ok((value, position));
        }
    }
    Err(ScipError::InvalidWireData)
}

fn byte_values<'a>(message: &'a Message<'a>, field: u32) -> Result<Vec<&'a [u8]>, ScipError> {
    message
        .get(&field)
        .into_iter()
        .flatten()
        .map(|value| match value {
            WireValue::Bytes(value) => Ok(*value),
            WireValue::Varint(_) => Err(ScipError::InvalidWireData),
        })
        .collect()
}

fn uint32(message: &Message<'_>, field: u32) -> Result<u32, ScipError> {
    match message.get(&field).and_then(|values| values.first()) {
        Some(WireValue::Varint(value)) => u32::try_from(*value).map_err(|_| ScipError::InvalidData),
        Some(WireValue::Bytes(_)) => Err(ScipError::InvalidWireData),
        None => Ok(0),
    }
}

fn optional_uint32(message: &Message<'_>, field: u32) -> Result<Option<u32>, ScipError> {
    match message.get(&field).and_then(|values| values.first()) {
        Some(WireValue::Varint(value)) => u32::try_from(*value)
            .map(Some)
            .map_err(|_| ScipError::InvalidData),
        Some(WireValue::Bytes(_)) => Err(ScipError::InvalidWireData),
        None => Ok(None),
    }
}

fn string(message: &Message<'_>, field: u32) -> Result<String, ScipError> {
    match message.get(&field).and_then(|values| values.first()) {
        Some(WireValue::Bytes(value)) => parse_string(value),
        Some(WireValue::Varint(_)) => Err(ScipError::InvalidWireData),
        None => Ok(String::new()),
    }
}

fn strings(message: &Message<'_>, field: u32) -> Result<Vec<String>, ScipError> {
    message
        .get(&field)
        .into_iter()
        .flatten()
        .map(|value| match value {
            WireValue::Bytes(value) => parse_string(value),
            WireValue::Varint(_) => Err(ScipError::InvalidWireData),
        })
        .collect()
}

fn parse_string(value: &[u8]) -> Result<String, ScipError> {
    if value.len() > MAXIMUM_STRING_BYTES {
        return Err(ScipError::LimitExceeded);
    }
    std::str::from_utf8(value)
        .ok()
        .filter(|value| !value.contains('\0'))
        .map(str::to_owned)
        .ok_or(ScipError::InvalidData)
}

fn message<'a>(parent: &'a Message<'a>, field: u32) -> Result<Option<Message<'a>>, ScipError> {
    match parent.get(&field).and_then(|values| values.first()) {
        Some(WireValue::Bytes(value)) => decode_message(value).map(Some),
        Some(WireValue::Varint(_)) => Err(ScipError::InvalidWireData),
        None => Ok(None),
    }
}

fn packed_u32(message: &Message<'_>, field: u32) -> Result<Vec<u32>, ScipError> {
    let Some(WireValue::Bytes(bytes)) = message.get(&field).and_then(|values| values.first())
    else {
        return if message.contains_key(&field) {
            Err(ScipError::InvalidWireData)
        } else {
            Ok(Vec::new())
        };
    };
    let mut values = Vec::new();
    let mut position = 0_usize;
    while position < bytes.len() {
        let (value, next) = read_varint(bytes, position)?;
        values.push(u32::try_from(value).map_err(|_| ScipError::InvalidData)?);
        position = next;
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codec_round_trips_unknown_extension_and_rejects_truncation() {
        let index = ScipIndex {
            tool_name: "cartograph".to_owned(),
            tool_version: "2.0.0".to_owned(),
            project_root: "file:///project".to_owned(),
            documents: vec![ScipDocument {
                relative_path: "src/lib.rs".to_owned(),
                language: "rust".to_owned(),
                occurrences: vec![ScipOccurrence {
                    range: vec![0, 3, 8],
                    symbol: "cartograph cartograph project 1 lib/foo().".to_owned(),
                    symbol_roles: 1,
                    enclosing_range: vec![0, 0, 2, 1],
                }],
                symbols: vec![ScipSymbolInformation {
                    symbol: "cartograph cartograph project 1 lib/foo().".to_owned(),
                    display_name: "foo".to_owned(),
                    kind: 17,
                    documentation: vec!["fn foo()".to_owned()],
                    relationships: Vec::new(),
                    enclosing_symbol: String::new(),
                    cartograph_edges: vec![CartographScipEdge {
                        target_symbol: "cartograph cartograph project 1 lib/bar().".to_owned(),
                        edge_kind: "calls".to_owned(),
                        site_count: 2,
                        provenance: "native-exact-project".to_owned(),
                        confidence_bits: 0.95_f32.to_bits(),
                    }],
                }],
            }],
        };
        let encoded =
            encode_scip_index(&index).unwrap_or_else(|error| panic!("SCIP encode failed: {error}"));
        assert_eq!(
            decode_scip_index(&encoded)
                .unwrap_or_else(|error| panic!("SCIP decode failed: {error}")),
            index
        );
        assert!(decode_scip_index(&encoded[..encoded.len() - 1]).is_err());
    }

    #[test]
    fn decoder_rejects_non_utf8_positions_and_wrong_known_wire_types() {
        let mut non_utf8 = Writer::new();
        non_utf8
            .message(INDEX_METADATA, |metadata| {
                metadata.uint32(METADATA_TEXT_ENCODING, 2)
            })
            .unwrap_or_else(|error| panic!("fixture encode failed: {error}"));
        assert_eq!(
            decode_scip_index(&non_utf8.bytes),
            Err(ScipError::InvalidData)
        );

        let mut wrong_wire = Writer::new();
        wrong_wire
            .message(INDEX_METADATA, |metadata| {
                metadata.uint32(METADATA_TEXT_ENCODING, TEXT_ENCODING_UTF8)
            })
            .and_then(|()| wrong_wire.uint32(INDEX_DOCUMENTS, 1))
            .unwrap_or_else(|error| panic!("fixture encode failed: {error}"));
        assert_eq!(
            decode_scip_index(&wrong_wire.bytes),
            Err(ScipError::InvalidWireData)
        );
    }
}
