# Plugin 拆分 Implementation Plan

> **Spec:** `docs/superpowers/specs/2026-07-09-plugin-split-todo-goal.md`

---

## 代码事实

| 事实 | 位置 |
|------|------|
| task-guard 源码（331行） | `packages/plugin-task-guard/src/task-guard.ts` |
| task-guard 测试 | `packages/plugin-task-guard/src/task-guard.test.ts` |
| task-guard barrel | `packages/plugin-task-guard/src/index.ts` |
| task-guard package.json | `packages/plugin-task-guard/package.json` |
| tsconfig path 引用 | `tsconfig.json` |
| commitlint scope | `commitlint.config.mjs` |
| task-guard 无调用方 | grep 确认零 import |
| todo_write 工具 | `task-guard.ts:155-198` |
| renderTodo + injectIntoSystem | `task-guard.ts:32-51` |
| unresolvedToolErrors | `task-guard.ts:60-83` |
| StopValidator 类型 | `task-guard.ts:15-17` |
| generatePlan（删） | `task-guard.ts:87-131` |
| planGuidance（删） | `task-guard.ts:133-151` |
| beforeRun hook（删） | `task-guard.ts:213-231`（在 plugin factory 内） |
| todo 全 done 检查（删） | `task-guard.ts:232-260`（在 beforeStop 内） |
| beforeStop hook | `task-guard.ts:232-280` |
| Plugin init 接口 | `packages/framework/src/plugin.ts` |
| collectStream | `@chengchenccc/core` |
| extractText | `@chengchenccc/message` |
| 现有 plugin 包结构参考 | `packages/plugin-identity/` |

---

## Task 1: 创建 plugin-todo

**Files:**
- Create: `packages/plugin-todo/package.json`
- Create: `packages/plugin-todo/tsconfig.json`
- Create: `packages/plugin-todo/tsconfig.test.json`
- Create: `packages/plugin-todo/src/index.ts`
- Create: `packages/plugin-todo/src/todo.ts`
- Create: `packages/plugin-todo/src/todo.test.ts`

- [ ] **Step 1: package.json**

复制 `packages/plugin-identity/package.json` 结构，改 name 为 `@chengchenccc/plugin-todo`。依赖：`@chengchenccc/core`, `@chengchenccc/framework`, `@chengchenccc/message`。

- [ ] **Step 2: tsconfig.json + tsconfig.test.json**

复制 plugin-identity 的结构。

- [ ] **Step 3: src/todo.ts**

从 task-guard 提取：
- `Todo` / `TodoStatus` 类型
- `renderTodo` 函数
- `injectIntoSystem` 函数
- `createTodoWriteTool` 函数
- `todoPlugin(opts?)` 工厂函数

```typescript
export interface TodoPluginOptions {
  showProgress?: boolean;
}

export function todoPlugin(opts?: TodoPluginOptions): Plugin {
  const showProgress = opts?.showProgress ?? true;
  const todos: Todo[] = [];

  return definePlugin({
    name: "todo",
    tools: [createTodoWriteTool({ todos })],
    hooks: {
      beforeModel: (ctx, messages) => {
        if (!showProgress || todos.length === 0) return messages;
        return injectIntoSystem(messages, `<todo>\n${renderTodo(todos)}\n</todo>`);
      },
    },
  });
}
```

- [ ] **Step 4: src/todo.test.ts**

测试：
- todoPlugin 返回正确 shape（name, hooks, tools）
- todo_write 工具执行后 todos 更新
- beforeModel 注入 todo 进度
- showProgress=false 不注入

- [ ] **Step 5: src/index.ts barrel**

```typescript
export { todoPlugin, type Todo, type TodoStatus, type TodoPluginOptions } from "./todo.js";
```

- [ ] **Step 6: bun install + build + test**

---

## Task 2: 创建 plugin-goal

**Files:**
- Create: `packages/plugin-goal/package.json`
- Create: `packages/plugin-goal/tsconfig.json`
- Create: `packages/plugin-goal/tsconfig.test.json`
- Create: `packages/plugin-goal/src/index.ts`
- Create: `packages/plugin-goal/src/goal.ts`
- Create: `packages/plugin-goal/src/goal.test.ts`

