import { describe, expect, test } from "bun:test";
import { guardedConsume } from "./cli-consume.js";

describe("guardedConsume", () => {
  test("a throwing consume reports the error and never rejects", async () => {
    const state: { reported: string | null } = { reported: null };
    await guardedConsume(
      async () => {
        throw new Error("stream broke");
      },
      (message) => {
        state.reported = message;
      },
    );
    expect(state.reported).toBe("stream broke");
  });

  test("a clean consume passes through", async () => {
    let consumed = false;
    await guardedConsume(
      async () => {
        consumed = true;
      },
      () => {},
    );
    expect(consumed).toBe(true);
  });
});
