import { describe, expect, test } from "bun:test";
import { evalJsonLogic } from "./json-logic.js";

const data = {
  store: { threshold: 3 },
  triage: { output: { severity: "high", count: 5 } },
};

describe("evalJsonLogic", () => {
  test("literals and var", () => {
    expect(evalJsonLogic(42, data)).toBe(42);
    expect(evalJsonLogic("x", data)).toBe("x");
    expect(evalJsonLogic({ var: "triage.output.severity" }, data)).toBe("high");
    expect(evalJsonLogic({ var: "triage.output.missing" }, data)).toBeNull();
    expect(evalJsonLogic({ var: ["triage.output.missing", "fallback"] }, data)).toBe("fallback");
    expect(evalJsonLogic(undefined, data)).toBeNull();
  });

  test("comparison operators", () => {
    expect(evalJsonLogic({ "==": [{ var: "triage.output.severity" }, "high"] }, data)).toBe(true);
    expect(evalJsonLogic({ "!=": [{ var: "triage.output.severity" }, "low"] }, data)).toBe(true);
    expect(evalJsonLogic({ ">": [{ var: "triage.output.count" }, 3] }, data)).toBe(true);
    expect(evalJsonLogic({ ">=": [{ var: "store.threshold" }, 3] }, data)).toBe(true);
    expect(evalJsonLogic({ "<": [{ var: "triage.output.count" }, 1] }, data)).toBe(false);
    expect(evalJsonLogic({ "<=": [{ var: "store.threshold" }, 3] }, data)).toBe(true);
  });

  test("in operator", () => {
    expect(evalJsonLogic({ in: ["high", ["low", "high"]] }, data)).toBe(true);
    expect(evalJsonLogic({ in: ["z", "abc"] }, data)).toBe(false);
    expect(evalJsonLogic({ in: ["b", "abc"] }, data)).toBe(true);
  });

  test("logic operators (array and bare-object forms)", () => {
    expect(
      evalJsonLogic(
        {
          and: [
            { "==": [{ var: "triage.output.severity" }, "high"] },
            { ">": [{ var: "triage.output.count" }, 1] },
          ],
        },
        data,
      ),
    ).toBe(true);
    expect(
      evalJsonLogic(
        {
          or: [
            { "==": [{ var: "triage.output.severity" }, "low"] },
            { ">": [{ var: "triage.output.count" }, 1] },
          ],
        },
        data,
      ),
    ).toBe(true);
    expect(
      evalJsonLogic({ not: [{ "==": [{ var: "triage.output.severity" }, "low"] }] }, data),
    ).toBe(true);
    expect(evalJsonLogic({ not: { "==": [{ var: "triage.output.severity" }, "low"] } }, data)).toBe(
      true,
    );
    expect(evalJsonLogic({ "!!": [{ var: "triage.output.severity" }] }, data)).toBe(true);
    expect(evalJsonLogic({ "!!": { var: "triage.output.severity" } }, data)).toBe(true);
    expect(
      evalJsonLogic(
        { if: [{ "==": [{ var: "triage.output.severity" }, "high"] }, "a", "b"] },
        data,
      ),
    ).toBe("a");
  });

  test("plain object evaluates values", () => {
    expect(evalJsonLogic({ a: { var: "triage.output.severity" }, b: 1 }, data)).toEqual({
      a: "high",
      b: 1,
    });
  });
});
