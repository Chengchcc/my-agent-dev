import { describe, expect, test } from "bun:test";
import { createModelRuntime } from "./model-runtime.js";
import type { Provider } from "./types.js";

function fakeProvider(id: string, modelIds: string[]): Provider {
  return {
    id,
    name: id,
    getModels: () =>
      modelIds.map((mid) => ({
        id: mid,
        name: mid,
        provider: id,
        api: "fake" as never,
        reasoning: false,
        input: ["text"] as const,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 100000,
        maxTokens: 4096,
        baseUrl: undefined,
      })),
    createModel() {
      throw new Error("not used");
    },
  };
}

describe("ModelRuntime", () => {
  test("registers and retrieves providers", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("test-p", ["m1"]));
    expect(rt.getProvider("test-p")).toBeTruthy();
  });

  test("rejects duplicate provider registration", () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("dup", ["m1"]));
    expect(() => rt.registerProvider(fakeProvider("dup", ["m2"]))).toThrow();
  });

  test("setProvider replaces existing", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("rep", ["m1"]));
    rt.setProvider(fakeProvider("rep", ["m2"]));
    const cat = await rt.refreshCatalog();
    expect(cat.models).toHaveLength(1);
    expect(cat.models[0]?.modelId).toBe("m2");
  });

  test("resolveModel finds model and returns credential", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("p1", ["m1", "m2"]));
    const { model, credential } = await rt.resolveModel("p1", "m2");
    expect(model.modelId).toBe("m2");
    expect(model.providerId).toBe("p1");
    expect(credential).toEqual({});
  });

  test("resolveModel throws for unknown provider", async () => {
    const rt = createModelRuntime();
    expect(rt.resolveModel("nope", "m1")).rejects.toThrow();
  });

  test("refreshCatalog aggregates all providers", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("p1", ["a", "b"]));
    rt.registerProvider(fakeProvider("p2", ["c"]));
    const cat = await rt.refreshCatalog();
    expect(cat.models).toHaveLength(3);
  });

  test("catalog is cached after refresh", async () => {
    const rt = createModelRuntime();
    rt.registerProvider(fakeProvider("p1", ["x"]));
    const cat1 = await rt.getCatalog();
    const cat2 = await rt.getCatalog();
    expect(cat1.timestamp).toBe(cat2.timestamp);
  });
});
