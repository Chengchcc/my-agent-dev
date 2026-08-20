import { describe, expect, test } from "bun:test";
import type { LarkProfileProvisioner } from "./provisioner.js";
import { LarkSetupManager } from "./setup-manager.js";

const SETUP_URL = "https://open.larkoffice.cn/setup?token=abc123";

function fakeProvisioner(): LarkProfileProvisioner {
  return {
    kind: "cli_setup",
    async start(input) {
      const timer = setTimeout(() => input.onUrl?.(SETUP_URL), 50);
      const { promise: waitForCompletion, resolve: resolveUrl } = Promise.withResolvers<string>();
      setTimeout(() => {
        clearTimeout(timer);
        resolveUrl(SETUP_URL);
      }, 200);
      return {
        setupId: `setup_${input.agentId}`,
        profileRef: input.profileRef,
        waitForCompletion,
        cancel: async () => clearTimeout(timer),
      };
    },
    async probe() {
      return "not_ready";
    },
  };
}

describe("LarkSetupManager onUrl wiring", () => {
  test("session.url is surfaced while pending, before completion", async () => {
    const manager = new LarkSetupManager(fakeProvisioner(), async () => {});
    try {
      const created = await manager.create({ agentId: "ag-1", brand: "feishu" });
      expect(created.url).toBeNull();

      await Bun.sleep(80);
      const pending = manager.get(created.setupId)!;
      expect(pending.url).toBe(SETUP_URL);
      expect(pending.status).toBe("pending");

      await Bun.sleep(200);
      const done = manager.get(created.setupId)!;
      expect(done.status).toBe("completed");
      expect(done.url).toBe(SETUP_URL);
    } finally {
      manager.dispose();
    }
  });
});
