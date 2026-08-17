import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mapRunEvent, mapRunOutcome } from "./event-mapper.js";
import { codingAgentOutputSchema } from "./protocol.js";

/** Fixture contract (ADR 0024): the REAL oma child emitted this JSONL.
 *  The adapter's local parser/mapping must consume it without drift. */
const FIXTURE = new URL("../../../apps/oh-my-agent/fixtures/rpc-basic.jsonl", import.meta.url)
  .pathname;

describe("oma wire fixture contract", () => {
  test("adapter parses and maps the real child fixture", () => {
    const lines = readFileSync(FIXTURE, "utf-8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    expect(lines.length).toBeGreaterThan(0);
    const outputs = lines.map((l) => codingAgentOutputSchema.parse(JSON.parse(l)));
    expect(outputs.some((o) => o.type === "response" && o.success === true)).toBe(true);
    expect(outputs.some((o) => o.type === "event")).toBe(true);
    expect(outputs[outputs.length - 1]?.type).toBe("outcome");

    for (const output of outputs) {
      if (output.type === "event") {
        expect(mapRunEvent(output.event).type).toBeTruthy();
      }
      if (output.type === "outcome") {
        expect(mapRunOutcome(output.outcome).status).toBe("completed");
      }
    }
  });
});
