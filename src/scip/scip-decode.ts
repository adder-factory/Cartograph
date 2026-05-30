/**
 * SCIP index decoder — `.scip` protobuf bytes → the {@link ScipIndex}
 * model.
 *
 * The inverse of `scip-encode.ts`. Field numbers mirror `scip.proto`
 * exactly, so a cartograph-exported index round-trips, and a foreign
 * indexer's `.scip` (scip-typescript, rust-analyzer, …) decodes the
 * same way. Unknown fields are ignored — forward-compatible by design.
 */

import {
  decodeMessage,
  getMessage,
  getMessages,
  getString,
  getStrings,
  getVarint,
  getPackedVarints,
} from './proto-reader.js';
import {
  type ScipIndex,
  type ScipDocument,
  type ScipOccurrence,
  type ScipSymbolInformation,
  type ScipRelationship,
  SCIP_FIELD,
} from './scip-encode.js';

function decodeRelationship(msg: ReturnType<typeof decodeMessage>): ScipRelationship {
  const F = SCIP_FIELD.relationship;
  return {
    symbol: getString(msg, F.symbol),
    isReference: getVarint(msg, F.isReference) !== 0,
    isImplementation: getVarint(msg, F.isImplementation) !== 0,
    isTypeDefinition: getVarint(msg, F.isTypeDefinition) !== 0,
    isDefinition: getVarint(msg, F.isDefinition) !== 0,
  };
}

function decodeSymbolInformation(msg: ReturnType<typeof decodeMessage>): ScipSymbolInformation {
  const F = SCIP_FIELD.symbolInformation;
  return {
    symbol: getString(msg, F.symbol),
    documentation: getStrings(msg, F.documentation),
    relationships: getMessages(msg, F.relationships).map(decodeRelationship),
    kind: getVarint(msg, F.kind),
    displayName: getString(msg, F.displayName),
    enclosingSymbol: getString(msg, F.enclosingSymbol),
  };
}

function decodeOccurrence(msg: ReturnType<typeof decodeMessage>): ScipOccurrence {
  const F = SCIP_FIELD.occurrence;
  const occ: ScipOccurrence = {
    range: getPackedVarints(msg, F.range),
    symbol: getString(msg, F.symbol),
    symbolRoles: getVarint(msg, F.symbolRoles),
  };
  const enclosing = getPackedVarints(msg, F.enclosingRange);
  if (enclosing.length > 0) occ.enclosingRange = enclosing;
  return occ;
}

function decodeDocument(msg: ReturnType<typeof decodeMessage>): ScipDocument {
  const F = SCIP_FIELD.document;
  return {
    relativePath: getString(msg, F.relativePath),
    occurrences: getMessages(msg, F.occurrences).map(decodeOccurrence),
    symbols: getMessages(msg, F.symbols).map(decodeSymbolInformation),
    language: getString(msg, F.language),
  };
}

/** Decode a `.scip` protobuf index into the {@link ScipIndex} model. */
export function decodeScipIndex(bytes: Uint8Array): ScipIndex {
  const root = decodeMessage(bytes);
  const metadata = getMessage(root, SCIP_FIELD.index.metadata);
  const toolInfo = metadata ? getMessage(metadata, SCIP_FIELD.metadata.toolInfo) : undefined;
  return {
    toolName: toolInfo ? getString(toolInfo, SCIP_FIELD.toolInfo.name) : '',
    toolVersion: toolInfo ? getString(toolInfo, SCIP_FIELD.toolInfo.version) : '',
    projectRoot: metadata ? getString(metadata, SCIP_FIELD.metadata.projectRoot) : '',
    documents: getMessages(root, SCIP_FIELD.index.documents).map(decodeDocument),
  };
}
