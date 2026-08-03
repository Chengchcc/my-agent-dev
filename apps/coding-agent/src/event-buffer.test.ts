import { describe, expect, test } from "bun:test";
import { createRunEventBuffer, ReplayWindowExceededError } from "./event-buffer.js";

describe("run event buffer", () => {
  test("appends with monotonic strictly increasing ids", () => {
    const buf = createRunEventBuffer(10);
    const a = buf.append({ type: "text_delta", data: { text: "a" } });
    const b = buf.append({ type: "text_delta", data: { text: "b" } });
    expect(b).toBe(a + 1);
    expect(buf.lastId()).toBe(b);
  });

  test("evicts oldest beyond bound", () => {
    const buf = createRunEventBuffer(3);
    buf.append({ type: "a", data: {} });
    buf.append({ type: "b", data: {} });
    buf.append({ type: "c", data: {} });
    buf.append({ type: "d", data: {} });
    expect(buf.oldestRetainedId()).toBe(1); // id 0 evicted
    expect(buf.lastId()).toBe(3);
  });

  test("subscribeAfter replays retained events strictly after id", () => {
    const buf = createRunEventBuffer(10);
    buf.append({ type: "a", data: { n: 0 } });
    buf.append({ type: "b", data: { n: 1 } });
    const seen: string[] = [];
    buf.subscribeAfter(0, (e) => seen.push(e.type));
    expect(seen).toEqual(["b"]);
  });

  test("stale Last-Event-ID throws replay_window_exceeded", () => {
    const buf = createRunEventBuffer(2);
    buf.append({ type: "a", data: {} });
    buf.append({ type: "b", data: {} });
    buf.append({ type: "c", data: {} });
    // oldest retained is id 1 now; requesting 0 must fail
    expect(() => buf.subscribeAfter(0, () => {})).toThrow(ReplayWindowExceededError);
  });

  test("live subscriber receives appended events", () => {
    const buf = createRunEventBuffer(10);
    const seen: number[] = [];
    buf.subscribeAfter(-1, (e) => seen.push(e.id));
    buf.append({ type: "x", data: {} });
    buf.append({ type: "y", data: {} });
    expect(seen).toEqual([0, 1]);
  });

  test("unsubscribe stops delivery", () => {
    const buf = createRunEventBuffer(10);
    const seen: number[] = [];
    const off = buf.subscribeAfter(-1, (e) => seen.push(e.id));
    buf.append({ type: "x", data: {} });
    off();
    buf.append({ type: "y", data: {} });
    expect(seen).toEqual([0]);
  });

  test("close clears subscribers and stops delivery", () => {
    const buf = createRunEventBuffer(10);
    const seen: number[] = [];
    buf.subscribeAfter(-1, (e) => seen.push(e.id));
    buf.append({ type: "pre", data: {} });
    expect(seen).toEqual([0]);
    buf.close();
    buf.append({ type: "post", data: {} });
    // closed: no new events delivered and none appended
    expect(seen).toEqual([0]);
    expect(buf.lastId()).toBe(0);
  });
});
