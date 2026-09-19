/**
 * Translate a local authoritative JSON Schema into the strict-output subset a
 * provider accepts. The backend still validates model output against the full
 * original schema with Ajv; this translation only removes keywords the
 * provider's constrained decoder may reject.
 *
 * Defaults are conservative: `$schema` is metadata; `const` becomes a
 * single-value `enum`; string length bounds are dropped (they remain enforced
 * locally). Everything else (types, required, additionalProperties:false,
 * enum, anyOf, min/max items, integer bounds) is retained.
 */

export interface ProviderSchemaOptions {
  /** Keywords to strip. Default: $schema, maxLength, minLength. */
  strip?: readonly string[];
  /** Convert `const` to `enum` (default true). */
  constToEnum?: boolean;
  /** Ensure every object lists all properties as required and forbids additional ones (default true). */
  forceStrictObjects?: boolean;
}

const DEFAULT_STRIP = ['$schema', 'maxLength', 'minLength'] as const;

type JsonSchema = Record<string, unknown>;

export function toProviderStrictSchema(schema: JsonSchema, options: ProviderSchemaOptions = {}): JsonSchema {
  const strip = new Set(options.strip ?? DEFAULT_STRIP);
  const constToEnum = options.constToEnum ?? true;
  const forceStrictObjects = options.forceStrictObjects ?? true;

  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== 'object') return node;
    const out: JsonSchema = {};
    const src = node as JsonSchema;
    for (const [key, value] of Object.entries(src)) {
      if (strip.has(key)) continue;
      if (key === 'const' && constToEnum) {
        out['enum'] = [value];
        continue;
      }
      if (key === 'properties' && value && typeof value === 'object') {
        const props: JsonSchema = {};
        for (const [pk, pv] of Object.entries(value as JsonSchema)) props[pk] = walk(pv);
        out[key] = props;
        continue;
      }
      if (key === 'items' || key === 'anyOf' || key === 'oneOf' || key === 'allOf' || key === 'not') {
        out[key] = walk(value);
        continue;
      }
      out[key] = value;
    }
    if (forceStrictObjects && out['type'] === 'object' && out['properties'] && typeof out['properties'] === 'object') {
      out['required'] = Object.keys(out['properties'] as JsonSchema);
      out['additionalProperties'] = false;
    }
    return out;
  };

  return walk(schema) as JsonSchema;
}
