import type { JsonSchema } from "./types.js";

/** JSON Schema 子集（workflow node input/output 校验用）。
 *  v1 支持：type/properties/required/additionalProperties/items/enum/
 *  minimum/maximum/minLength/maxLength/minItems/maxItems。不含 $ref/oneOf/pattern。 */

function matchesType(v: unknown, t: NonNullable<JsonSchema["type"]>): boolean {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "null":
      return v === null;
    case "object":
      return typeof v === "object" && v !== null && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function validate(value: unknown, schema: JsonSchema, path: string, errors: string[]): void {
  if (schema.type !== undefined && !matchesType(value, schema.type)) {
    errors.push(`${path} must be ${schema.type}`);
    return;
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => deepEqual(e, value))) {
    errors.push(`${path} must be one of ${JSON.stringify(schema.enum)}`);
    return;
  }
  if (schema.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return; // type error already
    const obj = value as Record<string, unknown>;
    for (const k of schema.required ?? []) {
      if (!(k in obj)) errors.push(`${path}.${k} is required`);
    }
    for (const [k, sub] of Object.entries(schema.properties ?? {})) {
      if (k in obj) validate(obj[k], sub, `${path}.${k}`, errors);
    }
    if (schema.additionalProperties === false) {
      const allowed = new Set(Object.keys(schema.properties ?? {}));
      for (const k of Object.keys(obj)) {
        if (!allowed.has(k)) errors.push(`${path}.${k} is not allowed`);
      }
    }
    return;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return; // type error already
    if (schema.minItems !== undefined && value.length < schema.minItems)
      errors.push(`${path} must have at least ${schema.minItems} items`);
    if (schema.maxItems !== undefined && value.length > schema.maxItems)
      errors.push(`${path} must have at most ${schema.maxItems} items`);
    if (schema.items)
      value.forEach((item, i) => validate(item, schema.items!, `${path}[${i}]`, errors));
    return;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return;
    if (schema.minLength !== undefined && value.length < schema.minLength)
      errors.push(`${path} must be at least ${schema.minLength} chars`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength)
      errors.push(`${path} must be at most ${schema.maxLength} chars`);
    return;
  }
  if (schema.type === "number" || schema.type === "integer") {
    if (typeof value !== "number") return;
    if (schema.type === "integer" && !Number.isInteger(value)) {
      errors.push(`${path} must be integer`);
      return;
    }
    if (schema.minimum !== undefined && value < schema.minimum)
      errors.push(`${path} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum)
      errors.push(`${path} must be <= ${schema.maximum}`);
    return;
  }
}

/** Validate `value` against a JSON-Schema-subset schema. Returns [] if valid. */
export function validateBySchema(value: unknown, schema: JsonSchema): string[] {
  const errors: string[] = [];
  validate(value, schema, "$", errors);
  return errors;
}

/** Convenience: true when the value conforms. */
export function isValidBySchema(value: unknown, schema: JsonSchema): boolean {
  return validateBySchema(value, schema).length === 0;
}
