import { describe, expect, test } from "bun:test";
import {
  formatInboxMd,
  formatStateMd,
  parseInboxMd,
  parseLoopConfig,
  parseStateMd,
  parseVerdictMd,
} from "./state-md.js";
import type { ItemState, LoopState } from "./types.js";

function sampleState(): LoopState {
  return {
    loopId: "test-loop",
    lastRun: "2026-07-01T08:00:00Z",
    items: {
      "01": {
        id: "01",
        source: "ci/4821",
        summary: "auth flaky",
        step: "verifying",
        attempt: 1,
        priority: 0,
        result: null,
      },
      "02": {
        id: "02",
        source: "issue/92",
        summary: "parser null",
        step: "fixing",
        attempt: 2,
        priority: 0,
        result: {
          verdict: "REJECT",
          reasons: ["scope drift"],
          evidence: "touched 5 files",
        },
      },
    },
  };
}

function emptyState(): LoopState {
  return { loopId: "", lastRun: null, items: {} };
}

// ============================================================
// parseStateMd
// ============================================================
describe("parseStateMd", () => {
  test("empty string → empty state", () => {
    const s = parseStateMd("");
    expect(s.loopId).toBe("");
    expect(s.lastRun).toBeNull();
    expect(s.items).toEqual({});
  });

  test("whitespace-only → empty state", () => {
    const s = parseStateMd("   \n  \n  ");
    expect(s.items).toEqual({});
  });

  test("parses frontmatter", () => {
    const md = `---
loopId: morning-triage
lastRun: 2026-07-01T08:15:00Z
version: 1
---

# Loop State — Morning Triage

## Items
`;
    const s = parseStateMd(md);
    expect(s.loopId).toBe("morning-triage");
    expect(s.lastRun).toBe("2026-07-01T08:15:00Z");
    expect(s.items).toEqual({});
  });

  test("parses single item without result", () => {
    const md = `---
loopId: test
lastRun: 2026-07-01T08:00:00Z
version: 1
---

# Loop State

## Items

### 01
source: ci/4821
summary: auth flaky
step: verifying
attempt: 1
priority: 0
`;
    const s = parseStateMd(md);
    expect(s.loopId).toBe("test");
    expect(s.items["01"]).toBeDefined();
    expect(s.items["01"]!.source).toBe("ci/4821");
    expect(s.items["01"]!.summary).toBe("auth flaky");
    expect(s.items["01"]!.step).toBe("verifying");
    expect(s.items["01"]!.attempt).toBe(1);
    expect(s.items["01"]!.priority).toBe(0);
    expect(s.items["01"]!.result).toBeNull();
  });

  test("parses item with REJECT result", () => {
    const md = `---
loopId: test
lastRun: null
version: 1
---

## Items

### 02
source: issue/92
summary: parser null
step: fixing
attempt: 2
priority: 0
result:
  verdict: REJECT
  reasons:
    - scope drift
  evidence: touched 5 files
`;
    const s = parseStateMd(md);
    const item = s.items["02"]!;
    expect(item.step).toBe("fixing");
    expect(item.attempt).toBe(2);
    expect(item.result).not.toBeNull();
    const result = item.result!;
    expect(result.verdict).toBe("REJECT");
    if ("reasons" in result) {
      expect(result.reasons).toEqual(["scope drift"]);
    }
    expect(result.evidence).toBe("touched 5 files");
  });

  test("parses item with PASS result", () => {
    const md = `---
loopId: test
lastRun: null
version: 1
---

## Items

### 01
source: ci/4821
summary: auth fixed
step: awaiting_review
attempt: 1
priority: 0
result:
  verdict: PASS
  evidence: 12/12 green
`;
    const s = parseStateMd(md);
    const item = s.items["01"]!;
    expect(item.step).toBe("awaiting_review");
    const result = item.result!;
    expect(result.verdict).toBe("PASS");
    expect(result.evidence).toBe("12/12 green");
  });

  test("parses item with ESCALATE result", () => {
    const md = `---
loopId: test
lastRun: null
version: 1
---

## Items

### 01
source: ci/4821
summary: env broken
step: inbox
attempt: 1
priority: 0
result:
  verdict: ESCALATE
  reasons:
    - mcp unreachable
  evidence: ""
`;
    const s = parseStateMd(md);
    const result = s.items["01"]!.result!;
    expect(result.verdict).toBe("ESCALATE");
  });

  test("parses multiple items", () => {
    const s = parseStateMd(formatStateMd(sampleState()));
    expect(Object.keys(s.items)).toEqual(["01", "02"]);
  });

  test("lastRun null → round-trip preserves null", () => {
    const md = `---
loopId: test
lastRun: null
version: 1
---

## Items
`;
    const s = parseStateMd(md);
    expect(s.lastRun).toBeNull();
  });
});

