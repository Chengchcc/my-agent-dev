import { describe, expect, test } from "bun:test";
import { openDb } from "../../infra/sqlite/db.js";
import { sqliteSkillPackAdapter } from "./adapter-sqlite.js";
import { BUILTIN_PACK_ID } from "./entities.js";
import type { SkillPackPort } from "./ports.js";
import {
  BuiltinPackImmutableError,
  createSkillPackService,
  type InstallSessionCtx,
} from "./service.js";

function makeSvc(
  checkSync?: (
    packId: string,
    ctx: InstallSessionCtx,
  ) => Promise<{ from: string | null; to: string } | null>,
) {
  const db = openDb(":memory:");
  const port: SkillPackPort = sqliteSkillPackAdapter(db);
  let idCounter = 0;
  const installCalls: { packId: string; ctx: InstallSessionCtx }[] = [];
  const syncCalls: { packId: string; ctx: InstallSessionCtx }[] = [];

  const svc = createSkillPackService({
    port,
    idGen: () => `pack-${++idCounter}`,
    triggerInstall: (packId, ctx) => {
      installCalls.push({ packId, ctx });
    },
    triggerSync: (packId, ctx) => {
      syncCalls.push({ packId, ctx });
    },
    checkSync,
  });

  return { svc, port, installCalls, syncCalls };
}

describe("SkillPackService", () => {
  // ─── installFromGit ────────────────────────────────────────────────

  test("installFromGit registers pending record and triggers install", async () => {
    const { svc, installCalls, port } = makeSvc();
    const row = await svc.installFromGit({
      name: "Test",
      description: "A test pack",
      url: "https://github.com/example/test",
      ref: "main",
    });
    expect(row.status).toBe("pending");
    expect(row.sourceKind).toBe("git");
    expect(row.sourceUrl).toBe("https://github.com/example/test");
    expect(row.versionRef).toBe("main");

    // Verify persisted
    const fetched = await port.get(row.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.status).toBe("pending");

    // Verify install triggered
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]!.packId).toBe(row.id);
    expect(installCalls[0]!.ctx.sourceUrl).toBe("https://github.com/example/test");
  });

  test("installFromZip registers pending record and triggers install", async () => {
    const { svc, installCalls } = makeSvc();
    const buffer = Buffer.from("fake zip");
    const row = await svc.installFromZip({
      name: "Test Zip",
      description: "A zip pack",
      buffer,
    });
    expect(row.status).toBe("pending");
    expect(row.sourceKind).toBe("zip");
    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]!.ctx.sourceKind).toBe("zip");
    // buffer should be base64 encoded
    expect(installCalls[0]!.ctx.sourceUrl).toBe(buffer.toString("base64"));
  });

  // ─── syncGit ───────────────────────────────────────────────────────

  test("syncGit transitions to syncing and triggers sync", async () => {
    const { svc, port, syncCalls } = makeSvc();
    // First create a ready git pack
    const row = await svc.installFromGit({ name: "G", description: "d", url: "url", ref: "main" });
    await port.applyInstallTransition(row.id, "installing", { now: Date.now() });
    await port.applyInstallTransition(row.id, "ready", { installedRef: "abc", now: Date.now() });

    const updated = await svc.syncGit(row.id);
    expect(updated.status).toBe("syncing");
    expect(syncCalls).toHaveLength(1);
    expect(syncCalls[0]!.packId).toBe(row.id);
  });

  test("syncGit rejects non-git packs", async () => {
    const { svc, port } = makeSvc();
    const row = await svc.installFromZip({ name: "Z", description: "d", buffer: Buffer.from("x") });
    await port.applyInstallTransition(row.id, "installing", { now: Date.now() });
    await port.applyInstallTransition(row.id, "ready", { installedRef: "xx", now: Date.now() });

    await expect(svc.syncGit(row.id)).rejects.toThrow("Cannot sync non-git pack");
  });

  test("syncGit without confirm blocks on upstream change and does not transition", async () => {
    const { svc, port, syncCalls } = makeSvc(async () => ({ from: "abc", to: "def" }));
    const row = await svc.installFromGit({ name: "G", description: "d", url: "url", ref: "main" });
    await port.applyInstallTransition(row.id, "installing", { now: Date.now() });
    await port.applyInstallTransition(row.id, "ready", { installedRef: "abc", now: Date.now() });

    await expect(svc.syncGit(row.id)).rejects.toThrow("upstream changed");
    expect((await port.get(row.id))?.status).toBe("ready");
    expect(syncCalls).toHaveLength(0);
  });

  test("syncGit with confirm skips the check and triggers sync", async () => {
    const { svc, port, syncCalls } = makeSvc(async () => ({ from: "abc", to: "def" }));
    const row = await svc.installFromGit({ name: "G", description: "d", url: "url", ref: "main" });
    await port.applyInstallTransition(row.id, "installing", { now: Date.now() });
    await port.applyInstallTransition(row.id, "ready", { installedRef: "abc", now: Date.now() });

    const updated = await svc.syncGit(row.id, true);
    expect(updated.status).toBe("syncing");
    expect(syncCalls).toHaveLength(1);
  });

  // ─── uninstall ─────────────────────────────────────────────────────

  test("uninstall rejects builtin pack", async () => {
    const { svc, port } = makeSvc();
    // Register a builtin-like pack manually
    await port.register({
      id: BUILTIN_PACK_ID,
      name: "Builtin",
      description: "System builtin",
      sourceKind: "builtin",
      sourceUrl: null,
      versionRef: null,
      now: Date.now(),
    });
    await expect(svc.uninstall(BUILTIN_PACK_ID)).rejects.toThrow(BuiltinPackImmutableError);
  });

  test("uninstall removes pack and cascade-clears assignments", async () => {
    const { svc, port } = makeSvc();
    const row = await svc.installFromGit({ name: "X", description: "d", url: "u" });
    await port.applyInstallTransition(row.id, "installing", { now: Date.now() });
    await port.applyInstallTransition(row.id, "ready", { installedRef: "x", now: Date.now() });

    await port.setAgentPacks("agent-1", [row.id], Date.now());
    expect(await port.listForAgent("agent-1")).toHaveLength(1);

    await svc.uninstall(row.id);
    expect(await port.get(row.id)).toBeNull();
    expect(await port.listForAgent("agent-1")).toHaveLength(0);
  });

  // ─── agent assignments ─────────────────────────────────────────────

  test("setAgentPacks overwrites existing assignments", async () => {
    const { svc } = makeSvc();
    const p1 = await svc.installFromGit({ name: "A", description: "d", url: "u" });
    const p2 = await svc.installFromGit({ name: "B", description: "d", url: "u2" });

    await svc.setAgentPacks("agent-1", [p1.id, p2.id]);
    expect(await svc.listForAgent("agent-1")).toHaveLength(2);

    await svc.setAgentPacks("agent-1", [p2.id]);
    expect(await svc.listForAgent("agent-1")).toHaveLength(1);
    expect((await svc.listForAgent("agent-1"))[0]!.id).toBe(p2.id);
  });
});
