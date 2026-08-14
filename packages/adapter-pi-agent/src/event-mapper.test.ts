import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildOutcomeMessages, createPiAccumulator, mapPiEvent } from "./event-mapper.js";
import { parsePiLine } from "./wire.js";

function linesOf(fixture: string): string[] {
  return readFileSync(join(import.meta.dir, "__fixtures__", fixture), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "");
}

describe("pi wire → CoreBackendEvent (synthetic fixtures per pi source)", () => {
  test("text run maps deltas, turn_end usage and final text", () => {
    const acc = createPiAccumulator();
    for (const line of linesOf("pi-wire-text.jsonl")) {
      const evt = parsePiLine(line);
      expect(evt).not.toBeNull();
      if (!evt) continue;
      mapPiEvent(acc, evt);
    }
    const text = acc.events
      .filter((e) => e.type === "text_delta")
      .map((e) => (e as { text: string }).text)
      .join("");
    expect(text).toBe("OK");
    expect(acc.usage.inputTokens).toBe(3618);
    expect(acc.usage.outputTokens).toBe(2);
    expect(acc.assistantTexts.at(-1)).toBe("OK");
    expect(acc.error).toBeNull();
  });

  test("tool run maps native tool started/completed with pi arg shapes", () => {
    const acc = createPiAccumulator();
    for (const line of linesOf("pi-wire-tool.jsonl")) {
      const evt = parsePiLine(line);
      if (!evt) continue;
      mapPiEvent(acc, evt);
    }
    const started = acc.events.filter((e) => e.type === "native_tool_started");
    const completed = acc.events.filter((e) => e.type === "native_tool_completed");
    expect(started).toHaveLength(1);
    expect(completed).toHaveLength(1);
    expect((started[0] as { toolName: string }).toolName).toBe("bash");
    expect(acc.assistantTexts.at(-1)).toContain("DONE");
  });

  test("malformed lines are skipped, not fatal", () => {
    const acc = createPiAccumulator();
    expect(parsePiLine("not json")).toBeNull();
    expect(acc.events).toHaveLength(0);
  });
});

describe("outcome messages", () => {
  test("assistant texts become canonical assistant messages", () => {
    expect(buildOutcomeMessages(["hello"])).toEqual([{ role: "assistant", text: "hello" }]);
  });
});

  test("an error event with NO message still registers a failed outcome", () => {
    const acc = createPiAccumulator();
    // A bare {type:"error"} line: JSON.stringify(undefined) used to return
    // undefined and poison acc.error into a non-null-non-string value that
    // the downstream `else if (acc.error)` branch swallowed.
    const evt = parsePiLine(JSON.stringify({ type: "error" }));
    expect(evt).not.toBeNull();
    if (evt) mapPiEvent(acc, evt);
    expect(typeof acc.error).toBe("string");
    expect(acc.error).toBeTruthy();
  });
