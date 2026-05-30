/**
 * Minimal protobuf wire-format reader — decode-only, zero-dependency.
 *
 * The counterpart to {@link ProtoWriter}. SCIP import has to DECODE a
 * `.scip` protobuf produced by cartograph's own export or by a foreign
 * indexer (scip-typescript, rust-analyzer, …); rather than pull a
 * protobuf runtime, this hand-rolls the slice of the wire format SCIP
 * uses — varints, length-delimited fields, and packed repeated int32.
 *
 * It decodes structurally (field number → raw values); the SCIP-shape
 * interpretation lives in `scip-decode.ts`.
 */

/** A decoded wire value — a varint number or a length-delimited blob. */
export type WireValue = number | Uint8Array;

/** A decoded message: field number → the values seen for that field. */
export type DecodedMessage = Map<number, WireValue[]>;

/** Wire type 0 — varint. */
const WIRE_VARINT = 0;
/** Wire type 1 — 64-bit fixed (skipped; SCIP uses none). */
const WIRE_I64 = 1;
/** Wire type 2 — length-delimited. */
const WIRE_LEN = 2;
/** Wire type 5 — 32-bit fixed (skipped; SCIP uses none). */
const WIRE_I32 = 5;

/** Low 7 bits of a varint byte carry payload; the 8th is the
 *  continuation flag. Each byte adds 7 bits, so the place value
 *  multiplies by 128 (= 2^7) per byte. */
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUATION_BIT = 0x80;
const VARINT_SHIFT_BASE = 128;
/** A protobuf tag packs `(field_number << 3) | wire_type`: divide by 8
 *  for the field number, mask the low 3 bits for the wire type. */
const TAG_FIELD_DIVISOR = 8;
const TAG_WIRE_MASK = 7;
/** Byte widths of the fixed-width wire types, skipped on decode. */
const I64_FIXED_BYTES = 8;
const I32_FIXED_BYTES = 4;

/**
 * Read a base-128 varint at `pos`. Returns `[value, nextPos]`. Uses
 * arithmetic accumulation (not 32-bit shifts) so values above 2^31 —
 * message lengths in a large index — decode correctly up to 2^53.
 */
export function readVarint(buf: Uint8Array, pos: number): [number, number] {
  let result = 0;
  let shift = 1;
  let p = pos;
  for (;;) {
    if (p >= buf.length) {
      throw new RangeError('readVarint: truncated varint at end of buffer');
    }
    const b = buf[p++]!;
    result += (b & VARINT_PAYLOAD_MASK) * shift;
    if ((b & VARINT_CONTINUATION_BIT) === 0) break;
    shift *= VARINT_SHIFT_BASE;
  }
  return [result, p];
}

/**
 * Decode one wire field at `pos` in `buf`. Returns `[value, nextPos]`
 * when the field carries a storable value, or `[null, nextPos]` when the
 * wire type is a fixed-width skip (I64 / I32 — SCIP defines none, but a
 * forward-compatible decoder must not choke). Throws `RangeError` on an
 * overrun or an unknown wire type.
 */
function decodeWireField(buf: Uint8Array, pos: number, wire: number): [WireValue | null, number] {
  if (wire === WIRE_VARINT) {
    const [value, next] = readVarint(buf, pos);
    return [value, next];
  }
  if (wire === WIRE_LEN) {
    const [len, afterLen] = readVarint(buf, pos);
    if (afterLen + len > buf.length) {
      throw new RangeError('decodeMessage: length-delimited field overruns buffer');
    }
    return [buf.subarray(afterLen, afterLen + len), afterLen + len];
  }
  if (wire === WIRE_I64) return [null, pos + I64_FIXED_BYTES];
  if (wire === WIRE_I32) return [null, pos + I32_FIXED_BYTES];
  throw new RangeError(`decodeMessage: unsupported wire type ${wire}`);
}

/**
 * Decode a protobuf message body into a field-number → values map.
 * Repeated fields accumulate every occurrence; the caller picks first
 * / last / all. Unknown 64-bit and 32-bit fixed fields are skipped
 * (SCIP defines none, but a forward-compatible decoder must not choke).
 */
export function decodeMessage(buf: Uint8Array): DecodedMessage {
  const fields: DecodedMessage = new Map();
  let pos = 0;
  while (pos < buf.length) {
    let tag: number;
    [tag, pos] = readVarint(buf, pos);
    const field = Math.floor(tag / TAG_FIELD_DIVISOR);
    const wire = tag & TAG_WIRE_MASK;
    const [value, next] = decodeWireField(buf, pos, wire);
    pos = next;
    if (value === null) continue; // fixed-width skip (I64 / I32)
    const arr = fields.get(field);
    if (arr) arr.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

/** Unpack a packed-varint field body (e.g. `Occurrence.range`). */
export function decodePackedVarints(buf: Uint8Array): number[] {
  const out: number[] = [];
  let pos = 0;
  while (pos < buf.length) {
    let v: number;
    [v, pos] = readVarint(buf, pos);
    out.push(v);
  }
  return out;
}

// ── typed field accessors ─────────────────────────────────────────

/** The first value of a field, or `undefined` when absent. */
export function firstValue(msg: DecodedMessage, field: number): WireValue | undefined {
  return msg.get(field)?.[0];
}

/** A varint field as a number (default 0 — proto3 scalar default). */
export function getVarint(msg: DecodedMessage, field: number): number {
  const v = firstValue(msg, field);
  return typeof v === 'number' ? v : 0;
}

/** A length-delimited field decoded as a UTF-8 string (default ''). */
export function getString(msg: DecodedMessage, field: number): string {
  const v = firstValue(msg, field);
  return v instanceof Uint8Array ? Buffer.from(v).toString('utf8') : '';
}

/** Every value of a repeated string field. */
export function getStrings(msg: DecodedMessage, field: number): string[] {
  return (msg.get(field) ?? [])
    .filter((v): v is Uint8Array => v instanceof Uint8Array)
    .map((v) => Buffer.from(v).toString('utf8'));
}

/** A nested-message field decoded one level deeper (or `undefined`). */
export function getMessage(msg: DecodedMessage, field: number): DecodedMessage | undefined {
  const v = firstValue(msg, field);
  return v instanceof Uint8Array ? decodeMessage(v) : undefined;
}

/** Every value of a repeated nested-message field, decoded. */
export function getMessages(msg: DecodedMessage, field: number): DecodedMessage[] {
  return (msg.get(field) ?? []).filter((v): v is Uint8Array => v instanceof Uint8Array).map((v) => decodeMessage(v));
}

/** A packed repeated int32 field as a number array (default []). */
export function getPackedVarints(msg: DecodedMessage, field: number): number[] {
  const v = firstValue(msg, field);
  return v instanceof Uint8Array ? decodePackedVarints(v) : [];
}
