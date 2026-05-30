/**
 * SCIP index model + protobuf encoders.
 *
 * Mirrors the message shapes from `scip.proto` (Sourcegraph's Code
 * Intelligence Protocol) that cartograph's export populates. The model
 * interfaces are plain JS objects; {@link encodeScipIndex} serialises
 * them to the protobuf wire format via {@link ProtoWriter}.
 *
 * proto3 default omission is applied here — zero enums, empty strings,
 * `false` bools and empty repeated fields are simply not written, so
 * the bytes match a generated encoder's output.
 */

import { ProtoWriter } from './proto-writer.js';

// ── enum constants (from scip.proto) ──────────────────────────────

/** `TextEncoding.UTF8`. */
export const TEXT_ENCODING_UTF8 = 1;
/** `PositionEncoding.UTF8CodeUnitOffsetFromLineStart` — byte offsets,
 *  which is what tree-sitter (and therefore cartograph) reports. */
export const POSITION_ENCODING_UTF8 = 1;
/** `SymbolRole.Definition` — the only role bit this exporter sets. */
export const SYMBOL_ROLE_DEFINITION = 1;

/** `SymbolInformation.Kind` values used by {@link nodeKindToScipKind}. */
export enum ScipSymbolKind {
  Class = 7,
  Constant = 8,
  Enum = 11,
  EnumMember = 12,
  Field = 15,
  File = 16,
  Function = 17,
  Interface = 21,
  Method = 26,
  Module = 29,
  Namespace = 30,
  Object = 33,
  Property = 41,
  Protocol = 42,
  Struct = 49,
  Trait = 53,
  TypeAlias = 55,
  Variable = 61,
}

// ── model ─────────────────────────────────────────────────────────

/** SCIP `Relationship` — a typed link between two symbols. */
export interface ScipRelationship {
  symbol: string;
  isReference?: boolean;
  isImplementation?: boolean;
  isTypeDefinition?: boolean;
  isDefinition?: boolean;
}

/** SCIP `SymbolInformation` — metadata about one symbol. */
export interface ScipSymbolInformation {
  symbol: string;
  displayName: string;
  /** 0 = `UnspecifiedKind`; omitted from the wire when 0. */
  kind: number;
  documentation: string[];
  relationships: ScipRelationship[];
  /** Containing symbol; empty string when unknown. */
  enclosingSymbol: string;
}

/** SCIP `Occurrence` — one place a symbol appears in a document. */
export interface ScipOccurrence {
  /** `[line, startChar, endChar]` or `[startLine, startChar, endLine, endChar]`, all 0-based. */
  range: number[];
  symbol: string;
  /** `SymbolRole` bitset; 0 (a plain reference) is omitted from the wire. */
  symbolRoles: number;
  /** Full enclosing range of a definition (4-element); optional. */
  enclosingRange?: number[];
}

/** SCIP `Document` — one source file. */
export interface ScipDocument {
  relativePath: string;
  language: string;
  occurrences: ScipOccurrence[];
  symbols: ScipSymbolInformation[];
}

/** SCIP `Index` — the top-level export artifact. */
export interface ScipIndex {
  toolName: string;
  toolVersion: string;
  /** `file://`-prefixed absolute path to the project root. */
  projectRoot: string;
  documents: ScipDocument[];
}

// ── protobuf field numbers (from scip.proto) ──────────────────────
// Named so the encoders/decoders read against the field's meaning,
// not a bare wire tag. Shared with scip-decode.ts via SCIP_FIELD.

/** Field-number tables for every SCIP message this codec touches. */
export const SCIP_FIELD = {
  index: { metadata: 1, documents: 2 } as const,
  metadata: { toolInfo: 2, projectRoot: 3, textDocumentEncoding: 4 } as const,
  toolInfo: { name: 1, version: 2 } as const,
  document: { relativePath: 1, occurrences: 2, symbols: 3, language: 4, positionEncoding: 6 } as const,
  symbolInformation: {
    symbol: 1,
    documentation: 3,
    relationships: 4,
    kind: 5,
    displayName: 6,
    enclosingSymbol: 8,
  } as const,
  occurrence: { range: 1, symbol: 2, symbolRoles: 3, enclosingRange: 7 } as const,
  relationship: { symbol: 1, isReference: 2, isImplementation: 3, isTypeDefinition: 4, isDefinition: 5 } as const,
} as const;

