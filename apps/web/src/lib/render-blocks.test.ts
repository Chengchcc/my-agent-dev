import { describe, expect, test } from "bun:test";
import { normalizeToolResultContent, stripSystemReminders } from "./render-blocks";

describe("stripSystemReminders", () => {
  test("strips the tool-failure reminder prefix, keeps the payload", () => {
    const raw =
      '<system-reminder>\nThis tool call FAILED. Do not proceed.\n</system-reminder>\n\n{"error":"kaboom"}';
    expect(stripSystemReminders(raw)).toBe('{"error":"kaboom"}');
  });

  test("strips attributed rule reminders anywhere in the content", () => {
    const raw =
      'head\n<system-reminder reason="rule_violation" rule="x">\nfix\n</system-reminder>\ntail';
    expect(stripSystemReminders(raw)).toBe("head\ntail");
  });

  test("content without reminders is unchanged", () => {
    expect(stripSystemReminders('{"ok":true}')).toBe('{"ok":true}');
  });
});

describe("normalizeToolResultContent", () => {
  test("string content passes through reminder stripping", () => {
    expect(normalizeToolResultContent('<system-reminder>nope</system-reminder>\n\n{"a":1}')).toBe(
      '{"a":1}',
    );
  });

  test("array content still joins text blocks", () => {
    expect(
      normalizeToolResultContent([
        { type: "text", text: "a" },
        { type: "text", text: "b" },
      ]),
    ).toBe("a\nb");
  });
});
