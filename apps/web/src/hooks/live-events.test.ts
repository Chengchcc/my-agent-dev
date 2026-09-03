import { describe, expect, test } from "bun:test";

// ── P1-1: Error event payload uses {message, stack?} not {error} ──
// ChatWorkspace renders error alerts from AgentEvent error payloads.
// The fix corrects reading `payload.error` to `payload.message`.

function extractErrorMessage(payload: unknown): string {
  const p = payload as { message?: string; stack?: string };
  return p.message ?? "An error occurred";
}

describe("P1-1: error event payload extraction", () => {
  test("extracts message from standard AgentEvent error payload", () => {
    const payload = { message: "Model API error", stack: "Error: ...\n    at ..." };
    expect(extractErrorMessage(payload)).toBe("Model API error");
  });

  test("falls back to default when message is missing", () => {
    expect(extractErrorMessage({})).toBe("An error occurred");
    expect(extractErrorMessage({ stack: "trace" })).toBe("An error occurred");
  });

  test("does NOT read .error property (the bug was reading payload.error)", () => {
    // AgentEvent error payload has no `error` field — it uses `message`.
    // If we accidentally read `error`, we'd get undefined and the fallback.
    const payload = { error: "wrong field", message: "correct field" };
    // Correct code reads .message, not .error:
    expect(extractErrorMessage(payload)).toBe("correct field");
  });
});

// ── P1-2: Un-id'd events should never be deduplicated ──
// Events without `lastEventId` collapsed to seq=0, causing all after
// the first to be dropped. Fix: only dedup when `e.lastEventId` is non-empty.

function dedupLiveEvents(events: Array<{ lastEventId: string | null; data: string }>): string[] {
  const seen = new Set<number>();
  const result: string[] = [];

  for (const e of events) {
    const seq = e.lastEventId ? parseInt(e.lastEventId, 10) : null;
    if (seq !== null && seen.has(seq)) continue;
    if (seq !== null) seen.add(seq);
    // Events without an id are never deduplicated
    result.push(e.data);
  }

  return result;
}

describe("P1-2: un-id'd event dedup", () => {
  test("deduplicates events with duplicate seq", () => {
    const events = [
      { lastEventId: "1", data: "a" },
      { lastEventId: "2", data: "b" },
      { lastEventId: "1", data: "a-duplicate" }, // dup seq, dropped
      { lastEventId: "3", data: "c" },
    ];
    expect(dedupLiveEvents(events)).toEqual(["a", "b", "c"]);
  });

  test("never deduplicates events without id", () => {
    const events = [
      { lastEventId: null, data: "no-id-1" },
      { lastEventId: null, data: "no-id-2" },
      { lastEventId: null, data: "no-id-3" },
    ];
    // All three pass through — none are collapsed to seq=0
    expect(dedupLiveEvents(events)).toEqual(["no-id-1", "no-id-2", "no-id-3"]);
  });

  test("mixed id and no-id events", () => {
    const events = [
      { lastEventId: null, data: "header" },
      { lastEventId: "5", data: "a" },
      { lastEventId: null, data: "trailer" },
      { lastEventId: "5", data: "a-dup" }, // dup id, dropped
      { lastEventId: null, data: "trailer-2" },
    ];
    expect(dedupLiveEvents(events)).toEqual(["header", "a", "trailer", "trailer-2"]);
  });

  test("regression: old behavior collapsed un-id'd to seq=0", () => {
    // Old code: seq = e.lastEventId ? parseInt : 0
    // This meant all un-id'd events had seq=0, so seen.has(0) dropped all after the first
    const events = [
      { lastEventId: null, data: "keep-me-1" },
      { lastEventId: null, data: "keep-me-2" },
      { lastEventId: null, data: "keep-me-3" },
    ];
    const oldBehaviorResult = (() => {
      const seen = new Set<number>();
      const r: string[] = [];
      for (const e of events) {
        const seq = e.lastEventId ? parseInt(e.lastEventId, 10) : 0; // BUG
        if (seen.has(seq)) continue;
        seen.add(seq);
        r.push(e.data);
      }
      return r;
    })();
    // Old bug: only keeps first un-id'd event
    expect(oldBehaviorResult).toEqual(["keep-me-1"]);
    // Fixed behavior: keeps all three
    expect(dedupLiveEvents(events)).toEqual(["keep-me-1", "keep-me-2", "keep-me-3"]);
  });
});
