import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeMcpConfigs } from "./mcp-mount.js";

describe("product-tools MCP data path", () => {
  test("backend writeMcpConfig output parses via child loadMcpConfig with token expansion", () => {
    const workspace = mkdtempSync(join(tmpdir(), "oma-pt-"));
    try {
      process.env.PRODUCT_TOOLS_RUN_TOKEN = "test-run-token-123";
      // Format the backend writeMcpConfig emits (type sse + url + headers).
      writeFileSync(
        join(workspace, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "product-tools": {
              type: "sse",
              url: "http://127.0.0.1:1234",
              headers: { Authorization: "Bearer ${PRODUCT_TOOLS_RUN_TOKEN}" },
            },
          },
        }),
      );
      // Child mergeMcpConfigs parses it; the header placeholder is the
      // wire what the child would expand in connectServer via expandEnvVars.
      const merged = mergeMcpConfigs(workspace, []);
      const cfg = merged["product-tools"] as {
        url: string;
        headers: Record<string, string>;
      };
      expect(cfg.url).toBe("http://127.0.0.1:1234");
      expect(cfg.headers.Authorization).toBe("Bearer ${PRODUCT_TOOLS_RUN_TOKEN}");
      // expandEnvVars: does the placeholder yield the real token? (private fn
      // lives in mcp-mount; emulate the same regex here.)
      const expanded = cfg.headers.Authorization.replace(
        /\$\{([A-Z_][A-Z0-9_]*)\}/g,
        (_, name: string) => process.env[name] ?? "",
      );
      expect(expanded).toBe("Bearer test-run-token-123");
    } finally {
      delete process.env.PRODUCT_TOOLS_RUN_TOKEN;
      rmSync(workspace, { recursive: true, force: true });
    }
  });
});
