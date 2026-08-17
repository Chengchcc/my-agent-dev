# M4 CronJob 集成 — 实施 Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `cron_job` 表加 `loop_config_path`、scheduler 的 `fire()` 分支到 `fireLoop()`、HTTP 加 `kind` 过滤。

**Architecture:** 不改 scheduler 现有逻辑，只加分支。`fireLoop()` 自管 retry/timeout/重读 job。manual loop（cronExpr=NULL）不注册 Bun.cron。

**Tech Stack:** TypeScript, drizzle-orm, Bun.cron, bun:test

**Reference:** `docs/superpowers/specs/2026-07-02-m4-cron-integration.md`

---

### Task 1: drizzle schema + migration

**Files:**
- Modify: `apps/backend/src/infra/db/schema.ts`
- Modify: `apps/backend/src/features/cron/domain.ts`
- Modify: `apps/backend/src/features/cron/ports.ts`

- [ ] **Step 1.1: 加 drizzle 列**

在 `schema.ts` 的 `cronJob` 表定义中加 `loopConfigPath`：

```typescript
// cron_job 表新增
loopConfigPath: text("loop_config_path"),
```

- [ ] **Step 1.2: Domain 加字段**

```typescript
export interface CronJobRow {
  // ... 现有字段
  loopConfigPath?: string | null;
}

export interface CreateCronJobInput {
  // ... 现有字段
  loopConfigPath?: string;
}

export interface UpdateCronJobInput {
  // ... 现有字段
  loopConfigPath?: string;
}
```

- [ ] **Step 1.3: Ports 加字段**

```typescript
export interface CreateCronJobRecord {
  // ... 现有字段
  loopConfigPath?: string;
}

export interface UpdateCronJobRecord {
  // ... 现有字段
  loopConfigPath?: string;
}
```

- [ ] **Step 1.4: Adapter 读写 loopConfigPath**

在 `sqliteCronJobAdapter` 的 `createCronJob` 和 `updateCronJob` 中处理 `loopConfigPath`：

```typescript
// createCronJob:
if (input.loopConfigPath !== undefined) values.loopConfigPath = input.loopConfigPath;

// updateCronJob:
if (patch.loopConfigPath !== undefined) sets.loopConfigPath = patch.loopConfigPath;
```

- [ ] **Step 1.5: 生成 migration**

```bash
cd apps/backend && bun run gen-drizzle
```

- [ ] **Step 1.6: Typecheck**

```bash
cd apps/backend && bun run typecheck
```

- [ ] **Step 1.7: Commit**

```bash
git add apps/backend && git commit -m "feat(backend): add loop_config_path to cron_job table"
```

---

### Task 2: HTTP — kind 过滤

**Files:**
- Modify: `apps/backend/src/features/cron/http.ts`

- [ ] **Step 2.1: 加 query 参数**

```typescript
.get("/api/cron-jobs", ({ query }) => {
  const kind = query.kind as string | undefined;
  let jobs = svc.list();
  if (kind === "loop") jobs = jobs.filter(j => j.loopConfigPath != null);
  if (kind === "cron") jobs = jobs.filter(j => j.loopConfigPath == null);
  return { cronJobs: jobs };
}, {
  query: t.Object({
    kind: t.Optional(t.Union([t.Literal("cron"), t.Literal("loop")])),
  }),
})
```

- [ ] **Step 2.2: Typecheck**

```bash
cd apps/backend && bun run typecheck
```

- [ ] **Step 2.3: Commit**

```bash
git add apps/backend/src/features/cron/http.ts && git commit -m "feat(backend): add kind query filter to GET /api/cron-jobs"
```

---

### Task 3: Scheduler — fire() 分支 + fireLoop()

**Files:**
- Modify: `apps/backend/src/features/cron/scheduler.ts`

- [ ] **Step 3.1: register() — 跳过 manual loop**

```typescript
register(job: CronJobRow) {
  this.unregister(job.cronJobId);
  if (!job.enabled) return;
  // Manual loop: no schedule
  if (!job.cronExpr) return;
  // ... 现有注册逻辑不变
}
```

- [ ] **Step 3.2: fire() — 加分支**

```typescript
async function fire(job: CronJobRow, _fireKey?: string): Promise<void> {
  if (job.loopConfigPath) {
    return fireLoop(job);
  }
  // ... 现有逻辑不变
}
```

