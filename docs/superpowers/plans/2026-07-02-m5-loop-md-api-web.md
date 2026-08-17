# M5 LOOP.md + API + Web — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** LOOP.md 替换硬编码 prompt、Loop CRUD API、Web 仪表盘。M1-M5 MVP 收尾。

**Architecture:** packages/loop 加 `parseLoopConfig`（复用以 YAML parser）。backend 加 `/api/loops` 路由 + `loop-config-generator` Skill 集成。前端三页面：仪表盘、创建、详情。

**Tech Stack:** TypeScript, Elysia, React/Next.js, bun:test

**Reference:** `docs/superpowers/specs/2026-07-02-m5-loop-md-api-web.md`

---

### Task 1: parseLoopConfig —— LOOP.md 解析

**Files:**
- Modify: `packages/loop/src/state-md.ts`

- [ ] **Step 1.1: 类型 + 解析函数**

```typescript
export interface LoopConfig {
  repo: string;
  generator: { model: string; systemPrompt: string };
  evaluator: { model: string; systemPrompt: string };
  acceptance: string;
}

export function parseLoopConfig(md: string): LoopConfig | null {
  if (!md.trim()) return null;

  const fmMatch = md.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch?.[1]) return null;

  const frontmatter = parseYamlBlock(fmMatch[1].split("\n"));
  const gen = frontmatter.generator as Record<string, unknown> | undefined;
  const eval_ = frontmatter.evaluator as Record<string, unknown> | undefined;

  if (!gen?.model || !eval_?.model) return null;

  return {
    repo: String(frontmatter.repo ?? ""),
    generator: {
      model: String(gen.model),
      systemPrompt: String(gen.systemPrompt ?? ""),
    },
    evaluator: {
      model: String(eval_.model),
      systemPrompt: String(eval_.systemPrompt ?? ""),
    },
    acceptance: String(frontmatter.acceptance ?? ""),
  };
}
```

- [ ] **Step 1.2: 测试**

```typescript
describe("parseLoopConfig", () => {
  test("parses full LOOP.md", () => {
    const md = `---
repo: /home/projects/test
generator:
  model: claude-sonnet-4
  systemPrompt: fix bugs
evaluator:
  model: claude-opus-4
  systemPrompt: verify
acceptance: tests pass
---
`;
    const cfg = parseLoopConfig(md);
    expect(cfg).not.toBeNull();
    expect(cfg!.repo).toBe("/home/projects/test");
    expect(cfg!.generator.model).toBe("claude-sonnet-4");
    expect(cfg!.generator.systemPrompt).toBe("fix bugs");
    expect(cfg!.evaluator.model).toBe("claude-opus-4");
    expect(cfg!.acceptance).toBe("tests pass");
  });

  test("missing model → null", () => {
    const md = `---
generator:
  systemPrompt: fix
evaluator:
  systemPrompt: verify
---`;
    expect(parseLoopConfig(md)).toBeNull();
  });

  test("empty → null", () => {
    expect(parseLoopConfig("")).toBeNull();
  });

  test("no frontmatter → null", () => {
    expect(parseLoopConfig("# Hello")).toBeNull();
  });
});
```

- [ ] **Step 1.3: 导出**

```typescript
// packages/loop/src/index.ts
export { parseLoopConfig } from "./state-md.js";
export type { LoopConfig } from "./state-md.js";
```

- [ ] **Step 1.4: Verify**

```bash
cd packages/loop && bun test && bun run typecheck
```

- [ ] **Step 1.5: Commit**

---

### Task 2: skills/loop-engine/ Skill Pack

**Files:**
- Create: `skills/loop-engine/loop-config-generator/SKILL.md`
- Create: `skills/loop-engine/registry.yaml`

- [ ] **Step 2.1: loop-config-generator/SKILL.md**

```markdown
---
name: loop-config-generator
description: >
  Translate natural-language Loop intents into LOOP.md configuration.
  Matches one of 7 patterns from registry.yaml and fills in parameters.
user_invocable: false
---

# Loop Config Generator

You generate `.loop/LOOP.md` from natural-language intents.

## Input
User intent (e.g. "每天早上检查 CI 失败，自动修简单的")

## Process
1. Read the pattern registry below
2. Match the intent to the best pattern
3. Fill in: schedule, generator/evaluator model, system prompts, acceptance criteria, safety constraints
4. Output LOOP.md content and the matched pattern name

## Patterns
{registry_content}
```

