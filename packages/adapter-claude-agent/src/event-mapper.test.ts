import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClaudeAccumulator, finalText, mapClaudeEvent } from "./event-mapper.js";
import { parseClaudeLine } from "./wire.js";

function linesOf(fixture: string): string[] {
  return readFileSync(join(import.meta.dir, "__fixtures__", fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

describe("claude stream-json → CoreBackendEvent (real 2.1.228 capture)", () => {
  test("text run maps text/thinking deltas, session id, result usage", () => {
    const acc = createClaudeAccumulator();
    for (const line of linesOf("claude-wire-text.jsonl")) {
      const evt = parseClaudeLine(line);
      expect(evt).not.toBeNull();
      if (!evt) continue;
      mapClaudeEvent(acc, evt);
    }
    // captured run: assistant text "OK", result success with modelUsage
    expect(acc.events.some((e) => e.type === "text_delta")).toBe(true);
    expect(acc.sessionId).toBe("0e491d46-b3a8-4e64-999a-400043c30f4e");
    expect(acc.result?.isError).toBe(false);
    expect(acc.usage.inputTokens).toBeGreaterThan(0);
    expect(acc.usage.outputTokens).toBeGreaterThan(0);
    expect(finalText(acc)).toBe("OK");
    expect(acc.error).toBeNull();
  });

  test("tool run maps tool_use / tool_result events", () => {
    const acc = createClaudeAccumulator();
    for (const line of linesOf("claude-wire-tool.jsonl")) {
      const evt = parseClaudeLine(line);
      if (!evt) continue;
      mapClaudeEvent(acc, evt);
    }
    const started = acc.events.filter((e) => e.type === "native_tool_started");
    const completed = acc.events.filter((e) => e.type === "native_tool_completed");
    expect(started.length).toBeGreaterThanOrEqual(1);
    expect(completed.length).toBe(started.length);
    expect((started[0] as { toolName: string }).toolName).toBe("Bash");
  });

  test("unknown system subtypes fall through harmlessly", () => {
    const acc = createClaudeAccumulator();
    mapClaudeEvent(acc, { type: "system", subtype: "thinking_tokens" });
    mapClaudeEvent(acc, { type: "system", subtype: "hook_started" });
    expect(acc.events).toHaveLength(0);
    expect(parseClaudeLine("not json")).toBeNull();
  });
});