- [ ] **Step 1: package.json + tsconfig**

同 Task 1 模式。

- [ ] **Step 2: src/goal.ts**

从 task-guard 提取 + 新增：

```typescript
// 提取的（保留）
export type StopValidator = (messages: readonly Message[]) => StopDecision | undefined | Promise<StopDecision | undefined>;
export function unresolvedToolErrors(messages: readonly Message[]): StopDecision | undefined;

// 新增的
export interface WorkSummary {
  changed_files: string[];
  commands_run: string[];
  test_result: "pass" | "fail" | "unknown";
  summary: string;
}

export interface GoalPluginOptions {
  goalCondition?: string;
  evaluatorModel?: ChatModel;
  extraValidators?: StopValidator[];
}

async function extractStructuredSummary(model: ChatModel, messages: readonly Message[]): Promise<WorkSummary> {
  // 只传最近 10 条消息
  // prompt 要求输出 JSON
  // 解析 JSON，失败返回 { changed_files: [], commands_run: [], test_result: "unknown", summary: "" }
}

async function evaluateGoal(model: ChatModel, summary: WorkSummary, condition: string): Promise<{ met: boolean; reason: string }> {
  // prompt: 给 summary + condition，要求输出 { met: boolean, reason: string }
  // 解析 JSON，失败返回 { met: false, reason: "evaluation failed" }
}

export function goalPlugin(opts?: GoalPluginOptions): Plugin {
  const goalCondition = opts?.goalCondition;
  const evaluatorModel = opts?.evaluatorModel;
  const extraValidators = opts?.extraValidators ?? [];

  return definePlugin({
    name: "goal",
    hooks: {
      beforeStop: async (ctx, messages) => {
        // Step 1: 确定性检查
        const errorCheck = unresolvedToolErrors(messages);
        if (errorCheck) return errorCheck;

        for (const validator of extraValidators) {
          const result = await validator(messages);
          if (result) return result;
        }

        // Step 2: goal 评估（可选）
        if (!goalCondition || !evaluatorModel) return undefined;

        const summary = await extractStructuredSummary(evaluatorModel, messages);
        const evaluation = await evaluateGoal(evaluatorModel, summary, goalCondition);

        if (!evaluation.met) {
          return { continue: true, reason: evaluation.reason };
        }
        return undefined; // goal 达成，允许停
      },
    },
  });
}
```

- [ ] **Step 3: src/goal.test.ts**

测试：
- goalPlugin 返回正确 shape
- unresolvedToolErrors 检测到 error -> force continue
- 无 goalCondition -> 允许停
- extraValidators 返回 continue -> force continue
- extractStructuredSummary 解析 JSON（用 echoModel mock）
- evaluateGoal met=false -> force continue

- [ ] **Step 4: src/index.ts barrel**

```typescript
export { goalPlugin, type GoalPluginOptions, type StopValidator, type WorkSummary, unresolvedToolErrors } from "./goal.js";
```

- [ ] **Step 5: bun install + build + test**

---

## Task 3: 删除 plugin-task-guard + 更新引用

**Files:**
- Delete: `packages/plugin-task-guard/` （整个目录）
- Modify: `tsconfig.json`（移除 path，加两个新 path）
- Modify: `commitlint.config.mjs`（scope 改）

- [ ] **Step 1: 删除 plugin-task-guard 目录**

`rm -rf packages/plugin-task-guard`

- [ ] **Step 2: tsconfig.json 更新**

移除 `{ "path": "./packages/plugin-task-guard" }`，加：
```json
{ "path": "./packages/plugin-todo" },
{ "path": "./packages/plugin-goal" },
```

- [ ] **Step 3: commitlint.config.mjs 更新**

移除 `"plugin-task-guard"`，加 `"plugin-todo"` 和 `"plugin-goal"`。

- [ ] **Step 4: bun install**

- [ ] **Step 5: typecheck + lint**

---

## Task 4: 最终验证

- [ ] `cd packages/plugin-todo && bun test`
- [ ] `cd packages/plugin-goal && bun test`
- [ ] `bun run typecheck`（全量）
- [ ] `npx biome check .`
- [ ] commit + push
