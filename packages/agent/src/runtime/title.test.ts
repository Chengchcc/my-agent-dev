import { describe, expect, test } from "bun:test";
import { buildTitleContext, isLowSignalTitleInput, normalizeGeneratedTitle } from "./title.js";

describe("title", () => {
  test("buildTitleContext extracts first N turns", () => {
    const ctx = buildTitleContext(
      [
        { role: "user", text: "帮我修复登录 bug" },
        { role: "assistant", text: "好的，我来看一下" },
        { role: "user", text: "还有第三轮" },
        { role: "user", text: "第四轮" },
        { role: "user", text: "第五轮不该出现" },
      ],
      2,
    );
    expect(ctx).toContain("帮我修复登录 bug");
    expect(ctx).not.toContain("第五轮");
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
