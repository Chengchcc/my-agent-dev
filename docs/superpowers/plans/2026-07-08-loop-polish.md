# Loop Feature 打磨 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans.

**Goal:** 修复 3 个阻断性问题 + 2 个信任建设 + 3 个体验优化。

**Spec:** `docs/superpowers/specs/2026-07-08-loop-polish-design.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| `GET /api/loops/:id` 读 STATE.md 文件 | `http.ts:88-150` |
| `GET /api/work/today` 读 STATE.md 文件 | `http.ts:54-87` |
| `LoopStateStore.load()` 从 DB 读 state | `loop-state-store.ts:82-91` |
| `loopReducer` 已有 `ADD_ITEM` action | `packages/loop/src/types.ts` |
| `buildGeneratorPrompt(item, template)` 只塞 summary | `loop-step.ts:132-141` |
| Evaluator session 无超时 | `loop-step.ts:331-333` |
| 预算超限后静默 break | `loop-step.ts:262` |
| `GET /api/loops` 不含 pendingCount | `http.ts:51-53` |
| `loop_budget` 表有每日预算数据 | `schema.ts:266-274` |
| Loop 详情页前端 | `apps/web/src/app/(main)/work/[loopId]/page.tsx` |
| Loop 列表前端 | `apps/web/src/app/(main)/work/page.tsx` |
| convPort 注入 loopRoutes | `main.ts:335` |

---

## Task 1: P0-1 -- HTTP 层改读 DB

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts`

- [ ] **Step 1: `GET /api/loops/:id` 改用 `store.load()`**

删除 `parseStateMd(await Bun.file(...STATE.md).text())` 的两处读取。改为 `const state = store.load(id)`。items 直接从 `state.items` 取。lastRun 从 `state.lastRun` 取。pendingCount = `Object.values(state.items).filter(i => i.step === "awaiting_review").length`。

- [ ] **Step 2: `GET /api/work/today` 改用 `store.load()`**

删除 `parseStateMd(await Bun.file(...STATE.md).text())`。改为遍历 loops，每个调 `store.load(loop.cronJobId)`，过滤 `awaiting_review` items。

- [ ] **Step 3: 删除无用的 `parseStateMd` import**

- [ ] **Step 4: typecheck + test + commit**

---

## Task 2: P0-2 -- 手动添加 item API + 前端

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts`
- Modify: `apps/web/src/app/(main)/work/[loopId]/page.tsx`
- Modify: `apps/web/src/lib/api.ts`
- Modify: `apps/web/src/features/loop/hooks.ts`

- [ ] **Step 1: `POST /api/loops/:id/items` 端点**

```typescript
.post("/api/loops/:id/items", async ({ params: { id }, body, set }) => {
  const job = cronSvc.getById(id);
  if (!job?.loopConfigPath) { set.status = 404; return { error: "Not a loop" }; }
  const state = store.load(id);
  const itemId = ulid();
  const newState = loopReducer(state, {
    type: "ADD_ITEM",
    item: { id: itemId, source: body.source, summary: body.summary },
    priority: body.priority,
  });
  store.save(id, newState, {}); // inboxItems empty - new items go to triaged
  const item = newState.items[itemId];
  set.status = 201;
  return { item };
}, {
  body: t.Object({
    source: t.String({ minLength: 1 }),
    summary: t.String({ minLength: 1 }),
    priority: t.Optional(t.Number()),
  }),
})
```

需要 import `loopReducer` from `@chengchenccc/loop` 和 `ulid`。

- [ ] **Step 2: api.ts 加 `addLoopItem`**

```typescript
addLoopItem: (loopId: string, body: { source: string; summary: string; priority?: number }) =>
  unwrap(client.api.loops({ id: loopId }).items.post(body)),
```

- [ ] **Step 3: hooks.ts 加 `useAddLoopItem`**

```typescript
export function useAddLoopItem(loopId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { source: string; summary: string; priority?: number }) =>
      api.addLoopItem(loopId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: loopKeys.detail(loopId) }),
  });
}
```

- [ ] **Step 4: 前端 Add Item 按钮 + 表单弹窗**

Loop 详情页加一个"Add Item"按钮。点击后弹 Dialog，表单含 source（select: ci/manual/lark）、summary（textarea）、priority（可选 number）。提交调 `useAddLoopItem`。

- [ ] **Step 5: typecheck + test + commit**

---

## Task 3: P0-3 -- Generator prompt 注入项目上下文

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`
- Modify: `apps/backend/src/features/loop/loop-step.test.ts`

- [ ] **Step 1: 扩展 `buildGeneratorPrompt`**

