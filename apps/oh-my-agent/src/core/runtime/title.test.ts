import { describe, expect, test } from "bun:test";
import { buildTitleContext, isLowSignalTitleInput, normalizeGeneratedTitle } from "./title.js";

describe("title", () => {
  test("buildTitleContext extracts most recent N turns", () => {
    const ctx = buildTitleContext(
      [
        { role: "user", text: "第一轮寒暄" },
        { role: "assistant", text: "" },
        { role: "user", text: "第二轮的实质问题是什么" },
        { role: "assistant", text: "" },
        { role: "user", text: "第三轮的实质问题" },
      ],
      2,
    );
    // Recent content wins; early greeting / empty thinking-filler turns must
    // not crowd out the substantive question that should produce a title.
    expect(ctx).toContain("第二轮的实质问题");
    expect(ctx).toContain("第三轮的实质问题");
    expect(ctx).not.toContain("第一轮寒暄");
  });

  test("isLowSignalTitleInput filters greetings", () => {
    expect(isLowSignalTitleInput("hi")).toBe(true);
    expect(isLowSignalTitleInput("hey hey")).toBe(true);
    expect(isLowSignalTitleInput("你好")).toBe(true);
    expect(isLowSignalTitleInput("ok")).toBe(true);
    expect(isLowSignalTitleInput("fix the login bug")).toBe(false);
    expect(isLowSignalTitleInput("add JWT authentication")).toBe(false);
  });

  test("normalizeGeneratedTitle strips XML tags and quotes", () => {
    expect(normalizeGeneratedTitle("<title>Fix login</title>")).toBe("Fix login");
    expect(normalizeGeneratedTitle('"Fix login"')).toBe("Fix login");
    expect(normalizeGeneratedTitle("「登录修复」")).toBe("登录修复");
  });

  test("normalizeGeneratedTitle rejects none/empty/overlong", () => {
    expect(normalizeGeneratedTitle("<title>none</title>")).toBeNull();
    expect(normalizeGeneratedTitle("none")).toBeNull();
    expect(normalizeGeneratedTitle("")).toBeNull();
    expect(normalizeGeneratedTitle("a".repeat(81))).toBeNull();
  });
});
