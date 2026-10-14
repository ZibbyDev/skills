/**
 * A tool's ARGUMENT CONTRACT with its words taken out — what a call may carry,
 * which fields it must carry, their types, enums, bounds and defaults — and a
 * small validator over the same keywords. Used to prove that rewording a tool's
 * descriptions accepts exactly the inputs it accepted before.
 *
 * `skeleton` removes only the `description` KEYWORD of each schema node; a
 * property that happens to be NAMED "description" stays (its name is under
 * `properties`, which is walked as a map of schemas).
 *
 * `accepts` knows the keywords these tool schemas use and throws on any other,
 * so a constraint it does not understand can never pass silently.
 */
const MAP_KEYWORDS = new Set(['properties', 'patternProperties', '$defs', 'definitions']);
const SCHEMA_KEYWORDS = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames']);
const LIST_KEYWORDS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);

export function skeleton(schema) {
  if (Array.isArray(schema)) return schema.map(skeleton);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const key of Object.keys(schema).sort()) {
    if (key === 'description') continue;
    const value = schema[key];
    if (MAP_KEYWORDS.has(key)) out[key] = Object.fromEntries(Object.keys(value).sort().map((name) => [name, skeleton(value[name])]));
    else if (SCHEMA_KEYWORDS.has(key) && value && typeof value === 'object') out[key] = skeleton(value);
    else if (LIST_KEYWORDS.has(key)) out[key] = value.map(skeleton);
    else out[key] = value;
  }
  return out;
}

const KNOWN = new Set(['type', 'description', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'minimum', 'maximum',
  'minItems', 'maxItems', 'minLength', 'maxLength', 'pattern', 'default', 'const', 'anyOf', 'oneOf']);
const typeOf = (v) => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);
const typeMatches = (want, v) => [].concat(want).some((t) => t === typeOf(v) || (t === 'number' && typeof v === 'number'));

export function accepts(schema, value) {
  if (schema === true || schema === undefined) return true;
  if (schema === false) return false;
  for (const key of Object.keys(schema)) if (!KNOWN.has(key)) throw new Error(`schema keyword "${key}" is not understood by this validator`);
  if (schema.type && !typeMatches(schema.type, value)) return false;
  if (schema.enum && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) return false;
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) return false;
  if (schema.anyOf && !schema.anyOf.some((s) => accepts(s, value))) return false;
  if (schema.oneOf && schema.oneOf.filter((s) => accepts(s, value)).length !== 1) return false;
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) return false;
    if (schema.maximum !== undefined && value > schema.maximum) return false;
  }
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && [...value].length < schema.minLength) return false;
    if (schema.maxLength !== undefined && [...value].length > schema.maxLength) return false;
    if (schema.pattern && !new RegExp(schema.pattern, 'u').test(value)) return false;
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return false;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return false;
    if (schema.items && !value.every((v) => accepts(schema.items, v))) return false;
  }
  if (typeOf(value) === 'object') {
    for (const name of schema.required || []) if (!(name in value)) return false;
    const props = schema.properties || {};
    for (const [name, v] of Object.entries(value)) {
      if (name in props) { if (!accepts(props[name], v)) return false; }
      else if (schema.additionalProperties === false) return false;
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !accepts(schema.additionalProperties, v)) return false;
    }
  }
  return true;
}