- [ ] **Step 2.2: registry.yaml**

```yaml
patterns:
  daily-triage:
    schedule: "0 8 * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "每日检查 CI/issue/PR，分类并修简单的"
  pr-babysitter:
    schedule: "*/15 * * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "监控开放 PR，提醒 reviewer"
  ci-sweeper:
    schedule: "*/15 * * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "修 CI 失败和测试 flaky"
  changelog-drafter:
    schedule: "0 9 * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "写 changelog 和发版笔记"
  dependency-sweeper:
    schedule: "0 */6 * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "升级依赖，检查 CVE"
  issue-triage:
    schedule: "0 */2 * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "分类 issue，打标签"
  post-merge-cleanup:
    schedule: "0 10 * * *"
    generator: { model: "claude-sonnet-4" }
    evaluator: { model: "claude-opus-4" }
    description: "清理合并后的 dead code"
```

- [ ] **Step 2.3: Commit**

---

### Task 3: seedSkillPacks 注册 loop-engine

**Files:**
- Modify: `apps/backend/src/main.ts`

`seedSkillPacks` 已处理 `builtinSkillsDir` 下的所有内容——`skills/loop-engine/` 会自动被复制到 `dataDir/skill-packs/loop-engine/`。无需改代码。

- [ ] **Step 3.1: 验证**

启动 backend，检查 `dataDir/skill-packs/loop-engine/` 存在且含 SKILL.md。

- [ ] **Step 3.2: Commit**

---

### Task 4: loopStep 读 LOOP.md

**Files:**
- Modify: `apps/backend/src/features/loop/loop-step.ts`

- [ ] **Step 4.1: 在 loopStep 开头读 LOOP.md**

```typescript
import { parseLoopConfig } from "@chengchenccc/loop";
import type { LoopConfig } from "@chengchenccc/loop";

// 在 loopStep 内部
const loopMdPath = `${params.loopConfigPath}/LOOP.md`;
let cfg: LoopConfig | null = null;
try {
  cfg = parseLoopConfig(await Bun.file(loopMdPath).text());
} catch {}

const genModel = cfg?.generator.model ?? GENERATOR_MODEL;
const evalModel = cfg?.evaluator.model ?? EVALUATOR_MODEL;
const genPrompt = cfg?.generator.systemPrompt || GENERATOR_PROMPT;
const evalPrompt = cfg?.evaluator.systemPrompt || EVALUATOR_PROMPT;
const acceptance = cfg?.acceptance || ACCEPTANCE;
const repo = cfg?.repo || workDir;
```

`repo` 用于 AgentSession 的 `cwd`——`buildSpec` 里传 `cwd: repo`。

- [ ] **Step 4.2: 更新 buildSpec 传 repo**

在 scheduler.ts 里 `fireLoop()` 的 `buildSpec` 改为从 LOOP.md 读 repo——但 M4 的 buildSpec 在 scheduler.ts 里是硬编码的。M5 不做 scheduler 重构——只改 loopStep 内部的 cwd。

- [ ] **Step 4.3: Typecheck + test**

```bash
cd apps/backend && bun run typecheck && bun test src/features/loop/
```

- [ ] **Step 4.4: Commit**

---

### Task 5: /api/loops CRUD

**Files:**
- Create: `apps/backend/src/features/loop/http.ts`

- [ ] **Step 5.1: 路由**

