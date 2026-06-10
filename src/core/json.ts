export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// jq's `//` alternative operator: null and false both fall through.
export function jqAlt(value: JsonValue | undefined, fallback: JsonValue): JsonValue {
  if (value === null || value === undefined || value === false) {
    return fallback;
  }
  return value;
}