/** Enum default (0) — proto3 omits it from the wire. */
const ENUM_UNSPECIFIED = 0;

// ── encoders ──────────────────────────────────────────────────────

function encodeRelationship(w: ProtoWriter, r: ScipRelationship): void {
  const F = SCIP_FIELD.relationship;
  w.string(F.symbol, r.symbol);
  if (r.isReference) w.bool(F.isReference, true);
  if (r.isImplementation) w.bool(F.isImplementation, true);
  if (r.isTypeDefinition) w.bool(F.isTypeDefinition, true);
  if (r.isDefinition) w.bool(F.isDefinition, true);
}

function encodeSymbolInformation(w: ProtoWriter, s: ScipSymbolInformation): void {
  const F = SCIP_FIELD.symbolInformation;
  w.string(F.symbol, s.symbol);
  for (const doc of s.documentation) w.string(F.documentation, doc);
  for (const rel of s.relationships) w.message(F.relationships, (m) => encodeRelationship(m, rel));
  if (s.kind !== ENUM_UNSPECIFIED) w.uint32(F.kind, s.kind);
  if (s.displayName) w.string(F.displayName, s.displayName);
  if (s.enclosingSymbol) w.string(F.enclosingSymbol, s.enclosingSymbol);
}

function encodeOccurrence(w: ProtoWriter, o: ScipOccurrence): void {
  const F = SCIP_FIELD.occurrence;
  w.packedUint32(F.range, o.range);
  w.string(F.symbol, o.symbol);
  if (o.symbolRoles !== ENUM_UNSPECIFIED) w.uint32(F.symbolRoles, o.symbolRoles);
  if (o.enclosingRange && o.enclosingRange.length > 0) {
    w.packedUint32(F.enclosingRange, o.enclosingRange);
  }
}

function encodeDocument(w: ProtoWriter, d: ScipDocument): void {
  const F = SCIP_FIELD.document;
  w.string(F.relativePath, d.relativePath);
  for (const occ of d.occurrences) w.message(F.occurrences, (m) => encodeOccurrence(m, occ));
  for (const sym of d.symbols) w.message(F.symbols, (m) => encodeSymbolInformation(m, sym));
  if (d.language) w.string(F.language, d.language);
  w.uint32(F.positionEncoding, POSITION_ENCODING_UTF8);
}

function encodeMetadata(w: ProtoWriter, index: ScipIndex): void {
  // version (field 1) = ProtocolVersion.Unspecified (0) — omitted.
  // tool_info is itself omitted when empty (proto3 message default).
  const F = SCIP_FIELD.metadata;
  if (index.toolName || index.toolVersion) {
    w.message(F.toolInfo, (tool) => {
      if (index.toolName) tool.string(SCIP_FIELD.toolInfo.name, index.toolName);
      if (index.toolVersion) tool.string(SCIP_FIELD.toolInfo.version, index.toolVersion);
    });
  }
  w.string(F.projectRoot, index.projectRoot);
  w.uint32(F.textDocumentEncoding, TEXT_ENCODING_UTF8);
}

/** Serialise a {@link ScipIndex} to the SCIP protobuf wire format. */
export function encodeScipIndex(index: ScipIndex): Uint8Array {
  const w = new ProtoWriter();
  w.message(SCIP_FIELD.index.metadata, (m) => encodeMetadata(m, index));
  for (const doc of index.documents) {
    w.message(SCIP_FIELD.index.documents, (m) => encodeDocument(m, doc));
  }
  return w.finish();
}
