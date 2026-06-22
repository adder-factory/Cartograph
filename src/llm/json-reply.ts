function isJsonObjectWithOwnField(value: unknown, field: string): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, field);
}

export function parseJsonObjectWithOwnField(rawText: string, field: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return isJsonObjectWithOwnField(parsed, field) ? parsed : null;
  } catch {
    return null;
  }
}
