# M3 AgentSession 接线 — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** loopStep() 从 packages/loop 迁到 `apps/backend`，接上真实 SessionFactory——generator 改代码、evaluator 验证、verdict 推进 step。

**Architecture:** packages/loop 删 loop-step.ts/loop-step.test.ts，只留纯逻辑。backend loop-step.ts 直接 import `@chengchenccc/loop` 的 reducer + state-md + parseVerdictMd，复用现有 SessionFactory。

**Tech Stack:** TypeScript, @chengchenccc/harness (AgentSession), bun:test

**Reference:** `docs/superpowers/specs/2026-07-01-m3-agent-session-wiring.md`

---

### Task 1: parseVerdictMd — 纯函数 + 测试

**Files:**
- Modify: `packages/loop/src/state-md.ts`
- Modify: `packages/loop/src/state-md.test.ts`

- [ ] **Step 1.1: 加 parseVerdictMd**

```typescript
// 在 state-md.ts 末尾加

export function parseVerdictMd(md: string): Verdict | null {
  if (!md.trim()) return null;

  const vMatch = md.match(/verdict:\s*(PASS|REJECT|ESCALATE)/i);
  if (!vMatch) return null;

  const verdict = vMatch[1]!.toUpperCase() as Verdict["verdict"];
  const eMatch = md.match(/evidence:\s*(.+)/);
  const evidence = eMatch?.[1]?.trim() ?? "";

  if (verdict === "PASS") {
    return { verdict, evidence };
  }

  const rMatch = md.match(/reasons:\s*(.+)/);
  const reasons = rMatch?.[1]
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) ?? [];
  return { verdict, reasons, evidence } as Verdict;
}
```

- [ ] **Step 1.2: 加测试**

```typescript
import { parseVerdictMd } from "./state-md.js";

describe("parseVerdictMd", () => {
  test("PASS", () => {
    const v = parseVerdictMd("verdict: PASS\nevidence: 12/12 green");
    expect(v).not.toBeNull();
    expect(v!.verdict).toBe("PASS");
    expect(v!.evidence).toBe("12/12 green");
  });

  test("REJECT with reasons", () => {
    const v = parseVerdictMd("verdict: REJECT\nreasons: scope drift, broke utils\nevidence: 5 files changed");
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
```

- [ ] **Step 1.3: 运行测试**

```bash
cd packages/loop && bun test --test-name-pattern="parseVerdictMd|state-md"
```

Expected: PASS

- [ ] **Step 1.4: Commit**

```bash
git add packages/loop/src/state-md.ts packages/loop/src/state-md.test.ts && git commit -m "feat(loop): add parseVerdictMd for evaluator verdict parsing"
```

---

### Task 2: 删除 packages/loop 中的 loop-step

**Files:**
- Delete: `packages/loop/src/loop-step.ts`
- Delete: `packages/loop/src/loop-step.test.ts`
- Modify: `packages/loop/src/index.ts`

- [ ] **Step 2.1: 删除文件**

```bash
rm packages/loop/src/loop-step.ts packages/loop/src/loop-step.test.ts
```

- [ ] **Step 2.2: 更新 index.ts——删 loopStep 导出，加 parseVerdictMd**

```typescript
export type {
  ItemId,
  ItemState,
  ItemStep,
  LoopAction,
  LoopState,
  Verdict,
} from "./types.js";
export { loopReducer } from "./loop-reducer.js";
export {
  parseStateMd,
  formatStateMd,
  parseInboxMd,
  formatInboxMd,
  parseVerdictMd,
} from "./state-md.js";
```

- [ ] **Step 2.3: 运行测试证实无破坏**

```bash
cd packages/loop && bun test
```

Expected: reducer + state-md tests PASS（loop-step tests 已删）。

- [ ] **Step 2.4: Commit**

```bash
git add packages/loop && git commit -m "refactor(loop): remove loop-step, keep pure logic only"
```

---

### Task 3: backend loop-step.ts — AgentSession 接线

**Files:**
- Create: `apps/backend/src/features/loop/loop-step.ts`

**前置：需要了解现有 SessionFactory 的接口。** 确认 `apps/backend/src/features/run/` 或 `apps/backend/src/features/session/` 里的 create/dispose 签名。

- [ ] **Step 3.1: 写 loop-step.ts**

