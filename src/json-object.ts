export type JsonObject = Record<string, unknown>;
export type JsonStringRecord = Record<string, string>;

/**
 * Coerce an unknown JSON-like value to an own-property string-keyed object.
 * Inherited fields are intentionally dropped so callers can safely inspect
 * parsed config/file payloads even if Object.prototype is polluted.
 */
export function asJsonObject(value: unknown): JsonObject | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;

  const ownOnly: JsonObject = Object.create(null);
  for (const [key, entryValue] of Object.entries(value)) {
    ownOnly[key] = entryValue;
  }
  return ownOnly;
}

export function asJsonStringRecord(value: unknown): JsonStringRecord | null {
  const object = asJsonObject(value);
  if (!object) return null;

  const ownOnly: JsonStringRecord = Object.create(null);
  for (const key of Object.keys(object)) {
    const entryValue = object[key];
    if (typeof entryValue === 'string') ownOnly[key] = entryValue;
  }
  return ownOnly;
}
