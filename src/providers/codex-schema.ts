import { isJsonObject, type JsonObject, type JsonValue } from '../core/json.js';

export interface CodexSchemaProjection {
  readonly schema: JsonObject;
  readonly changed: boolean;
}

const CODEX_UNSUPPORTED_SCHEMA_KEYWORDS = new Set(['uniqueItems']);
const CODEX_EMPTY_ARRAY_ITEMS: JsonObject = { type: 'string' };

function nullableSchema(schema: JsonValue): JsonValue {
  if (!isJsonObject(schema)) {
    return { anyOf: [schema, { type: 'null' }] };
  }
  const type = schema.type;
  if (typeof type === 'string') {
    return { ...schema, type: [type, 'null'] };
  }
  if (Array.isArray(type)) {
    return type.includes('null') ? schema : { ...schema, type: [...type, 'null'] };
  }
  return { anyOf: [schema, { type: 'null' }] };
}

export function projectCodexJsonSchema(schema: JsonObject): CodexSchemaProjection {
  let changed = false;

  function project(value: JsonValue): JsonValue {
    if (Array.isArray(value)) {
      return value.map(project);
    }
    if (!isJsonObject(value)) {
      return value;
    }

    if (typeof value.$ref === 'string') {
      if (Object.keys(value).length > 1) {
        changed = true;
      }
      return { $ref: value.$ref };
    }

    const projected: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      if (CODEX_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) {
        changed = true;
        continue;
      }
      projected[key] = project(child);
    }

    if (value.type === 'array' && value.items === undefined) {
      if (value.maxItems !== 0) {
        throw new TypeError('Codex array schemas without items must be constrained to maxItems 0');
      }
      projected.items = CODEX_EMPTY_ARRAY_ITEMS;
      changed = true;
    }

    const properties = value.properties;
    if (!isJsonObject(properties)) {
      return projected;
    }
    const required = new Set(
      Array.isArray(value.required)
        ? value.required.filter((item): item is string => typeof item === 'string')
        : [],
    );
    const projectedProperties: JsonObject = {};
    for (const [key, propertySchema] of Object.entries(properties)) {
      const projectedProperty = project(propertySchema);
      projectedProperties[key] = required.has(key)
        ? projectedProperty
        : nullableSchema(projectedProperty);
      if (!required.has(key)) {
        changed = true;
      }
    }
    projected.properties = projectedProperties;
    projected.required = Object.keys(properties);
    return projected;
  }

  const projected = project(schema);
  if (!isJsonObject(projected)) {
    throw new TypeError('Codex JSON schema must be an object');
  }
  return { schema: projected, changed };
}

function decodeJsonPointer(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

function resolveSchema(schema: JsonObject, root: JsonObject): JsonObject {
  const reference = schema.$ref;
  if (typeof reference !== 'string' || !reference.startsWith('#/')) {
    return schema;
  }
  let current: JsonValue = root;
  for (const segment of reference.slice(2).split('/').map(decodeJsonPointer)) {
    if (!isJsonObject(current) || current[segment] === undefined) {
      return schema;
    }
    current = current[segment];
  }
  return isJsonObject(current) ? current : schema;
}

export function normalizeCodexJsonValue(value: JsonValue, canonicalSchema: JsonObject): JsonValue {
  function normalize(current: JsonValue, schema: JsonObject): JsonValue {
    const resolved = resolveSchema(schema, canonicalSchema);
    if (Array.isArray(current)) {
      const items = resolved.items;
      return isJsonObject(items) ? current.map((item) => normalize(item, items)) : current;
    }
    if (!isJsonObject(current)) {
      return current;
    }
    const properties = resolved.properties;
    if (!isJsonObject(properties)) {
      return current;
    }
    const required = new Set(
      Array.isArray(resolved.required)
        ? resolved.required.filter((item): item is string => typeof item === 'string')
        : [],
    );
    const normalized: JsonObject = {};
    for (const [key, child] of Object.entries(current)) {
      const propertySchema = properties[key];
      if (child === null && !required.has(key)) {
        continue;
      }
      normalized[key] = isJsonObject(propertySchema) ? normalize(child, propertySchema) : child;
    }
    return normalized;
  }

  return normalize(value, canonicalSchema);
}