- [ ] **Step 3.3: fireLoop()**

```typescript
import { loopStep } from "../loop/loop-step.js";

async function fireLoop(job: CronJobRow): Promise<void> {
  let attempt = 0;
  let currentJob = job;

  while (true) {
    try {
      if (currentJob.timeoutMs > 0) {
        const result = await withTimeout(
          loopStep({
            loopConfigPath: currentJob.loopConfigPath!,
            sessionFactory: deps.sessionFactory!,
            buildSpec,
          }),
          currentJob.timeoutMs,
        );
        return;
      }
      await loopStep({
        loopConfigPath: currentJob.loopConfigPath!,
        sessionFactory: deps.sessionFactory!,
        buildSpec,
      });
      return;
    } catch (err) {
      attempt++;
      const maxRetries = currentJob.maxRetries ?? 0;
      if (attempt > maxRetries) {
        inFlight.delete(job.cronJobId);
        throw err;
      }

      // Re-read job before retry
      const fresh = deps.cronSvc.port.getCronJob(job.cronJobId);
      if (!fresh) {
        inFlight.delete(job.cronJobId);
        throw err;
      }
      currentJob = fresh;

      await new Promise((r) =>
        setTimeout(r, Math.min(1000 * 2 ** (attempt - 1), 30_000)),
      );
    }
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}
```

- [ ] **Step 3.4: buildSpec — 硬编码（M5 切 LOOP.md）**

```typescript
import { makeRunDeps } from "../span/span-executor.js";

function buildSpec(params: { sessionId: string; modelName: string; cwd: string }): SessionSpec {
  const runDeps = makeRunDeps({
    config: deps.config,
    supervisor: deps.supervisor,
    opsStore: deps.opsStore,
    agentSvc: deps.omaSvc,
    sessionFactory: deps.sessionFactory,
  });
  // 复用 makeRunDeps 里的 SessionSpec 构造
  return (runDeps as any).buildSpec(params) ?? {
    agentId: "loop-agent",
    cwd: params.cwd,
    model: (deps as any).makeModel?.({ modelName: params.modelName, modelProvider: "anthropic", modelBaseUrl: null }),
    modelName: params.modelName,
    plugins: [],
    tools: [],
    checkpointer: {} as any,
    contextManager: {} as any,
  };
}
```

- [ ] **Step 3.4: Typecheck**

```bash
cd apps/backend && bun run typecheck
```

- [ ] **Step 3.5: Commit**

```bash
git add apps/backend/src/features/cron/scheduler.ts && git commit -m "feat(backend): add fireLoop to CronScheduler for Loop integration"
```

---

### Task 4: Scheduler 测试

**Files:**
- Modify: `apps/backend/src/features/cron/scheduler.test.ts`

- [ ] **Step 4.1: fireLoop 端到端测试**

```typescript
test("fireLoop calls loopStep for loop job", async () => {
  const job = makeJob({ loopConfigPath: "/tmp/test-loop", cronExpr: "0 8 * * *" });
  // ... mock sessionFactory + buildSpec
  // 验证 loopStep 被调用
});

test("fireLoop retries on failure", async () => {
  // loopStep throws twice then succeeds → verify retry count
});

test("fireLoop exhausts retries", async () => {
  // loopStep always throws → verify final throw, inFlight released
});

test("fireLoop re-reads job on retry", async () => {
  // first fire fails, port returns updated job → verify loopStep called with updated job
});

test("manual loop (cronExpr=null) not registered", async () => {
  // register(job without cronExpr) → handle not created
});

test("kind=loop filter returns only loop jobs", async () => {
  // ... HTTP test
});
```

- [ ] **Step 4.2: 运行测试**

```bash
cd apps/backend && bun test --test-name-pattern="cron|loop"
```

- [ ] **Step 4.3: Commit**

```bash
git add apps/backend/src/features/cron/scheduler.test.ts && git commit -m "test(backend): add fireLoop scheduler tests"
```

---

### Task 5: 全 workspace 验证

- [ ] **Step 5.1: Full workspace**

```bash
bun run typecheck && bun run lint && bun run test
```

- [ ] **Step 5.2: Commit**

```bash
git add -A && git commit -m "chore(backend): full workspace typecheck, lint, test after M4"
```
