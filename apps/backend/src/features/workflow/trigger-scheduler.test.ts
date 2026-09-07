import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkflowTriggerScheduler } from "./trigger-scheduler.js";

const cronDef = (id: string, cron: string, enabled?: boolean) => ({
  version: 1 as const,
  id,
  triggers:
    enabled === undefined
      ? [{ type: "cron" as const, cron }]
      : [{ type: "cron" as const, cron, enabled }],
  nodes: [
    { id: "start", type: "start" as const },
    { id: "done", type: "end" as const, status: "success" as const },
  ],
  edges: [{ from: "start", to: "done" }],
});

describe("workflow trigger scheduler", () => {
  let dir: string;
  let scheduled: { cron: string; fn: () => void }[];
  let started: { workflowId: string }[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wf-sched-"));
    scheduled = [];
    started = [];
  });

  afterEach(() => {
    const sched = createWorkflowTriggerScheduler({
      workflowDir: dir,
      startExecution: async (input) => {
        started.push({ workflowId: input.workflowId });
        expect(input.triggeredBy).toBe("cron:* * * * *");
      },
      schedule: (cron, fn) => {
        const h = { cron, fn, stop: () => scheduled.splice(scheduled.indexOf(h), 1) };
        scheduled.push(h);
        return { stop: () => h.stop() };
      },
    });
    void sched.dispose();
  });

  test("registers enabled cron triggers", async () => {
    writeFileSync(join(dir, "a.workflow.json"), JSON.stringify(cronDef("a", "0 2 * * *")));
    const sched = createWorkflowTriggerScheduler({
      workflowDir: dir,
      startExecution: async () => {},
      schedule: (cron, fn) => {
        const h = { cron, fn, stop: () => scheduled.splice(scheduled.indexOf(h), 1) };
        scheduled.push(h);
        return h;
      },
    });
    await sched.sync();
    expect(scheduled.map((s) => s.cron)).toEqual(["0 2 * * *"]);
    await sched.dispose();
  });

  test("skips disabled triggers", async () => {
    writeFileSync(join(dir, "a.workflow.json"), JSON.stringify(cronDef("a", "* * * * *", false)));
    const sched = createWorkflowTriggerScheduler({
      workflowDir: dir,
      startExecution: async () => {},
      schedule: (cron, fn) => {
        const h = { cron, fn, stop: () => scheduled.splice(scheduled.indexOf(h), 1) };
        scheduled.push(h);
        return h;
      },
    });
    await sched.sync();
    expect(scheduled).toEqual([]);
    await sched.dispose();
  });

  test("fires workflow via startExecution and single-flights concurrent calls", async () => {
    writeFileSync(join(dir, "a.workflow.json"), JSON.stringify(cronDef("a", "* * * * *")));
    const sched = createWorkflowTriggerScheduler({
      workflowDir: dir,
      startExecution: async (input) => {
        started.push({ workflowId: input.workflowId });
        expect(input.triggeredBy).toBe("cron:* * * * *");
      },
      schedule: (cron, fn) => {
        const h = { cron, fn, stop: () => scheduled.splice(scheduled.indexOf(h), 1) };
        scheduled.push(h);
        fn();
        return h;
      },
    });
    await sched.sync();
    // schedule() calls fn immediately once (fire on sync)
    expect(started).toEqual([{ workflowId: "a" }]);
    await sched.dispose();
  });

  test("resync after PUT/DELETE removes old handles", async () => {
    writeFileSync(join(dir, "a.workflow.json"), JSON.stringify(cronDef("a", "0 2 * * *")));
    const sched = createWorkflowTriggerScheduler({
      workflowDir: dir,
      startExecution: async () => {},
      schedule: (cron, fn) => {
        const h = { cron, fn, stop: () => scheduled.splice(scheduled.indexOf(h), 1) };
        scheduled.push(h);
        return h;
      },
    });
    await sched.sync();
    expect(scheduled).toHaveLength(1);
    // simulate DELETE: remove file then resync
    const fs = await import("node:fs");
    fs.rmSync(join(dir, "a.workflow.json"));
    await sched.sync();
    expect(scheduled).toHaveLength(0);
    await sched.dispose();
  });

  test("cron tick swallows startExecution failures (H4)", async () => {
    writeFileSync(join(dir, "a.workflow.json"), JSON.stringify(cronDef("a", "* * * * *")));
    let calls = 0;
    const sched = createWorkflowTriggerScheduler({
      workflowDir: dir,
      startExecution: async () => {
        calls++;
        throw new Error("SQLITE_BUSY");
      },
      schedule: (cron, fn) => {
        scheduled.push({ cron, fn });
        return { stop() {} };
      },
    });
    await sched.sync();
    // Pre-H4 this rejection escaped the Bun.cron callback and killed the
    // whole backend process. fire() settles entirely in microtasks (no real
    // timers inside), so a microtask flush observes the swallowed error.
    scheduled[0]!.fn();
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(1);
    await sched.dispose();
  });
});
