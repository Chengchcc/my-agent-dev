import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { createModelRuntime } from "@my-agent-team/ai";
import { createCodingAgentApp } from "./app.js";
import { loadConfig } from "./config.js";

const tmp = `/tmp/coding-main-${Math.random().toString(36).slice(2, 8)}`;
const ws = `${tmp}/ws`;
mkdirSync(ws, { recursive: true });

describe("app lifecycle", () => {
  test("health responds before shutdown", async () => {
    const config = loadConfig({
      CODING_AGENT_AUTH_TOKEN: "t",
      CODING_AGENT_DATA_DIR: tmp,
      CODING_AGENT_WORKSPACE_ROOTS: ws,
    });
    const app = createCodingAgentApp({ config, modelRuntime: createModelRuntime() });
    const res = await app.fetch(new Request("http://localhost/health"));
    expect(res.status).toBe(200);
    await app.stop();
    // stop is idempotent
    await app.stop();
  });

  test("shutdown is idempotent", async () => {
    const config = loadConfig({
      CODING_AGENT_AUTH_TOKEN: "t",
      CODING_AGENT_DATA_DIR: tmp,
      CODING_AGENT_WORKSPACE_ROOTS: ws,
    });
    const app = createCodingAgentApp({ config, modelRuntime: createModelRuntime() });
    await app.stop();
    await app.stop();
    expect(true).toBe(true);
  });

  test("startup failure surfaces as ConfigError", () => {
    expect(() =>
      loadConfig({
        CODING_AGENT_AUTH_TOKEN: "",
        CODING_AGENT_DATA_DIR: tmp,
        CODING_AGENT_WORKSPACE_ROOTS: ws,
      }),
    ).toThrow(/AUTH_TOKEN/);
  });
});
