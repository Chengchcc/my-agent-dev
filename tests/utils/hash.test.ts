import { describe, it, expect } from "bun:test";
import { djb2Hash } from "../../src/utils/hash";

describe("djb2Hash", () => {
  it("returns a hex string", () => {
    const result = djb2Hash("test");
    expect(typeof result).toBe("string");
    expect(/^[0-9a-f]+$/.test(result)).toBe(true);
  });

  it("is deterministic — same input produces same output", () => {
    expect(djb2Hash("hello")).toBe(djb2Hash("hello"));
  });

  it("produces different outputs for different inputs", () => {
    expect(djb2Hash("hello")).not.toBe(djb2Hash("world"));
  });

  it("handles empty string", () => {
    const result = djb2Hash("");
    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
  });

  it("produces known regression values", () => {
    expect(djb2Hash("hello")).toBe("f923099");
    expect(djb2Hash("")).toBe("1505");
    expect(djb2Hash("world")).toBe("10a7356d");
  });
});
