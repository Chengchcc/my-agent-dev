import { describe, expect, test } from "bun:test";
import { buildLoopInput, type LoopInputDeps } from "./loop-input.js";

const baseDeps: LoopInputDeps = {
  systemPrompt: "sp",
  metaText: "meta",
  input: { inputId: "ti", message: { role: "user", text: "prompt" } },
};

describe("buildLoopInput", () => {
  test("product history + one Meta + one Prompt in order", () => {
    const result = buildLoopInput({
      ...baseDeps,
      history: [{ productEntryId: "pe-1", message: { role: "user", text: "old" } }],
    });
    const entries = result.batch.entries;
    expect(entries).toHaveLength(3);
    expect(entries[0]).toMatchObject({ source: "product_history", productEntryId: "pe-1" });
    expect(entries[1]).toMatchObject({ source: "meta" });
    expect(entries[2]).toMatchObject({ source: "prompt" });
  });

  test("every loop gets exactly one meta (normal and follow_up)", () => {
    for (const mode of ["normal", "follow_up"] as const) {
      const result = buildLoopInput(baseDeps, mode);
      const metas = result.batch.entries.filter((e) => e.source === "meta");
      expect(metas).toHaveLength(1);
    }
  });

  test("follow_up marks its prompt source", () => {
    const result = buildLoopInput(baseDeps, "follow_up");
    expect(result.batch.entries.at(-1)).toMatchObject({ source: "follow_up" });
  });

  test("no history entries means only meta + prompt", () => {
    const result = buildLoopInput(baseDeps);
    expect(result.batch.entries).toHaveLength(2);
  });
});