// ============================================================
// formatStateMd
// ============================================================
describe("formatStateMd", () => {
  test("empty state → valid markdown", () => {
    const md = formatStateMd(emptyState());
    expect(md).toContain("---");
    expect(md).toContain("loopId:");
    expect(md).toContain("## Items");
  });

  test("null result → no result line", () => {
    const md = formatStateMd(sampleState());
    // item 01 has null result — "result:" should NOT appear in its section
    const section01 = md.split("### 01")[1]?.split("### ")[0] ?? "";
    expect(section01).not.toContain("result:");
  });

  test("round-trip: format → parse → equivalent", () => {
    const s = sampleState();
    const md = formatStateMd(s);
    const parsed = parseStateMd(md);
    expect(parsed.loopId).toBe(s.loopId);
    expect(parsed.lastRun).toBe(s.lastRun);
    expect(Object.keys(parsed.items)).toEqual(Object.keys(s.items));
    for (const id of Object.keys(s.items)) {
      expect(parsed.items[id]!.step).toBe(s.items[id]!.step);
      expect(parsed.items[id]!.attempt).toBe(s.items[id]!.attempt);
      expect(parsed.items[id]!.source).toBe(s.items[id]!.source);
      expect(parsed.items[id]!.summary).toBe(s.items[id]!.summary);
    }
  });

  test("REJECT result → round-trip preserves reasons", () => {
    const s = sampleState();
    const md = formatStateMd(s);
    const parsed = parseStateMd(md);
    const result = parsed.items["02"]!.result;
    expect(result).not.toBeNull();
    if (result && "reasons" in result) {
      expect(result.reasons).toEqual(["scope drift"]);
    }
  });

  test("PASS result → round-trip preserves evidence", () => {
    const s: LoopState = {
      loopId: "test",
      lastRun: null,
      items: {
        "01": {
          id: "01",
          source: "ci",
          summary: "fixed",
          step: "awaiting_review",
          attempt: 1,
          priority: 0,
          result: { verdict: "PASS", evidence: "12/12 green" },
        },
      },
    };
    const md = formatStateMd(s);
    const parsed = parseStateMd(md);
    const result = parsed.items["01"]!.result!;
    expect(result.verdict).toBe("PASS");
    expect(result.evidence).toBe("12/12 green");
  });

  test("ESCALATE result → round-trip preserves reasons", () => {
    const s: LoopState = {
      loopId: "test",
      lastRun: null,
      items: {
        "01": {
          id: "01",
          source: "ci",
          summary: "broken",
          step: "inbox",
          attempt: 1,
          priority: 0,
          result: {
            verdict: "ESCALATE",
            reasons: ["mcp unreachable"],
            evidence: "no output",
          },
        },
      },
    };
    const md = formatStateMd(s);
    const parsed = parseStateMd(md);
    const result = parsed.items["01"]!.result!;
    expect(result.verdict).toBe("ESCALATE");
    if ("reasons" in result) {
      expect(result.reasons).toEqual(["mcp unreachable"]);
    }
  });
});

// ============================================================
// parseInboxMd / formatInboxMd
// ============================================================
describe("parseInboxMd / formatInboxMd", () => {
  test("empty string → empty inbox", () => {
    const items = parseInboxMd("");
    expect(items).toEqual({});
  });

  test("whitespace → empty inbox", () => {
    const items = parseInboxMd("  \n ");
    expect(items).toEqual({});
  });

  test("parses single inbox item", () => {
    const md = `### 99
source: manual
summary: dismissed
step: inbox
attempt: 2
priority: 0
result:
  verdict: REJECT
  reasons:
    - manual
  evidence: ""
`;
    const items = parseInboxMd(md);
    expect(items["99"]!.step).toBe("inbox");
    expect(items["99"]!.attempt).toBe(2);
    expect(items["99"]!.result).not.toBeNull();
  });

  test("round-trip inbox", () => {
    const items: Record<string, ItemState> = {
      "99": {
        id: "99",
        source: "manual",
        summary: "dismissed item",
        step: "inbox",
        attempt: 2,
        priority: 0,
        result: {
          verdict: "REJECT",
          reasons: ["手动驳回"],
          evidence: "",
        },
      },
    };
    const md = formatInboxMd(items);
    const parsed = parseInboxMd(md);
    expect(Object.keys(parsed)).toEqual(["99"]);
    expect(parsed["99"]!.step).toBe("inbox");
    expect(parsed["99"]!.summary).toBe("dismissed item");
  });

  test("formatInboxMd produces no frontmatter", () => {
    const md = formatInboxMd({});
    expect(md).not.toContain("---");
    expect(md).not.toContain("loopId");
  });

  test("multiple inbox items round-trip", () => {
    const items: Record<string, ItemState> = {
      a: {
        id: "a",
        source: "ci",
        summary: "one",
        step: "inbox",
        attempt: 1,
        priority: 0,
        result: null,
      },
      b: {
        id: "b",
        source: "manual",
        summary: "two",
        step: "inbox",
        attempt: 2,
        priority: 0,
        result: null,
      },
    };
    const md = formatInboxMd(items);
    const parsed = parseInboxMd(md);
    expect(Object.keys(parsed)).toEqual(["a", "b"]);
  });
});

