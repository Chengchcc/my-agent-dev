import { describe, expect, test } from "bun:test";
import { groupByProvider, modelRoutes, type WebModel } from "./http.js";

function model(id: string, name = id): WebModel {
  return {
    id,
    name,
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1000,
    maxTokens: 1000,
  };
}

describe("groupByProvider", () => {
  test("groups composite ids by provider prefix and strips it", () => {
    const groups = groupByProvider([model("anthropic/a"), model("openai/b")]);
    expect(groups).toHaveLength(2);
    const anthropic = groups.find((g) => g.id === "anthropic");
    const openai = groups.find((g) => g.id === "openai");
    expect(anthropic?.models[0]?.id).toBe("a");
    expect(openai?.models[0]?.id).toBe("b");
  });

  test("bare ids with no slash fall into the unknown bucket", () => {
    const groups = groupByProvider([model("claude-sonnet-5")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("unknown");
    expect(groups[0]?.models[0]?.id).toBe("claude-sonnet-5");
  });

  test("same provider models land in one bucket", () => {
    const groups = groupByProvider([model("anthropic/a"), model("anthropic/b")]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.id).toBe("anthropic");
    expect(groups[0]?.models.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("modelRoutes /api/models", () => {
  test("returns composite catalog ids grouped by provider", async () => {
    // Regression: the features.ts list callback used to strip the provider
    // prefix BEFORE groupByProvider — leaving bare ids that all fell into
    // the "unknown" bucket, breaking the web provider selector. The route
    // must receive composite ids and produce real provider groups.
    const app = modelRoutes({
      list: async () => [model("anthropic/a"), model("openai/b")],
    });
    const res = await app.handle(new Request("http://test/api/models"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      providers: Array<{ id: string; models: Array<{ id: string }> }>;
    };
    const anthropic = body.providers.find((p) => p.id === "anthropic");
    expect(anthropic).toBeTruthy();
    expect(anthropic?.models[0]?.id).toBe("a");
    const openai = body.providers.find((p) => p.id === "openai");
    expect(openai).toBeTruthy();
    expect(openai?.models[0]?.id).toBe("b");
    expect(body.providers.every((p) => p.id !== "unknown")).toBe(true);
  });
});