```typescript
import {
  loopReducer,
  parseStateMd,
  formatStateMd,
  parseInboxMd,
  formatInboxMd,
  parseVerdictMd,
} from "@chengchenccc/loop";
import type { LoopState, LoopAction } from "@chengchenccc/loop";
import type { SessionFactory } from "../../run/session-factory.js"; // 调整路径

type ReviewAction = {
  itemId: string;
  verdict: "approve" | "reject" | "promote" | "retry" | "dismiss";
  feedback?: string;
};

const GENERATOR_PROMPT = `
你是一个修 bug 的工程师。只改相关文件，不要重构无关代码。
绝对不能 commit 或 push。

修改完成后，在本地 git commit，commit message 以 item id 开头。

当前任务:
- 问题: {summary}
- 来源: {source}
{rejectionNote}
`.trim();

const EVALUATOR_PROMPT = `
你是验证者。立场：假定修复是坏的，直到证明能跑。

你要做:
1. 跑项目测试（命令: bun test）
2. 用 git diff 确认只改了相关文件
3. 对照验收标准判断

验收标准: {acceptance}
Generator 改的文件: {filesChanged}

将判决写入工作区根目录的 VERDICT.md，格式:
---
verdict: PASS|REJECT|ESCALATE
reasons: 原因（REJECT/ESCALATE 时必填，逗号分隔）
evidence: 你跑了什么、结果是什么
---
`.trim();

const ACCEPTANCE = "被修改的文件相关测试全绿，改动范围合理";
const GENERATOR_MODEL = "claude-sonnet-4";
const EVALUATOR_MODEL = "claude-opus-4";

function actionToReducer(action: ReviewAction): LoopAction {
  switch (action.verdict) {
    case "approve": return { type: "APPROVE", itemId: action.itemId };
    case "reject": return { type: "REJECT_HUMAN", itemId: action.itemId, feedback: action.feedback };
    case "promote": return { type: "PROMOTE", itemId: action.itemId };
    case "retry": return { type: "RETRY", itemId: action.itemId };
    case "dismiss": return { type: "DISMISS", itemId: action.itemId };
  }
}

function pruneTerminal(items: LoopState["items"]): LoopState["items"] {
  const result: LoopState["items"] = {};
  for (const [id, item] of Object.entries(items)) {
    if (item.step !== "resolved" && item.step !== "promoted") {
      result[id] = item;
    }
  }
  return result;
}

function buildGeneratorPrompt(item: LoopState["items"][string]): string {
  let note = "";
  if (item.result && "reasons" in item.result) {
    note = `- 上次被拒原因: ${item.result.reasons.join("; ")}`;
  }
  return GENERATOR_PROMPT
    .replace("{summary}", item.summary)
    .replace("{source}", item.source)
    .replace("{rejectionNote}", note);
}

export async function loopStep(params: {
  loopConfigPath: string;
  sessionFactory: SessionFactory;
  action?: ReviewAction;
}): Promise<LoopState> {
  const statePath = `${params.loopConfigPath}/STATE.md`;
  const inboxPath = `${params.loopConfigPath}/INBOX.md`;
  const workDir = params.loopConfigPath; // .loop/ 目录即工作区

  // 1. Read files
  let stateMd: string;
  let inboxMd: string;
  try { stateMd = await Bun.file(statePath).text(); } catch { stateMd = ""; }
  try { inboxMd = await Bun.file(inboxPath).text(); } catch { inboxMd = ""; }

  let state = parseStateMd(stateMd);
  const inboxItems = parseInboxMd(inboxMd);

  // 2. Human review action → reducer → write back
  if (params.action) {
    const action = params.action;

    if (action.verdict === "retry") {
      const item = inboxItems[action.itemId];
      if (item) {
        state = loopReducer(state, {
          type: "ADD_ITEM",
          item: { id: item.id, source: item.source, summary: item.summary },
          priority: item.priority,
        });
        state = loopReducer(state, { type: "TICK" });
        delete inboxItems[action.itemId];
      }
    } else if (action.verdict === "dismiss") {
      delete inboxItems[action.itemId];
    } else {
      const itemInState = state.items[action.itemId];
      const itemInInbox = inboxItems[action.itemId];
      if (itemInState) {
        state = loopReducer(state, actionToReducer(action));
      } else if (itemInInbox) {
        state = loopReducer(
          { ...state, items: { ...state.items, [action.itemId]: itemInInbox } },
          actionToReducer(action),
        );
      }
    }

    // Extract inbox + prune + write
    const newInboxItems: LoopState["items"] = {};
    const remainingItems: LoopState["items"] = {};
    for (const [id, item] of Object.entries(state.items)) {
      if (item.step === "inbox") newInboxItems[id] = item;
      else remainingItems[id] = item;
    }

    let mergedInbox = { ...inboxItems, ...newInboxItems };
    if (params.action.verdict === "retry") delete mergedInbox[params.action.itemId];
    if (params.action.verdict === "dismiss") delete mergedInbox[params.action.itemId];

    state = { ...state, items: pruneTerminal(remainingItems) };
    await Bun.write(statePath, formatStateMd(state));
    await Bun.write(inboxPath, formatInboxMd(mergedInbox));
    return state;
  }

  // 3. Cron TICK → Generator → Evaluator
  state = loopReducer(state, { type: "TICK" });

  // Pick first fixing item (single item serial, M4 adds parallelism)
  const fixingItems = Object.values(state.items).filter(i => i.step === "fixing");
  for (const item of fixingItems) {
    // Record base commit
    const baseSha = (await Bun.$`git rev-parse HEAD`.quiet()).text().trim();

    // Generator
    const genSessionId = `loop:${state.loopId}:gen:${item.id}:${item.attempt}`;
    const genSession = await params.sessionFactory.create({
      sessionId: genSessionId,
      model: GENERATOR_MODEL,
      systemPrompt: buildGeneratorPrompt(item),
      cwd: workDir,
    });
    await genSession.prompt(buildGeneratorPrompt(item));
    await params.sessionFactory.dispose(genSessionId);

    // Read generator output
    const headSha = (await Bun.$`git rev-parse HEAD`.quiet()).text().trim();
    const filesChanged = (await Bun.$`git diff --name-only ${baseSha}..${headSha}`.quiet()).text().trim();

    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: item.id });

    // Evaluator
    const evalSessionId = `loop:${state.loopId}:eval:${item.id}:${item.attempt}`;
    const evaluatorPrompt = EVALUATOR_PROMPT
      .replace("{acceptance}", ACCEPTANCE)
      .replace("{filesChanged}", filesChanged || "none");

    const evalSession = await params.sessionFactory.create({
      sessionId: evalSessionId,
      model: EVALUATOR_MODEL,
      systemPrompt: evaluatorPrompt,
      cwd: workDir,
    });
    await evalSession.prompt(evaluatorPrompt);
    await params.sessionFactory.dispose(evalSessionId);

    // Read verdict
    const verdictMd = await Bun.file(`${workDir}/VERDICT.md`).text().catch(() => "");
    const verdict = parseVerdictMd(verdictMd);

    if (verdict) {
      state = loopReducer(state, {
        type: "EVALUATOR_VERDICT",
        itemId: item.id,
        verdict,
      });
    }
    // If verdict is null → item stays at verifying (manual intervention needed)

    // Rollback on REJECT or ESCALATE
    const updatedItem = state.items[item.id];
    if (updatedItem && (updatedItem.step === "fixing" || updatedItem.step === "inbox")) {
      await Bun.$`git reset --hard ${baseSha}`.quiet();
    }
  }

  // 4. Extract inbox + prune + write
  const newInboxItems: LoopState["items"] = {};
  const remainingItems: LoopState["items"] = {};
  for (const [id, item] of Object.entries(state.items)) {
    if (item.step === "inbox") newInboxItems[id] = item;
    else remainingItems[id] = item;
  }

  const mergedInbox = { ...inboxItems, ...newInboxItems };
  state = { ...state, items: pruneTerminal(remainingItems) };
  await Bun.write(statePath, formatStateMd(state));
  await Bun.write(inboxPath, formatInboxMd(mergedInbox));

  return state;
}
```

