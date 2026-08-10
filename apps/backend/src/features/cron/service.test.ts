import { describe, expect, test } from "bun:test";
import type { CronJobPort } from "./ports.js";
import { CronJobNotFoundError, CronJobValidationError, createCronJobService } from "./service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockPort(initial: any[] = []): CronJobPort {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const store = new Map<string, any>();
  for (const r of initial) store.set(r.cronJobId, { ...r });
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createCronJob(input: any) {
      const r = { ...input };
      store.set(input.cronJobId, r);
      return r;
    },
    getCronJob(id: string) {
      return store.get(id) ?? null;
    },
    listCronJobs() {
      return [...store.values()];
    },
    listEnabledCronJobs() {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return [...store.values()].filter((r: any) => r.enabled);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    updateCronJob(id: string, patch: any) {
      const r = store.get(id);
      if (!r) return null;
      Object.assign(r, patch);
      return store.get(id) ?? null;
    },
    deleteCronJob(id: string) {
      return store.delete(id);
    },
  };
}

function makeIdGen() {
  let n = 0;
  return () => `cj-${++n}`;
}

const agent1Exists = async (id: string) => id === "agent-1";
const alwaysExists = async () => true;

describe("createCronJobService", () => {
  test("createCronJob validates agentId", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: agent1Exists,
    });
    await expect(
      svc.createCronJob({ name: "test", agentId: "nonexistent", cronExpr: "0 9 * * *" }),
    ).rejects.toThrow(CronJobValidationError);
  });

  test("createCronJob succeeds with valid agentId", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: agent1Exists,
    });
    const job = await svc.createCronJob({
      name: "test",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      prompt: "hello",
    });
    expect(job.cronJobId).toBe("cj-1");
    expect(job.name).toBe("test");
    expect(job.prompt).toBe("hello");
    expect(job.enabled).toBe(false);
    expect(job.timeoutMs).toBe(0);
    expect(job.maxRetries).toBe(0);
  });

  test("createCronJob with enabled:true", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    const job = await svc.createCronJob({
      name: "enabled job",
      agentId: "agent-1",
      cronExpr: "* * * * *",
      enabled: true,
    });
    expect(job.enabled).toBe(true);
  });

  test("createCronJob with timeout and retries", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    const job = await svc.createCronJob({
      name: "x",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      timeoutMs: 30000,
      maxRetries: 5,
    });
    expect(job.timeoutMs).toBe(30000);
    expect(job.maxRetries).toBe(5);
  });

  test("setEnabled toggles", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    const job = await svc.createCronJob({
      name: "toggle",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
    });
    expect(svc.setEnabled(job.cronJobId, true).enabled).toBe(true);
    expect(svc.setEnabled(job.cronJobId, false).enabled).toBe(false);
  });

  test("setEnabled throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    expect(() => svc.setEnabled("nonexistent", true)).toThrow(CronJobNotFoundError);
  });

  test("getById throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    expect(() => svc.getById("nonexistent")).toThrow(CronJobNotFoundError);
  });

  test("list returns all", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    await svc.createCronJob({ name: "a", agentId: "agent-1", cronExpr: "0 9 * * *" });
    await svc.createCronJob({ name: "b", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(svc.list()).toHaveLength(2);
  });

  test("exists returns true/false", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    expect(svc.exists("anything")).toBe(false);
    const job = await svc.createCronJob({ name: "x", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(svc.exists(job.cronJobId)).toBe(true);
  });

  test("update modifies fields", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    const job = await svc.createCronJob({
      name: "old",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
      timeoutMs: 1000,
    });
    const updated = await svc.update(job.cronJobId, { name: "new", timeoutMs: 5000 });
    expect(updated.name).toBe("new");
    expect(updated.timeoutMs).toBe(5000);
    expect(updated.cronExpr).toBe("0 9 * * *"); // unchanged
  });

  test("update validates new agentId", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: agent1Exists,
    });
    const job = await svc.createCronJob({ name: "x", agentId: "agent-1", cronExpr: "0 9 * * *" });
    await expect(svc.update(job.cronJobId, { agentId: "nonexistent" })).rejects.toThrow(
      CronJobValidationError,
    );
  });

  test("update throws on missing", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    await expect(svc.update("nonexistent", { name: "x" })).rejects.toThrow(CronJobNotFoundError);
  });

  test("remove deletes", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    const job = await svc.createCronJob({
      name: "to-delete",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
    });
    svc.remove(job.cronJobId);
    expect(() => svc.getById(job.cronJobId)).toThrow(CronJobNotFoundError);
  });

  test("remove throws on missing", () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    expect(() => svc.remove("nonexistent")).toThrow(CronJobNotFoundError);
  });

  test("convPort failure does not block createCronJob", async () => {
    let called = false;
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
      convPort: {
        createConversation: () => {
          called = true;
          throw new Error("boom");
        },
        addMember: () => {},
      },
    });
    const job = await svc.createCronJob({
      name: "conv-test",
      agentId: "agent-1",
      cronExpr: "0 9 * * *",
    });
    expect(job).not.toBeNull();
    expect(called).toBe(true); // tried but failed silently
  });

  test("convPort success creates conversation and adds owner member", async () => {
    const calls: string[] = [];
    const svc = createCronJobService({
      port: mockPort(),
      idGen: () => "cj-conv",
      agentExists: alwaysExists,
      convPort: {
        createConversation: (input) => {
          calls.push(`conv:${input.conversationId}:${input.title}:${input.origin}`);
        },
        addMember: (input) => {
          calls.push(
            `member:${input.conversationId}:${input.memberId}:${input.kind}:${input.agentId}`,
          );
        },
      },
    });
    await svc.createCronJob({ name: "My Job", agentId: "agent-1", cronExpr: "0 9 * * *" });
    expect(calls).toEqual(["conv:cj-conv:My Job:cron", "member:cj-conv:owner:agent:agent-1"]);
  });

  test("createCronJob accepts empty cronExpr for a disabled manual loop", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });

    const job = await svc.createCronJob({
      name: "manual loop",
      agentId: "loop-agent",
      cronExpr: "",
      enabled: false,
      loopConfigPath: "loops/manual-loop",
    });

    expect(job.cronExpr).toBe("");
    expect(job.enabled).toBe(false);
    expect(job.loopConfigPath).toBe("loops/manual-loop");
  });

  test("createCronJob still rejects invalid non-empty cron", async () => {
    const svc = createCronJobService({
      port: mockPort(),
      idGen: makeIdGen(),
      agentExists: alwaysExists,
    });
    await expect(
      svc.createCronJob({ name: "bad", agentId: "agent-1", cronExpr: "99 99 99 99 99" }),
    ).rejects.toThrow(CronJobValidationError);
  });
});