```typescript
import { Elysia, t } from "elysia";
import type { CronJobService } from "../cron/service.js";
import type { CronScheduler } from "../cron/scheduler.js";
import { loopStep } from "./loop-step.js";
import { parseStateMd } from "@chengchenccc/loop";

export function loopRoutes(
  cronSvc: CronJobService,
  scheduler: CronScheduler,
  dataDir: string,
) {
  return new Elysia()
    .get("/api/loops", () => ({
      loops: cronSvc.list().filter((j) => j.loopConfigPath != null),
    }))
    .get("/api/loops/:id", async ({ params: { id } }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) throw new Error("Not a loop");

      // Read STATE.md for lastRun + pending count
      let lastRun: string | null = null;
      let pendingCount = 0;
      try {
        const state = parseStateMd(
          await Bun.file(`${dataDir}/${job.loopConfigPath}/STATE.md`).text(),
        );
        lastRun = state.lastRun;
        pendingCount = Object.values(state.items).filter(
          (i) => i.step === "awaiting_review",
        ).length;
      } catch {}

      return {
        loop: {
          id: job.cronJobId,
          name: job.name,
          cronExpr: job.cronExpr,
          enabled: job.enabled,
          loopConfigPath: job.loopConfigPath,
          lastRun,
          pendingCount,
        },
      };
    })
    .post(
      "/api/loops",
      async ({ body, set }) => {
        // Body validation
        if (!body.name.trim()) throw new Error("name required");

        const loopId = idGen();
        const loopName = body.name.trim().toLowerCase().replace(/\s+/g, "-");
        const loopPath = `loops/${loopName}`;

        // Create directory
        await mkdir(`${dataDir}/${loopPath}/skills`, { recursive: true });

        // Write base LOOP.md (user confirms later via preview)
        await Bun.write(
          `${dataDir}/${loopPath}/LOOP.md`,
          `---\nrepo: ${body.repo}\ngenerator:\n  model: claude-sonnet-4\n  systemPrompt: ""\nevaluator:\n  model: claude-opus-4\n  systemPrompt: ""\nacceptance: ""\n---\n\n# ${body.name}\n\n${body.intent}`,
        );

        const job = cronSvc.create({
          name: body.name,
          agentId: "loop-agent",
          cronExpr: body.cronExpr ?? "",
          prompt: body.intent,
          loopConfigPath: loopPath,
          enabled: !body.paused,
        });

        scheduler.register(job);

        set.status = 201;
        return { loop: { id: job.cronJobId, name: job.name, cronExpr: job.cronExpr, loopConfigPath: job.loopConfigPath } };
      },
      {
        body: t.Object({
          name: t.String(),
          intent: t.String(),
          repo: t.String(),
          cronExpr: t.Optional(t.String()),
          paused: t.Optional(t.Boolean()),
        }),
      },
    )
    .delete("/api/loops/:id", async ({ params: { id }, set }) => {
      const job = cronSvc.getById(id);
      if (!job?.loopConfigPath) throw new Error("Not a loop");

      scheduler.unregister(id);
      cronSvc.remove(id);
      await rm(`${dataDir}/${job.loopConfigPath}`, { recursive: true, force: true });

      set.status = 204;
    });
}
```

- [ ] **Step 5.2: 注册到 main.ts**

```typescript
import { loopRoutes } from "./features/loop/http.js";
app.use(loopRoutes(cronSvc, cronScheduler, config.dataDir));
```

- [ ] **Step 5.3: Typecheck + test**

```bash
cd apps/backend && bun run typecheck
```

- [ ] **Step 5.4: Commit**

---

### Task 6: Web UI — 仪表盘 + 创建 + 详情

**Files:**
- Create: `apps/web/src/app/(main)/loops/page.tsx`
- Create: `apps/web/src/app/(main)/loops/new/page.tsx`
- Create: `apps/web/src/app/(main)/loops/[id]/page.tsx`
- Modify: 导航

- [ ] **Step 6.1: `/loops` 仪表盘页面**

参考现有 `/cron` 卡片布局。调用 `GET /api/loops`。

- [ ] **Step 6.2: `/loops/new` 创建页**

表单：name, intent, repo, cronExpr（可选）, paused。调用 `POST /api/loops`。

- [ ] **Step 6.3: `/loops/:id` 详情页**

调用 `GET /api/loops/:id`。显示 pending item list + 上次运行时间。

- [ ] **Step 6.4: 导航变更**

移除 `/issues`，加 `/loops`。

- [ ] **Step 6.5: Commit**

---

### Task 7: 全 workspace 验证

- [ ] **Step 7.1: Full workspace**

```bash
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 7.2: Commit**
