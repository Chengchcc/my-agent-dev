import { z } from "zod";

/**
 * Single source of truth for ALL process environment variables.
 *
 * Every process (backend / web / lark-bot) calls `parseEnv(process.env)`.
 * Missing or malformed vars → fail-fast at startup, not silent runtime.
 *
 * Naming convention: all vars prefixed with BACKEND_ (auth token, URL, etc.)
 *   The old web-only name BACKEND_TOKEN was normalized to BACKEND_AUTH_TOKEN.
 */

export const envSchema = z.object({
  // ── Auth (shared across all processes) ──
  BACKEND_AUTH_TOKEN: z.string().min(1).describe("Shared secret for x-auth-token header"),

  // ── Backend URL (lark-bot + web need this) ──
  BACKEND_URL: z.string().default("http://127.0.0.1:3000"),

  // ── Backend server config ──
  BACKEND_PORT: z.coerce.number().int().positive().default(3000),
  BACKEND_HOST: z.string().default("127.0.0.1"),
  BACKEND_DATA_DIR: z.string().optional(),
  BACKEND_WORKSPACE_ROOT: z.string().optional(),
  BACKEND_TEMPLATE_DIR: z.string().optional(),
  BACKEND_MAX_CONCURRENT: z.coerce.number().int().positive().default(8),
  BACKEND_CANCEL_GRACE_MS: z.coerce.number().int().positive().default(5_000),

  // ── Anthropic API ──
  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_AUTH_TOKEN: z.string().optional(),
  ANTHROPIC_BASE_URL: z.string().optional().describe("API proxy / alternative endpoint"),

  // ── Web-specific ──
  SESSION_SECRET: z.string().optional().describe("HMAC secret for session cookies"),
  NODE_ENV: z.string().optional(),
  MOCK_USER_ID: z.string().optional().describe("Dev-only: mock login user id"),
  MOCK_PASSWORD: z.string().optional().describe("Dev-only: mock login password"),

  // ── Lark-bot runner ──
  RUNNER_ENV: z
    .string()
    .optional()
    .describe("'dev' | 'prod' — selects lark-bot registry implementation"),

  // ── Phase 5: Coding Agent process + Product Tools MCP ──
  CODING_AGENT_BIN: z
    .string()
    .optional()
    .describe("Coding Agent executable spawned per Run (default: coding-agent on PATH)"),
  // ── Backend kinds (ADR 0002): CLI executables + mounts ──
  OMP_BIN: z.string().optional().describe("omp executable per Run (default: omp on PATH)"),
  PI_BIN: z.string().optional().describe("pi executable per Run (default: pi on PATH)"),
  PI_MCP_ADAPTER_PATH: z
    .string()
    .optional()
    .describe("pi-mcp-adapter extension path (default: pi's own install)"),
  CLAUDE_BIN: z.string().optional().describe("claude executable per Run (default: claude on PATH)"),
  CLAUDE_PERMISSION_MODE: z
    .string()
    .optional()
    .describe("claude --permission-mode (bypassPermissions refused under root)"),
  PRODUCT_TOOLS_MCP_URL: z
    .string()
    .optional()
    .describe("Public URL of the Product Backend Product Tools MCP endpoint"),
  PRODUCT_TOOLS_SERVICE_TOKEN: z
    .string()
    .optional()
    .describe("Service token the Coding Agent child sends to Product Tools MCP"),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parse and validate environment variables.
 *
 * Throws with a human-readable error listing all invalid/missing vars.
 * Call once at process startup.
 */
export function parseEnv(raw: Record<string, string | undefined>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment variables:\n${issues}`);
  }
  return result.data;
}
