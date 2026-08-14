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
    });
    expect(meta.startsWith("<system-reminder>")).toBe(true);
    expect(meta.endsWith("</system-reminder>")).toBe(true);
    expect(meta).toContain("Available Skills");
    expect(meta).toContain("math");
    expect(meta).toContain("Workspace root: /ws");
    expect(meta).toContain("anthropic/claude-sonnet");
  });

  test("omits empty plugin sections", () => {
    const meta = renderLoopMeta({
      plugins: [],
      workspace: { root: "/ws" },
      model: FAKE_MODEL,
    });
    expect(meta).toContain("Workspace");
  });

  test("renders workspace facts even with cwd present", () => {
    const meta = renderLoopMeta({
      plugins: [],
      workspace: { root: "/ws", cwd: "/ws/sub" },
      model: FAKE_MODEL,
    });
    expect(meta).toContain("Working directory: /ws/sub");
    expect(meta).toContain("Workspace");
  });
});
