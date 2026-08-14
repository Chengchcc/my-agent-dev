import { describe, expect, test } from "bun:test";
import { isValidWorkflowName } from "./workflow-tools.js";


describe("isValidWorkflowName", () => {
  test("plain labels pass; path segments and escapes are rejected", () => {
    expect(isValidWorkflowName("audit")).toBe(true);
    expect(isValidWorkflowName("audit-routes-2")).toBe(true);
    expect(isValidWorkflowName("../../x")).toBe(false);
    expect(isValidWorkflowName("a/b")).toBe(false);
    expect(isValidWorkflowName(".hidden")).toBe(false);
    expect(isValidWorkflowName("")).toBe(false);
    expect(isValidWorkflowName("x".repeat(65))).toBe(false);
  });
});
