import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOutcomeMessages, createOmpAccumulator, mapOmpEvent } from "./event-mapper.js";
import { parseOmpLine } from "./wire.js";

function linesOf(fixture: string): string[] {
  return readFileSync(join(import.meta.dir, "__fixtures__", fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

describe("omp wire → CoreBackendEvent", () => {
  test("text-only run maps deltas, usage and final text", () => {
    const acc = createOmpAccumulator();
    for (const line of linesOf("omp-wire-text.jsonl")) {
      const evt = parseOmpLine(line);
      expect(evt).not.toBeNull();
      for (const e of [evt!]) mapOmpEvent(acc, e);
    }
    // real captured stream: thinking deltas, text deltas, one assistant
    // message_end with usage, turn_end with the final text, agent_end.
    const text = acc.events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("OK");
    expect(acc.usage.inputTokens).toBeGreaterThan(0);
    expect(acc.usage.outputTokens).toBeGreaterThan(0);
    expect(acc.assistantTexts.at(-1)).toBe("OK");
    expect(acc.error).toBeNull();
  });

  test("tool run maps native tool started/completed", () => {
    const acc = createOmpAccumulator();
    for (const line of linesOf("omp-wire-tool.jsonl")) {
      const evt = parseOmpLine(line);
      if (!evt) continue;
      mapOmpEvent(acc, evt);
    }
    const started = acc.events.filter((e) => e.type === "native_tool_started");
    const completed = acc.events.filter((e) => e.type === "native_tool_completed");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBe(started.length);
    const first = started[0] as { toolName: string; callId: string };
    expect(first.toolName).toBe("bash");
    expect(first.callId).toMatch(/^call_/);
    // agent_end carries the canonical transcript — the final answer is
    // the last assistant text ("Done. /tmp/pi-tool-test.txt contains hello").
    expect(acc.assistantTexts.at(-1)).toContain("hello");
  });

  test("malformed lines are skipped, not fatal", () => {
    const acc = createOmpAccumulator();
    mapOmpEvent(acc, { type: "session" });
    expect(parseOmpLine("not json")).toBeNull();
    expect(parseOmpLine("")).toBeNull();
    expect(acc.events).toHaveLength(0);
  });
});

describe("outcome messages", () => {
  test("assistant texts become canonical assistant messages", () => {
    const messages = buildOutcomeMessages(["first", "second"]);
    expect(messages).toEqual([
      { role: "assistant", text: "first" },
      { role: "assistant", text: "second" },
    ]);
  });
});

  test("an error event with NO message still registers a failed outcome", () => {
    const acc = createOmpAccumulator();
    const evt = parseOmpLine(JSON.stringify({ type: "error" }));
    expect(evt).not.toBeNull();
    if (evt) mapOmpEvent(acc, evt);
    expect(typeof acc.error).toBe("string");
    expect(acc.error).toBeTruthy();
  });