describe("parseVerdictMd", () => {
  test("PASS", () => {
    const v = parseVerdictMd("verdict: PASS\nevidence: 12/12 green");
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe("PASS");
    expect(v!.evidence).toBe("12/12 green");
  });

  test("REJECT with reasons", () => {
    const v = parseVerdictMd(
      "verdict: REJECT\nreasons: scope drift, broke utils\nevidence: 5 files changed",
    );
    expect(v!.verdict).toBe("REJECT");
    if ("reasons" in v!) {
      expect(v!.reasons).toEqual(["scope drift", "broke utils"]);
    }
    expect(v!.evidence).toBe("5 files changed");
  });

  test("ESCALATE", () => {
    const v = parseVerdictMd("verdict: ESCALATE\nreasons: mcp unreachable\nevidence: no env");
    expect(v!.verdict).toBe("ESCALATE");
  });

  test("reasons roundtrip — JSON array", () => {
    const v = parseVerdictMd(
      'verdict: REJECT\nreasons: ["comma, in reason","multi-word too"]\nevidence: fail',
    );
    expect(v).not.toBeNull();
    if (v && v.verdict !== "PASS") {
      expect(v.reasons).toEqual(["comma, in reason", "multi-word too"]);
    }
  });

  test("reasons roundtrip — comma fallback", () => {
    const v = parseVerdictMd("verdict: REJECT\nreasons: a, b, c\nevidence: fail");
    expect(v).not.toBeNull();
    if (v && v.verdict !== "PASS") {
      expect(v.reasons).toEqual(["a", "b", "c"]);
    }
  });

  test("case insensitive", () => {
    const v = parseVerdictMd("verdict: pass\nevidence: ok");
    expect(v!.verdict).toBe("PASS");
  });

  test("missing verdict line → null", () => {
    const v = parseVerdictMd("evidence: something");
    expect(v).toBeNull();
  });

  test("empty string → null", () => {
    const v = parseVerdictMd("");
    expect(v).toBeNull();
  });

  test("whitespace only → null", () => {
    const v = parseVerdictMd("   \n  ");
    expect(v).toBeNull();
  });
});
describe("parseLoopConfig", () => {
  test("parses full LOOP.md", () => {
    const md = [
      "---",
      `projectId: proj-abc`,
      "generator:",
      "  model: claude-sonnet-4",
      "  systemPrompt: fix bugs",
      "evaluator:",
      "  model: claude-opus-4",
      "  systemPrompt: verify",
      "acceptance: tests pass",
      "---",
    ].join("\n");
    const cfg = parseLoopConfig(md);
    expect(cfg).not.toBeNull();
    expect(cfg!.projectId).toBe("proj-abc");
    expect(cfg!.generator.model).toBe("claude-sonnet-4");
    expect(cfg!.generator.systemPrompt).toBe("fix bugs");
    expect(cfg!.projectId).toBe("proj-abc");
    expect(cfg!.acceptance).toBe("tests pass");
  });

  test("missing model → null", () => {
    const md = [
      "---",
      "generator:",
      "  systemPrompt: fix",
      "evaluator:",
      "  systemPrompt: verify",
      "---",
    ].join("\n");
    expect(parseLoopConfig(md)).toBeNull();
  });

  test("generator.model equals evaluator.model → throws", () => {
    const md = [
      "---",
      `projectId: test`,
      "generator:",
      "  model: claude-sonnet-4",
      `  systemPrompt: "fix it"`,
      "evaluator:",
      "  model: claude-sonnet-4",
      `  systemPrompt: "verify it"`,
      `acceptance: "tests pass"`,
      "---",
    ].join("\n");
    expect(() => parseLoopConfig(md)).toThrow(/must differ/);
  });

  test("empty → null", () => {
    expect(parseLoopConfig("")).toBeNull();
  });

  test("no frontmatter → null", () => {
    expect(parseLoopConfig("# Hello")).toBeNull();
  });
});

describe("parseLoopConfig agent field (ADR 0023 P2)", () => {
  const base = [
    "---",
    "projectId: proj-x",
    "generator:",
    "  model: claude-sonnet-4",
    "  systemPrompt: fix",
    "evaluator:",
    "  model: claude-opus-4",
    "  systemPrompt: verify",
  ];

  test("reads the agent field when present", () => {
    const cfg = parseLoopConfig([...base, "agent: coder-1", "---"].join("\n"));
    expect(cfg?.agent).toBe("coder-1");
  });

  test("defaults to default for back-compat", () => {
    const cfg = parseLoopConfig([...base, "---"].join("\n"));
    expect(cfg?.agent).toBe("default");
  });
});