- [ ] **Step 3.2: Typecheck**

```bash
cd apps/backend && bun run typecheck
```

需要根据实际的 SessionFactory 路径调整 import。

- [ ] **Step 3.3: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.ts && git commit -m "feat(backend): add loopStep with AgentSession dispatch"
```

---

### Task 4: backend loop-step.test.ts — Mock SessionFactory

**Files:**
- Create: `apps/backend/src/features/loop/loop-step.test.ts`

- [ ] **Step 4.1: 写 mock SessionFactory + 测试**

```typescript
import { describe, test, expect, afterEach } from "bun:test";
import { loopStep } from "./loop-step.js";
import { parseStateMd, formatStateMd, parseInboxMd, loopReducer } from "@chengchenccc/loop";
import type { LoopState } from "@chengchenccc/loop";
import { mkdir, rm, writeFile } from "node:fs/promises";

const TMP = "/tmp/loop-step-m3-test";

async function initLoopDir(): Promise<string> {
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });
  return TMP;
}

function emptyState(): LoopState {
  return { loopId: "test", lastRun: null, items: {} };
}

function mockSessionFactory(verdictMd: string) {
  const sessions = new Map<string, { disposeCalled: boolean }>();
  return {
    sessions,
    factory: {
      async create(params: { sessionId: string; model: string; systemPrompt: string; cwd: string }) {
        const s = { disposeCalled: false };
        sessions.set(params.sessionId, s);
        return {
          async prompt(_input: string) {
            // Evaluator writes verdict to VERDICT.md
            await writeFile(`${params.cwd}/VERDICT.md`, verdictMd);
          },
        };
      },
      async dispose(sessionId: string) {
        const s = sessions.get(sessionId);
        if (s) s.disposeCalled = true;
      },
    },
  };
}

