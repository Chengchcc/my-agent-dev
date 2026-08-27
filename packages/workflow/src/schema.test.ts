import { describe, expect, test } from "bun:test";
import { isValidBySchema, validateBySchema } from "./schema.js";

describe("validateBySchema", () => {
  test("object schema with required/properties/additionalProperties", () => {
    const schema = {
      type: "object",
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name"],
      additionalProperties: false,
    };
    expect(validateBySchema({ name: "a", age: 1 }, schema)).toEqual([]);
    expect(validateBySchema({ age: 1 }, schema)).toEqual(["$.name is required"]);
    expect(validateBySchema({ name: "a", extra: true }, schema)).toEqual([
      "$.extra is not allowed",
    ]);
  });

  test("array with items and minItems", () => {
    const schema = { type: "array", items: { type: "number" }, minItems: 1 };
    expect(validateBySchema([1, 2], schema)).toEqual([]);
    expect(validateBySchema([], schema)).toEqual(["$ must have at least 1 items"]);
    expect(validateBySchema(["x"], schema)).toEqual(["$[0] must be number"]);
  });

  test("string length + enum + number bounds", () => {
    expect(validateBySchema("abc", { type: "string", minLength: 2, maxLength: 5 })).toEqual([]);
    expect(validateBySchema("a", { type: "string", minLength: 2 })).toEqual([
      "$ must be at least 2 chars",
    ]);
    expect(validateBySchema(3, { enum: [1, 2] })).toEqual(["$ must be one of [1,2]"]);
    expect(validateBySchema(5, { type: "integer", minimum: 0, maximum: 4 })).toEqual([
      "$ must be <= 4",
    ]);
    expect(validateBySchema(5.5, { type: "integer" })).toEqual(["$ must be integer"]);
  });

  test("isValidBySchema shorthand", () => {
    expect(
      isValidBySchema(
        { ok: true },
        { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      ),
    ).toBe(true);
    expect(
      isValidBySchema(
        { ok: 1 },
        { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
      ),
    ).toBe(false);
  });
});