```typescript
function buildGeneratorPrompt(
  item: LoopState["items"][string],
  template: string,
  context?: { repoPath?: string; gitLog?: string; projectName?: string },
): string {
  const ctx = context?.repoPath
    ? `\n\n## Project Context\n- Repo: ${context.repoPath}\n${context.gitLog ? `- Recent changes:\n${context.gitLog}\n` : ""}`
    : "";
  return `${template}${ctx}\n\n## Task\n${item.summary}\n`;
}
```

- [ ] **Step 2: loopStepImpl 里获取 git log + 传给 buildGeneratorPrompt**

在 Generator 调用前，获取最近 5 条 git log：
```typescript
const gitLog = await Bun.$`git log --oneline -5`.cwd(cwd).quiet().text().catch(() => "");
const genPrompt = buildGeneratorPrompt(item, cfg.generator.systemPrompt, {
  repoPath: cwd,
  gitLog,
  projectName: cfg.projectId,
});
```

- [ ] **Step 3: 测试更新**

`loop-step.test.ts` 验证 prompt 包含 "Project Context" 和 repo 路径。

- [ ] **Step 4: typecheck + test + commit**

---

## Task 4: P1-1 -- Evaluator 超时兜底

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`

- [ ] **Step 1: Evaluator 加超时**

```typescript
const EVALUATOR_TIMEOUT_MS = 60_000;

// 替换 await evalSession.prompt(evaluatorPrompt);
await Promise.race([
  evalSession.prompt(evaluatorPrompt),
  new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error("Evaluator timeout")), EVALUATOR_TIMEOUT_MS),
  ),
]).catch(() => {
  console.error(`[loop] evaluator timeout/crash for item ${item.id}`);
});
```

超时后 verdict 已经是 ESCALATE（现有逻辑），只需确保不卡住。

- [ ] **Step 2: typecheck + test + commit**

---

## Task 5: P1-2 -- 预算超限通知

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`

- [ ] **Step 1: 超限时写 conversation 系统消息**

在 `for (const item of fixingItems)` 循环前，检查预算：
```typescript
if (dailyCap > 0 && spent >= dailyCap) {
  // Write system message to conversation if convPort available
  if (params.convPort) {
    const ts = Date.now();
    params.convPort.appendLedgerEntry({
      conversationId: params.loopId,
      senderMemberId: "__system__",
      addressedTo: [],
      kind: "message",
      content: JSON.stringify({
        type: "budget_exceeded",
        spent,
        cap: dailyCap,
        message: `[系统] Loop 今日预算已耗尽（${spent}/${dailyCap}），暂停执行，明日自动恢复。`,
      }),
      ts,
    });
  }
  break;
}
```

需要给 `LoopStepParams` 加 `convPort?` 字段（可选）。

- [ ] **Step 2: main.ts / scheduler.ts 传 convPort**

- [ ] **Step 3: typecheck + test + commit**

---

## Task 6: P2 -- 体验优化（budgetHistory + review反馈 + pendingCount）

**Files:**
- Modify: `apps/backend/src/features/loop/http.ts`
- Modify: `apps/web/src/app/(main)/work/page.tsx`
- Modify: `apps/web/src/app/(main)/work/[loopId]/page.tsx`
- Modify: `apps/web/src/lib/api.ts`

- [ ] **Step 1: `GET /api/loops` 加 pendingCount**

```typescript
.get("/api/loops", () => {
  const loops = cronSvc.list().filter(j => j.loopConfigPath != null);
  return {
    loops: loops.map(j => ({
      ...j,
      pendingCount: Object.values(store.load(j.cronJobId).items)
        .filter(i => i.step === "awaiting_review").length,
    })),
  };
})
```

- [ ] **Step 2: `GET /api/loops/:id` 加 budgetHistory**

```typescript
// 从 loop_budget 表查最近 7 天
const budgetHistory = store.getBudgetHistory?.(id, 7) ?? [];
// 或直接在 store 加方法
```

`LoopStateStore` 加 `getBudgetHistory(loopId, days)` 方法。

- [ ] **Step 3: review 端点返回动作类型**

```typescript
return { state, action: body.verdict };
```

- [ ] **Step 4: 前端 Loop 列表显示 pendingCount badge**

- [ ] **Step 5: 前端 Loop 详情页加 Budget History 卡片**

- [ ] **Step 6: 前端 Review 后 toast 提示**

- [ ] **Step 7: typecheck + test + commit**

---

## Task 7: 最终验证

- [ ] **Step 1: typecheck + test + lint**
- [ ] **Step 2: commit + push**
