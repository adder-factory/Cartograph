/**
 * Minimal protobuf wire-format writer — encode-only, zero-dependency.
 *
 * Cartograph exports SCIP indexes (`scip.proto`, Sourcegraph's Code
 * Intelligence Protocol). SCIP is protobuf, but the export path only
 * ever ENCODES — so rather than pull a protobuf runtime dependency
 * (which cuts against the project's self-containment direction), this
 * file hand-rolls the slice of the proto3 wire format SCIP needs:
 * varints, length-delimited fields (string / bytes / nested message),
 * and packed repeated int32 (the `Occurrence.range` shape).
 *
 * proto3 default-value omission is the CALLER's responsibility — the
 * SCIP encoders in `scip-encode.ts` skip zero / empty / false fields
 * so the output matches what a generated encoder would emit.
 */

/** Wire type 0 — varint (int32 / int64 / uint / bool / enum). */
const WIRE_VARINT = 0;
/** Wire type 2 — length-delimited (string / bytes / message / packed). */
const WIRE_LEN = 2;

/** Varint encoding: 7 payload bits per byte, 8th bit flags "more
 *  bytes follow", so place value advances by 128 (= 2^7) per byte. */
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUATION_BIT = 0x80;
const VARINT_SHIFT_BASE = 128;
/** A protobuf tag is `(field_number << 3) | wire_type`; `<< 3` is a
 *  multiply by 8 in the arithmetic form used here. */
const TAG_FIELD_SHIFT_MULTIPLIER = 8;
/** Mask isolating one octet. */
const BYTE_MASK = 0xff;

/**
 * Accumulates protobuf-encoded bytes into a growable buffer. One
 * instance encodes one message; nested messages get their own child
 * instance whose `finish()` output is embedded length-prefixed.
 */
export class ProtoWriter {
  private buf = new Uint8Array(256);
  private len = 0;

  /** Grow the backing buffer so at least `extra` more bytes fit. */
  private ensure(extra: number): void {
    if (this.len + extra <= this.buf.length) return;
    let next = this.buf.length * 2;
    while (next < this.len + extra) next *= 2;
    const grown = new Uint8Array(next);
    grown.set(this.buf.subarray(0, this.len));
    this.buf = grown;
  }

  private pushByte(b: number): void {
    this.ensure(1);
    this.buf[this.len++] = b & BYTE_MASK;
  }

  private rawBytes(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.len);
    this.len += bytes.length;
  }

  /**
   * Append a base-128 varint. Uses arithmetic rather than 32-bit
   * bit-shifts so message lengths above 2^31 encode correctly (a
   * large SCIP index can exceed that). Negative input is a caller
   * bug — SCIP carries no negative wire values.
   */
  varint(value: number): void {
    if (value < 0 || !Number.isFinite(value)) {
      throw new RangeError(`ProtoWriter.varint: bad value ${value}`);
    }
    let v = Math.floor(value);
    while (v > VARINT_PAYLOAD_MASK) {
      this.pushByte((v % VARINT_SHIFT_BASE) | VARINT_CONTINUATION_BIT);
      v = Math.floor(v / VARINT_SHIFT_BASE);
    }
    this.pushByte(v);
  }

  /** Field tag = (fieldNumber << 3) | wireType, as a varint. */
  private tag(field: number, wireType: number): void {
    this.varint(field * TAG_FIELD_SHIFT_MULTIPLIER + wireType);
  }

  /** `int32` / `uint32` / enum field (wire type 0). */
  uint32(field: number, value: number): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value);
  }

  /** `bool` field (wire type 0). */
  bool(field: number, value: boolean): void {
    this.tag(field, WIRE_VARINT);
    this.varint(value ? 1 : 0);
  }

  /** `string` field (wire type 2, UTF-8 encoded). */
  string(field: number, value: string): void {
    this.bytes(field, Buffer.from(value, 'utf8'));
  }

  /**
   * Length-delimited field (wire type 2). String, bytes and nested
   * message all share this shape — a varint length then the payload.
   */
  bytes(field: number, value: Uint8Array): void {
    this.tag(field, WIRE_LEN);
    this.varint(value.length);
    this.rawBytes(value);
  }

  /** Nested message field — `fn` populates a fresh child writer. */
  message(field: number, fn: (w: ProtoWriter) => void): void {
    const child = new ProtoWriter();
    fn(child);
    this.bytes(field, child.finish());
  }

  /**
   * `repeated int32` encoded packed — proto3's default for scalar
   * repeated fields, and what SCIP's `Occurrence.range` expects. An
   * empty list emits nothing (proto3 default omission).
   */
  packedUint32(field: number, values: readonly number[]): void {
    if (values.length === 0) return;
    const child = new ProtoWriter();
    for (const v of values) child.varint(v);
    this.bytes(field, child.finish());
  }

  /** The encoded bytes. The returned view aliases the internal buffer. */
  finish(): Uint8Array {
    return this.buf.subarray(0, this.len);
  }
}
