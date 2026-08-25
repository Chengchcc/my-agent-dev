import { describe, expect, test } from "bun:test";
import {
  estimateContextTokens,
  isSilentContextOverflow,
  type UsageAnchor,
  usageTotalTokens,
} from "./context-estimate.js";

describe("estimateContextTokens (usage-anchored, oh-my-pi)", () => {
  const entries = [
    { entryId: "a", est: 100 },
    { entryId: "b", est: 200 },
    { entryId: "c", est: 300 },
  ];
  const estimateEntry = (e: { est: number }) => e.est;

  test("no anchor: full per-entry estimation", () => {
    expect(estimateContextTokens(entries, null, estimateEntry)).toBe(600);
  });

  test("anchor replaces everything up to and including the boundary entry", () => {
    const anchor: UsageAnchor = { afterEntryId: "b", tokens: 1000 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(1300);
  });

  test("anchor at last entry covers the whole branch", () => {
    const anchor: UsageAnchor = { afterEntryId: "c", tokens: 42 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(42);
  });

  test("anchor boundary entry gone (post-compaction) falls back to full estimate", () => {
    const anchor: UsageAnchor = { afterEntryId: "zzz", tokens: 1000 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(600);
  });

  test("null boundary (empty branch at call time) anchors everything", () => {
    const anchor: UsageAnchor = { afterEntryId: null, tokens: 500 };
    expect(estimateContextTokens(entries, anchor, estimateEntry)).toBe(1100);
  });
});

describe("isSilentContextOverflow (oh-my-pi)", () => {
  test("zai-style: input side over the window on a successful turn", () => {
    expect(
      isSilentContextOverflow({ inputTokens: 5000, cacheReadTokens: 0 }, "end_turn", 4000),
    ).toBe(true);
  });

  test("cacheRead counts toward the input side", () => {
    expect(isSilentContextOverflow({ inputTokens: 100, cacheReadTokens: 3950 }, "stop", 4000)).toBe(
      true,
    );
  });

  test("normal in-window usage is not overflow", () => {
    expect(isSilentContextOverflow({ inputTokens: 3000, outputTokens: 10 }, "end_turn", 4000)).toBe(
      false,
    );
  });

  test("xiaomi-style: length-stop with zero output filling the window", () => {
    expect(
      isSilentContextOverflow(
        { inputTokens: 3980, outputTokens: 0, cacheReadTokens: 0 },
        "max_tokens",
        4000,
      ),
    ).toBe(true);
    // output > 0 means generation happened: not a silent overflow
    expect(
      isSilentContextOverflow(
        { inputTokens: 3980, outputTokens: 5, cacheReadTokens: 0 },
        "max_tokens",
        4000,
      ),
    ).toBe(false);
  });

  test("no usage or non-positive limit never overflows", () => {
    expect(isSilentContextOverflow(undefined, "end_turn", 4000)).toBe(false);
    expect(isSilentContextOverflow({ inputTokens: 9999 }, "end_turn", 0)).toBe(false);
  });
});

describe("usageTotalTokens", () => {
  test("sums all four legs", () => {
    expect(
      usageTotalTokens({
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 5,
        cacheWriteTokens: 1,
      }),
    ).toBe(116);
  });
});
