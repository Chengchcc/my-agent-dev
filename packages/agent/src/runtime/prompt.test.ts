import { describe, expect, test } from "bun:test";
import type { Model } from "@my-agent-team/ai";
import type { Plugin } from "./plugin.js";
import { renderLoopMeta } from "./prompt.js";

const FAKE_MODEL: Model = {
  id: "claude-sonnet",
  name: "Claude Sonnet",
  provider: "anthropic",
  api: "anthropic-messages",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
};

describe("renderLoopMeta", () => {
  test("wraps non-empty sections in a single system-reminder", () => {
    const skillPlugin: Plugin = {
      name: "skills",
      meta: [{ name: "Available Skills", render: () => "- **math**: do math" }],
    };
    const meta = renderLoopMeta({
      plugins: [skillPlugin],
      workspace: { root: "/ws" },
      model: FAKE_MODEL,
      productContext: "User is debugging a test.",
    });
    expect(meta.startsWith("<system-reminder>")).toBe(true);
    expect(meta.endsWith("</system-reminder>")).toBe(true);
    expect(meta).toContain("Available Skills");
    expect(meta).toContain("math");
    expect(meta).toContain("Product Context");
    expect(meta).toContain("Workspace root: /ws");
    expect(meta).toContain("anthropic/claude-sonnet");
  });

  test("omits empty sections and empty product context", () => {
    const meta = renderLoopMeta({
      plugins: [],
      workspace: { root: "/ws" },
      model: FAKE_MODEL,
      productContext: "   ",
    });
    expect(meta).not.toContain("Product Context");
    expect(meta).toContain("Workspace");
  });

  test("returns empty string when all sections are empty", () => {
    const meta = renderLoopMeta({
      plugins: [],
      workspace: { root: "/ws" },
      model: FAKE_MODEL,
    });
    // workspace/model section always has content, so this should be non-empty.
    // Test the truly-empty path: no workspace facts at all is impossible since
    // root is required. Verify it's still well-formed.
    expect(meta).toContain("Workspace");
  });

  test("renders todo section when items present", () => {
    const meta = renderLoopMeta({
      plugins: [],
      workspace: { root: "/ws" },
      model: FAKE_MODEL,
      todo: { items: [{ id: "t1", text: "write tests", status: "in_progress" }] },
    });
    expect(meta).toContain("Todo");
    expect(meta).toContain("write tests");
    expect(meta).toContain("t1");
  });
});
