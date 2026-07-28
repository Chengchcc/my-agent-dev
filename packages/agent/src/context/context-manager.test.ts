import { describe, expect, test } from "bun:test";
import type { Message } from "@my-agent-team/message";
import { type ContextManagerContext, pipeContextManagers } from "./context-manager.js";
import { consoleLogger } from "../runtime/logger.js";

const ctx: ContextManagerContext = {
  sessionId: "t1",
  logger: consoleLogger({ level: "silent" }),
  model: { stream: async function* () {} },
};

const msgs: Message[] = [
  { role: "system", text: "sys" },
  { role: "user", text: "u1" },
  { role: "assistant", text: "a1" },
  { role: "user", text: "u2" },
];

describe("pipeContextManagers", () => {
  test("single CM returned as-is", async () => {
    const cm = { shape: async (_c: ContextManagerContext, m: readonly Message[]) => [...m] };
    const piped = pipeContextManagers(cm);
    const result = await piped.shape(ctx, msgs);
    expect(result).toEqual(msgs);
  });

  test("two CMs → second receives first's output", async () => {
    const calls: string[] = [];
    const a = {
      shape: async (_c: ContextManagerContext, m: readonly Message[]) => {
        calls.push("a");
        return m.slice(1);
      },
    };
    const b = {
      shape: async (_c: ContextManagerContext, m: readonly Message[]) => {
        calls.push("b");
        return m.slice(1);
      },
    };
    const piped = pipeContextManagers(a, b);
    const result = await piped.shape(ctx, msgs);

    expect(calls).toEqual(["a", "b"]);
    expect(result).toHaveLength(2);
  });

  test("first CM throws → pipe throws immediately, second not called", async () => {
    const b = {
      shape: async () => {
        throw new Error("should not be reached");
      },
    };
    const a = {
      shape: async () => {
        throw new Error("boom from A");
      },
    };
    const piped = pipeContextManagers(a, b);

    await expect(piped.shape(ctx, msgs)).rejects.toThrow("boom from A");
  });

  test("three CMs chained correctly", async () => {
    const a = { shape: async (_c: ContextManagerContext, m: readonly Message[]) => m.slice(0, 3) };
    const b = { shape: async (_c: ContextManagerContext, m: readonly Message[]) => m.slice(1) };
    const c = { shape: async (_c: ContextManagerContext, m: readonly Message[]) => [...m] };
    const piped = pipeContextManagers(a, b, c);
    const result = await piped.shape(ctx, msgs);

    expect(result).toEqual(msgs.slice(1, 3));
  });
});