describe("loopStep M3 — AgentSession wiring", () => {
  afterEach(async () => {
    await rm(TMP, { recursive: true, force: true });
  });

  test("TICK → generator called, evaluator called", async () => {
    const dir = await initLoopDir();
    // Seed triaged item
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory, sessions } = mockSessionFactory("verdict: PASS\nevidence: ok");

    const next = await loopStep({ loopConfigPath: dir, sessionFactory: factory });

    // Generator + Evaluator sessions created and disposed
    expect(sessions.size).toBe(2);
    for (const s of sessions.values()) {
      expect(s.disposeCalled).toBe(true);
    }
    // Verdict PASS → awaiting_review
    expect(next.items["01"]!.step).toBe("awaiting_review");
  });

  test("REJECT → item back to fixing, attempt+1", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory("verdict: REJECT\nreasons: scope drift\nevidence: 5 files");

    const next = await loopStep({ loopConfigPath: dir, sessionFactory: factory });

    expect(next.items["01"]!.step).toBe("fixing");
    expect(next.items["01"]!.attempt).toBe(2);
    expect(next.items["01"]!.result).not.toBeNull();
  });

  test("REJECT exhausted → inbox", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    // Set attempt to 3 (max retries default)
    state = {
      ...state,
      items: {
        "01": { ...state.items["01"]!, attempt: 3 },
      },
    };
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory("verdict: REJECT\nreasons: still broken\nevidence: x");

    const next = await loopStep({ loopConfigPath: dir, sessionFactory: factory });

    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("ESCALATE → inbox", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory("verdict: ESCALATE\nreasons: no env\nevidence: mcp unreachable");

    const next = await loopStep({ loopConfigPath: dir, sessionFactory: factory });

    expect(next.items["01"]!.step).toBe("inbox");
  });

  test("empty VERDICT.md → item stays verifying", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory(""); // empty verdict

    const next = await loopStep({ loopConfigPath: dir, sessionFactory: factory });

    expect(next.items["01"]!.step).toBe("verifying"); // stuck
  });

  test("human APPROVE behavior unchanged from M2", async () => {
    const dir = await initLoopDir();
    let state = emptyState();
    state = loopReducer(state, { type: "ADD_ITEM", item: { id: "01", source: "ci", summary: "flaky" } });
    state = loopReducer(state, { type: "TICK" });
    state = loopReducer(state, { type: "GENERATOR_DONE", itemId: "01" });
    state = loopReducer(state, { type: "EVALUATOR_VERDICT", itemId: "01", verdict: { verdict: "PASS", evidence: "ok" } });
    await Bun.write(`${dir}/STATE.md`, formatStateMd(state));

    const { factory } = mockSessionFactory("");
    const next = await loopStep({
      loopConfigPath: dir,
      sessionFactory: factory,
      action: { itemId: "01", verdict: "approve" },
    });

    expect(next.items["01"]).toBeUndefined(); // pruned
    // SessionFactory not called for human actions
    expect(factory.create).toBeDefined(); // was never called
  });
});
```

- [ ] **Step 4.2: 运行测试**

```bash
cd apps/backend && bun test --test-name-pattern="loopStep M3"
```

Expected: PASS

- [ ] **Step 4.3: Commit**

```bash
git add apps/backend/src/features/loop/loop-step.test.ts && git commit -m "test(backend): add loopStep M3 tests with mock SessionFactory"
```

---

### Task 5: 全量验证

- [ ] **Step 5.1: Full workspace**

```bash
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 5.2: Commit**

```bash
git add -A && git commit -m "chore(backend): full workspace typecheck, lint, test after M3"
```
